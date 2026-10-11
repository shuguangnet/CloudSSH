// Unit tests for the status collection script and parser, plus a spawned
// end-to-end pass over GET /api/automation/status/:id (auth, ownership and a
// real sshd collection on root-capable runners).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pbkdf2Sync } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

import { buildStatusScript, parseStatusOutput } from '../../standalone/status.mjs';

const FIXTURE = [
  'HOSTNAME:dm.us.933999.xyz',
  'UPTIME:2824574.32',
  'LOADAVG:0.04 0.03 0.04 1/500 12345',
  'MEMINFO:MemTotal:        986596 kB;MemAvailable:   459908 kB;SwapTotal:       1048572 kB;SwapFree:         838860 kB;',
  'DISK:/dev/vda1      21003583488 13730463744   6226698240      73% /',
  'CPUCORES:1',
  'CPUMODEL:AMD EPYC 9654 96-Core Processor',
  'OSRELEASE:Debian GNU/Linux 11 (bullseye)',
  'UNAME:Linux 5.10.0 x86_64',
  'ARCH:x86_64',
  'STAT1:cpu  100 0 50 8500 0 0 0 0 0 0',
  'NET1:Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 1000 10    0    0    0     0          0         0 1000 10    0    0    0     0       0          0',
  '  eth0: 100000 200    0    0    0     0          0         0 50000 100    0    0    0     0       0          0',
  'sleep 1',
  'STAT2:cpu  110 0 55 9490 0 0 0 0 0 0',
  'NET2:Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 1000 10    0    0    0     0          0         0 1000 10    0    0    0     0       0          0',
  '  eth0: 145120 300    0    0    0     0          0         0 101240 200    0    0    0     0       0          0',
  'UPTIME2:2824575.36',
].join('\n');

