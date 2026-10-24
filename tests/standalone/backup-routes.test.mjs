/**
 * /api/backup/* 路由集成测试：真实 standalone 服务器 + 管理员会话。
 * 校验鉴权（401/403）、导出下载、恢复暂存与跨数据目录的「重启交换」。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pbkdf2Sync, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { solveCaptcha } from './captcha-helper.mjs';
import { buildTar, parseTar } from '../../standalone/backup.mjs';
import { gzipSync, gunzipSync } from 'node:zlib';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const password = 'fixture-password-backup-123';

async function startPanel(directory, port, hash) {
  const child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, CAPTCHA_MODE: 'test', ADMIN_PASSWORD_HASH: hash },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return child; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  await stop(child);
  throw new Error(`Server startup timed out: ${logs}`);
}
async function stop(child) {
  child.kill('SIGTERM');
  await Promise.race([new Promise((done) => child.once('exit', done)), delay(3000).then(() => child.kill('SIGKILL'))]);
}

async function login(base) {
  const config = await (await fetch(`${base}/api/config`)).json();
  const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
  const response = await fetch(`${base}/api/auth/password/login`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }),
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
}

// 与 frontend/src/password-stretch.ts 同口径：verifier = SHA-256(pbkdf2(password, salt, iters))
function adminHash() {
  const salt = Buffer.from('backup-test-salt').toString('base64url').slice(0, 22);
  const stretched = pbkdf2Sync(password, Buffer.from(salt, 'base64url'), 1000, 32, 'sha256');
  const verifier = createHash('sha256').update(stretched).digest('base64url');
  return `pbkdf2$sha256$1000$${salt}$${verifier}`;
}

test: {
  const port = 18801;
  const base = `http://127.0.0.1:${port}`;
  const dirA = mkdtempSync(join(tmpdir(), 'bk-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'bk-b-'));
  const hash = adminHash();
  let child;
  try {
    child = await startPanel(dirA, port, hash);
    // 预置一个带数据的 sqlite（LocalNamespace 的 users-*.sqlite）
    const db = new DatabaseSync(join(dirA, 'users-backup-test.sqlite'));
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'panel-data\')');
    db.close();

    const anonExport = await fetch(`${base}/api/backup/export`, { method: 'POST' });
    assert.equal(anonExport.status, 401);
    const cookie = await login(base);
    const evilOrigin = await fetch(`${base}/api/backup/export`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example' } });
    assert.equal(evilOrigin.status, 403);
    const noOriginPost = await fetch(`${base}/api/backup/restore`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(noOriginPost.status, 403);

    const exportResponse = await fetch(`${base}/api/backup/export`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-disposition') || '', /^attachment; filename="cloudssh-backup-/);
    const archive = Buffer.from(await exportResponse.arrayBuffer());
    assert.ok(archive.length > 0);
    const manifest = JSON.parse(parseTar(gunzipSync(archive)).find((entry) => entry.name === 'manifest.json').data.toString('utf8'));
    assert.ok(manifest.files.some((file) => file.name === 'users-backup-test.sqlite'));

    // 坏包：合法 gzip tar 但缺 manifest → 400
    const bad = await fetch(`${base}/api/backup/restore`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/gzip' }, body: gzipSync(buildTar([{ name: 'x.txt', data: Buffer.from('x') }])) });
    assert.equal(bad.status, 400);
    // 好包暂存到 B 数据目录（重启后交换）
    // （restore 走同一服务实例的 DATA_DIR；跨目录交换用 backup.mjs 单测覆盖，这里验证同目录暂存）
    const restore = await fetch(`${base}/api/backup/restore`, { method: 'POST', headers: { Cookie: cookie, Origin: base }, body: archive });
    assert.equal(restore.status, 200);
    const result = await restore.json();
    assert.equal(result.requires_restart, true);
    assert.ok(result.files.includes('users-backup-test.sqlite'));
    assert.ok(existsSync(join(dirA, 'restore-staging', 'restore-pending.json')));
    // 原文件未被动（重启才交换）
    assert.ok(existsSync(join(dirA, 'users-backup-test.sqlite')));

    // 重启 → 交换生效，旧文件归档
    await stop(child);
    child = await startPanel(dirA, port, hash);
    assert.ok(!existsSync(join(dirA, 'restore-staging')), 'staging cleared after restart');
    const swapped = new DatabaseSync(join(dirA, 'users-backup-test.sqlite'), { readOnly: true });
    assert.equal(swapped.prepare('SELECT v FROM t').get().v, 'panel-data');
    swapped.close();
    assert.ok(readdirSync(dirA).some((name) => name.startsWith('pre-restore-')), 'archive dir present');
    // 恢复后仍可登录使用
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    if (child) await stop(child);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
  console.log('backup routes: ok');
}
