import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessStore } from '../../standalone/access-store.mjs';
import { SQLiteStorage } from '../../standalone/runtime.mjs';
import { shellQuote, validatePath } from '../../standalone/operations.mjs';

test('tokens persist, store only hashes, enforce ownership and revocation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-access-'));
  const file = join(directory, 'access.sqlite');
  const owner = { id: 1, github_id: -1 };
  const other = { id: 2, github_id: 99 };
  let store = new AccessStore(file);
  try {
    const { token, id } = store.create(owner, { name: 'agent', server_ids: [1, 2], scopes: ['read'], expires_in_days: 1 });
    assert.deepEqual(store.verify(token).server_ids, [1, 2]);
    assert.equal(store.verify('wrong'), null);
    assert.equal(store.list(owner)[0].token, undefined);
    assert.equal(store.list(owner)[0].hash, undefined);
    assert.deepEqual(store.list(other), []);
    assert.equal(store.revoke(other, id), false);
    store.audit(store.verify(token), 'read_file', 1, 'succeeded');
    assert.equal(store.audits(owner).length, 1);
    assert.equal(store.audits(other).length, 0);
    store.close(); store = new AccessStore(file);
    assert.ok(store.verify(token));
    assert.equal(store.revoke(owner, id), true);
    assert.equal(store.verify(token), null);
    assert.equal(store.isActive(id), false);
    assert.equal(readFileSync(file).includes(Buffer.from(token)), false);
    assert.throws(() => store.create(owner, { name: 'invalid', server_ids: [1], scopes: ['admin'], expires_in_days: 1 }));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('expired tokens cannot authorize operations', () => {
  const store = new AccessStore(':memory:');
  try {
    const { id, token } = store.create({ id: 1, github_id: 1 }, { name: 'test', server_ids: [1], scopes: ['exec'], expires_in_days: 1 });
    store.db.prepare('UPDATE mcp_tokens SET expires_at=0 WHERE id=?').run(id);
    assert.equal(store.verify(token), null);
    assert.equal(store.isActive(id), false);
  } finally { store.close(); }
});

test('local SQLite cursor and transaction preserve Durable Object behavior', () => {
  const storage = new SQLiteStorage(':memory:');
  try {
    storage.sql.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX item_value ON items(value);');
    storage.sql.exec('INSERT INTO items(value) VALUES (?)', 'before');
    assert.throws(() => storage.transactionSync(() => {
      storage.sql.exec('UPDATE items SET value=?', 'after'); throw new Error('rollback');
    }));
    assert.equal(storage.sql.exec('SELECT value FROM items').one().value, 'before');
    assert.equal([...storage.sql.exec('SELECT id FROM items')].length, 1);
  } finally { storage.close(); }
});

test('remote paths cannot inject shell arguments', () => {
  assert.equal(validatePath('/tmp/a; echo hacked'), "'/tmp/a; echo hacked'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.throws(() => validatePath('../secret'));
  assert.throws(() => validatePath('/tmp/a\ncommand'));
  assert.throws(() => validatePath('/tmp/a\0'));
});

test('tokens can be edited, temporarily disabled and batch deleted', () => {
  const store = new AccessStore(':memory:');
  try {
    const owner = { id: 1, github_id: -1 };
    const other = { id: 2, github_id: 99 };
    const { id, token } = store.create(owner, { name: 'agent', server_ids: [1], scopes: ['read'], expires_in_days: 1 });

    // 修改：字段级合并 + 去重，未提供的字段保持原值
    const edited = store.update(owner, id, { scopes: ['read', 'exec', 'exec'], server_ids: [1, 1, 2], name: ' agent ' });
    assert.equal(edited.name, 'agent');
    assert.deepEqual(edited.scopes, ['read', 'exec']);
    assert.deepEqual(edited.server_ids, [1, 2]);
    assert.ok(store.verify(token), 'editing keeps the token valid');
    assert.throws(() => store.update(owner, id, { scopes: ['admin'] }), /Invalid token settings/);
    assert.throws(() => store.update(owner, id, { server_ids: [] }), /Invalid token settings/);
    assert.equal(store.update(other, id, { name: 'stolen' }), null, "others' tokens are invisible");
    assert.equal(store.update(owner, 'f'.repeat(24), { name: 'ghost' }), null);

    // 临时禁用：立即失效、数据保留、可恢复
    assert.equal(store.setDisabled(owner, id, true).disabled, true);
    assert.equal(store.verify(token), null);
    assert.equal(store.isActive(id), false);
    assert.equal(store.list(owner)[0].disabled, true);
    assert.ok(store.update(owner, id, { name: 'while-disabled' }), 'disabled tokens stay editable');
    assert.equal(store.setDisabled(owner, id, false).disabled, false);
    assert.ok(store.verify(token));

    // 批量删除：活跃/不存在跳过，已撤销删除；他人令牌不受影响
    const active = store.create(owner, { name: 'active', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
    const gone = store.create(owner, { name: 'gone', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
    const foreign = store.create(other, { name: 'foreign', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
    store.revoke(owner, gone.id);
    const missing = '0'.repeat(24);
    assert.deepEqual(store.removeMany(owner, [gone.id, active.id, foreign.id, missing]),
      { deleted: [gone.id], skipped: [active.id, foreign.id, missing] });
    assert.ok(store.list(other).some((item) => item.id === foreign.id));
    assert.throws(() => store.remove(owner, active.id), /revoked before deletion/);

    // 撤销后不可修改/禁用
    store.revoke(owner, id);
    assert.throws(() => store.update(owner, id, { name: 'nope' }), /Revoked tokens cannot be modified/);
    assert.throws(() => store.setDisabled(owner, id, true), /Revoked tokens cannot be disabled/);
  } finally { store.close(); }
});

test('audit rows are purgeable by filter or id, scoped to the owner', () => {
  const store = new AccessStore(':memory:');
  try {
    const owner = { id: 1, github_id: -1 };
    const other = { id: 2, github_id: 99 };
    const mine = store.verify(store.create(owner, { name: 'mine', server_ids: [1], scopes: ['read'], expires_in_days: 1 }).token);
    const theirs = store.verify(store.create(other, { name: 'theirs', server_ids: [1], scopes: ['read'], expires_in_days: 1 }).token);
    store.audit(mine, 'list_servers', null, 'succeeded');
    store.audit(mine, 'read_file', 1, 'failed');
    store.audit(mine, 'read_file', 2, 'succeeded');
    store.audit(theirs, 'read_file', 1, 'succeeded');

    // 无筛选必须显式 all=true；参数非法直接拒绝
    assert.throws(() => store.purgeAudits(owner, {}), /without all=true/);
    assert.throws(() => store.purgeAudits(owner, { ids: [0] }), /Invalid audit ids/);
    assert.throws(() => store.purgeAudits(owner, { before: -1 }), /Invalid cursor/);
    assert.throws(() => store.purgeAudits(owner, { token_id: 'nope' }), /Invalid token id/);
    assert.throws(() => store.purgeAudits(owner, { server_id: 0 }), /Invalid server id/);
    assert.throws(() => store.purgeAudits(owner, { status: 'weird' }), /Invalid status/);
    assert.throws(() => store.purgeAudits(owner, { ids: Array.from({ length: 501 }, (_, index) => index + 1) }), /At most 500/);

    // 组合筛选只删自己名下的匹配行
    assert.equal(store.purgeAudits(owner, { tool: 'read_file', status: 'succeeded' }), 1);
    assert.equal(store.audits(theirs).length, 1, "other owners' rows survive");
    const rows = store.audits(owner);
    assert.equal(store.purgeAudits(owner, { ids: [rows[0].id] }), 1);
    // all=true 清空自己的全部记录
    const beforeAll = store.audits(owner).length;
    assert.equal(beforeAll, 1);
    assert.equal(store.purgeAudits(owner, { all: true }), beforeAll);
    assert.equal(store.audits(owner).length, 0);
    assert.equal(store.audits(other).length, 1);
  } finally { store.close(); }
});

test('legacy access databases gain the disabled_at column in place', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-access-legacy-'));
  const file = join(directory, 'access.sqlite');
  let store;
  try {
    // 旧库：mcp_tokens 没有 disabled_at 列（升级前的结构）
    store = new AccessStore(file);
    store.db.exec('DROP TABLE mcp_tokens');
    store.db.exec(`CREATE TABLE mcp_tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      github_id TEXT NOT NULL, user_id INTEGER NOT NULL, server_ids TEXT NOT NULL, scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, auth_generation TEXT NOT NULL)`);
    store.db.prepare('INSERT INTO mcp_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run('a'.repeat(24), 'legacy-hash', 'legacy', '-1', 1, '[1]', '["read"]', Date.now(), Date.now() + 86400000, 'github');
    store.close();

    store = new AccessStore(file);
    const columns = store.db.prepare('PRAGMA table_info(mcp_tokens)').all().map((row) => row.name);
    assert.ok(columns.includes('disabled_at'));
    const [row] = store.list({ id: 1, github_id: -1 });
    assert.equal(row.name, 'legacy');
    assert.equal(row.disabled, false);
    assert.equal(store.setDisabled({ id: 1, github_id: -1 }, row.id, true).disabled, true);
    // 迁移后新建令牌的列绑定仍然正确（显式列名，不受新增列影响）
    const fresh = store.create({ id: 1, github_id: -1 }, { name: 'fresh', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
    assert.ok(store.verify(fresh.token));
    assert.equal(store.verify(fresh.token).name, 'fresh');
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
