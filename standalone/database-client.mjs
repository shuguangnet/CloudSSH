// 数据库驱动适配层。
//
// 统一把三种协议收敛成两个动作：
//   query(sql, params) -> { columns, rows, rowCount, durationMs }
//   exec(sql, params)  -> { rowCount, durationMs }
//
// 传输层统一走 net-proxy 的本地隧道：驱动只连 127.0.0.1:<临时端口>，
// 完全不知道背后是直连、SOCKS5、HTTP 代理还是 SSH 跳板。这样 MySQL 的
// SSL 协商、Postgres 的 TLS 升级、Redis 的 RESP 都只是字节流，天然可用。
//
// 驱动是可选依赖：没装 mysql2 时只有 MySQL 不可用，其它引擎照常工作，
// 错误信息直接告诉运维装哪个包，而不是让整个 MCP 服务起不来。

import { createHash } from 'node:crypto';

import { createTunnel } from './net-proxy.mjs';
import { createRedaction, redactValue } from './redact.mjs';
import { assessSql, isWriteCommand, isWriteStatement as isWriteStatementImpl } from './sql-safety.mjs';
import { DEFAULT_PORTS } from './database-store.mjs';

// 结果集上限：MCP 的输出要进模型上下文，必须硬性截断，
// 否则一条 SELECT * 就能把上下文打爆。
export const MAX_ROWS = 200;
export const MAX_CELL_CHARS = 4096;
export const MAX_COLUMNS = 100;
const CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
export const MAX_QUERY_TIMEOUT_MS = 120000;
// 隧道在最后一次使用后保留一小段时间，避免每次查询都重新握手。
const TUNNEL_REUSE_MS = 30000;

/**
 * TCP keepalive 探活间隔。
 *
 * 数据库连接常被 NAT/防火墙在空闲时静默丢弃：两端都没收到 FIN，驱动
 * 以为连接还在，下一次查询才发现已经死了。内核 keepalive 让对端在空闲期
 * 就能暴露断连，而不是等到用户踩上去。
 */
const TCP_KEEPALIVE_MS = 30000;

/**
 * 池里连接空闲超过这个时长，复用前先 ping 一次。
 *
 * 30s 与隧道复用窗口对齐：隧道都回收了，池里的 socket 就没道理可靠。
 * 低于这个阈值的复用不 ping，否则每条查询都多一个往返。
 */
const PING_AFTER_IDLE_MS = 30000;

/** 拆除操作（pool.end / rollback）的硬上限，防止死传输上永久挂起。 */
const TEARDOWN_TIMEOUT_MS = 5000;

export { PING_AFTER_IDLE_MS, TCP_KEEPALIVE_MS, TEARDOWN_TIMEOUT_MS };

const error = (message, code = 'query') => Object.assign(new Error(message), { code });

// ==================== 驱动加载 ====================

const DRIVER_PACKAGES = {
  mysql: 'mysql2',
  mariadb: 'mysql2',
  postgres: 'pg',
  redis: 'ioredis',
};

/** 引擎 → 需要的 npm 包，供错误信息与文档使用。 */
export function driverPackage(engine) {
  return DRIVER_PACKAGES[engine] ?? null;
}

/**
 * 按需 import 驱动。返回 null 表示未安装——调用方必须给出可执行的提示，
 * 而不是抛一个 ENOENT 让运维去猜。
 */
async function loadDriver(engine) {
  const name = DRIVER_PACKAGES[engine];
  if (!name) throw error(`不支持的数据库类型：${engine}`, 'invalid');
  try {
    // mysql2 有回调版与 promise 版两个入口；这里必须用 promise 版，
    // 否则 pool.query() 返回非 Promise，await 会直接抛编程错误。
    if (name === 'mysql2') {
      const module = await import('mysql2/promise');
      return module.default ?? module;
    }
    const module = await import(name);
    return module.default ?? module;
  } catch (cause) {
    throw error(
      `缺少 ${engine} 驱动，请先安装：pnpm add ${name}（或 npm i ${name}）`,
      'driverMissing',
    );
  }
}

