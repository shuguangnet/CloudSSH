// 数据库驱动层集成测试：直连 + 经 SOCKS5 代理两条路径，覆盖
// MySQL / MariaDB / PostgreSQL / Redis 四种引擎。
//
// 依赖真实数据库（测试脚本会跳过不可用的引擎），因为这一层的价值
// 就在于「真的能连上并把结果正确归一化」——用 mock 驱动测不出
// 协议协商、类型转换、超时语义这些真正会出问题的地方。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  queryDatabase, testConnection, describeSchema, describeTable,
  closeAll, isWriteStatement, MAX_ROWS,
} from '../../standalone/database-client.mjs';

// 测试用数据库地址（compose 里起的容器映射到这些端口）
const TARGETS = {
  postgres: { engine: 'postgres', host: '127.0.0.1', port: 15432, database: 'app', username: 'postgres', password: 'pgpass' },
  mysql: { engine: 'mysql', host: '127.0.0.1', port: 13306, database: 'app', username: 'root', password: 'mysqlpass' },
  redis: { engine: 'redis', host: '127.0.0.1', port: 16379, database: '0', username: '', password: 'redispass' },
};

/** 探测某个端口是否有服务监听，用来跳过不可用的引擎。 */
async function reachable(host, port) {
  try {
    const socket = netConnect({ host, port });
    await Promise.race([once(socket, 'connect'), delay(800).then(() => { throw new Error('timeout'); })]);
    socket.destroy();
    return true;
  } catch { return false; }
}

const available = {};
for (const [name, target] of Object.entries(TARGETS)) {
  available[name] = await reachable(target.host, target.port);
}
const skipUnless = (name) => (available[name] ? {} : { skip: `${name} 测试库不可用（127.0.0.1:${TARGETS[name].port}）` });

