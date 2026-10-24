import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationStore } from '../../standalone/automation-store.mjs';
import { DashboardEngine } from '../../standalone/dashboard.mjs';

const OWNER = 'gh-1';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cloudssh-dash-'));
  const store = new AutomationStore(join(dir, 'automation.sqlite'));
  return { store, dir };
}

/** Output in the real STATUS_SCRIPT marker format the parser expects. */
function statusOutput({ cpuPercent = 90 } = {}) {
  // Deltas chosen so the derived usage equals cpuPercent exactly:
  // Δtotal=100, Δidle=100−cpuPercent, usage=(100−Δidle)/100.
  const idle2 = 9000 + Math.round(100 * (1 - cpuPercent / 100));
  const user2 = 10100 - idle2;
  const lines = [
    'HOSTNAME:box',
    'UPTIME:123456',
    'LOADAVG:0.50 0.40 0.30 1/100 1234',
    'MEMINFO:MemTotal: 7818876 kB;MemAvailable: 4691324 kB;SwapTotal: 0 kB;SwapFree: 0 kB',
    'DISK:/dev/sda1 8589934592 4294967296 4294967296 50% /',
    'CPUCORES:4',
    'CPUMODEL: Test CPU',
    'OSRELEASE:Test Linux 1.0',
    'UNAME:TestLinux 1.0',
    'ARCH:x86_64',
    'STAT1:cpu  1000 0 0 9000 0 0 0 0 0 0 0',
    'NET1:  eth0: 1000 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0',
    `STAT2:cpu  ${user2} 0 0 ${idle2} 0 0 0 0 0 0 0`,
    'NET2:  eth0: 3024 0 0 0 0 0 0 0 1524 0 0 0 0 0 0 0',
    'UPTIME2:123457',
  ];
  return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
}

function makeEngine({ store, servers, outputs = new Map(), clock = 1_000_000 } = {}) {
  const executed = [];
  let now = clock;
  const engine = new DashboardEngine({
    env: {},
    store,
    executeSaved: async (_env, _identity, serverId) => {
      executed.push(serverId);
      const next = outputs.get(serverId);
      if (next instanceof Error) throw next;
      return next || { stdout: '', stderr: '', exitCode: 0 };
    },
    SSHSession: {},
    now: () => now,
    log: () => {},
    intervalSeconds: 60,
    savedServers: async () => servers,
  });
  return { engine, executed, advance: (ms) => { now += ms; } };
}

test('dashboard collects concurrently per monitoring-enabled server and pushes snapshots', async () => {
  const { store, dir } = freshStore();
  try {
    // Monitoring-enabled servers 11/12 are collected; disabled 13 is not.
    store.saveMonitor(OWNER, { id: 1, github_id: OWNER }, 11, { interval_seconds: 60, failure_threshold: 2, enabled: true });
    store.saveMonitor(OWNER, { id: 1, github_id: OWNER }, 12, { interval_seconds: 60, failure_threshold: 2, enabled: true });
    store.saveMonitor(OWNER, { id: 1, github_id: OWNER }, 13, { interval_seconds: 60, failure_threshold: 2, enabled: false });

    const servers = [
      { id: 11, name: 'alpha', host: '10.0.0.11', transport_type: 'direct' },
      { id: 12, name: 'beta', host: '10.0.0.12', transport_type: 'direct' },
      { id: 13, name: 'disabled', host: '10.0.0.13', transport_type: 'direct' },
    ];
    const outputs = new Map([[11, statusOutput()], [12, statusOutput({ cpuPercent: 25 })]]);
    const { engine, executed } = makeEngine({ store, servers, outputs });

    const updates = [];
    const unsubscribe = engine.subscribe(OWNER, (snapshot) => updates.push(snapshot));
    await engine.tick();

    assert.equal(executed.length, 2, 'only monitoring-enabled servers collected');
    assert.ok(!executed.includes(13), 'disabled monitor is skipped');
    assert.equal(engine.snapshots(OWNER).length, 2);
    assert.equal(updates.length, 2, 'each collection pushed to subscribers');

    const alpha = engine.snapshots(OWNER).find((snapshot) => snapshot.server_id === 11);
    assert.equal(alpha.ok, true);
    assert.equal(alpha.cpu_percent, 90);
    assert.equal(alpha.cores, 4);
    assert.equal(alpha.load1, 0.5);
    assert.equal(alpha.mem_percent, 40);
    assert.equal(alpha.disk_percent, 50);
    assert.equal(alpha.rx_kbps, 2, 'net rate derived from 1s sample delta');
    assert.equal(alpha.tx_kbps, 1);
    assert.equal(alpha.uptime_seconds, 123456);

    const samples = store.listSamples(OWNER, 11, 0);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].ok, 1);
    assert.equal(samples[0].cpu_percent, 90);
    assert.equal(samples[0].rx_kbps, 2, 'metrics persisted next to latency');
    unsubscribe();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed collections produce error snapshots without stalling the fleet', async () => {
  const { store, dir } = freshStore();
  try {
    store.saveMonitor(OWNER, { id: 1, github_id: OWNER }, 21, { interval_seconds: 60, failure_threshold: 2, enabled: true });
    store.saveMonitor(OWNER, { id: 1, github_id: OWNER }, 22, { interval_seconds: 60, failure_threshold: 2, enabled: true });
    const servers = [
      { id: 21, name: 'good', host: '10.0.1.21', transport_type: 'direct' },
      { id: 22, name: 'bad', host: '10.0.1.22', transport_type: 'direct' },
    ];
    const outputs = new Map([
      [21, statusOutput()],
      [22, new Error('Status collection failed: fingerprint not trusted')],
    ]);
    const { engine } = makeEngine({ store, servers, outputs });
    await engine.tick();

    const snapshots = engine.snapshots(OWNER);
    const good = snapshots.find((snapshot) => snapshot.server_id === 21);
    const bad = snapshots.find((snapshot) => snapshot.server_id === 22);
    assert.equal(good.ok, true);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /fingerprint not trusted/);
    const samples22 = store.listSamples(OWNER, 22, 0);
    assert.equal(samples22.length, 1);
    assert.equal(samples22[0].ok, 0, 'failures recorded as down samples');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- spawned end-to-end over the HTTP API ----------
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import { solveCaptcha } from './captcha-helper.mjs';

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
    cwd: resolve('.'), env: { ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, CAPTCHA_MODE: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', (data) => { logs += data; }); child.stderr.on('data', (data) => { logs += data; });
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return child; } catch { /* Starting. */ }
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((done) => setTimeout(done, 50));
  }
  await stop(child); throw new Error(`Server startup timed out: ${logs}`);
}