/** 供 /api/db/drivers 与前端选择器使用，不暴露内部实现。 */
export async function driverStatus() {
  const result = {};
  for (const engine of Object.keys(DRIVER_PACKAGES)) {
    const name = DRIVER_PACKAGES[engine];
    // 探测时必须和 loadDriver 用同一个入口：mysql2 的 promise 版是
    // 子路径，只 import 'mysql2' 不能证明 await query() 能用。
    const specifier = name === 'mysql2' ? 'mysql2/promise' : name;
    try {
      await import(specifier);
      result[engine] = { engine, package: name, available: true };
    } catch (cause) {
      result[engine] = { engine, package: name, available: false, error: String(cause?.message ?? cause) };
    }
  }
  return result;
}

// ==================== 连接与隧道管理 ====================

/**
 * 连接池缓存：按「连接 ID + 配置指纹」索引。
 *
 * 配置一改（换库、换密码、换代理），指纹就变，旧池自然被弃用并关闭。
 * 这是最省心的缓存失效策略——不需要在更新路径里做任何手工失效。
 */
const pools = new Map();

/** 配置指纹：包含所有影响连通的字段，但不含密码明文。 */
function fingerprint(config) {
  const proxyKey = config.proxy
    ? `${config.proxy.kind}:${config.proxy.host ?? ''}:${config.proxy.port ?? ''}:${config.proxy.serverId ?? ''}`
    : 'direct';
  const hash = createHash('sha256');
  hash.update([
    config.engine, config.host, String(config.port), config.database ?? '',
    config.username ?? '', config.password ?? '', proxyKey,
  ].join('\u0000'));
  return hash.digest('hex');
}

async function createTunnelFor(config) {
  return await createTunnel(
    { host: config.host, port: config.port },
    config.proxy ?? null,
    { timeoutMs: CONNECT_TIMEOUT_MS, idleTimeoutMs: TUNNEL_REUSE_MS },
  );
}

/**
 * 真正建立物理连接。
 *
 * 每个引擎拿到的是「隧道端口 + 原始凭据」，驱动自己完成协议握手。
 * 返回值统一为 { run(sql, params), close() }，其中 run 已经做了
 * 超时与错误归一化。
 */
async function connectEngine(config) {
  const driver = await loadDriver(config.engine);
  if (config.engine === 'postgres') return connectPostgres(driver, config);
  if (config.engine === 'redis') return connectRedis(driver, config);
  return connectMysql(driver, config);
}

async function connectMysql(driver, config) {
  const tunnel = await createTunnelFor(config);
  const pool = driver.createPool({
    host: tunnel.host,
    port: tunnel.port,
    user: config.username || undefined,
    password: config.password || undefined,
    database: config.database || undefined,
    // MySQL 8 默认 caching_sha2_password；不开这个参数会在很多现网实例上失败。
    waitForConnections: true,
    connectionLimit: 4,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // NAT/防火墙空闲丢流：开 TCP keepalive，让死连接在空闲期就暴露。
    enableKeepAlive: true,
    keepAliveInitialDelay: TCP_KEEPALIVE_MS,
    // 多语句关闭：一条 query 里塞 ;DROP 是最容易被忽略的注入面。
    multipleStatements: false,
    // 让 mysql2 把 DECIMAL/BIGINT 以字符串返回，避免 JS 精度丢失后
    // 报表数字被悄悄改掉。
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
  });
  return {
    async run(sql, params, timeoutMs, redaction) {
      const [result, fields] = await withTimeout(
        pool.query({ sql, values: params, timeout: timeoutMs }),
        timeoutMs, '查询',
      );
      if (Array.isArray(result)) {
        return {
          columns: (fields ?? []).map((field) => field.name).slice(0, MAX_COLUMNS),
          rows: normalizeRows(result, fields, redaction),
          rowCount: result.length,
        };
      }
      return {
        columns: [],
        rows: [],
        rowCount: Number(result?.affectedRows ?? 0),
        affectedRows: Number(result?.affectedRows ?? 0),
      };
    },
    async ping() {
      await withTimeout(pool.query('SELECT 1'), TEARDOWN_TIMEOUT_MS, '心跳');
    },
    async close() {
      tunnel.close();
      // pool.end() 在死传输上会等一个永不回来的 FIN，必须给它设死线：
      // 否则一次断连就能把进程里的连接池永久挂住。
      await boundedTeardown(() => pool.end(), () => { try { pool.pool?._allConnections?.forEach((c) => c.destroy()); } catch { /* 已销毁 */ } });
    },
  };
}

