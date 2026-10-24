// Unit tests for the always-on live status hub: one SSH session shared by all
// viewers of a server, ticks that do not spawn processes, idle teardown, and
// the two transports (long poll + SSE) built on the same sampler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveStatusHub, clampInterval, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS } from '../../standalone/live-status.mjs';

const TICK = [
  'UPTIME:1000.5',
  'LOADAVG:0.10 0.20 0.30 1/200 4242',
  'MEMINFO:MemTotal: 1000000 kB;MemAvailable: 400000 kB;SwapTotal: 0 kB;SwapFree: 0 kB;',
  'STAT1:cpu  100 0 50 8500 0 0 0 0 0 0',
  'NET1:  eth0: 1000 10 0 0 0 0 0 0 500 10 0 0 0 0 0 0',
  'UPTIME1:1000.5',
].join('\n');

const FIRST = [
  'HOSTNAME:live.example',
  'DISK:/dev/vda1  21003583488 13730463744 6226698240 73% /',
  'CPUCORES:2',
  'CPUMODEL:AMD EPYC 9654 96-Core Processor',
  'OSRELEASE:Debian GNU/Linux 12 (bookworm)',
  'UNAME:Linux 6.6.0',
  'ARCH:x86_64',
  'UPTIME:1000.5',
  'LOADAVG:0.10 0.20 0.30 1/200 4242',
  'MEMINFO:MemTotal: 1000000 kB;MemAvailable: 400000 kB;SwapTotal: 0 kB;SwapFree: 0 kB;',
  'STAT1:cpu  100 0 50 8500 0 0 0 0 0 0',
  'NET1:  eth0: 1000 10 0 0 0 0 0 0 500 10 0 0 0 0 0 0',
  'UPTIME1:1000.5',
  'STAT2:cpu  110 0 55 9490 0 0 0 0 0 0',
  'NET2:  eth0: 2000 20 0 0 0 0 0 0 1500 20 0 0 0 0 0 0',
  'UPTIME2:1001.5',
].join('\n');

const IDENTITY = { github_id: '1', user_id: 1 };
const quiet = () => {};

function makeHub(scripts, options = {}) {
  const calls = [];
  const hub = createLiveStatusHub({
    env: {},
    SSHSession: class {},
    executeSaved: async (_env, _identity, _serverId, command) => {
      calls.push(command);
      const index = Math.min(calls.length - 1, scripts.length - 1);
      return { stdout: scripts[index], stderr: '', exitCode: 0 };
    },
    defaultIntervalMs: 5,
    intervalFloorMs: 5,
    idleTtlMs: 30,
    ...options,
  });
  return { hub, calls };
}

function waitFor(check, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 5);
  });
}

test('clampInterval bounds the client-requested cadence', () => {
  assert.equal(clampInterval(undefined), DEFAULT_INTERVAL_MS);
  assert.equal(clampInterval('nonsense'), DEFAULT_INTERVAL_MS);
  assert.equal(clampInterval(1), MIN_INTERVAL_MS);
  assert.equal(clampInterval(10 ** 9), MAX_INTERVAL_MS);
  assert.equal(clampInterval(4000), 4000);
  // The floor is injectable so tests can drive the sampler fast.
  assert.equal(clampInterval(1, 5), 5);
});

