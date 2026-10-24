import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessSql, isWriteCommand, isWriteStatement, sqlStatementVerbs,
} from '../../standalone/sql-safety.mjs';

// ==================== 回归：曾被正则放过的绕过 ====================
//
// 这一组全部是**实测能在只读连接上真正执行**的语句。正则版 isWriteStatement
// 对它们全部放行，其中 WITH 写 CTE 在测试库上真的删光了一张表。
// 任何一条重新变成放行，都是只读开关被击穿。

test('数据修改型 CTE 不能绕过只读闸门', () => {
  for (const sql of [
    'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
    'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x',
    'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x',
    'WITH RECURSIVE x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
    // 大小写与嵌套深度都不能影响判定
    'with x as (delete from users returning *) select * from x',
    'WITH a AS (SELECT 1), b AS (DELETE FROM t RETURNING *) SELECT * FROM b',
  ]) {
    assert.notEqual(assessSql(sql), null, `应拦截：${sql}`);
  }
});

test('SELECT 变体的写副作用不能绕过只读闸门', () => {
  for (const sql of [
    "SELECT * FROM users INTO OUTFILE '/tmp/dump.txt'",
    'SELECT * FROM users INTO DUMPFILE "/tmp/x"',
    'SELECT * FROM users FOR UPDATE',
    "SELECT * FROM users LOCK IN SHARE MODE",
    '@x := 1',
    "SELECT * INTO new_table FROM users",
  ]) {
    assert.notEqual(assessSql(sql), null, `应拦截：${sql}`);
  }
});

test('MySQL 可执行版本注释按 SQL 解析而非当注释跳过', () => {
  // /*!50000 ... */ 会被 MySQL 服务端真正执行，剥注释的实现会把它整段删掉。
  assert.notEqual(assessSql('/*!50000 DROP TABLE users */'), null);
  assert.notEqual(assessSql('/*!50000 DELETE FROM users */'), null);
  assert.notEqual(assessSql('SELECT 1 /*!50000 ; DROP TABLE users */'), null);
  // 普通注释与优化器提示仍然可以安全跳过
  assert.equal(assessSql('/* 普通注释 */ SELECT 1'), null);
  assert.equal(assessSql('/*+ MAX_EXECUTION_TIME(1000) */ SELECT 1'), null);
});

test('注释拆词不能绕过只读闸门', () => {
  for (const sql of [
    'DE/**/LETE FROM users',
    'UP--x\nDATE users SET a = 1',
    'D/**/R/**/O/**/P TABLE users',
    'TRUN#x\nCATE TABLE users',
  ]) {
    assert.notEqual(assessSql(sql), null, `应拦截：${sql}`);
  }
});

test('多语句一律拒绝，即使每条都是只读', () => {
  assert.notEqual(assessSql('SELECT 1; DROP TABLE users'), null);
  assert.notEqual(assessSql('SELECT 1; SELECT 2'), null);
  // 结尾单个分号不算多语句
  assert.equal(assessSql('SELECT 1;'), null);
  assert.equal(assessSql('SELECT 1;   '), null);
});

test('反斜杠引号造成的方言歧义被拒绝', () => {
  // MySQL 读法下这是一条 SELECT；PG/SQLite 读法下 ' 已被反斜杠转义，
  // 引号提前闭合，后面是一条真正的 DROP。
  assert.notEqual(assessSql("SELECT 'a\\'; DROP TABLE users --'"), null);
  // 双方言一致的双写引号写法不受影响
  assert.equal(assessSql("SELECT 'it''s a test'"), null);
});

// ==================== 合法只读查询不能被误拦 ====================

test('常见只读查询放行', () => {
  for (const sql of [
    'SELECT 1',
    'select * from users',
    'SELECT id, name FROM users WHERE active = true ORDER BY id LIMIT 10',
    'SHOW TABLES',
    'SHOW DATABASES',
    'SHOW CREATE TABLE users',
    'DESCRIBE users',
    'DESC users',
    'EXPLAIN SELECT 1',
    'EXPLAIN ANALYZE SELECT 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'VALUES (1), (2)',
    'TABLE users',
  ]) {
    assert.equal(assessSql(sql), null, `不应拦截：${sql}`);
  }
});

test('关键字出现在字符串或列名里不误拦', () => {
  for (const sql of [
    "SELECT * FROM logs WHERE message = 'TRUNCATE'",
    "SELECT 'DROP TABLE x' AS note",
    'SELECT * FROM logs WHERE note LIKE \'%DELETE%\'',
    // 保留字做列名必须加引号，引号内容被扫描器跳过
    'SELECT "delete", "update" FROM audit',
    'SELECT `drop` FROM `table`',
    "SELECT REPLACE(name, 'a', 'b') FROM t",
  ]) {
    assert.equal(assessSql(sql), null, `不应拦截：${sql}`);
  }
});

