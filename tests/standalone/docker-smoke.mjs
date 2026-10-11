import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { pbkdf2Sync } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// An isolated disposable Compose project; never touch the user's service or volume.
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise((done) => listener.close(done));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, COMPOSE_PROJECT_NAME: `cloudssh-smoke-${process.pid}`,
  PORT: String(port), BASE_URL: base, BIND_ADDRESS: '127.0.0.1',
  GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GITHUB_ALLOWED_USER_IDS: '',
};
function command(cmd, args, input) {
  const result = spawnSync(cmd, args, { env, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr}`);
  return result.stdout;
}
const password = 'docker-fixture-password-123';
let client;
try {
  command('docker', ['compose', 'build']);
  command('docker', ['compose', 'run', '--rm', '-T', '--no-deps', 'cloudssh', 'node', 'scripts/setup-standalone.mjs', '--stdin'], `${password}\n`);
  command('bash', ['scripts/deploy.sh', '--docker']);
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { healthy = true; break; } } catch { /* Starting. */ }
    await delay(100);
  }
  assert.equal(healthy, true);
  const config = await (await fetch(`${base}/api/config`)).json();
  const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
  const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const api = (path, method = 'GET', body) => fetch(`${base}${path}`, { method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await api('/api/servers', 'POST', { name: 'Docker fixture', host: '127.0.0.1', port: 22, username: 'ops', auth_method: 'password', credential: 'fixture' })).status, 201);
  const servers = await (await api('/api/servers')).json();
  const access = await (await api('/api/mcp/tokens', 'POST', { name: 'Docker agent', server_ids: [servers[0].id], scopes: ['read'], expires_in_days: 1 })).json();
  command('docker', ['compose', 'restart', 'cloudssh']);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Restarting. */ }
    await delay(100);
  }
  client = new Client({ name: 'docker-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access.token}` } } }));
  const listed = await client.callTool({ name: 'list_servers', arguments: {} });
  assert.equal(JSON.parse(listed.content[0].text).servers[0].name, 'Docker fixture');
  assert.equal((await api('/mcp/settings')).status, 200);
  console.log('Docker deployment script, login, MCP and persistent volume verified.');
} finally {
  await client?.close();
  command('docker', ['compose', 'down', '-v', '--remove-orphans']);
}