test('the first tick lifts slow facts and the rate pair; later ticks reuse the chain state', async () => {
  // Tick 2 is a light sample with a counter delta against tick 1.
  // A light tick with a busy window: total 9655→11000, idle 9490→10400, i.e.
  // 435 busy of 1345 total = 32.3%; network rx 2000→10000 over 1.0 s.
  const second = [
    'UPTIME:1001.5',
    'LOADAVG:0.40 0.25 0.31 1/200 4242',
    'MEMINFO:MemTotal: 1000000 kB;MemAvailable: 500000 kB;SwapTotal: 0 kB;SwapFree: 0 kB;',
    'STAT1:cpu  500 0 100 10400 0 0 0 0 0 0',
    'NET1:  eth0: 10000 30 0 0 0 0 0 0 6000 30 0 0 0 0 0 0',
    'UPTIME1:1001.5',
  ].join('\n');
  const { hub, calls } = makeHub([FIRST, second]);
  const session = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 7, intervalMs: 5 });
  const frames = [];
  const unsubscribe = session.attachSubscriber((frame) => { if (frame.type === 'status') frames.push(frame); });
  try {
    await waitFor(() => frames.length >= 2);
    assert.equal(frames[0].hostname, 'live.example');
    assert.equal(frames[0].cpu.cores, 2);
    assert.equal(frames[0].cpu.model, 'AMD EPYC 9654 96-Core Processor');
    assert.equal(frames[0].disk.usage_percent, 73);
    assert.equal(frames[0].os, 'Debian GNU/Linux 12 (bookworm) x86_64');
    // First frame: 65 busy of 1005 total ≈ 6.468% → 6.5%
    // 15 busy of 1005 total (STAT1→STAT2) ≈ 1.5%
    assert.equal(frames[0].cpu.usage_percent, 1.5);
    assert.equal(frames[0].network.rx_bytes_per_sec, 1000);
    assert.equal(frames[0].network.tx_bytes_per_sec, 1000);
    // Second frame keeps the memoized slow facts (the light tick never sent them)
    // but refreshes memory, load and the rates from the tick-to-tick delta.
    assert.equal(frames[1].hostname, 'live.example');
    assert.equal(frames[1].memory.usage_percent, 50);
    assert.deepEqual(frames[1].cpu.loadavg, [0.4, 0.25, 0.31]);
    assert.equal(frames[1].disk.usage_percent, 73);
    assert.equal(frames[1].cpu.usage_percent, 32.3);
    assert.equal(frames[1].network.rx_bytes_per_sec, 8000);
    assert.equal(frames[1].network.tx_bytes_per_sec, 4500);
    assert.ok(typeof frames[1].latency_ms === 'number');
    // Light ticks must not spawn `df`/`hostname`/`sleep`.
    assert.ok(!calls[1].includes('sleep'), 'later ticks must not sleep');
    assert.ok(!calls[1].includes('df -B1'), 'later ticks must not shell out to df');
  } finally {
    unsubscribe();
    session.stop();
  }
});

test('all viewers of one server share a single sampler (and a single SSH session)', async () => {
  const { hub, calls } = makeHub([FIRST, TICK]);
  const a = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 9, intervalMs: 200 });
  const b = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 9, intervalMs: 200 });
  assert.equal(a, b, 'same server must resolve to the same sampler');
  const stopA = a.attachSubscriber(quiet);
  const stopB = b.attachSubscriber(quiet);
  try {
    assert.equal(a.clientCount, 2);
    await waitFor(() => calls.length >= 2);
    // Two viewers, one sampler: two ticks per interval window, not four.
    assert.equal(calls.length, 2, `expected a shared sampler, saw ${calls.length} ticks`);
    assert.equal(hub.sessionCount(), 1);
  } finally {
    stopA();
    stopB();
    a.stop();
  }
});

test('a different cadence restarts the sampler instead of doubling it', () => {
  const { hub } = makeHub([FIRST]);
  const fast = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 3, intervalMs: 4000 });
  fast.attachSubscriber(quiet);
  const slow = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 3, intervalMs: 8000 });
  try {
    assert.notEqual(slow, fast);
    assert.equal(hub.sessionCount(), 1, 'only one sampler may exist per server');
  } finally {
    fast.stop();
    slow.stop();
  }
});