async function connectPostgres(driver, config) {
  const tunnel = await createTunnelFor(config);
  const pool = new driver.Pool({
    host: tunnel.host,
    port: tunnel.port,
    user: config.username || undefined,
    password: config.password || undefined,
    database: config.database || undefined,
    max: 4,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: TUNNEL_REUSE_MS,
    // 同 MySQL：内核 keepalive 防 NAT 静默丢流。
    keepAlive: true,
    keepAliveInitialDelayMillis: TCP_KEEPALIVE_MS,
    // 只读连接的强约束在服务端，不在驱动：见 applyReadOnly()。
  });
  pool.on('error', () => { /* 空闲连接异常不能让进程崩掉 */ });
  return {
    async run(sql, params, timeoutMs, redaction) {
      const client = await pool.connect();
      try {
        // statement_timeout 是 Postgres 侧的唯一可靠超时：客户端 abort 之后
        // 服务端仍可能继续跑完整个慢查询。
        await client.query(`SET statement_timeout = ${Math.trunc(timeoutMs)}`);
        const result = await withTimeout(client.query({ text: sql, values: params }), timeoutMs, '查询');
        const rows = normalizeRows(result.rows ?? [], null, redaction);
        return {
          columns: (result.fields ?? []).map((field) => field.name).slice(0, MAX_COLUMNS),
          rows,
          rowCount: result.rowCount ?? rows.length,
        };
      } finally {
        client.release();
      }
    },
    async ping() {
      const client = await withTimeout(pool.connect(), TEARDOWN_TIMEOUT_MS, '心跳');
      try { await withTimeout(client.query('SELECT 1'), TEARDOWN_TIMEOUT_MS, '心跳'); }
      finally { client.release(); }
    },
    async close() {
      tunnel.close();
      await boundedTeardown(() => pool.end(), () => { try { pool._clients?.forEach((c) => c.end?.()); } catch { /* 已销毁 */ } });
    },
  };
}

async function connectRedis(driver, config) {
  const tunnel = await createTunnelFor(config);
  const Redis = driver;
  const client = new Redis({
    host: tunnel.host,
    port: tunnel.port,
    username: config.username || undefined,
    password: config.password || undefined,
    db: Number(config.database || 0) || 0,
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    // 失败就失败，不要无限重连把 MCP 请求挂死。
    retryStrategy: () => null,
  });
  client.on('error', () => { /* 由每次调用自行处理 */ });
  await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'Redis 连接');
  return {
    async run(sql, params, timeoutMs, redaction) {
      // Redis 没有 SQL，两种传法：
      //   1) 一行命令：`GET user:1`（按空白切分，够用且最直观）
      //   2) params 直接传数组：['SET', 'key with space', 'value']
      //      —— 参数里含空格/引号时必须用这种，否则会被切错。
      const parts = Array.isArray(params) && params.length > 0
        ? params
        : String(sql).trim().split(/\s+/);
      if (parts.length === 0) throw error('Redis 命令不能为空', 'invalid');
      const [command, ...args] = parts.map((part) => String(part));
      const result = await withTimeout(client.call(command, ...args), timeoutMs, 'Redis 命令');
      const rows = Array.isArray(result)
        ? result.map((value, index) => ({ index, value: renderRedisValue(value) }))
        : [{ value: renderRedisValue(result) }];
      const shaped = rows.slice(0, MAX_ROWS).map((row) => (
        redaction ? { ...row, value: clampCell(row.value, redaction) } : row
      ));
      return { columns: ['value'], rows: shaped, rowCount: rows.length };
    },
    async ping() {
      await withTimeout(client.ping(), TEARDOWN_TIMEOUT_MS, '心跳');
    },
    async close() {
      tunnel.close();
      // disconnect() 同步拆 socket，不会挂；用 quit() 优雅关闭反而可能等不到应答。
      try { client.disconnect(); } catch { /* 已关闭 */ }
    },
  };
}

function renderRedisValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// ==================== 结果归一化 ====================

/** 把任意行数据转成「可 JSON 序列化、可进模型上下文」的纯对象。 */
function normalizeRows(rows, fields, redaction) {
  if (!Array.isArray(rows)) return [];
  const names = Array.isArray(fields) ? fields.map((field) => field.name) : null;
  return rows.slice(0, MAX_ROWS).map((row) => {
    // mysql2 返回数组（取决于 rowAsArray）或对象；Postgres 一直是对象。
    if (Array.isArray(row)) {
      const keys = names ?? row.map((_value, index) => `col_${index}`);
      const object = {};
      keys.slice(0, MAX_COLUMNS).forEach((key, index) => {
        object[key] = clampCell(row[index], redaction);
      });
      return object;
    }
    const object = {};
    for (const key of Object.keys(row).slice(0, MAX_COLUMNS)) object[key] = clampCell(row[key], redaction);
    return object;
  });
}

/**
 * 单元格裁剪：Buffer 转字符串、日期转 ISO、超大文本截断并标注。
 * 截断必须留痕，否则运维会以为字段本来就是短的。
 *
 * **脱敏必须在截断之前**：PEM 私钥块的模式以 `-----END ... -----` 结尾，
 * 先截断会让尾部标记消失、模式失配，于是超长私钥**整段原样返回**——
 * 这是实测过的泄漏路径，不是理论风险。所以顺序固定为
 * 「转成字符串 → 脱敏 → 截断」。
 *
 * @param {unknown} value
 * @param {{redact: (value: unknown) => unknown}} [redaction]
 */
function clampCell(value, redaction) {
  if (value === null || value === undefined) return null;
  let text;
  if (Buffer.isBuffer(value)) {
    text = value.toString('utf8');
    if (value.length > MAX_CELL_CHARS && !redaction) {
      return `${value.subarray(0, MAX_CELL_CHARS).toString('utf8')}…[已截断，共 ${value.length} 字节]`;
    }
  } else if (value instanceof Date) {
    return value.toISOString();
  } else if (typeof value === 'bigint') {
    return value.toString();
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    return value;
  }

  // 先脱敏：此时 text 是完整内容，PEM 尾标记还在。
  const safe = redaction ? String(redaction.redact(text)) : text;
  if (safe.length > MAX_CELL_CHARS) {
    const unit = Buffer.isBuffer(value) ? '字节' : '字符';
    const total = Buffer.isBuffer(value) ? value.length : safe.length;
    return `${safe.slice(0, MAX_CELL_CHARS)}…[已截断，共 ${total} ${unit}]`;
  }
  return safe;
}

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (cause) => { clearTimeout(timer); reject(cause); },
    );
  });
}

/**
 * 有界拆除：给拆除动作设死线，超时则执行强制回收。
 *
 * `pool.end()` / `pool.quit()` 会等每一个已检出的客户端归还，而归还依赖
 * socket 上的 FIN。传输死后那个 FIN 永远不会来，拆除就永久挂住——连带
 * 把整个进程里的那个池子留在半死状态。所以这里一律认为「拆除可能不返回」，
 * 超过 TEARDOWN_TIMEOUT_MS 就调 force 把 socket 强拆。
 *
 * 拆除失败不向上抛：调用方在清理路径上，没有比「已经尽力了」更好的结果。
 *
 * @param {() => Promise<unknown>} teardown
 * @param {() => void} [force]
 */
