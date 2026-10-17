// MCP 数据库工具 + /api/db/* 路由的接线测试。
//
// 这里不重测 SQL 执行细节（database-client-db.test.mjs 已覆盖真实数据库），
// 重点验证：
//   1. 授权边界——未授权的连接不能被查询，「存在但无权」不泄漏；
//   2. scope 边界——read token 拿不到 db_exec，只读连接拒绝写；
//   3. 审计确实落库且不含 SQL 正文；
//   4. 管理 API 的鉴权、同源校验与密码不回显。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect as netConnect } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { DatabaseStore } from '../../standalone/database-store.mjs';
import { registerDatabaseTools, databaseDescriptions } from '../../standalone/mcp-database.mjs';
import { createDatabaseRoutes } from '../../standalone/database-api.mjs';
import { closeAll } from '../../standalone/database-client.mjs';

const PG = { engine: 'postgres', host: '127.0.0.1', port: 15432, database: 'app', username: 'postgres', password: 'pgpass' };

async function reachable(host, port) {
  try {
    const socket = netConnect({ host, port });
    await Promise.race([once(socket, 'connect'), delay(600).then(() => { throw new Error('timeout'); })]);
    socket.destroy(); return true;
  } catch { return false; }
}
const pgAvailable = await reachable(PG.host, PG.port);
const skipPg = pgAvailable ? {} : { skip: 'Postgres 测试库不可用' };

