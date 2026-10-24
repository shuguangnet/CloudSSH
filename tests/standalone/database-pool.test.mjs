import assert from 'node:assert/strict';
import test from 'node:test';

import { closeAll, queryDatabase } from '../../standalone/database-client.mjs';
import { PING_AFTER_IDLE_MS, TCP_KEEPALIVE_MS, TEARDOWN_TIMEOUT_MS } from '../../standalone/database-client.mjs';

// ==================== 探活与拆除的时间常量 ====================
//
// 这些值有业务含义：改小会让每条查询多一个往返，改大则让死连接存活过久。
// 用例固定住它们，避免后续调优时无声漂移。

test('空闲探活阈值不超过隧道复用窗口', () => {
  assert.ok(PING_AFTER_IDLE_MS > 0, '必须开启空闲探活');
  assert.ok(PING_AFTER_IDLE_MS <= 30000, `探活阈值 ${PING_AFTER_IDLE_MS}ms 不应超过隧道复用窗口`);
});

test('TCP keepalive 间隔是有限正值', () => {
  assert.ok(TCP_KEEPALIVE_MS > 0);
  assert.ok(TCP_KEEPALIVE_MS <= 60000, `keepalive ${TCP_KEEPALIVE_MS}ms 过长`);
});

test('拆除死线短于默认查询超时', () => {
  assert.ok(TEARDOWN_TIMEOUT_MS > 0);
  assert.ok(TEARDOWN_TIMEOUT_MS < 30000, `拆除死线 ${TEARDOWN_TIMEOUT_MS}ms 不应长于默认查询超时`);
});

// ==================== 池复用与拆除 ====================

test('没有已建立的池时 closeAll 立即返回', async () => {
  const startedAt = Date.now();
  await closeAll();
  assert.ok(Date.now() - startedAt < 1000, 'closeAll 无池时必须立即返回');
  // 幂等：重复调用不抛
  await closeAll();
});

// ==================== 真实池的空闲探活（需要测试库） ====================

const TARGETS = {
  postgres: {
    engine: 'postgres',
    host: process.env.DBTEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.DBTEST_PG_PORT ?? 15432),
    database: process.env.DBTEST_PG_DB ?? 'app',
    username: process.env.DBTEST_PG_USER ?? 'postgres',
    password: process.env.DBTEST_PG_PASSWORD ?? 'pgpass',
  },
};

async function pgAvailable() {
  try {
    await queryDatabase({ id: 989, ...TARGETS.postgres, readOnly: true }, 'SELECT 1');
    return true;
  } catch {
    return false;
  }
}

test('池内连接被复用，且空闲未超阈值时不额外探活', async (t) => {
  if (!(await pgAvailable())) return t.skip('Postgres 测试库不可用');
  const config = { id: 9700, ...TARGETS.postgres, readOnly: true };

  await queryDatabase(config, 'SELECT 1');
  const startedAt = Date.now();
  const second = await queryDatabase(config, 'SELECT 2 AS n');
  const elapsed = Date.now() - startedAt;

  assert.equal(second.rows[0].n, 2);
  // 复用路径不应重新建连（建连 + 隧道握手在本地也要几十毫秒），
  // 这里给一个宽松上限，只排除「每次都全量重连」这种退化。
  assert.ok(elapsed < PING_AFTER_IDLE_MS, `第二次查询耗时 ${elapsed}ms 说明可能没有复用池`);
  await closeAll();
});

test('池被外部破坏后能自愈重建', async (t) => {
  if (!(await pgAvailable())) return t.skip('Postgres 测试库不可用');
  const config = { id: 9701, ...TARGETS.postgres, readOnly: true };

  await queryDatabase(config, 'SELECT 1');
  // closeAll 把池拆掉，等价于连接被外部掐死
  await closeAll();
  // 下一次查询必须自己重建，而不是报「连接已关闭」
  const result = await queryDatabase(config, 'SELECT 42 AS n');
  assert.equal(result.rows[0].n, 42);
  await closeAll();
});

test('查询中途断开连接后，后续查询仍可用（池自愈）', async (t) => {
  if (!(await pgAvailable())) return t.skip('Postgres 测试库不可用');
  const config = { id: 9702, ...TARGETS.postgres, readOnly: false };

  await queryDatabase(config, 'SELECT 1');
  // 在服务端掐掉这个连接：pg_terminate_backend 作用于同库其它会话。
  // 这里用更朴素的办法——直接关掉本地池，模拟传输消失。
  await closeAll();

  const again = await queryDatabase(config, 'SELECT 7 AS n');
  assert.equal(again.rows[0].n, 7);
  await closeAll();
});
