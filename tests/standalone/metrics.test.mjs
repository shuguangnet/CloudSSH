/**
 * /metrics 集成测试：未配置令牌 404；错误令牌 404；正确令牌 200 且输出
 * 合法 Prometheus 文本格式（HELP/TYPE + 数值行）。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pbkdf2Sync, createHash, randomBytes } from 'node:crypto';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const password = 'fixture-password-metrics-123';
const adminHash = (() => {
  const salt = randomBytes(12).toString('base64url');
  const stretched = pbkdf2Sync(password, Buffer.from(salt, 'base64url'), 1000, 32, 'sha256');
  return `pbkdf2$sha256$1000$${salt}$${createHash('sha256').update(stretched).digest('base64url')}`;
})();

async function startPanel(directory, port, metricsToken) {
  const child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, ADMIN_PASSWORD_HASH: adminHash, ...(metricsToken ? { METRICS_BEARER_TOKEN: metricsToken } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return child; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  child.kill('SIGKILL'); throw new Error('timeout');
}
const stop = (child) => Promise.race([
  new Promise((done) => { child.kill('SIGTERM'); child.once('exit', done); }),
  delay(3000).then(() => { child.kill('SIGKILL'); }),
]);

test: {
  const port = 18802;
  const base = `http://127.0.0.1:${port}`;
  let child;
  const dir = mkdtempSync(join(tmpdir(), 'metrics-'));
  try {
    child = await startPanel(dir, port, undefined);
    assert.equal((await fetch(`${base}/metrics`)).status, 404, 'no token configured → 404');

    await stop(child);
    child = await startPanel(dir, port, 'metrics-secret-token');
    assert.equal((await fetch(`${base}/metrics`)).status, 404, 'missing bearer → 404');
    assert.equal((await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer wrong' } })).status, 404, 'wrong bearer → 404');

    const ok = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer metrics-secret-token' } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') || '', /^text\/plain/);
    const body = await ok.text();
    for (const name of ['cloudssh_up', 'cloudssh_uptime_seconds', 'cloudssh_process_resident_memory_bytes', 'cloudssh_ws_connections_active', 'cloudssh_ssh_pool_idle_chains', 'cloudssh_live_status_sessions', 'cloudssh_cron_tasks', 'cloudssh_monitors', 'cloudssh_mcp_tokens_active']) {
      assert.match(body, new RegExp(`^${name} \\d`, 'm'), `metric ${name} present`);
    }
    assert.match(body, /^# HELP cloudssh_up /m);
    assert.match(body, /^cloudssh_up 1$/m);
    assert.match(body, /^cloudssh_cron_tasks 0$/m);
  } finally {
    if (child) await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('metrics: ok');
}
