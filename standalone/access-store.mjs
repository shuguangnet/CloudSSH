import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

export const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
export class AccessStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        github_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        server_ids TEXT NOT NULL, scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
        auth_generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT NOT NULL,
        github_id TEXT NOT NULL, server_id INTEGER, tool TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_audit_owner ON mcp_audit(github_id, id);
    `);
  }
  create(user, { name, server_ids, scopes, expires_in_days }, authGeneration = 'github') {
    if (typeof name !== 'string' || !name.trim() || name.length > 100 ||
        !Array.isArray(server_ids) || !server_ids.length || server_ids.length > 100 ||
        !server_ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
        !Array.isArray(scopes) || !scopes.length ||
        !scopes.every((scope) => ['read', 'write', 'exec'].includes(scope)) ||
        !Number.isInteger(expires_in_days) || expires_in_days < 1 || expires_in_days > 365) {
      throw new Error('Invalid token settings');
    }
    const count = this.db.prepare('SELECT count(*) AS n FROM mcp_tokens WHERE github_id=? AND revoked_at IS NULL AND expires_at>?')
      .get(String(user.github_id), Date.now());
    if (count.n >= 100) throw new Error('Maximum 100 active tokens per user');
    const id = randomBytes(12).toString('hex');
    const token = `cssh_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    this.db.prepare('INSERT INTO mcp_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(id, tokenHash(token), name.trim(), String(user.github_id), user.id,
        JSON.stringify([...new Set(server_ids)]), JSON.stringify([...new Set(scopes)]),
        now, now + expires_in_days * 86400000, authGeneration);
    return { id, token };
  }
  verify(token) {
    if (typeof token !== 'string' || !/^cssh_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM mcp_tokens WHERE hash=? AND revoked_at IS NULL AND expires_at>?')
      .get(tokenHash(token), Date.now());
    return row ? this.decode(row) : null;
  }
  decode(row) {
    const { hash, ...safe } = row;
    return { ...safe, server_ids: JSON.parse(row.server_ids), scopes: JSON.parse(row.scopes) };
  }
  isActive(id) {
    return Boolean(this.db.prepare('SELECT id FROM mcp_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?').get(id, Date.now()));
  }
  list(user) {
    return this.db.prepare('SELECT * FROM mcp_tokens WHERE github_id=? ORDER BY created_at DESC')
      .all(String(user.github_id)).map((row) => this.decode(row));
  }
  revoke(user, id) {
    return this.db.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE id=? AND github_id=? AND revoked_at IS NULL')
      .run(Date.now(), id, String(user.github_id)).changes > 0;
  }
  revokeOwner(user) {
    this.db.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE github_id=? AND revoked_at IS NULL')
      .run(Date.now(), String(user.github_id));
  }
  audit(identity, tool, serverId, status, details = {}) {
    this.db.prepare('INSERT INTO mcp_audit (token_id, github_id, server_id, tool, status, created_at, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(identity.id, identity.github_id, serverId ?? null, tool, status, Date.now(), JSON.stringify(details));
  }
  audits(user, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT * FROM mcp_audit WHERE github_id=? AND id<? ORDER BY id DESC LIMIT 100')
      .all(String(user.github_id), before);
  }
  close() { this.db.close(); }
}