async function boundedTeardown(teardown, force) {
  try {
    await withTimeout(Promise.resolve().then(teardown), TEARDOWN_TIMEOUT_MS, '关闭连接');
  } catch {
    try { force?.(); } catch { /* 已经拆干净了 */ }
  }
}

// ==================== 只读保护 ====================

/**
 * 写语句识别。
 *
 * 判定逻辑在 sql-safety.mjs 里做真正的词法扫描——正则版曾经放过
 * `WITH x AS (DELETE ...) SELECT`、`SELECT ... INTO OUTFILE`、
 * MySQL 可执行版本注释与注释拆词，只读连接名存实亡。
 *
 * 数据库侧的只读账号仍然是**真正的**安全边界，这里只是让「只读开关」
 * 对得起它的名字。
 *
 * @param {string} sql
 * @param {{engine?: string}} options
 */
export function isWriteStatement(sql, options = {}) {
  return isWriteStatementImpl(sql, options);
}

// ==================== 对外 API ====================

/**
 * 取得（并缓存）某个连接的可用客户端。
 *
 * 缓存命中不等于能用：连接可能被 NAT 或服务端的空闲回收静默弄死，
 * 两端都没收到 FIN。所以空闲超过 PING_AFTER_IDLE_MS 时先探一下，
 * 探活失败就丢掉重建——让用户看到「刚刚卡了一下」而不是「连接已失效」。
 *
 * @param {object} config resolveConnection() 的结果
 */
async function acquire(config) {
  const key = `${config.id}:${fingerprint(config)}`;
  const cached = pools.get(key);
  if (cached && !cached.broken) {
    const idleMs = Date.now() - cached.lastUsed;
    if (idleMs <= PING_AFTER_IDLE_MS) return cached;
    // 长时间空闲：先 ping。时间阈值的意义就是避免每条查询都多一个往返。
    try {
      await cached.client.ping();
      cached.lastUsed = Date.now();
      return cached;
    } catch (cause) {
      // 探活失败就是死了：整条隧道都不再可信（可能换成别的库了），
      // 重建而不是只换池。
      invalidate(key, cached);
      throw error(`空闲 ${Math.round(idleMs / 1000)}s 后的连接已不响应心跳（${cause?.message ?? cause}）`, 'connect');
    }
  }

  const client = await connectEngine(config);
  const entry = {
    client,
    broken: false,
    lastUsed: Date.now(),
  };
  pools.set(key, entry);
  return entry;
}

/** 连接失败时把缓存标记为坏的，下次请求会重建（而不是一直用坏连接）。 */
function invalidate(key, entry) {
  if (pools.get(key) === entry) {
    entry.broken = true;
    pools.delete(key);
    // 不 await：清理不能阻塞当前请求。close() 自身已经是有界的。
    void entry.client.close().catch(() => {});
  }
}

/** 关闭所有池，用于进程退出与测试。 */
export async function closeAll() {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(entries.map(async (entry) => {
    try { await entry.client.close(); } catch { /* 已关闭 */ }
  }));
}

/**
 * 执行一次查询，返回裁剪后的结果。
 *
 * @param {object} config resolveConnection() 的结果
 * @param {string} sql SQL（或 Redis 命令）
 * @param {Array} params 参数
 * @param {{readOnly?:boolean, timeoutMs?:number, allowWrite?:boolean}} [options]
 */