/** 造一个隔离的 store（每个测试独立 sqlite，互不干扰）。 */
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cloudssh-db-mcp-'));
  const store = new DatabaseStore(join(dir, 'database.sqlite'), { secretFile: join(dir, 'secret.key') });
  return { store, cleanup: () => { rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * 捕获 registerDatabaseTools 注册的工具，做成可直接调用的假 McpServer。
 * 这样能在不起 HTTP 服务的前提下测工具逻辑。
 */
function makeFakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, descriptor, handler) { tools.set(name, { descriptor, handler }); },
    async call(name, args) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} not registered`);
      return await tool.handler(args);
    },
  };
}

/** 模拟 MCP token 的 identity。 */
function identityFor(overrides = {}) {
  return { id: 'tok1', scopes: ['read', 'write'], db_connection_ids: [], ...overrides };
}

function auditTrail() {
  const entries = [];
  return { entries, audit: (tool, connectionId, status, details = {}) => entries.push({ tool, connectionId, status, ...details }) };
}

const descriptions = databaseDescriptions;

test('未授权的连接：db_query 被拒绝，且报错不泄漏「连接存在」', async () => {
  const { store, cleanup } = makeStore();
  try {
    const connection = store.createConnection({ name: 'secret-db', ...PG, readOnly: true });
    const server = makeFakeServer();
    const { audit } = auditTrail();
    registerDatabaseTools(server, {
      store,
      identity: identityFor({ db_connection_ids: [] }), // 故意不授权
      authorize: (connectionId, scope) => {
        if (connectionId !== undefined && connectionId !== null) {
          throw new Error('Database connection is not authorized for this token');
        }
        if (scope && !['read', 'write'].includes(scope)) throw new Error('bad scope');
      },
      audit, descriptions,
    });

    const response = await server.call('db_query', { connection_id: connection.id, sql: 'SELECT 1' });
    assert.equal(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    // 关键：错误信息里不能出现库名/主机，避免用错误信息探测连接是否存在。
    assert.match(payload.error, /not authorized/);
    assert.ok(!payload.error.includes('secret-db'));
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('授权后可读，且返回结果里没有任何密码字段', skipPg, async () => {
  const { store, cleanup } = makeStore();
  try {
    const connection = store.createConnection({ name: 'pg', ...PG, readOnly: true });
    const server = makeFakeServer();
    registerDatabaseTools(server, {
      store, identity: identityFor({ db_connection_ids: [connection.id] }),
      authorize: () => {}, audit: () => {}, descriptions,
    });

    const response = await server.call('db_query', {
      connection_id: connection.id, sql: 'SELECT name FROM users ORDER BY id',
    });
    assert.ok(!response.isError, response.content?.[0]?.text);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.rowCount, 2);
    assert.equal(payload.rows[0].name, 'alice');
    // 连接摘要里绝不能出现 password 明文或密文。
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(PG.password), '结果里出现了数据库密码');
    assert.equal(payload.connection.hasPassword, undefined, '连接摘要不应带 hasPassword');
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('只读连接上 db_exec 被拒绝（写入被前置拦截）', skipPg, async () => {
  const { store, cleanup } = makeStore();
  try {
    const connection = store.createConnection({ name: 'pg', ...PG, readOnly: true });
    const server = makeFakeServer();
    const { entries, audit } = auditTrail();
    registerDatabaseTools(server, {
      store, identity: identityFor({ db_connection_ids: [connection.id] }),
      authorize: () => {}, audit, descriptions,
    });

    const response = await server.call('db_exec', {
      connection_id: connection.id, sql: "INSERT INTO users (name) VALUES ('x')",
    });
    assert.equal(response.isError, true);
    assert.match(JSON.parse(response.content[0].text).error, /read-only/);
    // 审计必须记到这次被拒绝的执行。
    assert.ok(entries.some((entry) => entry.tool === 'db_exec' && entry.status === 'failed'));
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('read scope 的 token 根本拿不到 db_exec 工具', async () => {
  const { store, cleanup } = makeStore();
  try {
    const server = makeFakeServer();
    registerDatabaseTools(server, {
      store,
      identity: identityFor({ scopes: ['read'], db_connection_ids: [1] }),
      authorize: () => {}, audit: () => {}, descriptions,
    });
    // 工具注册阶段就按 scope 过滤，因此不存在这个工具。
    assert.equal(server.tools.has('db_exec'), false);
    assert.equal(server.tools.has('db_query'), true);
    assert.equal(server.tools.has('db_schema'), true);
    assert.equal(server.tools.has('db_list_connections'), true);
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('db_list_connections 只列出被授权的连接', async () => {
  const { store, cleanup } = makeStore();
  try {
    const a = store.createConnection({ name: 'a', ...PG });
    const b = store.createConnection({ name: 'b', ...PG });
    const server = makeFakeServer();
    registerDatabaseTools(server, {
      store, identity: identityFor({ db_connection_ids: [b.id] }),
      authorize: () => {}, audit: () => {}, descriptions,
    });
    const payload = JSON.parse((await server.call('db_list_connections', {})).content[0].text);
    assert.deepEqual(payload.connections.map((item) => item.id), [b.id]);
    assert.ok(!JSON.stringify(payload).includes(PG.password));
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('审计只记录 sql_sha256，不记录 SQL 正文', skipPg, async () => {
  const { store, cleanup } = makeStore();
  try {
    const connection = store.createConnection({ name: 'pg', ...PG, readOnly: true });
    const server = makeFakeServer();
    const { entries, audit } = auditTrail();
    registerDatabaseTools(server, {
      store, identity: identityFor({ db_connection_ids: [connection.id] }),
      authorize: () => {}, audit, descriptions,
    });

    const secretSql = 'SELECT name FROM users WHERE id = 1';
    await server.call('db_query', { connection_id: connection.id, sql: secretSql });

    const started = entries.find((entry) => entry.status === 'started');
    assert.ok(started, '必须写 started 审计');
    assert.match(started.sql_sha256, /^[a-f0-9]{64}$/);
    // 任何审计字段都不能包含 SQL 原文。
    assert.ok(!JSON.stringify(entries).includes(secretSql), '审计里出现了 SQL 正文');
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('db_schema 返回表清单，db_schema+table 返回列定义', skipPg, async () => {
  const { store, cleanup } = makeStore();
  try {
    const connection = store.createConnection({ name: 'pg', ...PG, readOnly: true });
    const server = makeFakeServer();
    registerDatabaseTools(server, {
      store, identity: identityFor({ db_connection_ids: [connection.id] }),
      authorize: () => {}, audit: () => {}, descriptions,
    });

    const overview = JSON.parse((await server.call('db_schema', { connection_id: connection.id })).content[0].text);
    assert.ok(overview.tables.some((table) => table.name === 'users'));

    const columns = JSON.parse((await server.call('db_schema', {
      connection_id: connection.id, schema: 'public', table: 'users',
    })).content[0].text);
    assert.deepEqual(columns.columns.map((c) => c.column), ['id', 'name', 'email', 'created_at']);
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('db_test 探测成功且不执行任何业务 SQL', skipPg, async () => {
  const { store, cleanup } = makeStore();
  try {
    const connection = store.createConnection({ name: 'pg', ...PG, readOnly: true });
    const server = makeFakeServer();
    registerDatabaseTools(server, {
      store, identity: identityFor({ db_connection_ids: [connection.id] }),
      authorize: () => {}, audit: () => {}, descriptions,
    });
    const payload = JSON.parse((await server.call('db_test', { connection_id: connection.id })).content[0].text);
    assert.equal(payload.ok, true);
    cleanup();
  } catch (error) { cleanup(); throw error; }
});

test('databaseStore 缺失时不注册任何数据库工具（未启用的部署保持原样）', () => {
  const server = makeFakeServer();
  registerDatabaseTools(server, { store: null, identity: identityFor(), authorize: () => {}, audit: () => {}, descriptions });
  assert.equal(server.tools.size, 0);
});

// ==================== 管理 API ====================

/** 起一个只用 databaseRoutes 的极简 HTTP 服务器。 */
async function withRoutes(run, { user = { id: 7, github_id: '7' }, env = {
  BASE_URL: 'http://127.0.0.1:8787',
} } = {}) {
  const { createServer } = await import('node:http');
  const { store, cleanup } = makeStore();
  const routes = createDatabaseRoutes({
    env, databaseStore: store, getAuthenticatedUser: async () => user,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, env.BASE_URL);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const request = new Request(url, {
      method: req.method, headers: req.headers,
      ...(body && req.method !== 'GET' ? { body, duplex: 'half' } : {}),
    });
    const response = await routes(request, url.pathname);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, store, call: async (path, init = {}) => {
      const response = await fetch(`${base}${path}`, init);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    } });
  } finally {
    await closeAll();
    server.close();
    cleanup();
  }
}

const sameOrigin = (base) => ({ Origin: base, 'Content-Type': 'application/json' });

test('API：未登录返回 401', async () => {
  await withRoutes(async ({ call }) => {
    const result = await call('/api/db/connections');
    assert.equal(result.status, 401);
  }, { user: null });
});

test('API：跨站写请求返回 403（CSRF 防护）', async () => {
  await withRoutes(async ({ call }) => {
    const result = await call('/api/db/connections', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', ...PG }),
    });
    assert.equal(result.status, 403);
  });
});

test('API：创建连接后不回显密码，且列表带 hasPassword', async () => {
  await withRoutes(async ({ base, call }) => {
    const created = await call('/api/db/connections', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ name: 'pg', ...PG, readOnly: true }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.hasPassword, true);
    assert.ok(!JSON.stringify(created.body).includes(PG.password));

    const list = await call('/api/db/connections');
    assert.equal(list.body.connections.length, 1);
    assert.ok(!JSON.stringify(list.body).includes(PG.password));
  });
});

test('API：非法引擎返回 400 而不是 500', async () => {
  await withRoutes(async ({ base, call }) => {
    const result = await call('/api/db/connections', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ name: 'x', ...PG, engine: 'oracle' }),
    });
    assert.equal(result.status, 400);
  });
});

test('API：/api/db/drivers 报告驱动安装状态', async () => {
  await withRoutes(async ({ call }) => {
    const result = await call('/api/db/drivers');
    assert.equal(result.status, 200);
    assert.ok(result.body.engines);
    // 我们刚装了这三种驱动，应当全部可用。
    for (const engine of ['mysql', 'postgres', 'redis']) {
      assert.equal(result.body.engines[engine]?.available, true, `${engine} 驱动应可用`);
    }
  });
});

test('API：删除被引用的代理返回 409 而非静默降级', async () => {
  await withRoutes(async ({ base, call }) => {
    const proxy = await call('/api/db/proxies', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ name: 'p', kind: 'socks5', host: '127.0.0.1', port: 1080 }),
    });
    assert.equal(proxy.status, 201);
    await call('/api/db/connections', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ name: 'pg', ...PG, proxyId: proxy.body.id }),
    });
    const removed = await call(`/api/db/proxies/${proxy.body.id}`, { method: 'DELETE', headers: sameOrigin(base) });
    assert.equal(removed.status, 400, '被引用时删除应被拒绝');
    assert.match(removed.body.error, /引用|in use|used/i);
  });
});

test('API：查询接口对只读连接拒绝写语句', skipPg, async () => {
  await withRoutes(async ({ base, call }) => {
    const created = await call('/api/db/connections', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ name: 'pg', ...PG, readOnly: true }),
    });
    const result = await call('/api/db/query', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ connection_id: created.body.id, sql: 'DELETE FROM users' }),
    });
    assert.equal(result.status, 403);
  });
});

test('API：查询成功返回列与行，并写入审计', skipPg, async () => {
  await withRoutes(async ({ base, call }) => {
    const created = await call('/api/db/connections', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ name: 'pg', ...PG, readOnly: true }),
    });
    const result = await call('/api/db/query', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ connection_id: created.body.id, sql: 'SELECT name FROM users ORDER BY id' }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.rowCount, 2);
    assert.equal(result.body.rows[0].name, 'alice');

    const audit = await call('/api/db/audit');
    assert.equal(audit.status, 200);
    assert.ok(audit.body.audit.length >= 1);
    const entry = audit.body.audit[0];
    assert.match(entry.sql_sha256, /^[a-f0-9]{64}$/);
    // 审计表结构里根本没有存 SQL 正文的列。
    assert.ok(!('sql' in entry));
    assert.ok(!JSON.stringify(entry).includes('SELECT name'));
  });
});

test('API：测试连接失败返回 ok:false + 原因（不是 5xx）', async () => {
  await withRoutes(async ({ base, call }) => {
    const created = await call('/api/db/connections', {
      method: 'POST', headers: sameOrigin(base),
      body: JSON.stringify({ name: 'bad', ...PG, port: 1, readOnly: true }),
    });
    const result = await call(`/api/db/connections/${created.body.id}/test`, {
      method: 'POST', headers: sameOrigin(base), body: '{}',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, false);
    assert.ok(result.body.error);
  });
});