test('合法含反斜杠的查询放行', () => {
  for (const sql of [
    String.raw`SELECT 'C:\\Users\\x' AS path`,
    String.raw`SELECT * FROM logs WHERE msg LIKE '%\\%'`,
    String.raw`SELECT regexp_replace(a, '\\.', '-') FROM t`,
    String.raw`SELECT 'it''s' AS quoted`,
  ]) {
    assert.equal(assessSql(sql), null, `不应拦截：${sql}`);
  }
});

test('PG dollar-quote 内容是字面量，不算写语句', () => {
  // $$ ... $$ 里包着的 DELETE 只是一段文本，不是可执行语句。
  assert.equal(assessSql("SELECT $$ DELETE FROM users $$ AS snippet"), null);
  assert.equal(assessSql('SELECT $tag$ DROP TABLE x $tag$ AS snippet'), null);
});

test('空输入不拦截', () => {
  assert.equal(assessSql(''), null);
  assert.equal(assessSql('   '), null);
  assert.equal(assessSql('\n\t '), null);
});

// ==================== Redis 命令白名单 ====================

test('Redis 只读命令放行', () => {
  for (const command of [
    'GET k', 'MGET a b', 'HGETALL h', 'KEYS *', 'SCAN 0', 'TTL k', 'TYPE k',
    'LRANGE l 0 -1', 'SMEMBERS s', 'ZRANGE z 0 -1', 'INFO keyspace', 'PING',
    'STRLEN k', 'EXISTS k', 'XLEN s',
  ]) {
    assert.equal(isWriteCommand(command), false, `不应拦截：${command}`);
  }
});

test('Redis 写命令被拦截', () => {
  for (const command of [
    'SET k v', 'DEL key', 'FLUSHALL', 'FLUSHDB', 'HSET h f v', 'LPUSH l v',
    'EXPIRE k 10', 'INCR n', 'RENAME a b', 'MOVE a 1', 'SETEX k 10 v',
    'PERSIST k', 'RESTORE k 0 v', 'MIGRATE host 6379 k 0 100',
  ]) {
    assert.equal(isWriteCommand(command), true, `应拦截：${command}`);
  }
});

test('Redis 未知命令按写处理（白名单而非黑名单）', () => {
  // 新版本或模块新增的命令不在白名单里，宁可拒绝也不放行。
  assert.equal(isWriteCommand('FT.SEARCH idx *'), true);
  assert.equal(isWriteCommand('JSON.SET doc $ {}'), true);
  assert.equal(isWriteCommand('SOME_FUTURE_WRITE_CMD k v'), true);
});

test('Redis 敏感父命令的子命令按白名单判断', () => {
  assert.equal(isWriteCommand('CONFIG GET maxmemory'), false);
  assert.equal(isWriteCommand('CONFIG SET maxmemory 100mb'), true);
  assert.equal(isWriteCommand('CLIENT LIST'), false);
  assert.equal(isWriteCommand('CLIENT KILL ID 1'), true);
  assert.equal(isWriteCommand('ACL WHOAMI'), false);
  assert.equal(isWriteCommand('ACL SETUSER eve on >pass'), true);
});

test('Redis 命令数组形式同样识别', () => {
  assert.equal(isWriteCommand(['GET', 'k']), false);
  assert.equal(isWriteCommand(['SET', 'k', 'v']), true);
  assert.equal(isWriteCommand(['CONFIG', 'SET', 'x', '1']), true);
});

// ==================== isWriteStatement 统一入口 ====================

test('isWriteStatement 在未指定引擎时也识别 Redis 只读命令', () => {
  assert.equal(isWriteStatement('GET k'), false);
  assert.equal(isWriteStatement('HGETALL h'), false);
  assert.equal(isWriteStatement('SET k v'), true);
  assert.equal(isWriteStatement('DEL k'), true);
});

test('isWriteStatement 指定 engine=redis 时走命令白名单', () => {
  assert.equal(isWriteStatement('GET k', { engine: 'redis' }), false);
  assert.equal(isWriteStatement('SET k v', { engine: 'redis' }), true);
  // SQL 动词在 Redis 通道里不是合法命令，按写处理
  assert.equal(isWriteStatement('SELECT 1', { engine: 'redis' }), true);
});

// ==================== 语句切分 ====================

test('语句动词按顶层分号切分', () => {
  assert.deepEqual(sqlStatementVerbs('SELECT 1'), ['SELECT']);
  assert.deepEqual(sqlStatementVerbs('SELECT 1; SELECT 2'), ['SELECT', 'SELECT']);
  assert.deepEqual(sqlStatementVerbs("SELECT 'a;b'"), ['SELECT']);
  assert.deepEqual(sqlStatementVerbs('SELECT 1; DROP TABLE t'), ['SELECT', 'DROP']);
});
