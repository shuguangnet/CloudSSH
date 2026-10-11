import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AccessStore } from '../../standalone/access-store.mjs';
import { createMcpServer } from '../../standalone/mcp.mjs';
import { buildStatusScript } from '../../standalone/status.mjs';

async function connectPair(server) {
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return client;
}

test('MCP snippets: list without scope, run with exec scope, blocked or unknown snippets refused', async () => {
  const store = new AccessStore(':memory:');
  const user = { id: 1, github_id: -1 };
  const snippets = [
    { id: 11, name: 'disk usage', category: 'ops', command: 'df -h /' },
    { id: 12, name: 'danger', category: '', command: 'rm -rf /' },
  ];
  const env = { USER_DB: { idFromName: (name) => name, get: () => ({ fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/internal/snippets') return Response.json(snippets);
    if (url.pathname === '/internal/servers') return Response.json([{ id: 1, name: 'authorized' }]);
    return Response.json({ error: 'Not Found' }, { status: 404 });
  } }) } };
  const dispatched = [];
  const execute = async (_env, _identity, id, command, _timeout, _session, check) => {
    check(); dispatched.push({ id, command }); return { stdout: 'ok', stderr: '', exitCode: 0 };
  };

  // 只读令牌：能列出片段，但 run_snippet 不可见
  const readToken = store.create(user, { name: 'reader', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
  const readServer = createMcpServer({ env, store, identity: store.verify(readToken.token), SSHSession: null,
    isBlockedCommand: (command) => ({ blocked: command.includes('rm -rf /'), reason: 'extreme danger' }), execute });
  const readClient = await connectPair(readServer);
  try {
    const listing = JSON.parse((await readClient.callTool({ name: 'list_snippets', arguments: {} })).content[0].text);
    assert.equal(listing.snippets.length, 2);
    assert.equal(listing.snippets[0].command, 'df -h /');
    assert.equal(listing.snippets[1].category, '');
    const tools = await readClient.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === 'run_snippet'), false);
    assert.equal(tools.tools.find((tool) => tool.name === 'list_snippets').annotations.readOnlyHint, true);
  } finally { await readClient.close(); await readServer.close(); }

  // exec 令牌：片段逐字执行，审计记录 snippet_id，未知/危险片段拒绝且不派发
  const execToken = store.create(user, { name: 'runner', server_ids: [1], scopes: ['exec'], expires_in_days: 1 });
  const identity = store.verify(execToken.token);
  const server = createMcpServer({ env, store, identity, SSHSession: null,
    isBlockedCommand: (command) => ({ blocked: command.includes('rm -rf /'), reason: 'extreme danger' }), execute });
  const client = await connectPair(server);
  try {
    const run = JSON.parse((await client.callTool({ name: 'run_snippet', arguments: { server_id: 1, snippet_id: 11 } })).content[0].text);
    assert.equal(run.stdout, 'ok'); assert.equal(run.snippet_name, 'disk usage'); assert.equal(run.snippet_id, 11);
    assert.equal(dispatched[0].command, 'df -h /');
    const unknown = await client.callTool({ name: 'run_snippet', arguments: { server_id: 1, snippet_id: 999 } });
    assert.equal(unknown.isError, true); assert.match(unknown.content[0].text, /not found/);
    const blocked = await client.callTool({ name: 'run_snippet', arguments: { server_id: 1, snippet_id: 12 } });
    assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /blocked/);
    assert.equal(dispatched.length, 1);
    assert.ok(store.audits(user).some((event) => event.tool === 'run_snippet' && event.status === 'started'
      && JSON.parse(event.details).snippet_id === 11));
    assert.ok(store.audits(user).some((event) => event.tool === 'run_snippet' && event.status === 'succeeded'));
  } finally { await client.close(); await server.close(); store.close(); }
});

