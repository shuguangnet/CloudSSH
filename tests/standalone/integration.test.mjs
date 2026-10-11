import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pbkdf2Sync, randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium } from '@playwright/test';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
  await exited; clearTimeout(timer);
}
async function startPanel(directory, port) {
  const child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'), env: { ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', (data) => { logs += data; }); child.stderr.on('data', (data) => { logs += data; });
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return child; } catch { /* Starting. */ }
    if (child.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  await stop(child); throw new Error(`Server startup timed out: ${logs}`);
}

test('native panel and real MCP client enforce authentication, persistence and revocation', { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-integration-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let child; let client;
  try {
    child = await startPanel(directory, port);
    assert.equal((await fetch(`${base}/api/servers`)).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.mcpEnabled, true); assert.equal(config.githubAuthRequired, true);
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body, origin = base) => fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const added = await api('/api/servers', 'POST', { name: 'fixture', host: '127.0.0.1', port: 2222, username: userInfo().username, auth_method: 'password', credential: 'fixture-only' });
    assert.equal(added.status, 201);
    const servers = await (await api('/api/servers')).json(); const id = servers[0].id;
    assert.equal(JSON.stringify(servers).includes('fixture-only'), false);
    const settings = { name: 'test agent', server_ids: [id], scopes: ['read'], expires_in_days: 1 };
    assert.equal((await api('/api/mcp/tokens', 'POST', settings, 'https://attacker.example')).status, 403);
    assert.equal((await api('/api/mcp/tokens', 'POST', { ...settings, server_ids: [99999] })).status, 400);
    const created = await api('/api/mcp/tokens', 'POST', settings); assert.equal(created.status, 201);
    const token = await created.json();
    if (process.env.SELF_HOSTED_BROWSER_TESTS === '1') await t.test('browser settings create and revoke tokens under CSP in three languages', async () => {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext();
        const [name, ...value] = cookie.split('=');
        await context.addCookies([{ name, value: value.join('='), url: base }]);
        const page = await context.newPage();
        const errors = []; page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}/mcp/settings`);
        await page.locator('input[name=server]').first().check();
        await page.locator('#name').fill('browser agent');
        await page.locator('#create-token button').click();
        await page.locator('#created').waitFor({ state: 'visible' });
        assert.match(await page.locator('#token').inputValue(), /^cssh_/);
        for (const locale of ['zh-CN', 'zh-TW', 'en-US']) {
          await page.locator('#language').selectOption(locale);
          assert.equal(await page.locator('html').getAttribute('lang'), locale);
        }
        const row = page.locator('#tokens tr').filter({ hasText: 'browser agent' });
        await row.getByRole('button', { name: 'Revoke' }).click();
        await row.getByText('Revoked', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
    client = new Client({ name: 'integration', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map((item) => item.name).sort(), ['download_file', 'get_server_info', 'list_files', 'list_servers', 'list_snippets', 'read_file']);
    const listed = JSON.parse((await client.callTool({ name: 'list_servers', arguments: {} })).content[0].text);
    assert.equal(listed.servers[0].id, id);
    assert.equal(JSON.stringify(listed).includes('fixture-only'), false);
    const denied = await client.callTool({ name: 'read_file', arguments: { server_id: 99999, path: '/etc/passwd' } }); assert.equal(denied.isError, true);
    const missingTrust = await client.callTool({ name: 'read_file', arguments: { server_id: id, path: '/etc/passwd' } });
    assert.equal(missingTrust.isError, true); assert.match(missingTrust.content[0].text, /fingerprint/);
    await client.close(); client = null;
    await stop(child); child = await startPanel(directory, port);
    assert.equal((await api('/api/mcp/tokens')).status, 200);
    assert.equal((await (await api('/api/servers')).json())[0].id, id);
    assert.ok((await (await api('/api/mcp/audit')).json()).some((item) => item.status === 'denied'));
    assert.equal((await api(`/api/mcp/tokens/${token.id}`, 'DELETE')).status, 200);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token.token}` } })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await api('/mcp/settings')).status, 200);
  } finally { await client?.close(); await stop(child); rmSync(directory, { recursive: true, force: true }); }
});

