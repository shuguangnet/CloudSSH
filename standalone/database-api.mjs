// 数据库连接管理 HTTP API（自托管面板用）。
//
// 与 MCP 工具的分工：
//   - 这里的路由给人（浏览器面板）用，按登录用户鉴权 + 同源校验。
//   - MCP 工具给 Agent 用，按 token 的 db_connection_ids 鉴权。
// 两者操作同一份 database.sqlite，但不共享授权模型——面板登录用户能
// 「管理」全部连接（含改密码），MCP token 只能「使用」被点名授权的连接。

import { createHash } from 'node:crypto';
import { originAllowed } from './origin.mjs';
import { queryDatabase, testConnection, driverStatus, driverPackage } from './database-client.mjs';
import { ENGINES, DEFAULT_PORTS } from './database-store.mjs';

const json = (data, status = 200) => Response.json(data, { status });

/** 把 store 抛出的错误码映射成 HTTP 状态码。 */
function errorResponse(error) {
  const code = error?.code;
  const status = code === 'invalid' ? 400
    : code === 'notFound' ? 404
      : code === 'driverMissing' ? 501
        : code === 'readOnly' ? 403
          : code === 'query' || code === 'connect' ? 502
            : 500;
  return json({ error: error.message, code: code ?? 'error' }, status);
}

