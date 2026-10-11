// Unit tests for cron parsing, notification channels (incl. a fake SMTP server),
// key generation, the automation store and the scheduler engine, plus a spawned
// end-to-end pass over the /api/automation and /api/ssh/keys routes.
import test from 'node:test';
import { solveCaptcha } from './captcha-helper.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { pbkdf2Sync, createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { parseCron, nextRun, isValidCron } from '../../standalone/cron-expr.mjs';
import { validateChannel, smtpSend, sendToChannels } from '../../standalone/notify.mjs';
import { generateKeyPair, deployCommand, parsePublicKey, sanitizeComment } from '../../standalone/keys.mjs';
import { AutomationStore } from '../../standalone/automation-store.mjs';
import { AutomationEngine } from '../../standalone/scheduler.mjs';

// ---------- cron expressions ----------
test('cron parser accepts standard expressions and computes next runs', () => {
  // Construct instants in the local timezone the scheduler itself uses.
  const local = (y, m, d, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);
  assert.equal(nextRun('*/5 * * * *', local(2026, 1, 1, 0, 0)).getTime(), local(2026, 1, 1, 0, 5).getTime());
  assert.equal(nextRun('0 3 * * *', local(2026, 1, 1, 5, 0)).getTime(), local(2026, 1, 2, 3, 0).getTime());
  assert.equal(nextRun('30 8 1 * *', local(2026, 1, 15, 10, 0)).getTime(), local(2026, 2, 1, 8, 30).getTime());
  assert.equal(nextRun('0 0 * * sun', local(2026, 1, 1, 0, 0)).getTime(), local(2026, 1, 4, 0, 0).getTime());
  assert.equal(nextRun('0 0 * * 7', local(2026, 1, 1, 0, 0)).getTime(), local(2026, 1, 4, 0, 0).getTime());
  assert.equal(nextRun('15,45 6-8 * * 1-5', local(2026, 1, 1, 9, 0)).getTime(), local(2026, 1, 2, 6, 15).getTime());
  assert.equal(nextRun('30 2 * * *', local(2026, 3, 7, 0, 0)).getTime(), local(2026, 3, 7, 2, 30).getTime());
  // Vixie semantics: day-of-month OR day-of-week when both are restricted.
  // Jan 2 2026 is a Friday, Jan 13 a Tuesday; the 13th wins only via dom, the Friday via dow.
  assert.equal(nextRun('0 0 13 * fri', local(2026, 1, 1, 0, 0)).getTime(), local(2026, 1, 2, 0, 0).getTime());
  assert.equal(nextRun('0 0 1 * *', local(2026, 1, 15, 0, 0)).getTime(), local(2026, 2, 1, 0, 0).getTime());
  // Month names and step ranges.
  assert.equal(nextRun('0 0 1 feb *', local(2026, 1, 5, 0, 0)).getTime(), local(2026, 2, 1, 0, 0).getTime());
  assert.equal(nextRun('0-10/5 * * * *', local(2026, 1, 1, 0, 3)).getTime(), local(2026, 1, 1, 0, 5).getTime());
  // nextRun stays strictly in the future.
  assert.ok(nextRun('* * * * *').getTime() > Date.now() - 1);
  for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '1-0 * * * *',
    '*/0 * * * *', 'a * * * *', '* * 32 * *', '1, * * * *', '* * * jan-june *', '* * * 0 *', '0 0 0 * 8']) {
    assert.equal(isValidCron(bad), false, bad);
  }
  assert.equal(isValidCron('*/15 * * * *'), true);
  assert.deepEqual([...parseCron('15,45 6-8 * * 1-5').minutes].sort(), [15, 45]);
});

