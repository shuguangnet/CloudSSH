// 数据库连接存储测试：加密往返、校验、merge 语义（密码不清空）、
// 引用完整性、审计。加密部分特意验证「改了密钥就解不开」（等价于
// 库文件被单独拷走后的场景）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { DatabaseStore, ENGINES, DEFAULT_PORTS } from '../../standalone/database-store.mjs';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dbstore-'));
  return {
    dir,
    file: join(dir, 'database.sqlite'),
    open: (options) => new DatabaseStore(join(dir, 'database.sqlite'), options),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ==================== 加密 ====================

test('加密往返：明文进、密文存、明文出', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const secret = 'p@ssw0rd-中文-🔐';
    const encrypted = store.encrypt(secret);
    assert.notEqual(encrypted, secret, '密文不能等于明文');
    assert.ok(!encrypted.includes(secret), '密文不能包含明文');
    assert.equal(store.decrypt(encrypted), secret);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('空字符串加密为 NULL，解密 NULL 得到空串', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.equal(store.encrypt(''), null);
    assert.equal(store.decrypt(null), '');
    assert.equal(store.decrypt(''), '');
    store.db.close();
  } finally { temp.cleanup(); }
});

test('每次加密的 IV 都不同（相同明文得到不同密文）', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const a = store.encrypt('same');
    const b = store.encrypt('same');
    assert.notEqual(a, b, 'GCM 必须每次用新 IV');
    assert.equal(store.decrypt(a), store.decrypt(b));
    store.db.close();
  } finally { temp.cleanup(); }
});

test('密钥文件自动生成且权限为 0600', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const secretFile = `${temp.file}.secret`;
    assert.ok(existsSync(secretFile), '应当生成独立密钥文件');
    const { mode } = statSync(secretFile);
    assert.equal(mode & 0o777, 0o600, '密钥文件必须是 0600');
    assert.ok(readFileSync(secretFile, 'utf8').trim().length >= 32);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('换掉密钥文件后旧密文无法解密（模拟只泄露 sqlite 文件）', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const encrypted = store.encrypt('top-secret');
    store.db.close();

    // 模拟攻击者只有 sqlite 文件、没有密钥文件。
    const other = tempStore();
    const attacker = other.open({ secretFile: `${temp.file}.secret-does-not-exist` });
    assert.throws(() => attacker.decrypt(encrypted), '换了密钥必须解密失败（GCM 认证失败）');
    attacker.db.close();
    other.cleanup();
  } finally { temp.cleanup(); }
});

test('篡改密文会被 GCM 认证标签检测出来', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const encrypted = store.encrypt('integrity');
    const raw = Buffer.from(encrypted, 'base64');
    raw[raw.length - 1] ^= 0xff;
    assert.throws(() => store.decrypt(raw.toString('base64')));
    store.db.close();
  } finally { temp.cleanup(); }
});

// ==================== 代理 CRUD ====================

test('创建 SOCKS5 代理：密码加密存储且不回显', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const proxy = store.createProxy({
      name: '内网 SS5', kind: 'socks5', host: '10.0.0.9', port: 1080,
      username: 'ops', password: 'proxy-pass',
    });
    assert.equal(proxy.kind, 'socks5');
    assert.equal(proxy.host, '10.0.0.9');
    assert.equal(proxy.hasPassword, true);
    assert.equal(proxy.password, undefined, 'API 层绝不能出现 password 字段');

    // 落盘的必须是密文。
    const row = store.db.prepare('SELECT password FROM db_proxies WHERE id=?').get(proxy.id);
    assert.notEqual(row.password, 'proxy-pass');
    assert.ok(row.password.length > 20);

    // 内部 resolve 能拿到明文用于建连。
    const resolved = store.resolveProxy(proxy.id);
    assert.equal(resolved.password, 'proxy-pass');
    assert.equal(resolved.username, 'ops');
    store.db.close();
  } finally { temp.cleanup(); }
});