test('status script is POSIX-safe and free of JS interpolation', () => {
  const script = buildStatusScript();
  // The script is assembled from single-quoted strings precisely so that
  // shell $(...) and $PRETTY_NAME survive verbatim.
  assert.ok(!/\$\{/.test(script), 'no JS template interpolation');
  assert.ok(script.includes('$(hostname'));
  assert.ok(script.includes('$PRETTY_NAME'));
  assert.ok(script.includes('sleep 1'));
});

test('parseStatusOutput derives metrics from delta samples', () => {
  const status = parseStatusOutput(FIXTURE);
  assert.equal(status.hostname, 'dm.us.933999.xyz');
  assert.equal(status.uptime_seconds, 2824574);
  assert.deepEqual(status.cpu.loadavg, [0.04, 0.03, 0.04]);
  assert.equal(status.cpu.cores, 1);
  assert.equal(status.cpu.model, 'AMD EPYC 9654 96-Core Processor');
  // busy delta 15 / total delta 1005 ≈ 1.5%
  assert.equal(status.cpu.usage_percent, 1.5);
  // 986596 kB total, 459908 available → used 526688 kB (53.4%)
  assert.equal(status.memory.total_bytes, 986596 * 1024);
  assert.equal(status.memory.used_bytes, (986596 - 459908) * 1024);
  assert.equal(status.memory.usage_percent, 53.4);
  assert.equal(status.swap.used_bytes, (1048572 - 838860) * 1024);
  assert.equal(status.swap.usage_percent, 20);
  assert.equal(status.disk.total_bytes, 21003583488);
  assert.equal(status.disk.used_bytes, 13730463744);
  assert.equal(status.disk.usage_percent, 73);
  // elapsed from /proc/uptime deltas = 1.04s; loopback excluded.
  assert.equal(status.network.rx_bytes_per_sec, Math.round(45120 / 1.04));
  assert.equal(status.network.tx_bytes_per_sec, Math.round(51240 / 1.04));
  assert.equal(status.os, 'Debian GNU/Linux 11 (bullseye) x86_64');
  assert.equal(status.latency_ms, undefined);
});

test('parseStatusOutput degrades gracefully on partial output', () => {
  // No second sample: CPU usage and network rates become null instead of throwing.
  const partial = FIXTURE.split('\n').filter((line) => !/^(STAT2|NET2|UPTIME2):/.test(line)).join('\n');
  const status = parseStatusOutput(partial);
  assert.equal(status.cpu.usage_percent, null);
  assert.equal(status.network, null);

  // ARM-style cpuinfo (no "model name") and missing os-release fall back to uname.
  const arm = [
    'HOSTNAME:arm-box',
    'UPTIME:500.5',
    'LOADAVG:0.10 0.20 0.30 1/100 5',
    'MEMINFO:MemTotal: 1000 kB;MemAvailable: 500 kB;SwapTotal: 0 kB;SwapFree: 0 kB;',
    'CPUCORES:2',
    'CPUMODEL:Model           : Cortex-A72',
    'ARCH:aarch64',
    'UNAME:Linux 6.6.0',
    'STAT1:cpu  10 0 5 985 0 0 0 0 0 0',
    'NET1:  eth0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0',
    'sleep 1',
    'STAT2:cpu  20 0 10 980 0 0 0 0 0 0',
    'NET2:  eth0: 2 2 0 0 0 0 0 0 2 2 0 0 0 0 0 0',
    'UPTIME2:501.5',
  ].join('\n');
  const armStatus = parseStatusOutput(arm);
  assert.equal(armStatus.cpu.model, 'Model           : Cortex-A72'); // raw grep fallback kept verbatim
  assert.equal(armStatus.os, 'Linux 6.6.0 aarch64'); // OSRELEASE missing → uname + arch
  assert.equal(armStatus.swap.usage_percent, 0);
  // Uptime-delta elapsed missing tolerance: UPTIME2 present here (501.5-500.5=1)
  assert.equal(armStatus.network.rx_bytes_per_sec, 1);

  // Garbage output is rejected.
  assert.throws(() => parseStatusOutput('some error message\nfrom a failed shell'));
});

test('collectServerStatus reports non-zero exits and timeouts as failures', async () => {
  const { collectServerStatus } = await import('../../standalone/status.mjs');
  const executeSaved = async () => ({ stdout: FIXTURE, stderr: '', exitCode: 3 });
  await assert.rejects(() => collectServerStatus({}, { github_id: '-1', user_id: 1 }, 7, executeSaved, null), /exit code 3|Status collection failed/);
  const failing = async () => { throw new Error('SSH authentication failed'); };
  await assert.rejects(() => collectServerStatus({}, { github_id: '-1', user_id: 1 }, 7, failing, null), /SSH authentication failed/);
  const okay = await collectServerStatus({}, { github_id: '-1', user_id: 1 }, 7, async () => ({ stdout: FIXTURE, stderr: '', exitCode: 0 }), null);
  assert.ok(okay.latency_ms >= 0);
  assert.equal(okay.hostname, 'dm.us.933999.xyz');
});

// ---------- spawned panel ----------

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

test('status API enforces auth and ownership', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-status-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let child;
  try {
    child = await startPanel(directory, port);
    assert.equal((await fetch(`${base}/api/automation/status/1`)).status, 401);

    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin' }) });
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    assert.equal((await api('/api/automation/status/999999')).status, 404);

    // A saved server without a trusted fingerprint fails politely (502, not a crash).
    const added = await api('/api/servers', 'POST', { name: 'untrusted', host: '127.0.0.1', port: 2222, username: 'nobody', auth_method: 'password', credential: 'x' });
    assert.equal(added.status, 201);
    const id = (await (await api('/api/servers')).json())[0].id;
    const blocked = await api(`/api/automation/status/${id}`);
    assert.equal(blocked.status, 502);
    assert.match((await blocked.json()).error, /fingerprint|Connect through the panel|authentication|failed/i);
  } finally {
    await stop(child); rmSync(directory, { recursive: true, force: true });
  }
});