/** 极简 SOCKS5 服务端（无认证），用来验证代理路径真的打通到数据库。 */
async function startSocks5() {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const n = buffer[1];
        if (buffer.length < 2 + n) return;
        buffer = buffer.subarray(2 + n);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
        return;
      }
      if (stage !== 'request') return;
      if (buffer.length < 5) return;
      const atyp = buffer[3];
      let host; let offset;
      if (atyp === 0x01) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join('.');
        offset = 8;
      } else if (atyp === 0x03) {
        const len = buffer[4];
        if (buffer.length < 5 + len + 2) return;
        host = buffer.subarray(5, 5 + len).toString();
        offset = 5 + len;
      } else { socket.end(Buffer.from([0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const port = buffer.readUInt16BE(offset);
      const rest = buffer.subarray(offset + 2);
      socket.removeListener('data', onData);
      const upstream = netConnect({ host, port });
      upstream.on('connect', () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (rest.length) upstream.write(rest);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    };
    socket.on('data', onData);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { kind: 'socks5', host: '127.0.0.1', port: server.address().port, close: () => server.close() };
}

// ==================== 直连：PostgreSQL ====================

test('Postgres 直连查询返回列名与行数据', skipUnless('postgres'), async () => {
  const config = { id: 9001, ...TARGETS.postgres, readOnly: true };
  const result = await queryDatabase(config, 'SELECT id, name, email FROM users ORDER BY id');
  assert.deepEqual(result.columns, ['id', 'name', 'email']);
  assert.equal(result.rowCount, 2);
  assert.equal(result.rows[0].name, 'alice');
  assert.equal(result.rows[1].email, 'b@example.com');
  assert.ok(result.durationMs >= 0);
  await closeAll();
});

test('Postgres 参数化查询（$1 占位符）防止注入', skipUnless('postgres'), async () => {
  const config = { id: 9002, ...TARGETS.postgres, readOnly: true };
  const result = await queryDatabase(config, 'SELECT name FROM users WHERE name = $1', ['alice']);
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].name, 'alice');

  // 注入尝试应当查不到任何东西，而不是报语法错或被拼进 SQL。
  const injected = await queryDatabase(config, 'SELECT name FROM users WHERE name = $1', ["alice' OR '1'='1"]);
  assert.equal(injected.rowCount, 0);
  await closeAll();
});

test('Postgres 只读连接拒绝写语句（不发给数据库）', skipUnless('postgres'), async () => {
  const config = { id: 9003, ...TARGETS.postgres, readOnly: true };
  await assert.rejects(
    queryDatabase(config, "INSERT INTO users (name) VALUES ('hacker')"),
    (error) => error.code === 'readOnly',
  );
  // 确认真的没写进去。
  const check = await queryDatabase(config, "SELECT count(*) AS n FROM users WHERE name = 'hacker'");
  assert.equal(Number(check.rows[0].n), 0);
  await closeAll();
});

test('Postgres 写语句在关闭只读后可以执行，并清理现场', skipUnless('postgres'), async () => {
  const config = { id: 9004, ...TARGETS.postgres, readOnly: false };
  await queryDatabase(config, "INSERT INTO users (name) VALUES ('temp-write')");
  const found = await queryDatabase(config, "SELECT id FROM users WHERE name = 'temp-write'");
  assert.equal(found.rowCount, 1);
  await queryDatabase(config, "DELETE FROM users WHERE name = 'temp-write'");
  await closeAll();
});

test('Postgres 语法错误被归一化为 query 错误', skipUnless('postgres'), async () => {
  const config = { id: 9005, ...TARGETS.postgres, readOnly: true };
  await assert.rejects(
    queryDatabase(config, 'SELEC broken syntax'),
    (error) => error.code === 'query' && /syntax/i.test(error.message),
  );
  await closeAll();
});

test('Postgres 连接参数错误归类为 connect 错误', skipUnless('postgres'), async () => {
  const config = { id: 9006, ...TARGETS.postgres, password: 'wrong-password', readOnly: true };
  await assert.rejects(
    queryDatabase(config, 'SELECT 1'),
    (error) => error.code === 'connect' && !/wrong-password/.test(error.message),
  );
  await closeAll();
});

test('Postgres describeSchema 列出业务表', skipUnless('postgres'), async () => {
  const config = { id: 9007, ...TARGETS.postgres, readOnly: true };
  const schema = await describeSchema(config);
  assert.equal(schema.engine, 'postgres');
  const names = schema.tables.map((row) => row.name);
  assert.ok(names.includes('users'), `期望包含 users，实际：${names.join(',')}`);
  await closeAll();
});

test('Postgres describeTable 返回列定义', skipUnless('postgres'), async () => {
  const config = { id: 9008, ...TARGETS.postgres, readOnly: true };
  const columns = await describeTable(config, 'public', 'users');
  const names = columns.map((row) => row.column);
  assert.deepEqual(names, ['id', 'name', 'email', 'created_at']);
  await closeAll();
});

// ==================== 直连：MySQL ====================

test('MySQL 直连查询返回列名与行数据', skipUnless('mysql'), async () => {
  const config = { id: 9101, ...TARGETS.mysql, readOnly: true };
  const result = await queryDatabase(config, 'SELECT id, name, email FROM users ORDER BY id');
  assert.deepEqual(result.columns, ['id', 'name', 'email']);
  assert.equal(result.rowCount, 2);
  assert.equal(result.rows[0].name, 'alice');
  await closeAll();
});

test('MySQL 参数化查询使用 ? 占位符', skipUnless('mysql'), async () => {
  const config = { id: 9102, ...TARGETS.mysql, readOnly: true };
  const result = await queryDatabase(config, 'SELECT name FROM users WHERE name = ?', ['bob']);
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].name, 'bob');
  await closeAll();
});

test('MySQL 只读连接拒绝写语句', skipUnless('mysql'), async () => {
  const config = { id: 9103, ...TARGETS.mysql, readOnly: true };
  await assert.rejects(
    queryDatabase(config, "UPDATE users SET name = 'x' WHERE id = 1"),
    (error) => error.code === 'readOnly',
  );
  await closeAll();
});