test('创建 SSH 代理只需要 serverId，不需要 host/port', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const proxy = store.createProxy({ name: '跳板机', kind: 'ssh', serverId: 7 });
    assert.equal(proxy.kind, 'ssh');
    assert.equal(proxy.serverId, 7);
    assert.equal(proxy.host, null);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('SSH 代理缺少 serverId 时拒绝', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.createProxy({ name: 'x', kind: 'ssh' }), /必须选择一台已保存的服务器/);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('代理类型白名单拒绝未知类型', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.createProxy({ name: 'x', kind: 'openvpn', host: 'h', port: 1 }), /不支持的代理类型/);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('代理用户名与密码必须成对提供', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.createProxy({
      name: 'x', kind: 'socks5', host: 'h', port: 1080, username: 'u',
    }), /必须同时填写/);
    assert.throws(() => store.createProxy({
      name: 'x', kind: 'socks5', host: 'h', port: 1080, password: 'p',
    }), /必须同时填写/);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('代理名称/主机拒绝控制字符与空值', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.createProxy({ name: '', kind: 'direct' }), /不能为空/);
    assert.throws(() => store.createProxy({ name: 'a\nb', kind: 'direct' }), /控制字符/);
    assert.throws(() => store.createProxy({ name: 'ok', kind: 'socks5', host: 'a b', port: 1 }), /空白字符/);
    assert.throws(() => store.createProxy({ name: 'ok', kind: 'socks5', host: 'mysql://db', port: 1 }), /不能是 URL/);
    assert.throws(() => store.createProxy({ name: 'ok', kind: 'socks5', host: '/var/run/x.sock', port: 1 }), /URL 或 socket 路径/);
    assert.throws(() => store.createProxy({ name: 'ok', kind: 'socks5', host: 'host;rm', port: 1 }), /非法字符/);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('更新代理：不传 password 保持原密码不变', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const proxy = store.createProxy({
      name: 'p', kind: 'socks5', host: '1.1.1.1', port: 1080, username: 'u', password: 'original',
    });
    const before = store.db.prepare('SELECT password FROM db_proxies WHERE id=?').get(proxy.id).password;

    store.updateProxy(proxy.id, { name: '改名了' });
    const after = store.db.prepare('SELECT * FROM db_proxies WHERE id=?').get(proxy.id);
    assert.equal(after.password, before, '不传 password 时密文必须原样保留');
    assert.equal(after.name, '改名了');

    // 显式传新密码才会改变。
    store.updateProxy(proxy.id, { password: 'changed' });
    assert.equal(store.resolveProxy(proxy.id).password, 'changed');

    // 显式传空串表示清空。
    store.updateProxy(proxy.id, { password: '' });
    assert.equal(store.resolveProxy(proxy.id).password, '');
    store.db.close();
  } finally { temp.cleanup(); }
});

test('删除仍被引用的代理会被拒绝（避免静默降级成直连）', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const proxy = store.createProxy({ name: 'p', kind: 'socks5', host: '1.1.1.1', port: 1080 });
    store.createConnection({
      name: 'c', engine: 'mysql', host: 'db', database: 'app', proxyId: proxy.id,
    });
    assert.throws(() => store.deleteProxy(proxy.id), /仍有 1 个数据库连接使用该代理/);
    assert.equal(store.listProxies().length, 1, '删除失败时不应真的删掉');
    store.db.close();
  } finally { temp.cleanup(); }
});

// ==================== 连接 CRUD ====================

test('创建 MySQL 连接：默认端口 3306，默认只读', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const conn = store.createConnection({
      name: '生产库', engine: 'mysql', host: 'db.example.com', database: 'app', username: 'ro', password: 'pw',
    });
    assert.equal(conn.port, 3306);
    assert.equal(conn.readOnly, true, '默认必须是只读');
    assert.equal(conn.hasPassword, true);
    assert.equal(conn.password, undefined);
    assert.equal(store.resolveConnection(conn.id).password, 'pw');
    store.db.close();
  } finally { temp.cleanup(); }
});

test('各引擎默认端口正确', () => {
  assert.deepEqual(DEFAULT_PORTS, { mysql: 3306, mariadb: 3306, postgres: 5432, redis: 6379 });
  assert.deepEqual(ENGINES.sort(), ['mariadb', 'mysql', 'postgres', 'redis']);
});

test('端口显式指定时优先生效', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const conn = store.createConnection({
      name: 'c', engine: 'postgres', host: 'db', port: 15432, database: 'app',
    });
    assert.equal(conn.port, 15432);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('非 redis 引擎必须有数据库名，redis 可省略', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.createConnection({ name: 'c', engine: 'mysql', host: 'h' }), /数据库名不能为空/);
    const redis = store.createConnection({ name: 'r', engine: 'redis', host: 'h' });
    assert.equal(redis.database, '');
    store.db.close();
  } finally { temp.cleanup(); }
});

