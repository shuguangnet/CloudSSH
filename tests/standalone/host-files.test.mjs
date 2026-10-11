import test from 'node:test';
import { solveCaptcha } from './captcha-helper.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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

test('host file browsing requires authentication and lists deployment files', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-hostfiles-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let child;
  try {
    child = await startPanel(directory, port);
    // Unauthenticated access is rejected but still reports the feature exists (not 404).
    assert.equal((await fetch(`${base}/api/host-files`)).status, 401);
    assert.equal((await fetch(`${base}/api/host-file?path=/etc/hostname`)).status, 401);

    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });

    // Default listing starts in the home directory.
    const home = await (await api('/api/host-files')).json();
    assert.equal(home.path, resolve(homedir()));
    assert.ok(Array.isArray(home.entries));

    // Fixture tree with directories, files, and ordering checks.
    const fixture = join(directory, 'fixture');
    mkdirSync(join(fixture, 'keys'), { recursive: true });
    mkdirSync(join(fixture, 'empty-dir'), { recursive: true });
    writeFileSync(join(fixture, 'zz-key'), '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n');
    writeFileSync(join(fixture, 'aa-key'), 'second\n');
    const listing = await (await api(`/api/host-files?path=${encodeURIComponent(fixture)}`)).json();
    assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.type, entry.size]), [
      ['empty-dir', 'dir', null],
      ['keys', 'dir', null],
      ['aa-key', 'file', 7],
      ['zz-key', 'file', 44],
    ]);
    assert.equal(listing.truncated, false);

    // Path traversal segments are resolved server-side; relative paths rejected.
    const normalized = await (await api(`/api/host-files?path=${encodeURIComponent(`${fixture}/../fixture`)}`)).json();
    assert.equal(normalized.path, resolve(fixture));
    assert.equal((await api('/api/host-files?path=relative/path')).status, 400);
    assert.equal((await api('/api/host-files?path=/definitely/not/here')).status, 404);

    // File reads return content, reject directories, oversized and missing files.
    const read = await (await api(`/api/host-file?path=${encodeURIComponent(join(fixture, 'aa-key'))}`)).json();
    assert.equal(read.content, 'second\n');
    assert.equal(read.size, 7);
    assert.equal((await api(`/api/host-file?path=${encodeURIComponent(fixture)}`)).status, 400);
    assert.equal((await api(`/api/host-file?path=${encodeURIComponent(join(fixture, 'nope'))}`)).status, 404);
    const big = join(directory, 'big-key');
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
    const tooLarge = await api(`/api/host-file?path=${encodeURIComponent(big)}`);
    assert.equal(tooLarge.status, 413);
    assert.equal((await api('/api/host-file?path=tmp/../etc')).status, 400);
  } finally {
    await stop(child); rmSync(directory, { recursive: true, force: true });
  }
});
