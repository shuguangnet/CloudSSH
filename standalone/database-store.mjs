// 数据库连接与代理的持久化（独立 database.sqlite）。
//
// 设计要点：
// 1. 密码/私密字段一律 AES-256-GCM 加密后落盘，密钥单独存在 secret 文件里，
//    与库文件分离——只拷走 database.sqlite 拿不到任何凭据。
// 2. 加密密钥是「进程级」的，不按用户派生：这张表里的连接属于整个部署
//    （MCP token 已按 owner 隔离），按用户派生会在 MCP 场景下因缺少
//    登录态而无法解密。
// 3. merge 语义：更新时「字段缺省」= 保持原值，「显式传空」= 清空。
//    这对密码尤其重要——前端回显永远拿不到明文，不传就绝不能覆盖。
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

export const ENGINES = ['mysql', 'mariadb', 'postgres', 'redis'];
export const PROXY_KINDS = ['direct', 'socks5', 'http', 'ssh'];

// 默认端口：只在用户没填端口时兜底，填了就完全以用户为准。
export const DEFAULT_PORTS = { mysql: 3306, mariadb: 3306, postgres: 5432, redis: 6379 };

const NAME_MAX = 100;
const HOST_MAX = 253;
const USER_MAX = 128;
const SECRET_MAX = 4096;
const DBNAME_MAX = 128;

const invalid = (message) => Object.assign(new Error(message), { code: 'invalid' });
const notFound = (message) => Object.assign(new Error(message), { code: 'notFound' });

// ==================== 加密 ====================

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * 读取或首次生成加密密钥。
 *
 * 密钥文件与 sqlite 文件放在同一目录但独立存放，权限 0600。它不是
 * 「防得住拿 root 的人」的机制（那不可能），而是防「只备份/泄露了
 * database.sqlite 一个文件」这种最常见的误操作。
 */
