import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AccessStore } from '../../standalone/access-store.mjs';
import { createMcpServer } from '../../standalone/mcp.mjs';

test('MCP protocol: scopes, server boundaries, audit and revocation before dispatch', async () => {
  const store = new AccessStore(':memory:');
  const user = { id: 1, github_id: -1 };
  const { token, id } = store.create(user, { name: 'reader', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
  const identity = store.verify(token);
  let dispatches = 0;
  const env = { USER_DB: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json([
    { id: 1, name: 'authorized', host: 'server1', port: 22, username: 'ops', credential: 'SECRET', cf_access_client_secret: 'SECRET' },
    { id: 2, name: 'hidden', host: 'server2', port: 22, username: 'ops' },
  ]) }) } };
  const server = createMcpServer({ env, store, identity, SSHSession: null, isBlockedCommand: () => ({ blocked: false }),
    execute: async (_env, _identity, _id, command, _timeout, _session, check) => {
      check(); dispatches++; return { stdout: command, stderr: '', exitCode: 0 };
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.some((tool) => tool.name === 'execute_command'), false);
    const listing = await client.callTool({ name: 'list_servers', arguments: {} });
    assert.equal(listing.content[0].text.includes('SECRET'), false);
    assert.equal(listing.content[0].text.includes('hidden'), false);
    const denied = await client.callTool({ name: 'read_file', arguments: { server_id: 2, path: '/etc/passwd' } });
    assert.equal(denied.isError, true); assert.equal(dispatches, 0);
    const injected = await client.callTool({ name: 'read_file', arguments: { server_id: 1, path: '/tmp/file\nrm' } });
    assert.equal(injected.isError, true); assert.equal(dispatches, 0);
    await client.callTool({ name: 'read_file', arguments: { server_id: 1, path: "/tmp/';touch /tmp/bad;#" } });
    assert.equal(dispatches, 1);
    assert.ok(store.audits(user).some((event) => event.status === 'succeeded'));
    store.revoke(user, id);
    const revoked = await client.callTool({ name: 'read_file', arguments: { server_id: 1, path: '/etc/passwd' } });
    assert.equal(revoked.isError, true); assert.equal(dispatches, 1);
  } finally { await client.close(); await server.close(); store.close(); }
});

test('revocation after SSH authentication prevents command dispatch', async () => {
  const store = new AccessStore(':memory:');
  const user = { id: 1, github_id: -1 };
  const { token, id } = store.create(user, { name: 'executor', server_ids: [1], scopes: ['exec'], expires_in_days: 1 });
  let dispatched = false;
  const server = createMcpServer({ env: {}, store, identity: store.verify(token), SSHSession: null,
    isBlockedCommand: () => ({ blocked: false }),
    execute: async (_env, _identity, _id, _command, _timeout, _session, check) => {
      store.revoke(user, id); check(); dispatched = true;
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const output = await client.callTool({ name: 'execute_command', arguments: { server_id: 1, command: 'echo ok' } });
    assert.equal(output.isError, true); assert.equal(dispatched, false);
  } finally { await client.close(); await server.close(); store.close(); }
});