test('MySQL describeSchema 列出业务表', skipUnless('mysql'), async () => {
  const config = { id: 9104, ...TARGETS.mysql, readOnly: true };
  const schema = await describeSchema(config);
  assert.equal(schema.engine, 'mysql');
  assert.ok(schema.tables.map((row) => row.name).includes('users'));
  await closeAll();
});

test('MySQL describeTable 返回列定义', skipUnless('mysql'), async () => {
  const config = { id: 9105, ...TARGETS.mysql, readOnly: true };
  const columns = await describeTable(config, 'app', 'users');
  assert.deepEqual(columns.map((row) => row.column), ['id', 'name', 'email']);
  await closeAll();
});

// ==================== 直连：Redis ====================

test('Redis 直连 GET / PING', skipUnless('redis'), async () => {
  const config = { id: 9201, ...TARGETS.redis, readOnly: true };
  const pong = await queryDatabase(config, 'PING');
  assert.equal(pong.rows[0].value, 'PONG');

  const value = await queryDatabase(config, 'GET greeting');
  assert.equal(value.rows[0].value, 'hello');
  await closeAll();
});

test('Redis 只读连接拒绝写命令', skipUnless('redis'), async () => {
  const config = { id: 9202, ...TARGETS.redis, readOnly: true };
  await assert.rejects(
    queryDatabase(config, 'SET greeting hacked'),
    (error) => error.code === 'readOnly',
  );
  const check = await queryDatabase(config, 'GET greeting');
  assert.equal(check.rows[0].value, 'hello', '被拒绝的命令不能真的执行');
  await closeAll();
});

test('Redis 也支持用参数数组传命令（避免空格歧义）', skipUnless('redis'), async () => {
  const config = { id: 9203, ...TARGETS.redis, readOnly: false };
  await queryDatabase(config, 'SET', ['SET', 'with space key', 'value with spaces']);
  const read = await queryDatabase(config, 'GET', ['GET', 'with space key']);
  assert.equal(read.rows[0].value, 'value with spaces');
  await queryDatabase(config, 'DEL', ['DEL', 'with space key']);
  await closeAll();
});

// ==================== 经 SOCKS5 代理 ====================

test('经 SOCKS5 代理连 Postgres 查询成功（代理层对驱动完全透明）', skipUnless('postgres'), async () => {
  const proxy = await startSocks5();
  try {
    const config = {
      id: 9301, ...TARGETS.postgres, readOnly: true,
      proxy: { kind: 'socks5', host: '127.0.0.1', port: proxy.port },
    };
    const result = await queryDatabase(config, 'SELECT name FROM users ORDER BY id');
    assert.equal(result.rowCount, 2);
    assert.equal(result.rows[0].name, 'alice');
    await closeAll();
  } finally { proxy.close(); }
});

test('经 SOCKS5 代理连 MySQL 查询成功', skipUnless('mysql'), async () => {
  const proxy = await startSocks5();
  try {
    const config = {
      id: 9302, ...TARGETS.mysql, readOnly: true,
      proxy: { kind: 'socks5', host: '127.0.0.1', port: proxy.port },
    };
    const result = await queryDatabase(config, 'SELECT name FROM users WHERE id = ?', [1]);
    assert.equal(result.rows[0].name, 'alice');
    await closeAll();
  } finally { proxy.close(); }
});

test('经 SOCKS5 代理连 Redis 查询成功', skipUnless('redis'), async () => {
  const proxy = await startSocks5();
  try {
    const config = {
      id: 9303, ...TARGETS.redis, readOnly: true,
      proxy: { kind: 'socks5', host: '127.0.0.1', port: proxy.port },
    };
    const result = await queryDatabase(config, 'GET greeting');
    assert.equal(result.rows[0].value, 'hello');
    await closeAll();
  } finally { proxy.close(); }
});

