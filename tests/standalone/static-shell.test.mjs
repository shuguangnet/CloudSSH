// Standalone split-shell serving: dist/public/index.html is served for '/' with
// no-cache while its hashed /assets/* files get immutable long-cache headers.
// Skips when the split shell has not been built (fallback = inlined worker shell).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const splitShell = existsSync('dist/public/index.html');

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
function rawRequest(port, rawPath) {
  return new Promise((resolveRequest, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: rawPath }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end();
  });
}

test('standalone serves the split app shell with immutable assets', { timeout: 60000, skip: !splitShell }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-shell-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  const dataDir = join(directory, 'data');
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: dataDir }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let panel;
  try {
    panel = spawn(process.execPath, ['standalone/server.mjs'], {
      cwd: resolve('.'), env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), BASE_URL: base, CAPTCHA_MODE: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = ''; panel.stdout.on('data', (data) => { logs += data; }); panel.stderr.on('data', (data) => { logs += data; });
    for (let i = 0; i < 100; i++) {
      try { const response = await fetch(`${base}/api/health`); if (response.ok) break; } catch { /* Starting. */ }
      if (panel.exitCode !== null) throw new Error(logs);
      await delay(50);
    }

    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type'), /text\/html/);
    assert.equal(shell.headers.get('cache-control'), 'no-cache');
    assert.equal(shell.headers.get('x-frame-options'), 'DENY');
    const html = await shell.text();
    const asset = html.match(/src=["']\/assets\/([\w.-]+\.js)["']/)?.[1];
    assert.ok(asset, 'split shell must reference a hashed JS asset');

    const js = await fetch(`${base}/assets/${asset}`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.ok((await js.text()).length > 1000, 'bundled JS payload');

    const favicon = await fetch(`${base}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type'), /svg/);

    const worker = await fetch(`${base}/sw.js`);
    assert.equal(worker.status, 200);
    assert.ok((await worker.text()).includes('cloudssh-v2'));

    // Path traversal and unknown assets must never escape the assets directory.
    // (WHATWG URLs normalise %2e%2e into '..' before routing, so the request
    // simply leaves /assets/* and lands on a non-file route — the payload of
    // dist/worker.mjs must never leak.)
    for (const rawPath of ['/assets/%2e%2e/worker.mjs', '/assets/..%2fworker.mjs', '/assets/missing.js']) {
      const response = await rawRequest(port, rawPath);
      assert.ok(!response.body.toString('utf8').includes('installWorkerGlobals'), `${rawPath} must not leak worker bundle source`);
      assert.notEqual(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    }
    assert.equal((await rawRequest(port, '/assets/..%2fworker.mjs')).status, 404);
    assert.equal((await rawRequest(port, '/assets/missing.js')).status, 404);
  } finally {
    await stop(panel); rmSync(directory, { recursive: true, force: true });
  }
});
