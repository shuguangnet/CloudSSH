import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

export const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const SCOPES = ['read', 'write', 'exec'];
const AUDIT_STATUSES = ['succeeded', 'failed', 'started', 'unknown', 'denied'];
const validName = (name) => typeof name === 'string' && name.trim().length > 0 && name.length <= 100;
const validServerIds = (ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= 100
  && ids.every((id) => Number.isSafeInteger(id) && id > 0);
const validScopes = (scopes) => Array.isArray(scopes) && scopes.length > 0
  && scopes.every((scope) => SCOPES.includes(scope));
// 输入非法（400）与状态冲突（409，如已撤销/已过期）需要区分，路由层按 code 映射状态码。
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid' });

// ==================== 令牌明文加密（支持二次查看） ====================
// 认证永远只走 SHA-256 哈希（verify 不碰密钥）；加密副本仅服务于「二次查看」。
// 密钥文件与 mcp.sqlite 分离（同 database-store 的约定）：只备份/泄露
// mcp.sqlite 拿不到令牌明文；反过来密钥文件丢失只影响 reveal（解密报
// decryptFailed），登录与令牌校验完全不受影响。
const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadSecret(secretFile) {
  if (existsSync(secretFile)) {
    const value = readFileSync(secretFile, 'utf8').trim();
    if (value.length >= 32) return value;
    throw new Error(`MCP 加密密钥文件损坏：${secretFile}`);
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  try { chmodSync(secretFile, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
  return secret;
}

/** 解析审计用客户端 IP：X-Forwarded-For 首跳 → X-Real-IP → 直连地址。
 * 形状校验（IPv4 八位组 / IPv6 十六进制冒号）防止把任意头内容写进审计；
 * 未通过反代时 XFF 可被调用方伪造——这是审计元数据不是鉴权依据，只作展示。 */
const ipShape = (value) => {
  const text = String(value ?? '').trim();
  if (!text || text.length > 45) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) <= 255) ? text : null;
  }
  if (text.includes(':')) {
    const bare = text.split('%')[0]; // 剥离 IPv6 zone id（fe80::1%eth0）
    return /^[0-9A-Fa-f:]{2,39}$/.test(bare) && bare.replace(/:/g, '').length >= 2 ? bare : null;
  }
  return null;
};
export function clientIpFrom(forwarded, realIp, socketAddress) {
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0] : '';
  return ipShape(first) || ipShape(realIp) || ipShape(socketAddress);
}