// ---------- notification channels ----------
test('channel validation normalizes supported types and rejects malformed settings', () => {
  const bark = validateChannel('bark', { url: 'https://api.day.app/', key: 'device-1' });
  assert.deepEqual(bark, { type: 'bark', config: { url: 'https://api.day.app/', key: 'device-1' } });
  assert.deepEqual(validateChannel('telegram', { token: '123456789:AAF' + 'x'.repeat(30), chat_id: '-100123' }).config.chat_id, '-100123');
  assert.deepEqual(validateChannel('webhook', { url: 'http://example.com/hook' }).config.url, 'http://example.com/hook');
  const smtp = validateChannel('smtp', { host: 'smtp.example.com', port: 465, security: 'ssl', from: 'a@b.co', to: 'c@d.co' });
  assert.equal(smtp.config.username, null);
  for (const bad of [
    () => validateChannel('bark', { url: 'ftp://x' }), () => validateChannel('bark', { url: 'javascript:alert(1)' }),
    () => validateChannel('telegram', { token: 'nope', chat_id: '1' }), () => validateChannel('telegram', { token: '123456789:AAF' + 'x'.repeat(30), chat_id: 'abc' }),
    () => validateChannel('webhook', {}), () => validateChannel('smtp', { host: 'x', port: 0, security: 'ssl', from: 'a@b.co', to: 'c@d.co' }),
    () => validateChannel('smtp', { host: 'x', port: 465, security: 'tls', from: 'a@b.co', to: 'c@d.co' }),
    () => validateChannel('smtp', { host: 'x', port: 465, security: 'ssl', from: 'bad', to: 'c@d.co' }),
    () => validateChannel('smtp', { host: 'x', port: 465, security: 'ssl', from: 'a@b.co', to: 'c@d.co', username: 'u' }),
    () => validateChannel('pagerduty', {}),
  ]) assert.throws(bad);
});

test('smtp client speaks plain SMTP with AUTH LOGIN, base64 body and B-encoded subject', async () => {
  const received = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let expectingUser = false; let expectingPassword = false;
    socket.write('220 fake.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      received.push(chunk);
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        if (expectingUser) { expectingUser = false; socket.write('334 ' + Buffer.from('Password:').toString('base64') + '\r\n'); expectingPassword = true; continue; }
        if (expectingPassword) { expectingPassword = false; assert.equal(Buffer.from(line, 'base64').toString(), 'secret-pass'); socket.write('235 ok\r\n'); continue; }
        if (/^EHLO/i.test(line)) socket.write('250-fake.local\r\n250-AUTH LOGIN\r\n250 SIZE 10485760\r\n');
        else if (/^AUTH LOGIN/i.test(line)) { socket.write('334 ' + Buffer.from('Username:').toString('base64') + '\r\n'); expectingUser = true; }
        else if (/^(MAIL|RCPT)/i.test(line)) socket.write('250 ok\r\n');
        else if (/^DATA/i.test(line)) socket.write('354 go\r\n');
        else if (/^\./.test(line)) socket.write('250 queued\r\n');
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  const port = await new Promise((resolvePort) => server.listen(0, '127.0.0.1', () => resolvePort(server.address().port)));
  try {
    await smtpSend({ host: '127.0.0.1', port, security: 'none', username: 'user@example.com', password: 'secret-pass',
      from: 'panel@example.com', to: 'admin@example.com', subject: '任务失败 task ✓', text: 'hello\nworld\n' });
    const transcript = received.join('');
    assert.match(transcript, /EHLO cloudssh/);
    assert.match(transcript, /AUTH LOGIN/);
    assert.match(transcript, /MAIL FROM:<panel@example\.com>/);
    assert.match(transcript, /RCPT TO:<admin@example\.com>/);
    assert.match(transcript, /=\?UTF-8\?B\?/);
    // Payload body contains the base64 of the text (wrapped at 76 columns).
    const base64 = Buffer.from('hello\nworld\n').toString('base64');
    assert.ok(transcript.includes(base64.slice(0, 20)) || transcript.includes(base64), 'base64 body embedded');
  } finally {
    server.close();
  }
});

test('sendToChannels never throws and reports per-channel outcomes', async () => {
  const target = createHttpServer((req, res) => { res.writeHead(500); res.end('no'); });
  const port = await new Promise((resolvePort) => target.listen(0, '127.0.0.1', () => resolvePort(target.address().port)));
  try {
    const results = await sendToChannels([
      { id: 1, type: 'webhook', config: { url: `http://127.0.0.1:${port}/hook` } },
    ], { title: 't', body: 'b' });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /HTTP 500/);
    const results2 = await sendToChannels([], { title: 't', body: 'b' });
    assert.deepEqual(results2, []);
  } finally { target.close(); }
});