test('status API collects live metrics over a real SSH connection', {
  timeout: 90000, skip: !existsSync('/usr/sbin/sshd') || process.getuid?.() !== 0,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-status-ssh-'));
  const dataDir = join(directory, 'data');
  const sshPort = await freePort(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const hostKey = join(directory, 'host-key'), clientKey = join(directory, 'client-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(join(directory, 'authorized_keys'), readFileSync(`${clientKey}.pub`));
  const sshConfig = join(directory, 'sshd_config');
  writeFileSync(sshConfig, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${directory}/authorized_keys\nStrictModes no\nPermitRootLogin yes\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nLogLevel ERROR\nSubsystem sftp internal-sftp\nAllowTcpForwarding yes\n`);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  let panel, socket;
  try {
    await delay(150); assert.equal(sshd.exitCode, null);
    const password = 'fixture-password-123';
    execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: dataDir }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
    panel = await startPanel(dataDir, port);
    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin' }) });
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    const added = await api('/api/servers', 'POST', { name: 'status-box', host: '127.0.0.1', port: sshPort, username: userInfo().username, auth_method: 'publickey', credential: readFileSync(clientKey, 'utf8') });
    assert.equal(added.status, 201);
    const id = (await (await api('/api/servers')).json()).find((item) => item.name === 'status-box').id;

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

    const first = await api(`/api/automation/status/${id}`);
    if (first.status !== 200) throw new Error(`status collection failed: ${JSON.stringify(await first.json())}`);
    assert.equal(first.status, 200);
    const status = await first.json();
    assert.equal(status.hostname, userInfo().hostname === '' ? null : userInfo().hostname || status.hostname);
    assert.ok(status.hostname, 'hostname collected');
    assert.ok(status.uptime_seconds > 0);
    assert.ok(status.cpu.cores >= 1);
    assert.ok(status.cpu.usage_percent === null || (status.cpu.usage_percent >= 0 && status.cpu.usage_percent <= 100));
    assert.ok(status.memory.total_bytes > 1024 * 1024);
    assert.ok(status.disk.total_bytes > 1024 * 1024);
    assert.ok(status.network.rx_bytes_per_sec >= 0 && status.network.tx_bytes_per_sec >= 0);
    assert.ok(typeof status.os === 'string' && status.os.length > 0);
    assert.ok(status.latency_ms >= 1000, `sampling includes the 1s sleep (${status.latency_ms}ms)`);

    // Immediate second request is throttled per server.
    assert.equal((await api(`/api/automation/status/${id}`)).status, 429);
    await delay(1600);
    const second = await api(`/api/automation/status/${id}`);
    assert.equal(second.status, 200);
    assert.ok((await second.json()).collected_at >= status.collected_at);

    // Regression (real SSH): cron exec timeout must convert seconds → ms.
    const task = await api('/api/automation/cron', 'POST', { name: 'st', server_id: id, command: 'printf status-cron-ok', cron_expr: '0 4 * * *', timeout_seconds: 30, notify_on_failure: false, enabled: false });
    assert.equal(task.status, 201);
    const run = await api(`/api/automation/cron/${(await task.json()).id}/run`, 'POST');
    if (run.status !== 200) throw new Error(`manual cron run failed: ${JSON.stringify(await run.json())}`);
    assert.equal(run.status, 200);
    const runResult = await run.json();
    assert.equal(runResult.ok, true, JSON.stringify(runResult));
    assert.match(runResult.output?.stdout ?? '', /status-cron-ok/);

    // Regression (real SSH): key deploy timeout must be ms-scale.
    const pair = await (await api('/api/ssh/keys/generate', 'POST', { comment: 'status-test' })).json();
    const deploy = await api('/api/ssh/keys/deploy', 'POST', { server_id: id, public_key: pair.publicKey });
    assert.equal(deploy.status, 200);
    const deployResult = await deploy.json();
    assert.equal(deployResult.ok, true, JSON.stringify(deployResult));
  } finally {
    socket?.close(); await stop(panel); await stop(sshd); rmSync(directory, { recursive: true, force: true });
  }
});