export function createDatabaseRoutes({ env, databaseStore, getAuthenticatedUser }) {
  const baseUrl = env.BASE_URL;
  return async function handleDatabase(request, pathname) {
    const user = await getAuthenticatedUser(request, env);
    if (!user) return json({ error: 'Authentication required' }, 401);

    // 写操作必须同源：否则任意站点都能借用户 cookie 改数据库配置。
    if (request.method !== 'GET') {
      if (!originAllowed(
        request.headers.get('Origin'), request.headers.get('Host'),
        request.headers.get('X-Forwarded-Host'), baseUrl,
      )) {
        return json({ error: 'Invalid origin' }, 403);
      }
    }

    // ---------- 驱动可用性（前端据此提示先装依赖） ----------
    if (pathname === '/api/db/drivers' && request.method === 'GET') {
      return json({
        engines: await driverStatus(),
        defaultPorts: DEFAULT_PORTS,
        supported: ENGINES,
      });
    }

    // ---------- 代理 ----------
    if (pathname === '/api/db/proxies' && request.method === 'GET') {
      return json({ proxies: databaseStore.listProxies() });
    }
    if (pathname === '/api/db/proxies' && request.method === 'POST') {
      const body = await readJson(request);
      if (body instanceof Response) return body;
      try { return json(databaseStore.createProxy(body), 201); }
      catch (error) { return errorResponse(error); }
    }
    const proxyMatch = pathname.match(/^\/api\/db\/proxies\/(\d+)$/);
    if (proxyMatch) {
      const id = Number(proxyMatch[1]);
      if (request.method === 'PATCH') {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        try { return json(databaseStore.updateProxy(id, body)); }
        catch (error) { return errorResponse(error); }
      }
      if (request.method === 'DELETE') {
        try { return json(databaseStore.deleteProxy(id)); }
        catch (error) { return errorResponse(error); }
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    // ---------- 连接 ----------
    if (pathname === '/api/db/connections' && request.method === 'GET') {
      return json({
        connections: databaseStore.listConnections(),
        proxies: databaseStore.listProxies(),
      });
    }
    if (pathname === '/api/db/connections' && request.method === 'POST') {
      const body = await readJson(request);
      if (body instanceof Response) return body;
      try { return json(databaseStore.createConnection(body), 201); }
      catch (error) { return errorResponse(error); }
    }

    const connectionMatch = pathname.match(/^\/api\/db\/connections\/(\d+)(\/test)?$/);
    if (connectionMatch) {
      const id = Number(connectionMatch[1]);
      const isTest = Boolean(connectionMatch[2]);

      if (isTest && request.method === 'POST') {
        // 「测试连接」先用请求体里的临时配置（表单还没保存也能测），
        // 没传就用已保存的配置。
        const body = await readJson(request, { optional: true });
        if (body instanceof Response) return body;
        let config;
        try {
          config = body && Object.keys(body).length > 0
            ? mergeUnsaved(databaseStore, id, body)
            : databaseStore.resolveConnection(id);
        } catch (error) { return errorResponse(error); }
        try {
          const result = await testConnection(config);
          return json({ ok: true, durationMs: result.durationMs, rows: result.rows });
        } catch (error) {
          // 测试失败是正常结果，不应报 5xx——前端要显示具体原因。
          return json({ ok: false, error: error.message, code: error.code ?? 'error' });
        }
      }

      if (request.method === 'PATCH') {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        try { return json(databaseStore.updateConnection(id, body)); }
        catch (error) { return errorResponse(error); }
      }
      if (request.method === 'DELETE') {
        try { return json(databaseStore.deleteConnection(id)); }
        catch (error) { return errorResponse(error); }
      }
      if (request.method === 'GET') {
        try { return json(databaseStore.getConnection(id)); }
        catch (error) { return errorResponse(error); }
      }
      return json({ error: 'Method not allowed' }, 405);
    }

    // ---------- 只读查询（面板里的 SQL 控制台） ----------
    if (pathname === '/api/db/query' && request.method === 'POST') {
      const body = await readJson(request);
      if (body instanceof Response) return body;
      const connectionId = Number(body.connection_id);
      if (!Number.isSafeInteger(connectionId) || connectionId <= 0) return json({ error: 'connection_id is required' }, 400);
      if (typeof body.sql !== 'string' || !body.sql.trim()) return json({ error: 'sql is required' }, 400);
      try {
        const config = databaseStore.resolveConnection(connectionId);
        const startedAt = Date.now();
        const result = await queryDatabase(config, body.sql, body.params ?? [], {
          timeoutMs: body.timeout_ms,
        });
        databaseStore.recordAudit({
          connectionId, connectionName: config.name, tool: 'db_query', engine: config.engine,
          status: 'succeeded', sqlSha256: sqlFingerprint(body.sql),
          rowCount: result.rowCount, durationMs: result.durationMs,
        });
        return json({
          columns: result.columns, rows: result.rows, rowCount: result.rowCount,
          returnedRows: result.rows.length, durationMs: result.durationMs,
          truncated: result.rowCount > result.rows.length,
          serverDurationMs: Date.now() - startedAt,
        });
      } catch (error) {
        try {
          const config = databaseStore.resolveConnection(connectionId);
          databaseStore.recordAudit({
            connectionId, connectionName: config.name, tool: 'db_query', engine: config.engine,
            status: 'failed', sqlSha256: sqlFingerprint(body.sql), error: error.message,
          });
        } catch { /* 连接本身不存在时无需审计 */ }
        return errorResponse(error);
      }
    }

    // ---------- 审计 ----------
    if (pathname === '/api/db/audit' && request.method === 'GET') {
      const limit = Number(new URL(request.url).searchParams.get('limit') || 100);
      return json({ audit: databaseStore.listAudit(limit) });
    }

    return json({ error: 'Not found' }, 404);
  };

}

/**
 * 表单里可能改了还没保存：用请求体覆盖已保存配置，但不落库。
 * 这样「测试连接」可以在保存前验证，避免把坏配置写进库。
 */
function mergeUnsaved(databaseStore, id, body) {
  const saved = databaseStore.resolveConnection(id);
  let proxy = saved.proxy;
  if (body.proxyId !== undefined) {
    const proxyId = body.proxyId === null || body.proxyId === '' ? null : Number(body.proxyId);
    proxy = proxyId ? databaseStore.resolveProxy(proxyId) : null;
  }
  return {
    ...saved,
    engine: body.engine ?? saved.engine,
    host: body.host ?? saved.host,
    port: body.port === undefined ? saved.port : Number(body.port),
    database: body.database ?? saved.database,
    username: body.username ?? saved.username,
    // 前端拿不到明文密码；只有用户真的输入了新密码才覆盖。
    password: typeof body.password === 'string' && body.password.length > 0 ? body.password : saved.password,
    proxy,
  };
}

/** 读取并校验 JSON body；非法时直接返回 400 Response。 */
async function readJson(request, { optional = false } = {}) {
  const text = await request.text();
  if (!text.trim()) {
    return optional ? {} : json({ error: 'Request body is required' }, 400);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }
  return parsed;
}

/** SQL 指纹：审计只留哈希，不留正文。 */
function sqlFingerprint(sql) {
  return createHash('sha256').update(String(sql)).digest('hex');
}
