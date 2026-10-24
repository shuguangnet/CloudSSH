/**
 * 自托管备份导出 / 恢复（无第三方依赖）。
 *
 * 导出：对 DATA_DIR 内每个 SQLite 用 `VACUUM INTO` 生成一致性快照（WAL 模式下
 * 直接 copy 文件可能拿到未 checkpoint 的半截数据），连同密钥/账号文件打进一个
 * 手写 USTAR tar，再 gzip。manifest.json 记录格式版本与每个文件的 sha256。
 *
 * 恢复：上传的包先解包校验（gzip → tar → manifest → 文件名白名单 + 哈希），
 * 落到 DATA_DIR/restore-staging/ 并写入 restore-pending.json 标记；**下次启动**
 * 在打开任何数据库之前由 applyPendingRestore() 原地交换：现役文件移入
 * pre-restore-<ts>/（保留，不自动删，恢复失败可手工换回），暂存文件就位。
 *
 * 不备份的内容：`-wal`/`-shm` 边车（VACUUM INTO 已保证一致性）、restore-staging 与
 * pre-restore 目录自身、临时文件。恢复期间活跃 SSH 会话会随重启断开——这是
 * 既有语义（重启即断），备份恢复不额外承诺在线迁移。
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BACKUP_FORMAT = 'cloudssh-backup';
export const BACKUP_VERSION = 1;
/** 恢复上传体积上限（解压前）。SQLite 面板库通常远小于此。 */
export const RESTORE_MAX_UPLOAD = 512 * 1024 * 1024;
const STAGING_DIR = 'restore-staging';
const PENDING_MARKER = 'restore-pending.json';

// ==================== USTAR tar ====================

function octal(value, length) {
  // length 含结尾 NUL/空格占位；正文数字位 = length - 1
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new Error(`Tar field overflow: ${value}`);
  return Buffer.from(text, 'ascii');
}