test('dashboard API and SSE stream require auth and report collection errors', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-dash-e2e-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let child;
  try {
    child = await startPanel(directory, port);
    // Login follows the real flow: PBKDF2 key + test-mode captcha (fixed answer).
    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    assert.equal(login.status, 200, `login failed: ${await login.text()}`);
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];

    // Unauthenticated access is rejected.
    assert.equal((await fetch(`${base}/api/dashboard/snapshots`)).status, 401);
    assert.equal((await fetch(`${base}/api/dashboard/history?server_id=1`)).status, 401);

    // Save a server pointing at a closed port so dashboard collection fails fast.
    const added = await fetch(`${base}/api/servers`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'dead', host: '127.0.0.1', port: 9, username: 'nobody', auth_method: 'password', credential: 'wrong' }) });
    assert.equal(added.status, 201);
    const serverId = ((await (await fetch(`${base}/api/servers`, { headers: { Cookie: cookie } })).json())[0]).id;
    const monitor = await fetch(`${base}/api/automation/monitor/${serverId}`, { method: 'PUT', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ interval_seconds: 3600, failure_threshold: 3, enabled: true }) });
    assert.equal(monitor.status, 200, `monitor save failed: ${await monitor.text()}`);

    // The SSE stream must answer auth'd requests with an initial snapshot frame.
    const controller = new AbortController();
    const streamResponse = await fetch(`${base}/api/dashboard/stream`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstFrame = null;
    let updated = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !updated) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (frame.startsWith('data:')) {
          const payload = JSON.parse(frame.slice(5));
          if (!firstFrame) firstFrame = payload;
          if (payload.type === 'update') { updated = true; break; }
        }
        separator = buffer.indexOf('\n\n');
      }
    }
    controller.abort();
    assert.ok(firstFrame && firstFrame.type === 'snapshot', 'SSE stream opened with a snapshot frame');
    assert.ok(updated, 'SSE stream pushed a collection update');

    // Snapshots and history reflect the failed collection as a down sample.
    const snapshots = await (await fetch(`${base}/api/dashboard/snapshots`, { headers: { Cookie: cookie } })).json();
    assert.equal(snapshots.snapshots.length, 1);
    assert.equal(snapshots.snapshots[0].ok, false);
    const history = await (await fetch(`${base}/api/dashboard/history?server_id=${serverId}`, { headers: { Cookie: cookie } })).json();
    assert.equal(history.samples.length >= 1, true);
    assert.equal(history.samples.every((sample) => sample.ok === 0 || sample.ok === 1), true);
  } finally {
    await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
test('metric columns are idempotent-migrated and monitor identities are enumerable', async () => {
  const { store, dir } = freshStore();
  try {
    // Second construction runs the ALTER migrations again — must not throw.
    const again = new AutomationStore(join(dir, 'automation.sqlite'));
    store.insertSample(OWNER, 31, { ts: 1000, ok: true, latency_ms: 42, cpu_percent: 7.5, mem_percent: 61, rx_kbps: 3, tx_kbps: 4 });
    again.insertSample(OWNER, 31, { ts: 2000, ok: false, latency_ms: null });
    const samples = again.listSamples(OWNER, 31, 0);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].cpu_percent, 7.5);
    assert.equal(samples[1].cpu_percent, null, 'probe-only rows keep null metrics');
    assert.deepEqual(
      store.listEnabledMonitorIdentities(),
      [],
      'no monitors yet — dashboard tick would be a no-op',
    );
    store.saveMonitor(OWNER, { id: 1, github_id: OWNER }, 31, { interval_seconds: 60, failure_threshold: 2, enabled: true });
    assert.equal(store.listEnabledMonitorIdentities().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