export async function queryDatabase(config, sql, params = [], options = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw error('SQL 不能为空', 'invalid');
  if (sql.length > 100000) throw error('SQL 过长（上限 100000 字符）', 'invalid');
  if (!Array.isArray(params)) throw error('参数必须是数组', 'invalid');

  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs) || DEFAULT_QUERY_TIMEOUT_MS, 1000),
    MAX_QUERY_TIMEOUT_MS,
  );

  // 只读连接 + 写语句 = 直接拒绝，不发给数据库。
  // options.internal 只给本模块的元数据查询（information_schema）用：
  // 那些 SELECT 对用户来说必须是不可见的实现细节，不能让调用方
  // 通过 readOnly:false 把任意写语句送进只读连接。
  const readOnly = options.internal ? false : (config.readOnly ?? true);
  if (readOnly) {
    const reason = config.engine === 'redis'
      ? (isWriteCommand(sql) ? '只读连接拒绝执行写命令。如确需写入，请关闭该连接的「只读」开关。' : null)
      : assessSql(sql);
    if (reason) throw error(reason, 'readOnly');
  }

  const key = `${config.id}:${fingerprint(config)}`;
  let entry;
  try {
    entry = await acquire(config);
  } catch (cause) {
    // 连接阶段失败（DNS/代理/认证）归类为 connect，便于路由层区分状态码。
    if (cause.code === 'invalid' || cause.code === 'driverMissing') throw cause;
    throw error(`连接数据库失败：${cause.message}`, 'connect');
  }

  const startedAt = Date.now();
  try {
    // 脱敏器传进 run()，因为**脱敏必须发生在截断之前**：先截断会让 PEM
    // 尾标记消失、私钥模式失配，超长私钥就会整段泄漏。
    const redaction = createRedaction();
    const result = await entry.client.run(sql, params, timeoutMs, redaction);
    entry.lastUsed = Date.now();
    return {
      ...result,
      ...(redaction.count > 0 ? { redactedCells: redaction.count } : {}),
      durationMs: Date.now() - startedAt,
    };
  } catch (cause) {
    // 建连后的错误里，凡属于「拿不到可用会话」的都归 connect，其余归 query。
    // 认证失败在不同驱动里表现差别很大（PG 在 pool.connect() 抛、
    // MySQL 在首次 query 抛），统一在这里按错误语义分流，调用方看到的
    // 状态码才稳定。
    if (isConnectionLoss(cause)) invalidate(key, entry);
    const code = isConnectFailure(cause) ? 'connect' : 'query';
    throw error(sanitizeError(cause), code);
  }
}

/**
 * 判断错误是否说明「连接已经不可用」。
 *
 * 只有这类错误才值得丢弃连接池；语法错误、权限错误重连一百次也没用，
 * 反而会掩盖真正的问题。
 */
function isConnectionLoss(cause) {
  const code = String(cause?.code ?? '');
  const message = String(cause?.message ?? '');
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'].includes(code)) return true;
  if (code === '57P01' || code === '08006' || code === '08003') return true; // Postgres 断连族
  return /server closed the connection|Connection terminated|connection is closed|Client has encountered a connection error/i.test(message);
}

/**
 * 判断错误是否属于「建连/认证失败」。
 *
 * 和 isConnectionLoss 的区别：那个判断的是「已有连接坏了」，这个判断
 * 的是「压根没连上」。两者都会导致丢弃连接池，但返回给调用方的语义不同
 * ——前者是查询失败，后者应该提示用户检查配置。
 */