function tarHeader(name, size, mtime) {
  if (Buffer.byteLength(name) > 99) throw new Error(`Tar entry name too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  octal(0o644, 8).copy(header, 100);   // mode
  header.write('0000000\0', 108, 8, 'ascii');  // uid
  header.write('0000000\0', 116, 8, 'ascii');  // gid
  octal(size, 12).copy(header, 124);
  octal(Math.floor(mtime / 1000), 12).copy(header, 136);
  header.write('        ', 148, 8, 'ascii');   // chksum 占位（8 空格）
  header.write('0', 156, 1, 'ascii');          // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('cloudssh\0', 265, 32, 'ascii'); // uname
  header.write('cloudssh\0', 297, 32, 'ascii'); // gname
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumField = Buffer.alloc(8);
  checksumField.write(octal(checksum, 7).toString('ascii') + '\0 ', 0, 8, 'ascii');
  checksumField.copy(header, 148);
  return header;
}

/** entries: [{name, data:Buffer, mtime?:number}] → tar Buffer */
export function buildTar(entries) {
  const now = Date.now();
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    parts.push(tarHeader(entry.name, data.length, entry.mtime ?? now));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // 结束标记
  return Buffer.concat(parts);
}

/** 严格解析 USTAR：校验 magic 与校验和，返回 [{name, data}] */
export function parseTar(buffer) {
  const entries = [];
  for (let offset = 0; offset + 512 <= buffer.length; offset += 512) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // 结束块
    const magic = header.toString('ascii', 257, 262);
    if (magic !== 'ustar') throw new Error('Invalid tar: missing ustar magic');
    const storedChecksum = parseInt(header.toString('ascii', 148, 156).replace(/[\0 ]/g, ''), 8);
    if (!Number.isInteger(storedChecksum)) throw new Error('Invalid tar: unreadable checksum');
    const actual = header.reduce((sum, byte, index) =>
      sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (storedChecksum !== actual) throw new Error('Invalid tar: checksum mismatch');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const name = prefix + header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeField = header.toString('ascii', 124, 136).replace(/[\0 ].*$/, '');
    const size = parseInt(sizeField, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar: bad size for ${name}`);
    const typeflag = header.toString('ascii', 156, 157);
    if (typeflag !== '0' && typeflag !== '\0') throw new Error(`Invalid tar: unsupported entry type "${typeflag}"`);
    if (offset + 512 + size > buffer.length) throw new Error(`Invalid tar: truncated entry ${name}`);
    entries.push({ name, data: Buffer.from(buffer.subarray(offset + 512, offset + 512 + size)) });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ==================== 备份文件清单 ====================

const SAFE_NAME = /^[\w][\w.-]*$/;

/** DATA_DIR 中应进入备份的文件（相对名）。排除 wal/shm 边车与备份工作目录。 */
export function listBackupFiles(dataDir) {
  const files = [];
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === PENDING_MARKER) continue;
    if (name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('.tmp')) continue;
    if (name === 'admin-account.json' || name === 'admin-password-hash' || name.endsWith('.sqlite.secret')) {
      files.push(name);
      continue;
    }
    if (name.endsWith('.sqlite')) files.push(name);
  }
  return files.sort();
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 单库 VACUUM INTO 快照（与源库活动句柄并存安全）。 */
function vacuumInto(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

/**
 * 生成完整备份包。返回 { buffer(gzip tar), filename, manifest }。
 * 任一文件读取失败即抛错（宁可备份失败，不出半截包）。
 */
export function createBackup(dataDir) {
  const names = listBackupFiles(dataDir);
  if (names.length === 0) throw new Error('Nothing to back up in data directory');
  const entries = [];
  const files = [];
  for (const name of names) {
    const source = join(dataDir, name);
    let content;
    if (name.endsWith('.sqlite')) {
      const snapshot = `${source}.backup-${process.pid}-${Date.now()}.tmp`;
      try {
        vacuumInto(source, snapshot);
        content = readFileSync(snapshot);
      } finally {
        try { rmSync(snapshot, { force: true }); } catch { /* 尽力清理 */ }
      }
    } else {
      content = readFileSync(source);
    }
    entries.push({ name, data: content, mtime: statSync(source).mtimeMs });
    files.push({ name, size: content.length, sha256: sha256(content) });
  }
  const manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, created_at: new Date().toISOString(), files };
  const manifestEntry = { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) };
  const buffer = gzipSync(buildTar([manifestEntry, ...entries]), { level: 6 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return { buffer, filename: `cloudssh-backup-${stamp}.tar.gz`, manifest };
}

// ==================== 恢复 ====================

/**
 * 校验并暂存恢复包。成功后写 restore-pending.json；实际交换发生在下次启动
 * （applyPendingRestore）。返回 manifest 供 API 响应展示。
 */
export function stageRestore(dataDir, uploaded) {
  if (!Buffer.isBuffer(uploaded) || uploaded.length === 0) throw Object.assign(new Error('Empty upload'), { status: 400 });
  if (uploaded.length > RESTORE_MAX_UPLOAD) throw Object.assign(new Error('Backup exceeds size limit'), { status: 413 });
  let tar;
  try {
    tar = gunzipSync(uploaded);
  } catch {
    throw Object.assign(new Error('Not a valid backup archive (gzip expected)'), { status: 400 });
  }
  const entries = parseTar(tar);
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  if (!manifestEntry) throw Object.assign(new Error('Backup is missing manifest.json'), { status: 400 });
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Backup manifest is not valid JSON'), { status: 400 });
  }
  if (manifest?.format !== BACKUP_FORMAT || !Number.isInteger(manifest.version) || manifest.version > BACKUP_VERSION) {
    throw Object.assign(new Error(`Unsupported backup format/version: ${manifest?.format ?? '?'} v${manifest?.version ?? '?'}`), { status: 400 });
  }
  const byName = new Map(entries.filter((entry) => entry.name !== 'manifest.json').map((entry) => [entry.name, entry]));
  const verified = new Set();
  for (const described of manifest.files ?? []) {
    if (typeof described?.name !== 'string' || !SAFE_NAME.test(described.name)) {
      throw Object.assign(new Error(`Backup manifest contains unsafe file name: ${described?.name}`), { status: 400 });
    }
    const entry = byName.get(described.name);
    if (!entry || entry.data.length !== described.size || sha256(entry.data) !== described.sha256) {
      throw Object.assign(new Error(`Backup file failed integrity check: ${described.name}`), { status: 400 });
    }
    verified.add(described.name);
  }
  const extras = [...byName.keys()].filter((name) => !verified.has(name));
  if (extras.length > 0) {
    throw Object.assign(new Error(`Backup contains files absent from manifest: ${extras.join(', ')}`), { status: 400 });
  }
  // 全部校验通过后才写暂存目录（先写临时目录再原子改名，中断不留半个暂存）
  const staging = join(dataDir, STAGING_DIR);
  const stagingTmp = join(dataDir, `${STAGING_DIR}.incoming-${process.pid}-${Date.now()}`);
  rmSync(stagingTmp, { recursive: true, force: true });
  try {
    mkdirSync(stagingTmp, { recursive: true, mode: 0o700 });
    for (const described of manifest.files) {
      const entry = byName.get(described.name);
      if (!entry) throw new Error(`Internal error: ${described.name} disappeared during validation`);
      writeFileSync(join(stagingTmp, described.name), entry.data, { mode: 0o600 });
    }
    writeFileSync(join(stagingTmp, PENDING_MARKER), JSON.stringify({ staged_at: new Date().toISOString(), files: manifest.files.map((file) => file.name) }, null, 2), { mode: 0o600 });
    rmSync(staging, { recursive: true, force: true });
    renameSync(stagingTmp, staging);
  } catch (error) {
    rmSync(stagingTmp, { recursive: true, force: true });
    throw error;
  }
  return { manifest, restart_required: true };
}

/**
 * 启动期应用暂存的恢复：在打开任何数据库之前调用。
 * 现役文件移入 pre-restore-<ts>/，暂存文件就位，删除暂存目录。
 * 返回恢复描述（用于日志），无待恢复时返回 null。
 */
export function applyPendingRestore(dataDir) {
  const staging = join(dataDir, STAGING_DIR);
  const marker = join(staging, PENDING_MARKER);
  if (!existsSync(marker)) return null;
  const restored = [];
  for (const entry of readdirSync(staging, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === PENDING_MARKER) continue;
    if (!SAFE_NAME.test(entry.name)) continue; // stageRestore 已白名单校验，双保险
    restored.push(entry.name);
  }
  if (restored.length === 0) {
    rmSync(staging, { recursive: true, force: true });
    return null;
  }
  const archive = join(dataDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  for (const name of restored) {
    const live = join(dataDir, name);
    if (existsSync(live)) renameSync(live, join(archive, name));
    renameSync(join(staging, name), live);
    try { rmSync(`${live}-wal`, { force: true }); rmSync(`${live}-shm`, { force: true }); } catch { /* 旧边车尽力清理 */ }
  }
  rmSync(staging, { recursive: true, force: true });
  return { archived_to: archive, files: restored };
}
