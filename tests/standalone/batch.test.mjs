// 批量命令执行 /api/batch/exec 端到端测试：
// 路由守卫（认证/CSRF/归属/入参）+ 自起 sshd 的真机 SSE 流式执行
// （两台服务器并发、输出聚合、非零退出码、stderr 回传）。
import test from 'node:test';
import { solveCaptcha } from './captcha-helper.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pbkdf2Sync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

/** 与 frontend/src/sse-stream.ts 同语义的最小 SSE 解析（测试专用）。 */
function parseSseChunks(chunks, onEvent) {
  let buffer = chunks.join('');
  let index;
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ }
    }
  }
  return buffer;
}

async function freePort() {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function stop(child) {
  if (!child || typeof child.kill !== 'function' || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolveStop) => { child.once('exit', () => resolveStop(true)); }),
    new Promise((resolveStop) => { setTimeout(() => resolveStop(false), 3000).unref?.(); }),
  ]);
  // 兜底:面板 shutdown 最多等 200s,测试不容忍挂死;强杀并等回收,避免子进程句柄吊住事件循环。
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolveStop) => { child.once('exit', resolveStop); setTimeout(resolveStop, 2000).unref?.(); });
  }
}

async function startPanel(directory, port) {
  const child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve(import.meta.dirname, '../..'),
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, CAPTCHA_MODE: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  for (let i = 0; i < 200; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return { child, logs }; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`Panel exited: ${logs}`);
    await delay(50);
  }
  await stop(child);
  throw new Error(`Server startup timed out: ${logs}`);
}

/** POST /api/batch/exec 并解析 SSE 为事件数组（直到 run_done 或超时）。 */
async function runBatch(base, cookie, body, { timeoutMs = 60000 } = {}) {
  const response = await fetch(`${base}/api/batch/exec`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    return { status: response.status, payload: await response.json().catch(() => ({})) };
  }
  const events = [];
  let pending = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = parseSseChunks([pending, decoder.decode(value, { stream: true })], (event) => events.push(event));
    if (events.some((event) => event.type === 'run_done')) {
      void reader.cancel().catch(() => {});
      break;
    }
  }
  parseSseChunks([pending], (event) => events.push(event));
  return { status: response.status, events };
}