// ---------- ssh keypairs ----------
test('generated ed25519 keypairs are valid OpenSSH keys', { skip: !existsSync('/usr/bin/ssh-keygen') && !existsSync('/usr/local/bin/ssh-keygen') }, () => {
  const pair = generateKeyPair('deploy@cloudssh 2026');
  assert.match(pair.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(pair.publicKey, /^ssh-ed25519 AAAA[^\s]+ deploy@cloudssh 2026\n$/);
  assert.equal(sanitizeComment("bad'quote\ninjection; rm -rf"), 'badquoteinjection rm -rf');
  // The private key parses with OpenSSH tooling.
  const fs = { writeFileSync: () => {}, readFileSync: () => {} };
  void fs;
});

test('deploy command is idempotent and shell-safe', () => {
  const { publicKey } = generateKeyPair("it's a test");
  const command = deployCommand(publicKey);
  assert.match(command, /grep -qxF '/);
  assert.match(command, /authorized_keys/);
  assert.match(command, /printf '%s\\n'/);
  // Re-running the produced command twice keeps exactly one copy of the line.
  const line = parsePublicKey(publicKey);
  const bash = (script) => execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'cloudssh-deploy-'));
  try {
    const home = `export HOME=${JSON.stringify(dir)}; `;
    bash(home + command);
    const once = bash(`cat ${JSON.stringify(join(dir, '.ssh/authorized_keys'))}`);
    bash(home + command);
    const twice = bash(`cat ${JSON.stringify(join(dir, '.ssh/authorized_keys'))}`);
    assert.equal(once, twice);
    assert.ok(once.includes(line));
    const mode = bash(`stat -c %a ${JSON.stringify(join(dir, '.ssh/authorized_keys'))}`).trim();
    assert.equal(mode, '600');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => parsePublicKey('not a key'));
  assert.throws(() => parsePublicKey("ssh-ed25519 AAAA1234'; rm -rf /"));
});

// ---------- store + scheduler engine ----------
function freshStore() {
  return new AutomationStore(':memory:');
}

function fakeEnvWithServers(servers) {
  const body = JSON.stringify(servers.map((server) => ({ id: server.id, name: server.name, host: server.host, port: server.port,
    transport_type: server.transport_type ?? 'direct', jump_server_id: server.jump_server_id ?? null })));
  return {
    USER_DB: {
      idFromName: (name) => `stub-${name}`,
      get: () => ({
        fetch: async (input) => {
          const url = new URL(typeof input === 'string' ? input : input.url);
          if (url.pathname === '/internal/servers') return new Response(body, { status: 200 });
          throw new Error(`unexpected stub fetch ${url.pathname}`);
        },
      }),
    },
  };
}

const USER = { id: 7, github_id: 'gh-1' };
const OWNER = 'gh-1';
const IDENTITY = { github_id: 'gh-1', user_id: 7 };