function isConnectFailure(cause) {
  const code = String(cause?.code ?? '');
  const message = String(cause?.message ?? '');
  // 认证/权限类
  if (['28P01', '28000', '42501', 'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(code)) return true;
  if (code === 'NOAUTH' || code === 'WRONGPASS') return true;
  if (/password authentication failed|Access denied for user|authentication failed|no password supplied|role .* does not exist|database .* does not exist|Unknown database/i.test(message)) return true;
  // 网络/解析类
  if (isConnectionLoss(cause)) return true;
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|connect ECONNREFUSED|Connection refused|timeout expired|ETIMEDOUT/i.test(message)) return true;
  return false;
}

/**
 * 错误脱敏：驱动的错误信息里经常带连接串（含密码）。
 * 返回给 MCP / HTTP 的错误必须去掉这段。
 */
function sanitizeError(cause) {
  let message = String(cause?.message ?? cause ?? '未知错误');
  // mysql://user:pass@host/db 与 postgres://... 形态
  message = message.replace(/([a-z+]+:\/\/[^:@\s]+):([^@\s]+)@/gi, '$1:***@');
  // password=xxx / password: xxx
  message = message.replace(/(password\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***');
  // 兜底：截断，避免驱动把整条 SQL 或凭据打进日志
  return message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
}

/**
 * 探测连接是否可用（连通性 + 认证），供「测试连接」按钮使用。
 * 不执行任何业务 SQL：MySQL/PG 用最小代价的探针，Redis 用 PING。
 */
export async function testConnection(config) {
  const startedAt = Date.now();
  const probe = config.engine === 'redis'
    ? 'PING'
    : config.engine === 'postgres' ? 'SELECT 1 AS ok' : 'SELECT 1 AS ok';
  const result = await queryDatabase(config, probe, [], { timeoutMs: CONNECT_TIMEOUT_MS + 5000, internal: true });
  return {
    ok: true,
    durationMs: Date.now() - startedAt,
    columns: result.columns,
    rows: result.rows.slice(0, 5),
    version: null,
  };
}

/** 列出库中的 schema，帮助 MCP 客户端在不猜表结构的情况下工作。 */
export async function describeSchema(config, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  if (config.engine === 'redis') {
    // Redis 没有 schema；给一个 keyspace 概览（只读 INFO 里的一段）。
    const info = await queryDatabase(config, 'INFO keyspace', [], { timeoutMs, internal: true });
    return {
      engine: 'redis',
      tables: [],
      note: 'Redis 没有表结构，可用 INFO keyspace 查看各 db 的键数量。',
      raw: info.rows,
    };
  }

  if (config.engine === 'postgres') {
    const result = await queryDatabase(config, `
      SELECT table_schema AS schema, table_name AS name, table_type AS type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
      LIMIT ${MAX_ROWS}`, [], { timeoutMs, internal: true });
    return { engine: 'postgres', tables: result.rows, rowCount: result.rowCount };
  }

  // MySQL / MariaDB
  const result = await queryDatabase(config, `
    SELECT table_schema AS \`schema\`, table_name AS name, table_type AS type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
    ORDER BY table_schema, table_name
    LIMIT ${MAX_ROWS}`, [], { timeoutMs, internal: true });
  return { engine: config.engine, tables: result.rows, rowCount: result.rowCount };
}

/** 某个表的列定义，供生成 SQL 时参考。 */
export async function describeTable(config, schema, table) {
  const name = String(table || '').trim();
  if (!name) throw error('表名不能为空', 'invalid');
  if (config.engine === 'postgres') {
    const result = await queryDatabase(config, `
      SELECT column_name AS column, data_type AS type, is_nullable AS nullable,
             column_default AS default_value
      FROM information_schema.columns
      WHERE table_name = $1 AND ($2 = '' OR table_schema = $2)
      ORDER BY ordinal_position`, [name, String(schema || '')], { internal: true });
    return result.rows;
  }
  if (config.engine === 'redis') throw error('Redis 没有表结构', 'invalid');
  const result = await queryDatabase(config, `
    SELECT column_name AS \`column\`, column_type AS type, is_nullable AS nullable,
           column_default AS default_value, column_key AS key_type
    FROM information_schema.columns
    WHERE table_name = ? AND (? = '' OR table_schema = ?)
    ORDER BY ordinal_position`, [name, String(schema || ''), String(schema || '')], { internal: true });
  return result.rows;
}

export { DEFAULT_PORTS, DEFAULT_QUERY_TIMEOUT_MS };