test('batch exec enforces auth, origin, ownership and input validation', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-batch-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let child;
  try {
    ({ child } = await startPanel(directory, port));
    assert.equal((await fetch(`${base}/api/batch/exec`, { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 401);

    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const post = (body, headers = {}) => fetch(`${base}/api/batch/exec`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // CSRF：Origin 与 BASE_URL/Host 均不符 → 403（隧道场景在 docker.test.mjs 已覆盖同一共享实现）。
    assert.equal((await post({ server_ids: [1], command: 'true' }, { Origin: 'http://evil.example' })).status, 403);
    // 入参校验。
    assert.equal((await post({ server_ids: [], command: 'true' })).status, 400);
    assert.equal((await post({ server_ids: ['x'], command: 'true' })).status, 400);
    assert.equal((await post({ server_ids: Array.from({ length: 21 }, (_, i) => i + 1), command: 'true' })).status, 400);
    assert.equal((await post({ server_ids: [1], command: '   ' })).status, 400);
    assert.equal((await post({ server_ids: [1], command: 'true', timeout: 'nope' })).status, 400);
    // 归属：不存在的服务器 → 404。
    const unknown = await post({ server_ids: [999999], command: 'true' });
    assert.equal(unknown.status, 404);
  } finally {
    await stop(child); rmSync(directory, { recursive: true, force: true });
  }
});

test('batch exec streams aggregated output and exit codes over real SSH', {
  timeout: 120000, skip: !existsSync('/usr/sbin/sshd') || process.getuid?.() !== 0,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-batch-ssh-'));
  const dataDir = join(directory, 'data');
  const sshPort = await freePort(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const hostKey = join(directory, 'host-key'), clientKey = join(directory, 'client-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(join(directory, 'authorized_keys'), readFileSync(`${clientKey}.pub`));
  const sshConfig = join(directory, 'sshd_config');
  writeFileSync(sshConfig, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${directory}/authorized_keys\nStrictModes no\nPermitRootLogin yes\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nLogLevel ERROR\n`);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  let panel;
  try {
    await delay(150); assert.equal(sshd.exitCode, null);
    const password = 'fixture-password-123';
    execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: dataDir }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
    ({ child: panel } = await startPanel(dataDir, port));
    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    // 两台"服务器"（同一 sshd，两个条目）并发执行。
    const ids = [];
    for (const name of ['batch-a', 'batch-b']) {
      const added = await api('/api/servers', 'POST', { name, host: '127.0.0.1', port: sshPort, username: userInfo().username, auth_method: 'publickey', credential: readFileSync(clientKey, 'utf8') });
      assert.equal(added.status, 201);
      ids.push((await (await api('/api/servers')).json()).find((item) => item.name === name).id);
    }

    // 先经真实连接信任主机指纹（与 docker.test 相同流程：WS 事件 → 持久化 known-hosts）。
    const connection = await (await api(`/api/servers/${ids[0]}/connect`, 'POST')).json();
    const socket = new WebSocket(connection.wsUrl || connection.ws_url || connection.url, { headers: { Cookie: cookie, Origin: base } });
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('SSH handshake timed out')), 20000);
      socket.on('message', (data, binary) => {
        if (binary) return;
        const event = JSON.parse(data.toString());
        if (event.type === 'host_key_verified') {
          void api('/api/known-hosts', 'POST', { host: event.knownHostIdentity || '127.0.0.1', port: sshPort, fingerprint: event.fingerprint });
        }
        if (event.event === 'shell_ready') { clearTimeout(timer); resolveReady(); }
        if (event.type === 'error') { clearTimeout(timer); rejectReady(new Error(event.message)); }
      });
      socket.on('error', (error) => { clearTimeout(timer); rejectReady(error); });
    });
    socket.close();

    const command = 'echo batch-$((20+3)); echo warn-line >&2; if [ "$USER" = nobody ]; then exit 7; fi';
    const { status, events } = await runBatch(base, cookie, { server_ids: ids, command, timeout: 60 });
    assert.equal(status, 200);
    assert.equal(events[0].type, 'run_start');
    assert.equal(events[0].total, 2);

    const starts = events.filter((event) => event.type === 'server_start');
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map((event) => event.server_id).sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
    const names = new Set(starts.map((event) => event.name));
    assert.ok(names.has('batch-a') && names.has('batch-b'), `names: ${JSON.stringify([...names])}`);

    const outputText = events.filter((event) => event.type === 'output').map((event) => event.text).join('');
    assert.ok(outputText.includes('batch-23'), `output: ${JSON.stringify(outputText.slice(0, 200))}`);

    const dones = events.filter((event) => event.type === 'server_done');
    assert.equal(dones.length, 2);
    for (const done of dones) {
      assert.equal(done.exit_code, 0);
      assert.ok(done.duration_ms >= 0);
      assert.equal(done.truncated, false);
    }
    const stderrJoined = dones.map((done) => done.stderr || '').join('');
    assert.ok(stderrJoined.includes('warn-line'), `stderr: ${JSON.stringify(stderrJoined)}`);

    const last = events.at(-1);
    assert.equal(last.type, 'run_done');
    assert.equal(last.completed, 2);

    // 非零退出码如实回传。
    const failed = await runBatch(base, cookie, { server_ids: [ids[0]], command: 'echo before-fail; exit 9' });
    const failedDone = failed.events.find((event) => event.type === 'server_done');
    assert.ok(failedDone, 'missing server_done');
    assert.equal(failedDone.exit_code, 9);
    assert.ok(failed.events.some((event) => event.type === 'output' && event.text.includes('before-fail')));

    // 超时中止：30 秒 sleep、5 秒超时 → streamExecCommand 超时抛错 → server_error 而非悬挂。
    const timedOut = await runBatch(base, cookie, { server_ids: [ids[0]], command: 'sleep 30', timeout: 5 }, { timeoutMs: 45000 });
    const timeoutEvent = timedOut.events.find((event) => event.type === 'server_error');
    assert.ok(timeoutEvent, `expected server_error, got ${JSON.stringify(timedOut.events.map((event) => event.type))}`);
  } finally {
    await stop(panel); await stop(sshd); rmSync(directory, { recursive: true, force: true });
  }
});
