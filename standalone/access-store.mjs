import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

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
export class AccessStore {
  constructor(file) {
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
        status TEXT NOT NULL, created_at INTEGER NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_audit_owner ON mcp_audit(github_id, id);
      CREATE INDEX IF NOT EXISTS mcp_audit_token ON mcp_audit(github_id, token_id, id);
      CREATE INDEX IF NOT EXISTS mcp_audit_filter ON mcp_audit(github_id, server_id, id);
    `);
    // 老库升级：disabled_at 是后加的列（临时禁用令牌），CREATE TABLE IF NOT EXISTS 不会补列。
    const columns = new Set(this.db.prepare('PRAGMA table_info(mcp_tokens)').all().map((row) => row.name));
    if (!columns.has('disabled_at')) this.db.exec('ALTER TABLE mcp_tokens ADD COLUMN disabled_at INTEGER');
  }
  create(user, { name, server_ids, scopes, expires_in_days }, authGeneration = 'github') {
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
    // 显式列名：新增列（如 disabled_at）不会打乱位置绑定。
    this.db.prepare(`INSERT INTO mcp_tokens
      (id, hash, name, github_id, user_id, server_ids, scopes, created_at, expires_at, revoked_at, disabled_at, auth_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
      .run(id, tokenHash(token), name.trim(), String(user.github_id), user.id,
        JSON.stringify([...new Set(server_ids)]), JSON.stringify([...new Set(scopes)]),
        now, now + expires_in_days * 86400000, authGeneration);
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
    const { hash, ...safe } = row;
    return { ...safe, disabled: Boolean(row.disabled_at), server_ids: JSON.parse(row.server_ids), scopes: JSON.parse(row.scopes) };
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
  update(user, id, { name, server_ids, scopes }) {
    const row = this.owned(user, id);
    if (!row) return null;
    if (row.revoked_at) throw new Error('Revoked tokens cannot be modified');
    if (row.expires_at <= Date.now()) throw new Error('Expired tokens cannot be modified');
    const next = {
      name: name === undefined ? row.name : name,
      server_ids: server_ids === undefined ? JSON.parse(row.server_ids) : server_ids,
      scopes: scopes === undefined ? JSON.parse(row.scopes) : scopes,
    };
    if (!validName(next.name) || !validServerIds(next.server_ids) || !validScopes(next.scopes)) {
      throw invalid('Invalid token settings');
    }
    this.db.prepare('UPDATE mcp_tokens SET name=?, server_ids=?, scopes=? WHERE id=? AND github_id=?')
      .run(next.name.trim(), JSON.stringify([...new Set(next.server_ids)]), JSON.stringify([...new Set(next.scopes)]),
        id, String(user.github_id));
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
  audit(identity, tool, serverId, status, details = {}) {
    this.db.prepare('INSERT INTO mcp_audit (token_id, github_id, server_id, tool, status, created_at, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(identity.id, identity.github_id, serverId ?? null, tool, status, Date.now(), JSON.stringify(details));
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
  close() { this.db.close(); }
}