test('anonymous-looking failures are reported and non-fatal blips keep the last frame', async () => {
  let failing = false;
  let calls = 0;
  const hub = createLiveStatusHub({
    env: {}, SSHSession: class {},
    executeSaved: async () => {
      calls++;
      if (failing) throw new Error('connect ETIMEDOUT');
      return { stdout: FIRST, stderr: '', exitCode: 0 };
    },
    defaultIntervalMs: 5, intervalFloorMs: 5, idleTtlMs: 30,
  });
  const session = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 11, intervalMs: 5 });
  const events = [];
  const unsubscribe = session.attachSubscriber((frame) => events.push(frame));
  try {
    await waitFor(() => events.some((event) => event.type === 'status'));
    failing = true;
    await waitFor(() => events.some((event) => event.type === 'error'));
    // The stream survives a first blip and still exposes the last good frame so
    // a reconnecting viewer paints values instead of an empty skeleton.
    assert.equal(session.currentFrame().type, 'status');
    assert.equal(session.currentFrame().stale, false);
    assert.ok(calls >= 2);
  } finally {
    unsubscribe();
    session.stop();
  }
});

test('an untrusted fingerprint stops the stream instead of retrying forever', async () => {
  let calls = 0;
  const hub = createLiveStatusHub({
    env: {}, SSHSession: class {},
    executeSaved: async () => {
      calls++;
      throw new Error('Connect through the panel first and verify the host fingerprint');
    },
    defaultIntervalMs: 5, intervalFloorMs: 5, idleTtlMs: 30,
  });
  const session = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 12, intervalMs: 5 });
  const errors = [];
  const unsubscribe = session.attachSubscriber((frame) => { if (frame.type === 'error') errors.push(frame); });
  try {
    await waitFor(() => session.stopped);
    assert.equal(calls, 1, 'a non-retryable failure must not be retried');
    assert.equal(errors[0].fatal, true);
    assert.match(errors[0].message, /fingerprint/);
    assert.equal(hub.sessionCount(), 0, 'a stopped sampler must leave the hub');
  } finally {
    unsubscribe();
  }
});

test('sampling stops once the last viewer detaches', async () => {
  const { hub, calls } = makeHub([FIRST]);
  const session = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 21, intervalMs: 5 });
  const unsubscribe = session.attachSubscriber(quiet);
  await waitFor(() => calls.length >= 1);
  unsubscribe();
  await waitFor(() => session.stopped);
  const settled = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, settled, 'no ticks may run without viewers');
  assert.equal(hub.sessionCount(), 0);
});

test('long poll answers immediately once a frame exists and streams over SSE', async () => {
  const { hub } = makeHub([FIRST, TICK]);
  const session = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 31, intervalMs: 5 });
  const detach = session.attachSubscriber(quiet);
  try {
    await waitFor(() => session.currentFrame().type === 'status');
    const response = await hub.longPoll(session, new Request('http://localhost/api/automation/status/live/31'));
    assert.equal(response.status, 200);
    const frame = await response.json();
    assert.equal(frame.type, 'status');
    assert.equal(frame.server_id, 31);

    // SSE: the stream opens with the current frame, then pushes updates.
    const streamResponse = hub.streamResponse(session, new Request('http://localhost/api/automation/status/live/31/stream'));
    assert.match(streamResponse.headers.get('Content-Type'), /text\/event-stream/);
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /^data: \{.*"type":"status"/);
    await reader.cancel();
  } finally {
    detach();
    session.stop();
  }
});

test('a long poll that finds nothing yet holds the request open until a frame lands', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hub = createLiveStatusHub({
    env: {}, SSHSession: class {},
    executeSaved: async () => { await gate; return { stdout: FIRST, stderr: '', exitCode: 0 }; },
    defaultIntervalMs: 5, intervalFloorMs: 5, idleTtlMs: 30,
  });
  const session = hub.subscribe({ owner: '1', identity: IDENTITY, serverId: 41, intervalMs: 5 });
  try {
    assert.equal(session.currentFrame().type, 'pending');
    const pending = hub.longPoll(session, new Request('http://localhost/api/automation/status/live/41'));
    release();
    const frame = await (await pending).json();
    assert.equal(frame.type, 'status');
    assert.equal(frame.hostname, 'live.example');
  } finally {
    session.stop();
  }
});
