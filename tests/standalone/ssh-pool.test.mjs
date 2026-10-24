// End-to-end coverage for the pooled persistent SSH chains behind
// executeSaved (standalone). Reuse is proven with `$PPID`: every exec channel
// spawned over the same authenticated SSH connection reports the same sshd
// session process as its parent, while a freshly built chain reports a
// different one. Requires a real sshd (root-capable runners only).
import test from 'node:test';
import { solveCaptcha } from './captcha-helper.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pbkdf2Sync } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

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

test('SSH chains are pooled per server and expire after the idle TTL', {
  timeout: 120000, skip: !existsSync('/usr/sbin/sshd') || process.getuid?.() !== 0,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-pool-'));
  const sshPort = await freePort(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const hostKey = join(directory, 'host-key'), clientKey = join(directory, 'client-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(join(directory, 'authorized_keys'), readFileSync(`${clientKey}.pub`));
  const sshConfig = join(directory, 'sshd_config');
  writeFileSync(sshConfig, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${directory}/authorized_keys\nStrictModes no\nPermitRootLogin yes\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nLogLevel ERROR\nSubsystem sftp internal-sftp\nAllowTcpForwarding yes\n`);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  let panel; let socket = null;
  const { WebSocket } = await import('ws');
  try {
    await delay(150); assert.equal(sshd.exitCode, null);
    const password = 'fixture-password-123';
    const dataDir = join(directory, 'data');
    execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: dataDir }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
    // Short pool TTL so expiry is observable within the test budget.
    panel = spawn(process.execPath, ['standalone/server.mjs'], {
      cwd: resolve('.'), env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), BASE_URL: base, CAPTCHA_MODE: 'test', SSH_POOL_IDLE_MS: '3000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = ''; panel.stdout.on('data', (data) => { logs += data; }); panel.stderr.on('data', (data) => { logs += data; });
    for (let i = 0; i < 100; i++) {
      try { const response = await fetch(`${base}/api/health`); if (response.ok) break; } catch { /* Starting. */ }
      if (panel.exitCode !== null) throw new Error(logs);
      await delay(50);
    }

    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    const added = await api('/api/servers', 'POST', { name: 'pool-box', host: '127.0.0.1', port: sshPort, username: userInfo().username, auth_method: 'publickey', credential: readFileSync(clientKey, 'utf8') });
    assert.equal(added.status, 201);
    const id = (await (await api('/api/servers')).json()).find((item) => item.name === 'pool-box').id;

    // Trust the host key through the real connect flow, then close the terminal.
    const connection = await (await api(`/api/servers/${id}/connect`, 'POST')).json();
    socket = new WebSocket(connection.wsUrl || connection.ws_url || connection.url, { headers: { Cookie: cookie, Origin: base } });
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Panel SSH handshake timed out')), 20000);
      socket.on('message', (data, binary) => {
        if (binary) return;
        const event = JSON.parse(data.toString());
        if (event.type === 'host_key_verified') {
          void api('/api/known-hosts', 'POST', { host: event.knownHostIdentity || '127.0.0.1', port: sshPort, fingerprint: event.fingerprint });
        }
        if (event.event === 'shell_ready') { clearTimeout(timer); resolveReady(); }
        if (event.type === 'error') { clearTimeout(timer); reject(new Error(event.message)); }
      });
      socket.on('error', reject);
    });
    socket.close(); socket = null;

    const runEcho = async () => {
      const task = await api('/api/automation/cron', 'POST', { name: `pool-${Date.now()}-${Math.random()}`, server_id: id, command: 'echo POOLTEST:$PPID', cron_expr: '0 4 * * *', timeout_seconds: 30, notify_on_failure: false, enabled: false });
      assert.equal(task.status, 201);
      const run = await api(`/api/automation/cron/${(await task.json()).id}/run`, 'POST');
      assert.equal(run.status, 200);
      const output = (await run.json()).output?.stdout ?? '';
      const ppid = output.match(/POOLTEST:(\d+)/)?.[1];
      assert.ok(ppid, `echo must print PPID, got ${JSON.stringify(output)}`);
      return ppid;
    };

    // Back-to-back runs share the pooled chain: identical sshd parent process.
    const first = await runEcho();
    const second = await runEcho();
    assert.equal(first, second, 'consecutive commands must reuse the pooled SSH chain');

    // After the idle TTL the chain is closed; the next run gets a new one.
    await delay(4500);
    const third = await runEcho();
    assert.notEqual(first, third, 'expired chain must be replaced by a fresh connection');
  } finally {
    socket?.close(); await stop(panel); await stop(sshd); rmSync(directory, { recursive: true, force: true });
  }
});