test('非法引擎与非法端口被拒绝', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.createConnection({ name: 'c', engine: 'oracle', host: 'h', database: 'd' }), /不支持的数据库类型/);
    assert.throws(() => store.createConnection({ name: 'c', engine: 'mysql', host: 'h', database: 'd', port: 70000 }), /端口必须是/);
    assert.throws(() => store.createConnection({ name: 'c', engine: 'mysql', host: 'h', database: 'd', port: 'abc' }), /端口必须是/);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('引用不存在的代理时拒绝', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.createConnection({
      name: 'c', engine: 'mysql', host: 'h', database: 'd', proxyId: 999,
    }), /指定的代理不存在/);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('更新连接：不传 password 保持原密码；readOnly 可切换', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const conn = store.createConnection({
      name: 'c', engine: 'mysql', host: 'h', database: 'd', username: 'u', password: 'pw',
    });
    const updated = store.updateConnection(conn.id, { name: '新名字', readOnly: false });
    assert.equal(updated.name, '新名字');
    assert.equal(updated.readOnly, false);
    assert.equal(store.resolveConnection(conn.id).password, 'pw', '未传 password 时必须保留');
    store.db.close();
  } finally { temp.cleanup(); }
});

test('连接的代理被删后 resolve 给出明确错误而不是静默直连', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    const proxy = store.createProxy({ name: 'p', kind: 'socks5', host: '1.1.1.1', port: 1080 });
    const conn = store.createConnection({
      name: 'c', engine: 'mysql', host: 'h', database: 'd', proxyId: proxy.id,
    });
    // 绕过引用检查直接删（模拟并发/手工改库）。
    store.db.prepare('DELETE FROM db_proxies WHERE id=?').run(proxy.id);
    assert.throws(() => store.resolveConnection(conn.id), /引用的代理已被删除/);
    store.db.close();
  } finally { temp.cleanup(); }
});

test('删除不存在的连接/代理报 notFound', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    assert.throws(() => store.deleteConnection(123), (e) => e.code === 'notFound');
    assert.throws(() => store.deleteProxy(123), (e) => e.code === 'notFound');
    assert.throws(() => store.getConnection(123), (e) => e.code === 'notFound');
    store.db.close();
  } finally { temp.cleanup(); }
});

test('数据在重开 store 后仍然存在（持久化 + 可解密）', () => {
  const temp = tempStore();
  try {
    const first = temp.open();
    const conn = first.createConnection({
      name: 'persist', engine: 'postgres', host: 'db', database: 'app', password: 'keep-me',
    });
    first.db.close();

    const second = temp.open();
    const resolved = second.resolveConnection(conn.id);
    assert.equal(resolved.password, 'keep-me', '密钥文件复用时必须能解开旧密文');
    assert.equal(resolved.host, 'db');
    second.db.close();
  } finally { temp.cleanup(); }
});

// ==================== 审计 ====================

test('审计记录不含 SQL 正文，只存 sha256', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    store.recordAudit({
      connectionId: 1, connectionName: 'prod', tool: 'db_query', engine: 'mysql',
      status: 'succeeded', sqlSha256: 'a'.repeat(64), rowCount: 5, durationMs: 12,
    });
    const [entry] = store.listAudit(10);
    assert.equal(entry.status, 'succeeded');
    assert.equal(entry.sql_sha256, 'a'.repeat(64));
    assert.equal(entry.row_count, 5);
    // 表中根本没有存 SQL 正文的列。
    const columns = store.db.prepare('PRAGMA table_info(db_audit)').all().map((c) => c.name);
    assert.ok(!columns.includes('sql'), '审计表不得包含 sql 正文字段');
    assert.ok(!columns.includes('result'));
    store.db.close();
  } finally { temp.cleanup(); }
});

test('审计错误信息被截断，且写入失败不影响调用方', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    store.recordAudit({
      connectionId: 1, connectionName: 'p', tool: 'db_exec', engine: 'mysql',
      status: 'failed', error: 'x'.repeat(2000),
    });
    assert.equal(store.listAudit(1)[0].error.length, 500);
    store.db.close();
    // 已关闭的 db：recordAudit 必须吞掉异常（审计不能阻断业务）。
    assert.doesNotThrow(() => store.recordAudit({
      connectionId: 1, connectionName: 'p', tool: 't', engine: 'mysql', status: 'failed',
    }));
  } finally { temp.cleanup(); }
});

test('listAudit 的 limit 被夹在 1-500 之间', () => {
  const temp = tempStore();
  try {
    const store = temp.open();
    for (let index = 0; index < 5; index += 1) {
      store.recordAudit({
        connectionId: 1, connectionName: 'p', tool: 'db_query', engine: 'mysql', status: 'succeeded',
      });
    }
    assert.equal(store.listAudit(0).length, 1);
    assert.equal(store.listAudit(3).length, 3);
    assert.equal(store.listAudit(9999).length, 5);
    store.db.close();
  } finally { temp.cleanup(); }
});