test('real SSH: panel WebSocket, host trust, headless MCP commands, file I/O and jump host', {
  timeout: 90000, skip: !existsSync('/usr/sbin/sshd') || process.getuid?.() !== 0,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-ssh-'));
  const dataDir = join(directory, 'data');
  const sshPort = await freePort(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const hostKey = join(directory, 'host-key'), clientKey = join(directory, 'client-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  const publicKey = readFileSync(`${clientKey}.pub`); writeFileSync(join(directory, 'authorized_keys'), publicKey);
  const sshConfig = join(directory, 'sshd_config');
  writeFileSync(sshConfig, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${directory}/authorized_keys\nStrictModes no\nPermitRootLogin yes\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nLogLevel ERROR\nSubsystem sftp internal-sftp\nAllowTcpForwarding yes\n`);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  let panel, client, socket, sftpSocket;
  try {
    await delay(150); assert.equal(sshd.exitCode, null);
    const password = 'fixture-password-123';
    execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: dataDir }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
    panel = await startPanel(dataDir, port);
    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin' }) });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const api = (path, method = 'GET', body) => fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const addServer = async (name, jump_server_id) => {
      const response = await api('/api/servers', 'POST', { name, host: '127.0.0.1', port: sshPort, username: userInfo().username, auth_method: 'publickey', credential: readFileSync(clientKey, 'utf8'), jump_server_id });
      assert.equal(response.status, 201);
      return (await (await api('/api/servers')).json()).find((item) => item.name === name).id;
    };
    const id = await addServer('direct');
    // Exercise the actual browser WebSocket adapter; accept verified host keys like the panel.
    const connection = await (await api(`/api/servers/${id}/connect`, 'POST')).json();
    const websocketUrl = connection.wsUrl || connection.ws_url || connection.url;
    assert.ok(websocketUrl, JSON.stringify(connection));
    socket = new WebSocket(websocketUrl, { headers: { Cookie: cookie, Origin: base } });
    let fingerprint, sftpUrl;
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Panel SSH handshake timed out')), 20000);
      socket.on('message', async (data, binary) => {
        if (binary) return;
        const event = JSON.parse(data.toString());
        if (event.type === 'sftp_attach') sftpUrl = event.url;
        if (event.type === 'host_key_verified') {
          fingerprint = event.fingerprint;
          await api('/api/known-hosts', 'POST', { host: event.knownHostIdentity || '127.0.0.1', port: sshPort, fingerprint });
        }
        if (event.event === 'shell_ready') { clearTimeout(timer); resolveReady(); }
        if (event.type === 'error') { clearTimeout(timer); reject(new Error(event.message)); }
      });
      socket.on('error', reject);
    });
    assert.ok(fingerprint); assert.ok(sftpUrl);
    sftpSocket = new WebSocket(sftpUrl, { headers: { Cookie: cookie, Origin: base } });
    await new Promise((resolveListed, reject) => {
      const timer = setTimeout(() => reject(new Error('SFTP listing timed out')), 10000);
      sftpSocket.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'sftp_socket_ready') sftpSocket.send(JSON.stringify({ type: 'sftp_init' }));
        if (event.type === 'sftp_ready') sftpSocket.send(JSON.stringify({ type: 'sftp_list', path: directory }));
        if (event.type === 'sftp_list_result') { clearTimeout(timer); resolveListed(); }
        if (event.type === 'sftp_error') { clearTimeout(timer); reject(new Error(event.message)); }
      });
      sftpSocket.on('error', reject);
    });
    sftpSocket.close(); sftpSocket = null; socket.close(); socket = null;
    // Jump identity is route-scoped; trust the fixture's known key for this route.
    const jumped = await addServer('jumped', id);
    await api('/api/known-hosts', 'POST', { host: `jump:${id}@127.0.0.1:${sshPort}|127.0.0.1`, port: sshPort, fingerprint });
    const token = await (await api('/api/mcp/tokens', 'POST', { name: 'SSH agent', server_ids: [id, jumped], scopes: ['read', 'write', 'exec'], expires_in_days: 1 })).json();
    client = new Client({ name: 'ssh-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    const failed = await client.callTool({ name: 'execute_command', arguments: { server_id: id, command: 'printf cloudssh-ok; printf diagnostic >&2; exit 7' } });
    assert.equal(failed.isError, true);
    const command = JSON.parse(failed.content[0].text);
    assert.equal(command.stdout, 'cloudssh-ok'); assert.equal(command.stderr, 'diagnostic'); assert.equal(command.exit_code, 7);
    const success = await call('execute_command', { server_id: id, command: 'printf cloudssh-ok' });
    assert.equal(success.stdout, 'cloudssh-ok'); assert.equal(success.exit_code, 0);
    const target = join(directory, "file ' with spaces.txt");
    await call('write_file', { server_id: id, path: target, content: 'hello\n世界\n' });
    const read = await call('read_file', { server_id: id, path: target });
    assert.equal(Buffer.from(read.stdout, 'base64').toString(), 'hello\n世界\n');

    // 面板命令片段：list_snippets 可见，run_snippet 逐字执行
    await api('/api/snippets', 'POST', { name: 'whoami fixture', command: 'printf snippet-ok', category: 'ops' });
    const snippetList = await call('list_snippets', {});
    const created = snippetList.snippets.find((item) => item.name === 'whoami fixture');
    assert.ok(created, JSON.stringify(snippetList));
    const snippetRun = await call('run_snippet', { server_id: id, snippet_id: created.id });
    assert.equal(snippetRun.stdout, 'snippet-ok');
    assert.equal(snippetRun.snippet_name, 'whoami fixture');

    // 分块下载：300 KiB 随机数据，逐块校验 sha256，末块 truncated=false
    const blobPath = join(directory, 'blob.bin');
    const blob = randomBytes(300 * 1024);
    writeFileSync(blobPath, blob);
    const localHash = (buffer) => createHash('sha256').update(buffer).digest('hex');
    let offset = 0; const downloaded = [];
    for (;;) {
      const chunk = await call('download_file', { server_id: id, path: blobPath, offset, max_bytes: 262144 });
      const raw = Buffer.from(chunk.content_base64, 'base64');
      assert.equal(chunk.size_bytes, blob.length);
      assert.equal(chunk.chunk_bytes, raw.length);
      assert.equal(chunk.content_sha256, localHash(raw));
      downloaded.push(raw); offset += raw.length;
      if (!chunk.truncated) break;
      assert.ok(offset < blob.length + 1024, 'download did not terminate');
    }
    assert.equal(Buffer.concat(downloaded).toString('hex'), blob.toString('hex'));

    // 分块上传：首块原子创建，后续 append，末尾 sha256 与木地一致
    const uploadPath = join(directory, 'upload.bin');
    const payload = randomBytes(300 * 1024);
    const payloadB64 = payload.toString('base64');
    for (let position = 0, index = 0; position < payloadB64.length; position += 128000, index++) {
      const uploaded = await call('upload_file', {
        server_id: id, path: uploadPath,
        content_base64: payloadB64.slice(position, position + 128000), append: index > 0,
      });
      assert.equal(uploaded.exit_code, 0);
    }
    const remoteHash = await call('execute_command', { server_id: id, command: `sha256sum -- ${JSON.stringify(uploadPath)}` });
    assert.match(remoteHash.stdout, new RegExp(`^${localHash(payload)}`));

    // 服务器信息概览：一条命令拿到 CPU/内存/磁盘/OS
    const info = await call('get_server_info', { server_id: id });
    assert.ok(info.cpu.cores >= 1, JSON.stringify(info));
    assert.ok(info.memory.total_bytes > 0);
    assert.ok(info.disk.total_bytes > 0);
    assert.ok(typeof info.os === 'string' && info.os.length > 0);
    assert.ok(info.uptime_seconds >= 0);

    const forwarded = await call('execute_command', { server_id: jumped, command: 'printf jump-ok' });
    assert.equal(forwarded.stdout, 'jump-ok');
    const blocked = await client.callTool({ name: 'execute_command', arguments: { server_id: id, command: 'rm -rf /' } });
    assert.equal(blocked.isError, true);
  } finally { sftpSocket?.close(); socket?.close(); await client?.close(); await stop(panel); await stop(sshd); rmSync(directory, { recursive: true, force: true }); }
});


test('administrator account migration, account/password changes, invalidation and restart', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-account-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'original-password-123'; const newPassword = 'updated-password-456';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let child;
  const derive = async (value) => {
    const config = await (await fetch(`${base}/api/config`)).json();
    return pbkdf2Sync(value, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
  };
  const login = (username, key) => fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, key }) });
  const cookieOf = (response) => response.headers.getSetCookie().find(value => value.startsWith('session=')).split(';')[0];
  const request = (cookie, path, method = 'GET', body, origin = base) => fetch(`${base}${path}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    child = await startPanel(directory, port);
    assert.ok(existsSync(join(directory, 'admin-account.json')));
    assert.equal(JSON.parse(readFileSync(join(directory, 'admin-account.json'), 'utf8')).username, 'admin');
    assert.equal((await fetch(`${base}/api/admin/account`)).status, 401);
    const key = await derive(password);
    assert.equal((await login(undefined, key)).status, 401);
    assert.equal((await login('wrong-name', key)).status, 401);
    const valid = await login('admin', key); assert.equal(valid.status, 200);
    let cookie = cookieOf(valid); const originalCookie = cookie;
    assert.equal((await request(cookie, '/account/settings')).status, 200);
    assert.equal((await request(cookie, '/api/admin/account', 'PUT', { username: 'operator', currentKey: key }, 'https://attacker.example')).status, 403);
    assert.equal((await request(cookie, '/api/admin/account', 'PUT', { username: 'bad name', currentKey: key })).status, 400);
    assert.equal((await request(cookie, '/api/admin/account', 'PUT', { username: 'operator', currentKey: key, passwordHash: 123 })).status, 400);
    assert.equal((await request(cookie, '/api/admin/account', 'PUT', { username: 'operator', currentKey: await derive('wrong-password') })).status, 401);
    const added = await request(cookie, '/api/servers', 'POST', { name: 'preserved', host: '127.0.0.1', port: 2222, username: 'root', auth_method: 'password', credential: 'fixture-only' });
    assert.equal(added.status, 201);
    const serverId = (await (await request(cookie, '/api/servers')).json())[0].id;
    const created = await request(cookie, '/api/mcp/tokens', 'POST', { name: 'preserved until password rotation', server_ids: [serverId], scopes: ['read'], expires_in_days: 1 });
    assert.equal(created.status, 201); const token = (await created.json()).token;
    const renamed = await request(cookie, '/api/admin/account', 'PUT', { username: 'operator', currentKey: key });
    assert.equal(renamed.status, 200); assert.equal((await renamed.json()).loginRequired, false);
    assert.equal((await request(originalCookie, '/api/auth/me')).status, 200);
    assert.equal((await login('admin', key)).status, 401);
    const renamedLogin = await login('operator', key); assert.equal(renamedLogin.status, 200); cookie = cookieOf(renamedLogin);
    assert.equal((await request(cookie, '/api/admin/account')).status, 200);
    assert.equal((await request(cookie, '/api/mcp/tokens')).status, 200);
    assert.equal((await (await request(cookie, '/api/mcp/tokens')).json())[0].revoked_at, null);
    if (process.env.SELF_HOSTED_BROWSER_TESTS === '1') {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext();
        const [name, ...value] = cookie.split('=');
        await context.addCookies([{ name, value: value.join('='), url: base }]);
        const page = await context.newPage(); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${base}/account/settings`);
        await page.locator('#save:not([disabled])').waitFor();
        assert.equal(await page.locator('#username').inputValue(), 'operator');
        for (const locale of ['en-US', 'zh-TW', 'zh-CN']) {
          await page.locator('#language').selectOption(locale);
          assert.equal(await page.locator('html').getAttribute('lang'), locale);
        }
        await page.locator('#username').fill('operator2');
        await page.locator('#current-password').fill(password);
        await page.locator('#new-password').fill(newPassword);
        await page.locator('#confirm-password').fill('mismatched-password');
        await page.locator('#save').click();
        await page.getByText('两次输入的新密码不一致。', { exact: true }).waitFor();
        await page.locator('#confirm-password').fill(newPassword);
        await page.locator('#save').click();
        await page.getByText('密码已更新，请使用新账号和密码重新登录。', { exact: true }).waitFor();
        await page.goto(`${base}/?lang=zh-CN`);
        await page.locator('#admin-login-btn').click();
        await page.locator('#admin-login-dialog input[name=username]').fill('operator2');
        await page.locator('#admin-login-dialog input[type=password]').fill(newPassword);
        await page.locator('#admin-login-dialog .auth-challenge-dialog__button--submit').click();
        await page.locator('#admin-account-link').waitFor({ state: 'visible' });
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    } else {
      const salt = randomBytes(16); const stretched = pbkdf2Sync(newPassword, salt, 600000, 32, 'sha256');
      const passwordHash = `pbkdf2$sha256$600000$${salt.toString('base64url')}$${createHash('sha256').update(stretched).digest('base64url')}`;
      const updated = await request(cookie, '/api/admin/account', 'PUT', { username: 'operator2', currentKey: key, passwordHash });
      assert.equal(updated.status, 200); assert.equal((await updated.json()).loginRequired, true);
    }
    assert.equal((await request(originalCookie, '/api/auth/me')).status, 401);
    assert.equal((await request(cookie, '/api/admin/account')).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await login('operator2', key)).status, 401);
    const newLogin = await login('operator2', await derive(newPassword)); assert.equal(newLogin.status, 200); cookie = cookieOf(newLogin);
    assert.equal((await (await request(cookie, '/api/servers')).json())[0].name, 'preserved');
    assert.ok((await (await request(cookie, '/api/mcp/tokens')).json())[0].revoked_at);
    await stop(child); child = await startPanel(directory, port);
    assert.equal((await (await request(cookie, '/api/admin/account')).json()).username, 'operator2');
    assert.equal((await login('operator2', await derive(newPassword))).status, 200);
  } finally { await stop(child); rmSync(directory, { recursive: true, force: true }); }
});
