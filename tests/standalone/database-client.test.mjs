// 数据库客户端层的可单测部分：写语句识别、连接池缓存键、结果归一化、
// 错误脱敏。真正连库的部分由集成测试（有可用数据库时）覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isWriteStatement, MAX_ROWS, MAX_CELL_CHARS, MAX_COLUMNS,
  driverPackage, driverStatus,
} from '../../standalone/database-client.mjs';

// ==================== 写语句识别 ====================

test('SELECT / SHOW / DESCRIBE / EXPLAIN 不算写操作', () => {
  for (const sql of [
    'SELECT 1',
    'select * from users',
    '  SELECT id FROM t WHERE x = 1',
    'SHOW TABLES',
    'DESCRIBE users',
    'EXPLAIN SELECT 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    '(SELECT 1)',
  ]) {
    assert.equal(isWriteStatement(sql), false, `${sql} 应被视为只读`);
  }
});

test('常见写语句被识别', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'insert into t values (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'TRUNCATE t',
    'ALTER TABLE t ADD COLUMN c INT',
    'CREATE TABLE t (id INT)',
    'GRANT ALL ON t TO u',
    'REVOKE ALL ON t FROM u',
    'RENAME TABLE a TO b',
    'REPLACE INTO t VALUES (1)',
    'CREATE INDEX idx ON t(c)',
    'VACUUM',
    'REINDEX',
  ]) {
    assert.equal(isWriteStatement(sql), true, `${sql} 应被视为写操作`);
  }
});

test('Redis 写命令被识别（del/set/expire 等）', () => {
  for (const command of ['DEL key', 'SET k v', 'HSET h f v', 'LPUSH l v', 'FLUSHALL', 'EXPIRE k 10', 'INCR n']) {
    assert.equal(isWriteStatement(command), true, `${command} 应被视为写操作`);
  }
  for (const command of ['GET k', 'HGETALL h', 'KEYS *', 'INFO keyspace', 'PING', 'TTL k']) {
    assert.equal(isWriteStatement(command), false, `${command} 应被视为只读`);
  }
});

test('注释不能用来藏写语句', () => {
  assert.equal(isWriteStatement('/* 查询 */ DELETE FROM t'), true);
  assert.equal(isWriteStatement('-- note\nDELETE FROM t'), true);
  assert.equal(isWriteStatement('  \n\n  /* a */ /* b */ UPDATE t SET a=1'), true);
  // 纯注释 + SELECT 仍然是只读
  assert.equal(isWriteStatement('/* note */ SELECT 1'), false);
});

test('多语句一律按写处理（防止一条 query 里夹带 DROP）', () => {
  assert.equal(isWriteStatement('SELECT 1; DROP TABLE users'), true);
  assert.equal(isWriteStatement('SELECT 1; DELETE FROM t'), true);
  // 结尾单个分号是合法的，不算多语句
  assert.equal(isWriteStatement('SELECT 1;'), false);
  assert.equal(isWriteStatement('SELECT 1;  '), false);
});

test('空语句与纯空白不被当成写操作', () => {
  assert.equal(isWriteStatement(''), false);
  assert.equal(isWriteStatement('   '), false);
});

// ==================== 常量与驱动元信息 ====================

test('结果集上限是有限正数（避免上下文被打爆）', () => {
  assert.ok(Number.isInteger(MAX_ROWS) && MAX_ROWS > 0 && MAX_ROWS <= 1000);
  assert.ok(Number.isInteger(MAX_CELL_CHARS) && MAX_CELL_CHARS > 0);
  assert.ok(Number.isInteger(MAX_COLUMNS) && MAX_COLUMNS > 0);
});

test('driverPackage 映射到正确的 npm 包', () => {
  assert.equal(driverPackage('mysql'), 'mysql2');
  assert.equal(driverPackage('mariadb'), 'mysql2');
  assert.equal(driverPackage('postgres'), 'pg');
  assert.equal(driverPackage('redis'), 'ioredis');
  assert.equal(driverPackage('oracle'), null);
});

test('driverStatus 报告每个引擎的驱动可用性', async () => {
  const status = await driverStatus();
  // 按引擎名索引（前端直接用 engines.postgres.available 判断），
  // 且四种引擎必须齐全。
  assert.deepEqual(Object.keys(status).sort(), ['mariadb', 'mysql', 'postgres', 'redis']);
  for (const [engine, entry] of Object.entries(status)) {
    assert.equal(entry.engine, engine);
    assert.ok(['mysql2', 'pg', 'ioredis'].includes(entry.package));
    assert.equal(typeof entry.available, 'boolean');
  }
  // mariadb 走 mysql2 协议，两者共用驱动。
  assert.equal(status.mariadb.package, status.mysql.package);
});