test('代理不可达时报告连接失败而不是挂起', skipUnless('postgres'), async () => {
  const config = {
    id: 9304, ...TARGETS.postgres, readOnly: true,
    // 1 号端口几乎肯定没人监听
    proxy: { kind: 'socks5', host: '127.0.0.1', port: 1 },
  };
  await assert.rejects(
    queryDatabase(config, 'SELECT 1'),
    (error) => error.code === 'connect',
  );
  await closeAll();
});

// ==================== testConnection ====================

test('testConnection 对可用库返回 ok（不执行任何业务 SQL）', skipUnless('postgres'), async () => {
  const result = await testConnection({ id: 9401, ...TARGETS.postgres, readOnly: true });
  assert.equal(result.ok, true);
  assert.ok(result.durationMs >= 0);
  assert.deepEqual(result.rows[0], { ok: 1 });
  await closeAll();
});

test('testConnection 对错误密码失败', skipUnless('mysql'), async () => {
  await assert.rejects(
    testConnection({ id: 9402, ...TARGETS.mysql, password: 'nope', readOnly: true }),
    (error) => error.code === 'connect' || error.code === 'query',
  );
  await closeAll();
});

// ==================== 配置变更使连接池失效 ====================

test('更改密码后旧连接池被弃用（不会一直用旧凭据重试）', skipUnless('postgres'), async () => {
  const good = { id: 9501, ...TARGETS.postgres, readOnly: true };
  assert.equal((await queryDatabase(good, 'SELECT 1 AS ok')).rowCount, 1);

  // 同一个 id 但密码变错 → 指纹变化 → 必须重建连接并失败。
  await assert.rejects(
    queryDatabase({ ...good, password: 'wrong' }, 'SELECT 1'),
    (error) => error.code === 'connect',
  );

  // 改回正确密码仍然可用（证明池没有被永久毒化）。
  assert.equal((await queryDatabase(good, 'SELECT 1 AS ok')).rowCount, 1);
  await closeAll();
});

test('结果集按 MAX_ROWS 截断', skipUnless('postgres'), async () => {
  const config = { id: 9502, ...TARGETS.postgres, readOnly: true };
  // generate_series 造出远超上限的行数
  const result = await queryDatabase(config, `SELECT generate_series(1, ${MAX_ROWS + 500}) AS n`);
  assert.equal(result.rows.length, MAX_ROWS, `行数必须被截断到 ${MAX_ROWS}`);
  assert.equal(result.rowCount, MAX_ROWS + 500, 'rowCount 保留真实总数，便于调用方知道被截断');
  await closeAll();
});

test('超长文本单元格被截断并留痕', skipUnless('postgres'), async () => {
  const config = { id: 9503, ...TARGETS.postgres, readOnly: true };
  const result = await queryDatabase(config, "SELECT repeat('x', 10000) AS blob");
  const value = result.rows[0].blob;
  assert.ok(value.length < 10000, '必须被截断');
  assert.match(value, /已截断/);
  await closeAll();
});

test('SQL 为空或超长时在进入驱动前被拒绝', async () => {
  await assert.rejects(queryDatabase({ id: 1, engine: 'postgres', readOnly: true }, ''), /SQL 不能为空/);
  await assert.rejects(queryDatabase({ id: 1, engine: 'postgres', readOnly: true }, 'x'.repeat(100001)), /SQL 过长/);
  await assert.rejects(
    queryDatabase({ id: 1, engine: 'postgres', readOnly: true }, 'SELECT 1', 'not-an-array'),
    /参数必须是数组/,
  );
});

test('isWriteStatement 在客户端层被 queryDatabase 真正执行（不只测函数）', async () => {
  // 不连库也能验证：只读 + 写语句必须在建连之前就被拒绝。
  const config = { id: 1, engine: 'postgres', host: '127.0.0.1', port: 1, readOnly: true };
  await assert.rejects(
    queryDatabase(config, 'DROP TABLE users'),
    (error) => error.code === 'readOnly',
    '写语句必须在建连之前就被拦下',
  );
});