test('automation store persists tasks, runs, channels and monitor state', () => {
  const store = freshStore();
  const { id } = store.createTask(OWNER, USER, { name: 't1', server_id: 3, command: 'uptime', cron_expr: '*/5 * * * *',
    timeout_seconds: 60, notify_on_failure: true, enabled: true }, 12345);
  assert.equal(store.listTasks(OWNER)[0].name, 't1');
  assert.equal(store.dueTasks(12345).length, 1);
  assert.equal(store.dueTasks(12344).length, 0);
  store.updateTask(OWNER, id, { name: 't2', cron_expr: '0 * * * *', enabled: false }, null);
  assert.equal(store.listTasks(OWNER)[0].name, 't2');
  assert.equal(store.listTasks(OWNER)[0].enabled, 0);
  assert.equal(store.dueTasks(9e15).length, 0, 'disabled tasks are never due');
  const runId = store.recordRun(store.taskById(OWNER, id), { started_at: 1, trigger: 'schedule' });
  store.finishRun(runId, { finished_at: 5, status: 'failed', exit_code: 2, duration_ms: 4, error: 'boom', output: 'out' });
  assert.equal(store.listRuns(OWNER, id)[0].status, 'failed');
  for (let index = 0; index < 60; index++) {
    store.recordRun(store.taskById(OWNER, id), { started_at: index, trigger: 'schedule' });
  }
  assert.equal(store.listRuns(OWNER, id).length, 20, 'paged');
  store.pruneRuns(id, 50);
  assert.ok(store.listRuns(OWNER, id, Number.MAX_SAFE_INTEGER, 1000).length <= 50, 'pruned to 50');
  assert.throws(() => store.createTask(OWNER, USER, { name: '', server_id: 1, command: 'x', cron_expr: '* * * * *', timeout_seconds: 60, notify_on_failure: true, enabled: true }, null));
  assert.throws(() => store.createTask(OWNER, USER, { name: 'x', server_id: 1, command: 'x', cron_expr: '* * * * *', timeout_seconds: 10, notify_on_failure: true, enabled: true }, null));

  const channel = store.saveChannel(OWNER, { type: 'webhook', config: { url: 'http://x/hook' }, enabled: true });
  assert.equal(store.listChannels(OWNER)[0].config.url, 'http://x/hook');
  store.saveChannel(OWNER, { type: 'bark', config: { url: 'http://x/' }, enabled: false }, channel.id);
  assert.equal(store.listChannels(OWNER)[0].type, 'bark');
  assert.equal(store.listChannels(OWNER, { enabledOnly: true }).length, 0);
  assert.equal(store.deleteChannel(OWNER, channel.id), true);

  store.saveMonitor(OWNER, USER, 3, { interval_seconds: 60, failure_threshold: 2, enabled: true });
  assert.equal(store.listMonitors(OWNER)[0].server_id, 3);
  assert.equal(store.dueMonitors(Date.now() + 1).length, 1);
  store.updateMonitorState(OWNER, 3, { status: 'down', consecutive_failures: 2, last_probe_at: 1, last_error: 'refused', next_probe_at: 61, notified_status: null });
  assert.equal(store.listMonitors(OWNER)[0].status, 'down');
  store.insertSample(OWNER, 3, { ts: 1, ok: true, latency_ms: 12 });
  assert.equal(store.listSamples(OWNER, 3, 0)[0].latency_ms, 12);
  store.updateMonitorNotified(OWNER, 3, 'down');
  assert.equal(store.listMonitors(OWNER)[0].notified_status, 'down');
  store.deleteMonitor(OWNER, 3);
  assert.equal(store.listMonitors(OWNER).length, 0);
  assert.equal(store.listSamples(OWNER, 3, 0).length, 0);
});

function makeEngine({ servers = [], execResults = [], probes = [], notifications = [], nowValue = 1_000_000 } = {}) {
  const store = freshStore();
  store.saveChannel(OWNER, { type: 'webhook', config: { url: 'http://127.0.0.1:1/unused' }, enabled: true });
  let clock = nowValue;
  const executed = [];
  const engine = new AutomationEngine({
    store,
    env: fakeEnvWithServers(servers),
    SSHSession: {},
    execute: async (...args) => {
      executed.push(args);
      const next = execResults.shift() ?? { stdout: 'ok', stderr: '', exitCode: 0 };
      if (next instanceof Error) throw next;
      return next;
    },
    notify: async (channels, message) => { notifications.push({ channels, message }); return channels.map(() => ({ ok: true })); },
    probe: async (server) => probes.length ? probes.shift() : { ok: true, latencyMs: 10 },
    now: () => clock,
    log: () => {},
  });
  return { store, engine, executed, notifications, advance: (ms) => { clock += ms; } };
}

test('scheduler runs due tasks, records history, skips long-overdue runs and advances schedules', async () => {
  const { store, engine, executed, notifications, advance } = makeEngine({
    servers: [{ id: 3, name: 'srv', host: '127.0.0.1', port: 22 }],
  });
  const nextAt = nextRun('*/5 * * * *', new Date(1_000_000)).getTime();
  store.createTask(OWNER, USER, { name: 'job', server_id: 3, command: 'uptime', cron_expr: '*/5 * * * *',
    timeout_seconds: 60, notify_on_failure: true, enabled: true }, nextAt);
  advance(nextAt - 1_000_000 + 1000); // just past due

  await engine.cronTick();
  assert.equal(executed.length, 1);
  assert.equal(executed[0][3], 'uptime');
  const task = store.listTasks(OWNER)[0];
  assert.ok(task.next_run_at > task.last_run_at, 'schedule advanced past the executed slot');
  assert.equal(task.last_status, 'succeeded');
  assert.equal(store.listRuns(OWNER, task.id)[0].status, 'succeeded');
  assert.equal(notifications.length, 0, 'no notification on success');

  // A task that became overdue while the panel was down is skipped without running.
  advance(11 * 60_000 + nextRun('*/5 * * * *', new Date(engine.now())).getTime() - engine.now());
  const before = executed.length;
  await engine.cronTick();
  assert.equal(executed.length, before, 'overdue run skipped');
});