function loadSecret(secretFile) {
  if (existsSync(secretFile)) {
    const value = readFileSync(secretFile, 'utf8').trim();
    if (value.length >= 32) return value;
    throw new Error(`数据库加密密钥文件损坏：${secretFile}`);
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  try { chmodSync(secretFile, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
  return secret;
}

export class DatabaseStore {
  constructor(file, { secretFile } = {}) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS db_proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        host TEXT,
        port INTEGER,
        username TEXT,
        password TEXT,
        server_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS db_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database_name TEXT,
        username TEXT,
        password TEXT,
        proxy_id INTEGER,
        read_only INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS db_connections_proxy ON db_connections(proxy_id);
      CREATE TABLE IF NOT EXISTS db_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL,
        connection_name TEXT NOT NULL,
        tool TEXT NOT NULL,
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        sql_sha256 TEXT,
        row_count INTEGER,
        duration_ms INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS db_audit_conn ON db_audit(connection_id, id);`);

    const target = secretFile || `${file}.secret`;
    this.secret = loadSecret(target);
    // scrypt 把任意长度的密钥文件转成 32 字节定长 key，salt 固定即可
    // ——密钥本身已经是高熵随机值，不需要额外盐。
    this.key = scryptSync(this.secret, 'cloudssh:database-mcp', 32);
  }

  encrypt(plaintext) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) return null;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  decrypt(stored) {
    if (!stored) return '';
    const raw = Buffer.from(stored, 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('密文长度非法');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(CIPHER, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  // ==================== 校验 ====================

  #requireText(value, field, max) {
    if (typeof value !== 'string') throw invalid(`${field}必须是字符串`);
    const trimmed = value.trim();
    if (!trimmed) throw invalid(`${field}不能为空`);
    if (trimmed.length > max) throw invalid(`${field}过长（上限 ${max} 字符）`);
    if (/[\x00-\x1f\x7f]/.test(trimmed)) throw invalid(`${field}不能包含控制字符`);
    return trimmed;
  }

  #optionalText(value, field, max) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw invalid(`${field}必须是字符串`);
    if (value.length > max) throw invalid(`${field}过长（上限 ${max} 字符）`);
    if (/[\x00-\x1f\x7f]/.test(value)) throw invalid(`${field}不能包含控制字符`);
    return value;
  }

  /**
   * 主机名校验。与 net-proxy.validHost 保持同一套规则：主机要么是 IP，
   * 要么是 DNS 名，绝不能含空格、斜杠、冒号等字符——否则这些字符会原样
   * 进入驱动和日志，属于配置注入的入口。
   */
  #requireHost(value, field) {
    const host = this.#requireText(value, field, HOST_MAX);
    if (/\s/.test(host)) throw invalid(`${field}不能包含空白字符`);
    if (host.startsWith('/') || host.includes('://')) throw invalid(`${field}只能是主机名或 IP，不能是 URL 或 socket 路径`);
    if (!/^[a-zA-Z0-9._:-]+$/.test(host)) throw invalid(`${field}包含非法字符`);
    return host;
  }

  #requirePort(value, engine) {
    if (value === undefined || value === null || value === '') {
      return DEFAULT_PORTS[engine] ?? null;
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw invalid('端口必须是 1-65535 的整数');
    return port;
  }

  #requireEngine(engine) {
    if (!ENGINES.includes(engine)) throw invalid(`不支持的数据库类型：${engine}`);
    return engine;
  }

  #proxyId(value) {
    if (value === undefined || value === null || value === '' || value === 0) return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw invalid('代理 ID 非法');
    if (!this.db.prepare('SELECT 1 FROM db_proxies WHERE id=?').get(id)) throw invalid('指定的代理不存在');
    return id;
  }

  // ==================== 代理 CRUD ====================

  listProxies() {
    return this.db.prepare('SELECT * FROM db_proxies ORDER BY id').all().map((row) => this.#toProxy(row));
  }

  getProxy(id) {
    const row = this.db.prepare('SELECT * FROM db_proxies WHERE id=?').get(Number(id));
    if (!row) throw notFound('代理不存在');
    return this.#toProxy(row);
  }

  /** 带解密的完整代理配置，仅供内部建连使用，绝不直接回给 API。 */
  resolveProxy(id) {
    const row = this.db.prepare('SELECT * FROM db_proxies WHERE id=?').get(Number(id));
    if (!row) throw notFound('代理不存在');
    return {
      kind: row.kind,
      host: row.host,
      port: row.port,
      username: row.username || '',
      password: row.password ? this.decrypt(row.password) : '',
      serverId: row.server_id,
    };
  }

  #toProxy(row) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      host: row.host,
      port: row.port,
      username: row.username || '',
      // 只回 hasPassword，绝不回显明文或密文。
      hasPassword: Boolean(row.password),
      serverId: row.server_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createProxy(body = {}) {
    const name = this.#requireText(body.name, '代理名称', NAME_MAX);
    const kind = body.kind;
    if (!PROXY_KINDS.includes(kind)) throw invalid(`不支持的代理类型：${kind}`);

    let host = null;
    let port = null;
    let serverId = null;
    if (kind === 'ssh') {
      serverId = Number(body.serverId);
      if (!Number.isSafeInteger(serverId) || serverId <= 0) throw invalid('SSH 代理必须选择一台已保存的服务器');
    } else if (kind !== 'direct') {
      host = this.#requireHost(body.host, '代理主机');
      port = this.#requirePort(body.port, null);
    }
    const username = this.#optionalText(body.username, '代理用户名', USER_MAX);
    const password = this.#optionalText(body.password, '代理密码', SECRET_MAX);
    if ((username && !password) || (!username && password)) {
      throw invalid('代理用户名与密码必须同时填写或同时留空');
    }

    const now = Date.now();
    const info = this.db.prepare(`INSERT INTO db_proxies
      (name, kind, host, port, username, password, server_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, kind, host, port, username, this.encrypt(password), serverId, now, now);
    return this.getProxy(info.lastInsertRowid);
  }

  updateProxy(id, body = {}) {
    const current = this.db.prepare('SELECT * FROM db_proxies WHERE id=?').get(Number(id));
    if (!current) throw notFound('代理不存在');

    const name = body.name === undefined ? current.name : this.#requireText(body.name, '代理名称', NAME_MAX);
    const kind = body.kind === undefined ? current.kind : body.kind;
    if (!PROXY_KINDS.includes(kind)) throw invalid(`不支持的代理类型：${kind}`);

    let host = null;
    let port = null;
    let serverId = null;
    if (kind === 'ssh') {
      serverId = Number(body.serverId ?? current.server_id);
      if (!Number.isSafeInteger(serverId) || serverId <= 0) throw invalid('SSH 代理必须选择一台已保存的服务器');
    } else if (kind !== 'direct') {
      host = this.#requireHost(body.host ?? current.host, '代理主机');
      port = this.#requirePort(body.port ?? current.port, null);
    }
    const username = body.username === undefined
      ? (current.username || '')
      : this.#optionalText(body.username, '代理用户名', USER_MAX);
    // 密码缺省 = 保持原值；显式空串 = 清空。前端拿不到明文，必须这样区分。
    const password = body.password === undefined
      ? current.password
      : this.encrypt(this.#optionalText(body.password, '代理密码', SECRET_MAX));

    const now = Date.now();
    this.db.prepare(`UPDATE db_proxies SET name=?, kind=?, host=?, port=?, username=?,
      password=?, server_id=?, updated_at=? WHERE id=?`)
      .run(name, kind, host, port, username, password, serverId, now, Number(id));
    return this.getProxy(id);
  }

  deleteProxy(id) {
    const target = Number(id);
    if (!this.db.prepare('SELECT 1 FROM db_proxies WHERE id=?').get(target)) throw notFound('代理不存在');
    // 引用检查：静默把连接降级成直连会让运维在毫不知情的情况下直连生产库。
    const used = this.db.prepare('SELECT count(*) AS n FROM db_connections WHERE proxy_id=?').get(target);
    if (used.n > 0) throw invalid(`仍有 ${used.n} 个数据库连接使用该代理，请先解除引用`);
    this.db.prepare('DELETE FROM db_proxies WHERE id=?').run(target);
    return { ok: true };
  }

  // ==================== 连接 CRUD ====================

  listConnections() {
    return this.db.prepare('SELECT * FROM db_connections ORDER BY id').all()
      .map((row) => this.#toConnection(row));
  }

  getConnection(id) {
    const row = this.db.prepare('SELECT * FROM db_connections WHERE id=?').get(Number(id));
    if (!row) throw notFound('数据库连接不存在');
    return this.#toConnection(row);
  }

  /** 带解密的完整连接配置，仅供内部建连使用。 */
  resolveConnection(id) {
    const row = this.db.prepare('SELECT * FROM db_connections WHERE id=?').get(Number(id));
    if (!row) throw notFound('数据库连接不存在');
    let proxy = null;
    if (row.proxy_id) {
      try {
        proxy = this.resolveProxy(row.proxy_id);
      } catch (error) {
        if (error.code === 'notFound') throw invalid('该连接引用的代理已被删除，请重新配置');
        throw error;
      }
    }
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database_name || '',
      username: row.username || '',
      password: row.password ? this.decrypt(row.password) : '',
      readOnly: Boolean(row.read_only),
      proxy,
    };
  }

  #toConnection(row) {
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database_name || '',
      username: row.username || '',
      hasPassword: Boolean(row.password),
      proxyId: row.proxy_id,
      readOnly: Boolean(row.read_only),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createConnection(body = {}) {
    const name = this.#requireText(body.name, '连接名称', NAME_MAX);
    const engine = this.#requireEngine(body.engine);
    const host = this.#requireHost(body.host, '主机');
    const port = this.#requirePort(body.port, engine);
    const databaseName = this.#optionalText(body.database, '数据库名', DBNAME_MAX);
    if (engine !== 'redis' && !databaseName) throw invalid('数据库名不能为空');
    const username = this.#optionalText(body.username, '用户名', USER_MAX);
    const password = this.#optionalText(body.password, '密码', SECRET_MAX);
    const proxyId = this.#proxyId(body.proxyId);
    const readOnly = body.readOnly === undefined ? true : Boolean(body.readOnly);

    const now = Date.now();
    const info = this.db.prepare(`INSERT INTO db_connections
      (name, engine, host, port, database_name, username, password, proxy_id, read_only, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, engine, host, port, databaseName || null, username,
        this.encrypt(password), proxyId, readOnly ? 1 : 0, now, now);
    return this.getConnection(info.lastInsertRowid);
  }

  updateConnection(id, body = {}) {
    const current = this.db.prepare('SELECT * FROM db_connections WHERE id=?').get(Number(id));
    if (!current) throw notFound('数据库连接不存在');

    const name = body.name === undefined ? current.name : this.#requireText(body.name, '连接名称', NAME_MAX);
    const engine = body.engine === undefined ? current.engine : this.#requireEngine(body.engine);
    const host = body.host === undefined ? current.host : this.#requireHost(body.host, '主机');
    const port = body.port === undefined ? current.port : this.#requirePort(body.port, engine);
    const databaseName = body.database === undefined
      ? (current.database_name || '')
      : this.#optionalText(body.database, '数据库名', DBNAME_MAX);
    if (engine !== 'redis' && !databaseName) throw invalid('数据库名不能为空');
    const username = body.username === undefined
      ? (current.username || '')
      : this.#optionalText(body.username, '用户名', USER_MAX);
    // 密码缺省 = 保持原值；显式空串 = 清空。
    const password = body.password === undefined
      ? current.password
      : this.encrypt(this.#optionalText(body.password, '密码', SECRET_MAX));
    const proxyId = body.proxyId === undefined ? current.proxy_id : this.#proxyId(body.proxyId);
    const readOnly = body.readOnly === undefined ? Boolean(current.read_only) : Boolean(body.readOnly);

    const now = Date.now();
    this.db.prepare(`UPDATE db_connections SET name=?, engine=?, host=?, port=?, database_name=?,
      username=?, password=?, proxy_id=?, read_only=?, updated_at=? WHERE id=?`)
      .run(name, engine, host, port, databaseName || null, username, password,
        proxyId, readOnly ? 1 : 0, now, Number(id));
    return this.getConnection(id);
  }

  deleteConnection(id) {
    const target = Number(id);
    const info = this.db.prepare('DELETE FROM db_connections WHERE id=?').run(target);
    if (info.changes === 0) throw notFound('数据库连接不存在');
    return { ok: true };
  }

  // ==================== 审计 ====================

  /**
   * 记录一次数据库操作。
   *
   * 刻意不存 SQL 正文与结果集：审计的目的是回答「谁在什么时候动了哪个库、
   * 成功没有」，而不是复制一份生产数据。只留 sha256 便于「同一条语句被
   * 反复执行」这类异常模式的识别。
   */
  recordAudit(entry) {
    try {
      this.db.prepare(`INSERT INTO db_audit
        (connection_id, connection_name, tool, engine, status, sql_sha256, row_count, duration_ms, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.connectionId, entry.connectionName, entry.tool, entry.engine, entry.status,
          entry.sqlSha256 ?? null, entry.rowCount ?? null, entry.durationMs ?? null,
          entry.error ? String(entry.error).slice(0, 500) : null, Date.now());
    } catch {
      // 审计失败绝不能阻断业务——数据查询本身比日志重要。
    }
  }

  listAudit(limit = 100) {
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), 500)
      : 100;
    return this.db.prepare('SELECT * FROM db_audit ORDER BY id DESC LIMIT ?').all(safeLimit);
  }
}
