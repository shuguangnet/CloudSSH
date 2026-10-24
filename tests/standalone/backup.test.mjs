import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  buildTar, parseTar, createBackup, stageRestore, applyPendingRestore, listBackupFiles,
  BACKUP_FORMAT, RESTORE_MAX_UPLOAD,
} from '../../standalone/backup.mjs';

function makeDataDir() {
  return mkdtempSync(join(tmpdir(), 'cloudssh-backup-'));
}

function makeSqlite(path, rows) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
  for (const [key, value] of rows) insert.run(key, value);
  return db;
}

test('tar round-trip：小文件、跨块文件与多文件顺序', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'big.bin', data: Buffer.alloc(1500, 7) },
    { name: 'empty.dat', data: Buffer.alloc(0) },
  ];
  const parsed = parseTar(buildTar(entries));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((entry) => entry.name), ['a.txt', 'big.bin', 'empty.dat']);
  assert.equal(parsed[0].data.toString(), 'hello');
  assert.equal(parsed[1].data.length, 1500);
  assert.ok(parsed[1].data.every((byte) => byte === 7));
  assert.equal(parsed[2].data.length, 0);
});

test('tar 解析拒绝校验和不匹配与非法 magic', () => {
  const tar = buildTar([{ name: 'x', data: Buffer.from('y') }]);
  const corrupt = Buffer.from(tar);
  corrupt[0] ^= 0xff; // 破坏文件名 → 校验和失配
  assert.throws(() => parseTar(corrupt), /checksum/);
  const notTar = Buffer.alloc(2048, 0x41);
  assert.throws(() => parseTar(notTar), /ustar/);
});