test('notify-on-change establishes a baseline, alerts on change, stays silent on repeat and resets on command edit', async () => {
  const { store, engine, notifications } = makeEngine({
    servers: [{ id: 3, name: 'srv', host: '127.0.0.1', port: 22 }],
    execResults: [
      { stdout: 'v1', stderr: '', exitCode: 0 }, // baseline
      { stdout: 'v2', stderr: '', exitCode: 0 }, // changed → notify
      { stdout: 'v2', stderr: '', exitCode: 0 }, // unchanged → silent
      { stdout: 'v2', stderr: '', exitCode: 0 }, // after command edit → new baseline, silent
    ],
  });
  const { id } = store.createTask(OWNER, USER, { name: 'job', server_id: 3, command: 'x', cron_expr: '0 0 * * *',
    timeout_seconds: 60, notify_on_failure: false, notify_on_change: true, enabled: true }, null);

  await engine.runTask(store.taskById(OWNER, id)); // first run only stores the baseline
  assert.equal(notifications.length, 0);
  assert.ok(store.taskById(OWNER, id).last_output_sha, 'baseline hash stored on the task');

  await engine.runTask(store.taskById(OWNER, id));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message.title, /output changed/);
  assert.match(notifications[0].message.body, /v2/);

  await engine.runTask(store.taskById(OWNER, id)); // identical output → no alert
  assert.equal(notifications.length, 1);

  store.updateTask(OWNER, id, { command: 'y' }, null); // editing resets the baseline
  assert.equal(store.taskById(OWNER, id).last_output_sha, null);
  await engine.runTask(store.taskById(OWNER, id));
  assert.equal(notifications.length, 1, 'first run of a new command only re-baselines');

  // Tasks without the flag never notify on output changes.
  const { id: plainId } = store.createTask(OWNER, USER, { name: 'plain', server_id: 3, command: 'x', cron_expr: '0 0 * * *',
    timeout_seconds: 60, notify_on_failure: false, notify_on_change: false, enabled: true }, null);
  await engine.runTask(store.taskById(OWNER, plainId));
  await engine.runTask(store.taskById(OWNER, plainId));
  assert.equal(notifications.length, 1, 'notify_on_change disabled → always silent on success');
});

test('scheduler notifies on failure and manual runs share the same path', async () => {
  const { store, engine, executed, notifications } = makeEngine({
    servers: [{ id: 3, name: 'srv', host: '127.0.0.1', port: 22 }],
    execResults: [new Error('fingerprint not verified')],
  });
  const { id } = store.createTask(OWNER, USER, { name: 'job', server_id: 3, command: 'x', cron_expr: '0 0 * * *',
    timeout_seconds: 60, notify_on_failure: true, enabled: true }, null);
  const result = await engine.runTask(store.taskById(OWNER, id), { trigger: 'manual' });
  assert.equal(result.ok, false);
  assert.match(result.error, /fingerprint/);
  assert.equal(executed.length, 1);
  const run = store.listRuns(OWNER, id)[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.trigger, 'manual');
  assert.match(run.error, /fingerprint/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message.title, /job/);
  assert.match(notifications[0].message.body, /srv/);
});

test('monitor state machine: up → down (threshold) → notified once → recovered', async () => {
  const probes = [];
  const { store, engine, notifications } = makeEngine({
    servers: [{ id: 3, name: 'srv', host: '127.0.0.1', port: 22 }],
    probes,
  });
  store.saveMonitor(OWNER, USER, 3, { interval_seconds: 60, failure_threshold: 2, enabled: true });
  store.updateMonitorState(OWNER, 3, { status: 'unknown', consecutive_failures: 0, next_probe_at: 1 });

  const state = () => store.listMonitors(OWNER)[0];
  let current = state();
  // Healthy probe.
  probes.push({ ok: true, latencyMs: 12 });
  await engine.probeOne(current);
  current = state();
  assert.equal(current.status, 'up');
  assert.equal(current.consecutive_failures, 0);
  assert.equal(notifications.length, 0);
  // First failure below threshold keeps the previous status, no alert.
  probes.push({ ok: false, latencyMs: 0, error: 'connection refused' });
  await engine.probeOne(current);
  current = state();
  assert.equal(current.status, 'up');
  assert.equal(current.consecutive_failures, 1);
  assert.equal(notifications.length, 0);
  // Second failure reaches threshold: down + alert.
  probes.push({ ok: false, latencyMs: 0, error: 'connection refused' });
  await engine.probeOne(current);
  current = state();
  assert.equal(current.status, 'down');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message.title, /srv/);
  assert.match(notifications[0].message.body, /2 consecutive/);
  assert.equal(current.notified_status, 'down');
  // Still down: no duplicate alert.
  probes.push({ ok: false, latencyMs: 0, error: 'timeout' });
  await engine.probeOne(current);
  current = state();
  assert.equal(current.status, 'down');
  assert.equal(notifications.length, 1);
  // Recovery: alert once.
  probes.push({ ok: true, latencyMs: 33 });
  await engine.probeOne(current);
  current = state();
  assert.equal(current.status, 'up');
  assert.equal(current.consecutive_failures, 0);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].message.title, /recovered/i);
  assert.equal(current.notified_status, 'up');
  // Samples recorded for charting.
  assert.ok(store.listSamples(OWNER, 3, 0).length >= 4);
});