export class AccessStore {
  constructor(file, { secretFile } = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        github_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        server_ids TEXT NOT NULL, scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
        disabled_at INTEGER,
        auth_generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT NOT NULL,
        github_id TEXT NOT NULL, server_id INTEGER, tool TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, details TEXT NOT NULL, ip TEXT);
      CREATE INDEX IF NOT EXISTS mcp_audit_owner ON mcp_audit(github_id, id);
      CREATE INDEX IF NOT EXISTS mcp_audit_token ON mcp_audit(github_id, token_id, id);
      CREATE INDEX IF NOT EXISTS mcp_audit_filter ON mcp_audit(github_id, server_id, id);
    `);
    // 老库升级：这些列都是后加的，CREATE TABLE IF NOT EXISTS 不会补列。
    // SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查 PRAGMA 再 ALTER。
    const columns = new Set(this.db.prepare('PRAGMA table_info(mcp_tokens)').all().map((row) => row.name));
    if (!columns.has('disabled_at')) this.db.exec('ALTER TABLE mcp_tokens ADD COLUMN disabled_at INTEGER');
    // 数据库连接授权：与 server_ids 同构，存 JSON 数组；空数组 = 不授权任何库。
    if (!columns.has('db_connection_ids')) {
      this.db.exec("ALTER TABLE mcp_tokens ADD COLUMN db_connection_ids TEXT NOT NULL DEFAULT '[]'");
    }
    // 令牌明文加密副本：支撑设置页「二次查看」。老令牌没有副本（reveal 不可用）。
    if (!columns.has('token_enc')) this.db.exec('ALTER TABLE mcp_tokens ADD COLUMN token_enc TEXT');
    // 审计来源 IP：老记录为 NULL，前端展示为「—」。
    const auditColumns = new Set(this.db.prepare('PRAGMA table_info(mcp_audit)').all().map((row) => row.name));
    if (!auditColumns.has('ip')) this.db.exec('ALTER TABLE mcp_audit ADD COLUMN ip TEXT');
    // :memory:（单测）不落密钥文件；真实部署默认在 mcp.sqlite 同目录生成 .secret。
    this.key = file === ':memory:' ? null : scryptSync(loadSecret(secretFile || `${file}.secret`), 'cloudssh:mcp-tokens', 32);
  }
  create(user, { name, server_ids, scopes, expires_in_days, db_connection_ids }, authGeneration = 'github') {
    if (!validName(name) || !validServerIds(server_ids) || !validScopes(scopes) ||
        !Number.isInteger(expires_in_days) || expires_in_days < 1 || expires_in_days > 365) {
      throw invalid('Invalid token settings');
    }
    const count = this.db.prepare('SELECT count(*) AS n FROM mcp_tokens WHERE github_id=? AND revoked_at IS NULL AND expires_at>?')
      .get(String(user.github_id), Date.now());
    if (count.n >= 100) throw new Error('Maximum 100 active tokens per user');
    const id = randomBytes(12).toString('hex');
    const token = `cssh_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    // 显式列名：新增列（如 disabled_at）不会打乱位置绑定。token_enc 是
    // 加密后的明文副本（仅当配置了密钥，即真实部署），供设置页二次查看。
    this.db.prepare(`INSERT INTO mcp_tokens
      (id, hash, name, github_id, user_id, server_ids, scopes, created_at, expires_at, revoked_at, disabled_at, auth_generation, token_enc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
      .run(id, tokenHash(token), name.trim(), String(user.github_id), user.id,
        JSON.stringify([...new Set(server_ids)]), JSON.stringify([...new Set(scopes)]),
        now, now + expires_in_days * 86400000, authGeneration, this.encrypt(token));
    // 数据库授权是后续补上的能力：老 UI 不传时就保持空数组（默认不授权）。
    const wanted = Array.isArray(db_connection_ids) ? db_connection_ids : [];
    if (wanted.length > 0) {
      if (!validServerIds(wanted)) throw invalid('Invalid database connection selection');
      this.db.prepare('UPDATE mcp_tokens SET db_connection_ids=? WHERE id=?')
        .run(JSON.stringify([...new Set(wanted)]), id);
    }
    return { id, token };
  }
  /** 认证：撤销、过期、临时禁用任一命中即视为无效。 */
  verify(token) {
    if (typeof token !== 'string' || !/^cssh_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM mcp_tokens WHERE hash=? AND revoked_at IS NULL AND disabled_at IS NULL AND expires_at>?')
      .get(tokenHash(token), Date.now());
    return row ? this.decode(row) : null;
  }
  decode(row) {
    const { hash, token_enc, ...safe } = row;
    return {
      ...safe,
      disabled: Boolean(row.disabled_at),
      // 列表/详情永不携带哈希与密文；revealable 告知前端能否二次查看。
      revealable: Boolean(token_enc),
      server_ids: JSON.parse(row.server_ids),
      scopes: JSON.parse(row.scopes),
      // 老令牌行可能没有这一列（历史数据），一律按「无授权」处理。
      db_connection_ids: safe.db_connection_ids ? JSON.parse(safe.db_connection_ids) : [],
    };
  }
  /** AES-256-GCM 加密令牌明文；未配置密钥（如 :memory: 单测）返回 NULL。 */
  encrypt(plaintext) {
    if (!this.key || typeof plaintext !== 'string' || plaintext.length === 0) return null;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  decrypt(stored) {
    const raw = Buffer.from(stored, 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('密文长度非法');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(CIPHER, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }
  /**
   * 二次查看令牌明文。仅浏览器会话 + 同源 POST 可达（路由层把关），
   * 返回 `{ token }`；老令牌（升级前创建、无加密副本）返回 `{ token: null }`。
   * 密钥文件丢失/损坏时抛 decryptFailed——绝不把密文当明文回传。
   */
  reveal(user, id) {
    const row = this.owned(user, id);
    if (!row) return null;
    if (!row.token_enc || !this.key) return { token: null };
    try { return { token: this.decrypt(row.token_enc) }; }
    catch (error) { throw Object.assign(new Error('decryptFailed'), { code: 'decryptFailed' }); }
  }
  isActive(id) {
    return Boolean(this.db.prepare('SELECT id FROM mcp_tokens WHERE id=? AND revoked_at IS NULL AND disabled_at IS NULL AND expires_at>?')
      .get(id, Date.now()));
  }
  /** 取自己名下的令牌行（含已禁用）——修改/禁用操作只在这里做归属判定。 */
  owned(user, id) {
    return this.db.prepare('SELECT * FROM mcp_tokens WHERE id=? AND github_id=?').get(id, String(user.github_id)) ?? null;
  }
  /**
   * 修改令牌的名称/权限/授权主机。活跃与临时禁用的令牌都可改（撤销、过期除外）——
   * 禁用只是临时停用，随后仍可改回并重新启用。
   */
  update(user, id, { name, server_ids, scopes, db_connection_ids }) {
    const row = this.owned(user, id);
    if (!row) return null;
    if (row.revoked_at) throw new Error('Revoked tokens cannot be modified');
    if (row.expires_at <= Date.now()) throw new Error('Expired tokens cannot be modified');
    const currentDbIds = row.db_connection_ids ? JSON.parse(row.db_connection_ids) : [];
    const next = {
      name: name === undefined ? row.name : name,
      server_ids: server_ids === undefined ? JSON.parse(row.server_ids) : server_ids,
      scopes: scopes === undefined ? JSON.parse(row.scopes) : scopes,
      // 数据库授权允许显式清空（传空数组），缺省则保持原值。
      db_connection_ids: db_connection_ids === undefined ? currentDbIds : db_connection_ids,
    };
    if (!validName(next.name) || !validServerIds(next.server_ids) || !validScopes(next.scopes)) {
      throw invalid('Invalid token settings');
    }
    // 允许空数组表示「不授权任何数据库」，所以这里不能用 validServerIds
    // （它要求非空）——只校验元素类型。
    if (!Array.isArray(next.db_connection_ids) ||
        !next.db_connection_ids.every((v) => Number.isSafeInteger(v) && v > 0)) {
      throw invalid('Invalid database connection selection');
    }
    this.db.prepare('UPDATE mcp_tokens SET name=?, server_ids=?, scopes=?, db_connection_ids=? WHERE id=? AND github_id=?')
      .run(next.name.trim(), JSON.stringify([...new Set(next.server_ids)]), JSON.stringify([...new Set(next.scopes)]),
        JSON.stringify([...new Set(next.db_connection_ids)]), id, String(user.github_id));
    return this.decode(this.db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(id));
  }
  /** 临时禁用/启用：禁用立即失效（verify/isActive 拒绝），数据保留，随时可恢复。 */
  setDisabled(user, id, disabled) {
    const row = this.owned(user, id);
    if (!row) return null;
    if (row.revoked_at) throw new Error('Revoked tokens cannot be disabled or enabled');
    if (row.expires_at <= Date.now()) throw new Error('Expired tokens cannot be disabled or enabled');
    this.db.prepare('UPDATE mcp_tokens SET disabled_at=? WHERE id=? AND github_id=?')
      .run(disabled ? Date.now() : null, id, String(user.github_id));
    return this.decode(this.db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(id));
  }
  list(user) {
    return this.db.prepare('SELECT * FROM mcp_tokens WHERE github_id=? ORDER BY created_at DESC')
      .all(String(user.github_id)).map((row) => this.decode(row));
  }
  revoke(user, id) {
    return this.db.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE id=? AND github_id=? AND revoked_at IS NULL')
      .run(Date.now(), id, String(user.github_id)).changes > 0;
  }
  /** 删除令牌记录：仅允许删除已撤销或已过期的令牌（禁用中的令牌需先撤销）。 */
  remove(user, id) {
    const row = this.db.prepare('SELECT id FROM mcp_tokens WHERE id=? AND github_id=?').get(id, String(user.github_id));
    if (!row) return false;
    const disposable = this.db.prepare('SELECT id FROM mcp_tokens WHERE id=? AND github_id=? AND (revoked_at IS NOT NULL OR expires_at<=?)')
      .get(id, String(user.github_id), Date.now());
    if (!disposable) throw new Error('Active tokens must be revoked before deletion');
    this.db.prepare('DELETE FROM mcp_tokens WHERE id=? AND github_id=?').run(id, String(user.github_id));
    return true;
  }
  /**
   * 批量删除令牌记录：逐条套用 remove() 的规则（他人/不存在/仍有效 → 跳过），
   * 汇总删除与跳过，避免一条失败中断整批。
   */
  removeMany(user, ids) {
    const deleted = []; const skipped = [];
    for (const id of ids) {
      let removed = false;
      try { removed = this.remove(user, id); } catch { removed = false; }
      (removed ? deleted : skipped).push(id);
    }
    return { deleted, skipped };
  }
  revokeOwner(user) {
    this.db.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE github_id=? AND revoked_at IS NULL')
      .run(Date.now(), String(user.github_id));
  }
  audit(identity, tool, serverId, status, details = {}, ip = null) {
    this.db.prepare('INSERT INTO mcp_audit (token_id, github_id, server_id, tool, status, created_at, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(identity.id, identity.github_id, serverId ?? null, tool, status, Date.now(), JSON.stringify(details), ip);
  }
  /**
   * 清理审计：可按 id 列表精确删除，或按 before 游标 + 令牌/服务器/工具/状态筛选批量删除；
   * 不带任何筛选条件时必须显式 all=true（避免误清空）。只删自己名下的记录。
   */
  purgeAudits(user, { ids = null, before = null, all = false, token_id = null, server_id = null, tool = null, status = null } = {}) {
    const where = ['github_id=?']; const args = [String(user.github_id)];
    if (Array.isArray(ids) && ids.length) {
      if (ids.length > 500) throw invalid('At most 500 audit rows per request');
      if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid audit ids');
      where.push(`id IN (${ids.map(() => '?').join(',')})`); args.push(...ids);
    } else {
      if (before !== null) {
        if (!Number.isSafeInteger(before) || before < 1) throw new Error('Invalid cursor');
        where.push('id<?'); args.push(before);
      }
      if (token_id) {
        if (!/^[a-f0-9]{24}$/.test(token_id)) throw new Error('Invalid token id');
        where.push('token_id=?'); args.push(token_id);
      }
      if (server_id !== null) {
        if (!Number.isSafeInteger(server_id) || server_id < 1) throw new Error('Invalid server id');
        where.push('server_id=?'); args.push(server_id);
      }
      if (tool) {
        if (typeof tool !== 'string' || tool.length > 60) throw new Error('Invalid tool');
        where.push('tool=?'); args.push(tool);
      }
      if (status) {
        if (!AUDIT_STATUSES.includes(status)) throw new Error('Invalid status');
        where.push('status=?'); args.push(status);
      }
      if (!all && where.length === 1) throw new Error('Refusing to purge every audit row without all=true');
    }
    return this.db.prepare(`DELETE FROM mcp_audit WHERE ${where.join(' AND ')}`).run(...args).changes;
  }
  /** 审计列表：支持 token_id / server_id / tool / status 组合筛选 + before 游标分页。 */
  audits(user, { before = Number.MAX_SAFE_INTEGER, token_id = null, server_id = null, tool = null, status = null } = {}) {
    const where = ['github_id=?', 'id<?']; const args = [String(user.github_id), before];
    if (token_id) { where.push('token_id=?'); args.push(token_id); }
    if (server_id !== null) { where.push('server_id=?'); args.push(server_id); }
    if (tool) { where.push('tool=?'); args.push(tool); }
    if (status) { where.push('status=?'); args.push(status); }
    return this.db.prepare(`SELECT * FROM mcp_audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100`).all(...args);
  }
  /** /metrics 用：未撤销、未过期的令牌数（不回内容，只回计数）。 */
  countActiveTokens() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL AND disabled_at IS NULL AND expires_at > ?').get(Date.now());
    return row?.n ?? 0;
  }

  close() { this.db.close(); }
}
