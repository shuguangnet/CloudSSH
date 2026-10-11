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