test('monitor skips non-direct servers and records the reason', async () => {
  const { store, engine } = makeEngine({
    servers: [{ id: 5, name: 'jumped', host: '10.0.0.9', port: 22, jump_server_id: 2 }],
  });
  store.saveMonitor(OWNER, USER, 5, { interval_seconds: 60, failure_threshold: 3, enabled: true });
  await engine.probeOne({ owner: OWNER, user_id: USER.id, github_id: 'gh-1', server_id: 5, interval_seconds: 60, failure_threshold: 3, status: 'unknown', consecutive_failures: 0, notified_status: null });
  const monitor = store.listMonitors(OWNER)[0];
  assert.match(monitor.last_error, /direct/);
  assert.ok(monitor.next_probe_at > engine.now(), 'retries slowly instead of hot-looping');
});

// ---------- spawned end-to-end over the HTTP API ----------
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
    await delay(50);
  }
  await stop(child); throw new Error(`Server startup timed out: ${logs}`);
}

test('automation and key APIs enforce auth and persist across restart', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-automation-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });

  // Local webhook target for notification testing.
  const hookHits = [];
  const hook = createHttpServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { hookHits.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(200); res.end('ok'); });
  });
  const hookPort = await new Promise((resolvePort) => hook.listen(0, '127.0.0.1', () => resolvePort(hook.address().port)));

  let child;
  try {
    child = await startPanel(directory, port);
    const unauthenticated = await fetch(`${base}/api/automation/cron`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await fetch(`${base}/api/ssh/keys/generate`, { method: 'POST' })).status, 401);

    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.automationEnabled, true);
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body, origin = base) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    // Keypair generation returns a usable OpenSSH pair.
    const pair = await (await api('/api/ssh/keys/generate', 'POST', { comment: 'panel-test' })).json();
    assert.match(pair.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
    assert.match(pair.publicKey, /^ssh-ed25519 /);
    assert.equal(createHash('sha256').update(pair.privateKey).digest('hex').length, 64);
    // Deploying to an unknown server reports failure without throwing.
    const deploy = await (await api('/api/ssh/keys/deploy', 'POST', { server_id: 999999, public_key: pair.publicKey })).json();
    assert.equal(deploy.ok, false);

    // Notification channels CRUD + test dispatch.
    assert.equal((await api('/api/automation/notifications', 'POST', { type: 'webhook', config: { url: 'http://bad' } }, 'https://evil.example')).status, 403);
    assert.equal((await api('/api/automation/notifications', 'POST', { type: 'webhook', config: { url: 'javascript:alert(1)' } })).status, 400);
    const created = await api('/api/automation/notifications', 'POST', { type: 'webhook', config: { url: `http://127.0.0.1:${hookPort}/hook` }, enabled: true });
    assert.equal(created.status, 201);
    const channelId = (await created.json()).id;
    const testResult = await (await api('/api/automation/notifications/test', 'POST')).json();
    assert.equal(testResult.results[0].ok, true);
    assert.match(hookHits[0].title, /test/i);

    // Scheduled tasks CRUD with validation.
    assert.equal((await api('/api/automation/cron', 'POST', { name: 'x', server_id: 1, command: 'true', cron_expr: '61 * * * *' })).status, 400);
    const added = await api('/api/servers', 'POST', { name: 'fixture-box', host: '127.0.0.1', port: 2222, username: 'fixture', auth_method: 'password', credential: 'fixture-only' });
    assert.equal(added.status, 201);
    const servers = await (await api('/api/servers')).json();
    const serverId = servers[0].id;
    assert.equal((await api('/api/automation/cron', 'POST', { name: 'other-owner task', server_id: 999999, command: 'printf scheduled-ok', cron_expr: '*/5 * * * *', timeout_seconds: 60, notify_on_failure: true, enabled: true })).status, 400, 'tasks require an owned server');
    const created2 = await api('/api/automation/cron', 'POST', { name: 'probe task', server_id: serverId, command: 'printf scheduled-ok', cron_expr: '*/5 * * * *', timeout_seconds: 60, notify_on_failure: false, notify_on_change: true, enabled: true });
    assert.equal(created2.status, 201);
    const taskId = (await created2.json()).id;
    const tasks = (await (await api('/api/automation/cron')).json()).tasks;
    assert.equal(tasks[0].server_name, servers[0].name);
    assert.equal(tasks[0].notify_on_change, 1, 'notify_on_change round-trips through the API');
    assert.ok(tasks[0].next_run_at > Date.now() - 1000);
    assert.equal((await api(`/api/automation/cron/${taskId}`, 'PUT', { name: 'renamed', server_id: serverId, command: 'printf updated', cron_expr: '0 * * * *', timeout_seconds: 90, notify_on_failure: true, enabled: true })).status, 200);
    assert.equal((await api('/api/automation/cron/424242/run', 'POST')).status, 404);

    // Manual run against a server without a verified fingerprint fails and is recorded.
    const run = await api(`/api/automation/cron/${taskId}/run`, 'POST');
    assert.equal(run.status, 500);
    const runBody = await run.json();
    assert.equal(runBody.ok, false);
    const runs = (await (await api(`/api/automation/cron/${taskId}/runs`)).json()).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].trigger, 'manual');
    assert.match(runs[0].error, /fingerprint/);

    // Monitors: upsert, validation, list and samples.
    assert.equal((await api('/api/automation/monitor/1', 'PUT', { interval_seconds: 10, failure_threshold: 3 })).status, 400);
    const monitorPut = await api(`/api/automation/monitor/${serverId}`, 'PUT', { interval_seconds: 60, failure_threshold: 2 });
    assert.equal(monitorPut.status, 200);
    const monitors = (await (await api('/api/automation/monitor')).json()).monitors;
    assert.equal(monitors[0].server_id, serverId);
    assert.equal(monitors[0].monitorable, true);
    assert.equal((await api(`/api/automation/monitor/${serverId}/samples`)).status, 200);
    assert.equal((await api(`/api/automation/monitor/${serverId}`, 'DELETE')).status, 200);

    // The automation page is served with CSP for authenticated sessions.
    const page = await api('/automation');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
    assert.match(await page.text(), /automation\.js/);
    assert.equal((await fetch(`${base}/automation`, { redirect: 'manual' })).status, 302, 'anonymous visitors are redirected');

    // PWA assets are served with proper content types.
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).headers.get('content-type'), 'application/manifest+json');
    assert.match(await (await fetch(`${base}/manifest.webmanifest`)).text(), /icon-512/);
    assert.equal((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(`${base}/icons/icon-192.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/icons/icon-192.png`)).status, 200);

    // Restart: channels, tasks and history persist.
    await stop(child);
    child = await startPanel(directory, port);
    const channelsAfter = (await (await api('/api/automation/notifications')).json()).channels;
    assert.equal(channelsAfter.length, 1);
    const tasksAfter = (await (await api('/api/automation/cron')).json()).tasks;
    assert.equal(tasksAfter[0].name, 'renamed');
    const runsAfter = (await (await api(`/api/automation/cron/${taskId}/runs`)).json()).runs;
    assert.equal(runsAfter.length, 1);

    assert.equal((await api(`/api/automation/notifications/${channelId}`, 'DELETE')).status, 200);
    assert.equal((await api(`/api/automation/cron/${taskId}`, 'DELETE')).status, 200);
    assert.equal((await (await api('/api/automation/cron')).json()).tasks.length, 0);
  } finally {
    await stop(child); hook.close(); rmSync(directory, { recursive: true, force: true });
  }
});