test('MCP download_file: chunked reads with size, sha256 and truncation flag', async () => {
  const store = new AccessStore(':memory:');
  const user = { id: 1, github_id: -1 };
  const { token } = store.create(user, { name: 'reader', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
  const commands = [];
  // 模拟远端：SIZE:1000 / CHUNK:262144 溢出上限会被钳制，这里用 5 字节文件验证语义
  const execute = async (_env, _identity, id, command, _timeout, _session, check) => {
    check(); commands.push(command);
    if (command.includes("'/tmp/missing'")) return { stdout: '', stderr: 'no such file', exitCode: 1 };
    if (command.includes('test -f')) {
      const offset = Number(command.match(/tail -c \+(\d+)/)[1]) - 1;
      const maxBytes = Number(command.match(/head -c (\d+)/)[1]);
      const size = 5;
      const chunk = Math.max(0, Math.min(maxBytes, size - offset));
      const sha = chunk === 3 ? 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3' : 'deadbeef';
      const body = Buffer.from('ABCDE'.slice(offset, offset + chunk)).toString('base64');
      return { stdout: `SIZE:${size}\nCHUNK:${chunk}\nSHA256:${sha}\n${body}\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'unexpected', exitCode: 1 };
  };
  const server = createMcpServer({ env: {}, store, identity: store.verify(token), SSHSession: null,
    isBlockedCommand: () => ({ blocked: false }), execute });
  const client = await connectPair(server);
  try {
    const first = JSON.parse((await client.callTool({ name: 'download_file', arguments: { server_id: 1, path: '/tmp/a.log', offset: 0, max_bytes: 3 } })).content[0].text);
    assert.equal(first.size_bytes, 5); assert.equal(first.chunk_bytes, 3);
    assert.equal(first.truncated, true); assert.equal(first.encoding, 'base64');
    assert.equal(Buffer.from(first.content_base64, 'base64').toString(), 'ABC');
    assert.equal(first.content_sha256, 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3');
    assert.match(commands[0], /f='\/tmp\/a\.log'; test -f "\$f"/);
    assert.match(commands[0], /tail -c \+1 -- "\$f" \| head -c 3/);
    const second = JSON.parse((await client.callTool({ name: 'download_file', arguments: { server_id: 1, path: '/tmp/a.log', offset: 3, max_bytes: 3 } })).content[0].text);
    assert.equal(second.chunk_bytes, 2); assert.equal(second.truncated, false);
    assert.equal(Buffer.from(second.content_base64, 'base64').toString(), 'DE');
    assert.match(commands[1], /tail -c \+4/);
    // 远端 exit_code 非 0 时原样返回，交给包装器标记失败
    const missing = await client.callTool({ name: 'download_file', arguments: { server_id: 1, path: '/tmp/missing' } });
    assert.equal(missing.isError, true);
    assert.match(JSON.parse(missing.content[0].text).stderr, /no such file/);
    // 默认 max_bytes = 256 KiB，超限被 zod 拒绝
    const oversize = await client.callTool({ name: 'download_file', arguments: { server_id: 1, path: '/tmp/a.log', max_bytes: 262145 } });
    assert.equal(oversize.isError, true);
  } finally { await client.close(); await server.close(); store.close(); }
});

test('MCP upload_file: atomic first chunk, append continuation, strict base64 validation', async () => {
  const store = new AccessStore(':memory:');
  const user = { id: 1, github_id: -1 };
  const { token } = store.create(user, { name: 'writer', server_ids: [1], scopes: ['write'], expires_in_days: 1 });
  const commands = [];
  const execute = async (_env, _identity, id, command, _timeout, _session, check) => {
    check(); commands.push(command);
    if (command.includes('test -f "$target"')) return { stdout: '5\n', stderr: '', exitCode: 0 };
    return { stdout: 'BYTES:3\n', stderr: '', exitCode: 0 };
  };
  const server = createMcpServer({ env: {}, store, identity: store.verify(token), SSHSession: null,
    isBlockedCommand: () => ({ blocked: false }), execute });
  const client = await connectPair(server);
  try {
    const create = JSON.parse((await client.callTool({ name: 'upload_file', arguments: {
      server_id: 1, path: '/tmp/b.bin', content_base64: Buffer.from('ABC').toString('base64') } })).content[0].text);
    assert.equal(create.bytes_written, 3); assert.equal(create.append, false);
    assert.match(commands[0], /mktemp "\$dir\/\.cloudssh-mcp\.XXXXXXXX"/);
    assert.match(commands[0], /mv -f -- "\$tmp" "\$target"/);
    assert.doesNotMatch(commands[0], />> "\$target"/);
    const append = JSON.parse((await client.callTool({ name: 'upload_file', arguments: {
      server_id: 1, path: '/tmp/b.bin', content_base64: Buffer.from('DE').toString('base64'), append: true } })).content[0].text);
    assert.equal(append.append, true); assert.equal(append.bytes_written, 2);
    assert.match(commands[1], /test -f "\$target"/);
    assert.match(commands[1], />> "\$target"/);
    assert.doesNotMatch(commands[1], /mktemp/);
    // 非法/超长 base64 在派发前拒绝
    for (const bad of ['!!!not-base64!!!', 'AB', 'QUJD=', `A`.repeat(128001)]) {
      const rejected = await client.callTool({ name: 'upload_file', arguments: { server_id: 1, path: '/tmp/b.bin', content_base64: bad } });
      assert.equal(rejected.isError, true, bad.slice(0, 16));
    }
    assert.equal(commands.length, 2);
  } finally { await client.close(); await server.close(); store.close(); }
});

test('MCP get_server_info: reuses the status collector with the token recheck', async () => {
  const store = new AccessStore(':memory:');
  const user = { id: 1, github_id: -1 };
  const { token, id } = store.create(user, { name: 'reader', server_ids: [1], scopes: ['read'], expires_in_days: 1 });
  const identity = store.verify(token);
  const execute = async (_env, _identity, _serverId, command, _timeout, _session, check) => {
    assert.equal(command, buildStatusScript());
    store.revoke(user, id); // 认证后撤销令牌：recheck 必须拒绝派发
    check();
  };
  const server = createMcpServer({ env: {}, store, identity, SSHSession: null,
    isBlockedCommand: () => ({ blocked: false }), execute });
  const client = await connectPair(server);
  try {
    const denied = await client.callTool({ name: 'get_server_info', arguments: { server_id: 1 } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /revoked|expired/i);
  } finally { await client.close(); await server.close(); store.close(); }
});

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