test('createBackup 用 VACUUM INTO 拿到 WAL 内未 checkpoint 的数据', () => {
  const dir = makeDataDir();
  try {
    const db = makeSqlite(join(dir, 'users-abc.sqlite'), [['k1', 'v1']]);
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('k2', 'v2');
    // 不 checkpoint、不关闭 —— 直接备份
    const { buffer, filename, manifest } = createBackup(dir);
    assert.match(filename, /^cloudssh-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/);
    assert.equal(manifest.format, BACKUP_FORMAT);
    const names = manifest.files.map((file) => file.name);
    assert.ok(names.includes('users-abc.sqlite'));
    // 解包快照应包含 WAL 里的 v2
    const entries = parseTar(gunzipSync(buffer));
    const snapshot = entries.find((entry) => entry.name === 'users-abc.sqlite');
    const probe = mkdtempSync(join(tmpdir(), 'probe-'));
    try {
      writeFileSync(join(probe, 'snap.sqlite'), snapshot.data);
      const check = new DatabaseSync(join(probe, 'snap.sqlite'), { readOnly: true });
      assert.equal(check.prepare("SELECT value FROM kv WHERE key='k2'").get().value, 'v2');
      check.close();
    } finally { rmSync(probe, { recursive: true, force: true }); }
    // 备份不留临时文件
    assert.ok(readdirSync(dir).every((name) => !name.includes('.backup-')), 'snapshot tmp cleaned');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listBackupFiles 排除 wal/shm/tmp 与 pending 标记，包含账号与密钥文件', () => {
  const dir = makeDataDir();
  try {
    writeFileSync(join(dir, 'users-x.sqlite'), '');
    writeFileSync(join(dir, 'users-x.sqlite-wal'), '');
    writeFileSync(join(dir, 'users-x.sqlite-shm'), '');
    writeFileSync(join(dir, 'mcp.sqlite'), '');
    writeFileSync(join(dir, 'mcp.sqlite.secret'), '');
    writeFileSync(join(dir, 'admin-account.json'), '{}');
    writeFileSync(join(dir, 'admin-password-hash'), 'legacy');
    writeFileSync(join(dir, 'stray.tmp'), '');
    writeFileSync(join(dir, 'restore-pending.json'), '{}');
    const names = listBackupFiles(dir);
    assert.deepEqual(names, ['admin-account.json', 'admin-password-hash', 'mcp.sqlite', 'mcp.sqlite.secret', 'users-x.sqlite']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stageRestore 全链路：校验通过 → 暂存 → 启动交换 → 归档旧文件', () => {
  const dir = makeDataDir();
  try {
    makeSqlite(join(dir, 'mcp.sqlite'), [['token', 't1']]).close();
    writeFileSync(join(dir, 'admin-account.json'), '{"v":1}');
    const { buffer } = createBackup(dir);

    // 外部篡改包内文件 → 哈希校验失败
    const tamperedTar = parseTar(gunzipSync(buffer));
    const idx = tamperedTar.findIndex((entry) => entry.name === 'mcp.sqlite');
    tamperedTar[idx].data = Buffer.from('evil');
    assert.equal(stageRestore(dir, gzipSync(buildTar(tamperedTar))).manifest, undefined); // 不应到达
  } catch (error) {
    assert.match(String(error.message ?? error), /integrity|manifest/i);
  } finally {
    // 上面 stageRestore 必须失败且不留暂存目录
    assert.ok(!existsSync(join(dir, 'restore-staging')));
    rmSync(dir, { recursive: true, force: true });
  }

  // 正常恢复流程
  const source = makeDataDir();
  const target = makeDataDir();
  try {
    makeSqlite(join(source, 'mcp.sqlite'), [['token', 't1']]).close();
    writeFileSync(join(source, 'admin-account.json'), '{"version":1}');
    const { buffer, manifest } = createBackup(source);

    const result = stageRestore(target, buffer);
    assert.equal(result.restart_required, true);
    assert.deepEqual(result.manifest.files.map((file) => file.name).sort(), ['admin-account.json', 'mcp.sqlite']);
    // 目标目录暂未被触碰（重启才交换）
    assert.deepEqual(readdirSync(target).sort(), ['restore-staging']);

    const applied = applyPendingRestore(target);
    assert.ok(applied);
    assert.deepEqual(applied.files.sort(), ['admin-account.json', 'mcp.sqlite']);
    assert.equal(readFileSync(join(target, 'admin-account.json'), 'utf8'), '{"version":1}');
    const db = new DatabaseSync(join(target, 'mcp.sqlite'), { readOnly: true });
    assert.equal(db.prepare("SELECT value FROM kv WHERE key='token'").get().value, 't1');
    db.close();
    // 暂存目录被清理；无 pending；旧状态归档目录存在
    assert.ok(!existsSync(join(target, 'restore-staging')));
    const archived = readdirSync(target).find((name) => name.startsWith('pre-restore-'));
    assert.ok(archived, 'pre-restore archive exists');
    // 二次启动：无待恢复
    assert.equal(applyPendingRestore(target), null);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('stageRestore 拒绝非 gzip、未知格式与路径穿越名', () => {
  const dir = makeDataDir();
  try {
    assert.throws(() => stageRestore(dir, Buffer.from('not gzip at all')), /gzip/i);
    // 合法 tar + manifest，但 manifest 声明了穿越文件名
    const evilFiles = [{ name: '../escape.txt', size: 2, sha256: '00' }];
    const manifest = { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, version: 1, files: evilFiles })) };
    const pkg = gzipSync(buildTar([manifest]));
    assert.throws(() => stageRestore(dir, pkg), /unsafe file name/i);
    // tar 内含 manifest 未声明的多余文件
    const honest = { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: BACKUP_FORMAT, version: 1, files: [] })) };
    const extra = { name: 'extra.txt', data: Buffer.from('x') };
    assert.throws(() => stageRestore(dir, gzipSync(buildTar([honest, extra]))), /absent from manifest/i);
    // 超限体积
    const huge = Buffer.alloc(0);
    assert.throws(() => stageRestore(dir, Buffer.alloc(RESTORE_MAX_UPLOAD + 1)), /size limit/i);
    assert.equal(huge.length, 0);
    // 失败后不留暂存
    assert.ok(!existsSync(join(dir, 'restore-staging')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('applyPendingRestore：现役同名文件被归档而非覆盖删除', () => {
  const source = makeDataDir();
  const target = makeDataDir();
  try {
    writeFileSync(join(source, 'admin-account.json'), '{"new":true}');
    const { buffer } = createBackup(source);
    writeFileSync(join(target, 'admin-account.json'), '{"old":true}');
    stageRestore(target, buffer);
    applyPendingRestore(target);
    assert.equal(readFileSync(join(target, 'admin-account.json'), 'utf8'), '{"new":true}');
    const archiveDir = readdirSync(target).find((name) => name.startsWith('pre-restore-'));
    const archived = JSON.parse(readFileSync(join(target, archiveDir, 'admin-account.json'), 'utf8'));
    assert.equal(archived.old, true);
    // 权限保持 0600
    const mode = statSync(join(target, 'admin-account.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

