// Unit tests for docker container management helpers, plus a spawned
// end-to-end pass over the /api/docker/* routes (auth, ownership, validation
// and a real sshd session whose PATH points at a fake docker binary).
import test from 'node:test';
import { solveCaptcha } from './captcha-helper.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pbkdf2Sync } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

import { listContainersScript, parseContainerLines, buildDockerAction, buildDockerLogsCommand, statsScript, parseStatsLines, imagesScript, parseImageLines, buildImageAction } from '../../standalone/docker.mjs';

test('docker command builders validate names, actions and tails', () => {
  assert.equal(listContainersScript(), "docker ps -a --no-trunc --format '{{json .}}'");
  assert.equal(statsScript(), "docker stats --no-stream --format '{{json .}}'");
  assert.equal(imagesScript(), "docker images --no-trunc --format '{{json .}}'");

  assert.equal(buildDockerAction('caddy', 'restart').command, "docker restart 'caddy'");
  assert.equal(buildDockerAction('filebrowser', 'remove').command, "docker rm -f 'filebrowser'");
  assert.equal(buildDockerAction('a.b-c_1', 'start').command, "docker start 'a.b-c_1'");
  assert.equal(buildDockerAction('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'stop').command.includes("'012345"), true);

  // Injection attempts must be rejected, not quoted through.
  for (const evil of ['', 'x; rm -rf /', '$(id)', '`id`', 'a b', "a'b", 'a"b', 'x\ny', 'x'.repeat(200), '-leading-dash']) {
    assert.throws(() => buildDockerAction(evil, 'start'), /Invalid container/, JSON.stringify(evil));
    assert.throws(() => buildDockerLogsCommand(evil, 200), /Invalid container/, JSON.stringify(evil));
  }
  for (const badAction of ['exec', '', 'start extra', 'START']) {
    assert.throws(() => buildDockerAction('caddy', badAction), /Unsupported action/);
  }
  for (const badTail of [0, 10, 19, 2001, 100000, 'nan', null, 1.5]) {
    assert.throws(() => buildDockerLogsCommand('caddy', badTail), /Tail/);
  }
  // undefined falls back to the 200-line default.
  assert.equal(buildDockerLogsCommand('caddy').command, "docker logs --timestamps --tail 200 'caddy' 2>&1");
  assert.equal(buildDockerLogsCommand('caddy', '500').command, "docker logs --timestamps --tail 500 'caddy' 2>&1");
});

test('parseImageLines maps docker images JSON and flags dangling/unreferenced images', () => {
  const stdout = [
    '{"Containers":"1","CreatedAt":"2026-10-11 08:05:08 +0200 CEST","CreatedSince":"13 hours ago","Digest":"\u003cnone\u003e","ID":"sha256:26c57eb7621099abcdef0123456789abcdef0123456789abcdef0123456789","Repository":"caddy","SharedSize":"0B","Size":"52.4MB","UniqueSize":"52.4MB","VirtualSize":"52.4MB"}',
    '{"Containers":"0","CreatedAt":"2026-10-11 07:00:00 +0000 UTC","CreatedSince":"2 days ago","ID":"sha256:e16e50103cf4abcde0123456789abcdef0123456789abcdef0123456789","Repository":"\u003cnone\u003e","Tag":"\u003cnone\u003e","Size":"12MB"}',
    'junk line',
    '{"ID":""}',
  ].join('\n');
  const images = parseImageLines(stdout);
  assert.equal(images.length, 2, 'junk and empty-ID lines dropped');
  assert.equal(images[0].repository, 'caddy');
  assert.equal(images[0].tag, ''); // absent Tag → empty string
  assert.equal(images[0].short_id, '26c57eb76210');
  assert.equal(images[0].containers, 1);
  assert.equal(images[0].size, '52.4MB');
  assert.equal(images[0].created_since, '13 hours', 'trailing " ago" stripped');
  assert.equal(images[1].dangling, true);
  assert.equal(images[1].containers, 0);
});

test('buildImageAction validates refs and maps prune variants', () => {
  assert.deepEqual(buildImageAction('nginx:alpine', 'pull'), { command: "docker pull 'nginx:alpine'", timeout: 300000 });
  assert.deepEqual(buildImageAction('ghcr.io/a/b:v1.2', 'remove'), { command: "docker rmi -f 'ghcr.io/a/b:v1.2'", timeout: 60000 });
  assert.equal(buildImageAction(null, 'prune-dangling').command, 'docker image prune -f');
  assert.equal(buildImageAction(null, 'prune-all').command, 'docker image prune -a -f');
  for (const bad of ['nginx:alpine; rm -rf /', '', 'a b', '$(x)', '-leadingdash', 'a..b', 'with$var']) {
    assert.throws(() => buildImageAction(bad, 'pull'), /Invalid image reference/);
    assert.throws(() => buildImageAction(bad, 'remove'), /Invalid image reference/);
  }
  assert.throws(() => buildImageAction('nginx', 'explode'), /Unsupported action/);
});

test('parseStatsLines maps docker stats JSON, strips name prefixes and tolerates junk lines', () => {
  const stdout = [
    '{"BlockIO":"1.2kB / 3.4MB","CPUPerc":"0.12%","MemUsage":"1.5GiB / 3.8GiB","MemPerc":"39.4%","NetIO":"5MB / 2MB","PIDs":"7","ID":"26c57eb76210","Name":"/caddy"}',
    'WARNING: some notice line',
    '{"BlockIO":"0B / 0B","CPUPerc":"0.00%","MemUsage":"0B / 0B","MemPerc":"0.00%","NetIO":"0B / 0B","ID":"e16e50103cf4","Name":"second,alias"}',
    'not json at all',
    '',
  ].join('\n');
  const stats = parseStatsLines(stdout);
  assert.equal(stats.size, 2);
  assert.deepEqual(stats.get('caddy'), {
    cpu_percent: '0.12%', mem_usage: '1.5GiB / 3.8GiB', mem_percent: '39.4%',
    net_io: '5MB / 2MB', block_io: '1.2kB / 3.4MB',
  });
  assert.equal(stats.get('second').mem_usage, '0B / 0B');
  assert.equal(parseStatsLines('').size, 0);
  assert.equal(parseStatsLines(null).size, 0);
});

test('parseContainerLines maps docker ps JSON and tolerates junk lines', () => {
  const stdout = [
    '{"Names":"caddy","ID":"26c57eb7621099abcdef0123456789abcdef0123456789abcdef0123456789","Image":"caddy:latest","State":"running","Status":"Up 13 hours (healthy)","RunningFor":"13 hours ago","Ports":"0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/udp, 2019/tcp","CreatedAt":"2026-10-11 08:05:08 +0200 CEST"}',
    'WARNING: some unrelated docker warning', // skipped
    '{"Names":"filebrowser","ID":"e16e50103cf4abcde0123456789abcdef0123456789abcdef0123456789","Image":"filebrowser/filebrowser:latest","State":"exited","Status":"Exited (0) 2 minutes ago","RunningFor":"2 minutes ago","Ports":"0.0.0.0:8060->80/tcp, [::]:8060->80/tcp","CreatedAt":"2026-10-11 07:00:00 +0000 UTC"}',
    '',
  ].join('\n');
  const containers = parseContainerLines(stdout);
  assert.equal(containers.length, 2);
  assert.equal(containers[0].name, 'caddy');
  assert.equal(containers[0].short_id, '26c57eb76210');
  assert.equal(containers[0].image, 'caddy:latest');
  assert.equal(containers[0].state, 'running');
  assert.equal(containers[0].status, 'Up 13 hours (healthy)');
  assert.equal(containers[0].running_for, '13 hours'); // " ago" stripped
  assert.equal(containers[0].ports, '0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/udp, 2019/tcp');
  assert.equal(containers[1].state, 'exited');
  assert.equal(containers[1].running_for, '2 minutes');

  assert.deepEqual(parseContainerLines(''), []);
  assert.deepEqual(parseContainerLines(null), []);
  // Entries without a name or ID are dropped rather than crashing the route.
  assert.deepEqual(parseContainerLines('{"Names":"","ID":"x"}'), []);
  assert.deepEqual(parseContainerLines('{"Names":"x","ID":""}'), []);
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

test('docker API enforces auth and ownership', { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-docker-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const password = 'fixture-password-123';
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: directory }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  let child;
  try {
    child = await startPanel(directory, port);
    assert.equal((await fetch(`${base}/api/docker/1/containers`)).status, 401);
    assert.equal((await fetch(`${base}/api/docker/1/action`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ container: 'x', action: 'start' }) })).status, 401);

    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    assert.equal((await api('/api/docker/999999/containers')).status, 404);
    assert.equal((await api('/api/docker/999999/action', 'POST', { container: 'x', action: 'start' })).status, 404);

    // Input validation happens before any SSH exec.
    const added = await api('/api/servers', 'POST', { name: 'docker-box', host: '127.0.0.1', port: 2222, username: 'nobody', auth_method: 'password', credential: 'x' });
    assert.equal(added.status, 201);
    const id = (await (await api('/api/servers')).json())[0].id;
    assert.equal((await api(`/api/docker/${id}/action`, 'POST', { container: 'caddy; rm -rf /', action: 'start' })).status, 400);
    assert.equal((await api(`/api/docker/${id}/action`, 'POST', { container: 'caddy', action: 'exec' })).status, 400);
    assert.equal((await api(`/api/docker/${id}/logs`, 'POST', { container: 'caddy', tail: 99999 })).status, 400);
    // Cross-origin POST is rejected.
    assert.equal((await fetch(`${base}/api/docker/${id}/action`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ container: 'caddy', action: 'start' }) })).status, 403);

    // SSH-tunnel / reverse-proxy access: Origin differs from BASE_URL but matches
    // the request Host (or X-Forwarded-Host). Must stay allowed like the main
    // routes, or docker logs POSTs fail with "Invalid origin" over the tunnel.
    // fetch() cannot override Host, so issue a raw request instead.
    const tunneled = await new Promise((resolve) => {
      const req = request(`http://127.0.0.1:${port}/api/docker/${id}/logs`, { method: 'POST', headers: { Host: 'localhost:8788', Origin: 'http://localhost:8788', Cookie: cookie, 'Content-Type': 'application/json' } }, (res) => {
        let raw = ''; res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      });
      req.end(JSON.stringify({ container: 'caddy', tail: 100 }));
    });
    // 400: input validation reached (container name passes regex, but the server
    // entry's port is unreachable — validation precedes SSH). The point: NOT 403.
    assert.notEqual(tunneled.status, 403, `tunnel POST must not be rejected as CSRF: ${tunneled.body}`);
    const forwarded = await new Promise((resolve) => {
      const req = request(`http://127.0.0.1:${port}/api/docker/${id}/logs`, { method: 'POST', headers: { Host: 'proxy.internal', 'X-Forwarded-Host': 'panel.example.com', Origin: 'https://panel.example.com', Cookie: cookie, 'Content-Type': 'application/json' } }, (res) => {
        let raw = ''; res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      });
      req.end(JSON.stringify({ container: 'caddy', tail: 100 }));
    });
    assert.notEqual(forwarded.status, 403, `X-Forwarded-Host POST must not be rejected as CSRF: ${forwarded.body}`);
    // But an Origin that matches neither BASE_URL nor Host nor XFH stays forbidden.
    const spoofed = await new Promise((resolve) => {
      const req = request(`http://127.0.0.1:${port}/api/docker/${id}/logs`, { method: 'POST', headers: { Host: 'localhost:8788', Origin: 'http://evil.example', Cookie: cookie, 'Content-Type': 'application/json' } }, (res) => {
        let raw = ''; res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.end(JSON.stringify({ container: 'caddy', tail: 100 }));
    });
    assert.equal(spoofed.status, 403);

    // A saved server without a trusted fingerprint fails politely (502, not a crash).
    const blocked = await api(`/api/docker/${id}/containers`);
    assert.equal(blocked.status, 502);
  } finally {
    await stop(child); rmSync(directory, { recursive: true, force: true });
  }
});

test('docker API manages containers over a real SSH connection with a stub docker', {
  timeout: 120000, skip: !existsSync('/usr/sbin/sshd') || process.getuid?.() !== 0,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-docker-ssh-'));
  const dataDir = join(directory, 'data');
  const sshPort = await freePort(); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const hostKey = join(directory, 'host-key'), clientKey = join(directory, 'client-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(join(directory, 'authorized_keys'), readFileSync(`${clientKey}.pub`));

  // Stub docker binary. `stop failcase` fails with docker-style stderr.
  const binDir = join(directory, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stubLines = [
    '#!/bin/sh',
    'if [ "$1" = "ps" ]; then',
    `  printf '%s\\n' '{"Names":"caddy","ID":"26c57eb7621099abcdef0123456789abcdef0123456789abcdef0123456789","Image":"caddy:latest","State":"running","Status":"Up 13 hours","RunningFor":"13 hours ago","Ports":"0.0.0.0:80->80/tcp, [::]:80->80/tcp, 2019/tcp","CreatedAt":"2026-10-11 08:05:08 +0200 CEST"}'`,
    `  printf '%s\\n' '{"Names":"filebrowser","ID":"e16e50103cf4abcde0123456789abcdef0123456789abcdef0123456789","Image":"filebrowser/filebrowser:latest","State":"exited","Status":"Exited (0) 2 minutes ago","RunningFor":"2 minutes ago","Ports":"0.0.0.0:8060->80/tcp, [::]:8060->80/tcp","CreatedAt":"2026-10-11 07:00:00 +0000 UTC"}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "stats" ]; then',
    `  printf '%s\n' '{"BlockIO":"1.2kB / 3.4MB","CPUPerc":"0.12%","MemUsage":"1.5GiB / 3.8GiB","MemPerc":"39.4%","NetIO":"5MB / 2MB","PIDs":"7","ID":"26c57eb7621099abcdef0123456789abcdef0123456789abcdef0123456789","Name":"caddy"}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "images" ]; then',
    `  printf '%s\n' '{"Containers":"1","CreatedAt":"2026-10-11 08:05:08 +0200 CEST","CreatedSince":"13 hours ago","Digest":"\u003cnone\u003e","ID":"sha256:26c57eb7621099abcdef0123456789abcdef0123456789abcdef0123456789","Repository":"caddy","SharedSize":"0B","Size":"52.4MB","UniqueSize":"52.4MB"}'`,
    `  printf '%s\n' '{"Containers":"0","CreatedAt":"2026-10-11 07:00:00 +0000 UTC","CreatedSince":"2 days ago","ID":"sha256:e16e50103cf4abcde0123456789abcdef0123456789abcdef0123456789abcdef0123456789","Repository":"\u003cnone\u003e","Tag":"\u003cnone\u003e","Size":"12MB"}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "pull" ]; then',
    '  echo "IMAGE:$*"',
    '  exit 0',
    'fi',
    'if [ "$1" = "rmi" ] || [ "$1" = "image" ]; then',
    '  echo "IMAGE:$*"',
    '  exit 0',
    'fi',
    'if [ "$1" = "logs" ]; then',
    '  echo "2026-10-11T08:00:01.000000000Z stub log line 1"',
    '  echo "2026-10-11T08:00:02.000000000Z stub log line 2"',
    '  exit 0',
    'fi',
    'if [ "$1" = "stop" ] && [ "$2" = "failcase" ]; then',
    '  echo "Error response from daemon: cannot stop container: failcase" >&2',
    '  exit 1',
    'fi',
    'echo "ACTION:$*"',
    'exit 0',
  ];
  writeFileSync(join(binDir, 'docker'), stubLines.join('\n') + '\n');
  chmodSync(join(binDir, 'docker'), 0o755);

  const sshConfig = join(directory, 'sshd_config');
  writeFileSync(sshConfig, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${directory}/sshd.pid\nAuthorizedKeysFile ${directory}/authorized_keys\nStrictModes no\nPermitRootLogin yes\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nLogLevel ERROR\nSetEnv PATH=${binDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n`);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  let panel, socket;
  try {
    await delay(150); assert.equal(sshd.exitCode, null);
    const password = 'fixture-password-123';
    execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], { env: { ...process.env, DATA_DIR: dataDir }, input: password, stdio: ['pipe', 'pipe', 'pipe'] });
    panel = await startPanel(dataDir, port);
    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = (path, method = 'GET', body) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    const added = await api('/api/servers', 'POST', { name: 'docker-box', host: '127.0.0.1', port: sshPort, username: userInfo().username, auth_method: 'publickey', credential: readFileSync(clientKey, 'utf8') });
    assert.equal(added.status, 201);
    const id = (await (await api('/api/servers')).json()).find((item) => item.name === 'docker-box').id;

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

    // List containers through the stub docker.
    const listed = await api(`/api/docker/${id}/containers`);
    if (listed.status !== 200) throw new Error(`container list failed: ${JSON.stringify(await listed.json())}`);
    const containers = (await listed.json()).containers;
    assert.equal(containers.length, 2);
    assert.equal(containers[0].name, 'caddy');
    assert.equal(containers[0].state, 'running');
    assert.equal(containers[0].running_for, '13 hours');
    // Stats from the stub merge into running containers only.
    assert.equal(containers[0].cpu_percent, '0.12%');
    assert.equal(containers[0].mem_usage, '1.5GiB / 3.8GiB');
    assert.equal(containers[0].mem_percent, '39.4%');
    assert.equal(containers[1].name, 'filebrowser');
    assert.equal(containers[1].cpu_percent, undefined, 'stopped containers have no stats');

    // Image list and image actions share the same exec pipeline.
    const listedImages = await api(`/api/docker/${id}/images`);
    assert.equal(listedImages.status, 200);
    const { images } = await listedImages.json();
    assert.equal(images.length, 2);
    assert.equal(images[0].repository, 'caddy');
    assert.equal(images[1].dangling, true);
    const pulled = await api(`/api/docker/${id}/image-action`, 'POST', { ref: 'nginx:alpine', action: 'pull' });
    assert.equal(pulled.status, 200);
    assert.match((await pulled.json()).stdout, /IMAGE:pull nginx:alpine/);
    const pruned = await api(`/api/docker/${id}/image-action`, 'POST', { action: 'prune-dangling' });
    assert.match((await pruned.json()).stdout, /IMAGE:image prune -f/);
    assert.equal((await api(`/api/docker/${id}/image-action`, 'POST', { ref: 'nginx; rm -rf /', action: 'pull' })).status, 400, 'dangerous refs rejected');
    assert.equal((await api(`/api/docker/${id}/image-action`, 'POST', { ref: 'nginx', action: 'explode' })).status, 400);
    assert.equal(containers[1].name, 'filebrowser');
    assert.equal(containers[1].state, 'exited');

    // Immediate re-list is throttled per server.
    assert.equal((await api(`/api/docker/${id}/containers`)).status, 429);

    // Lifecycle actions reach the stub docker with validated names.
    const restart = await (await api(`/api/docker/${id}/action`, 'POST', { container: 'caddy', action: 'restart' })).json();
    assert.equal(restart.ok, true, JSON.stringify(restart));
    assert.match(restart.stdout, /ACTION:restart caddy/);
    const remove = await (await api(`/api/docker/${id}/action`, 'POST', { container: 'filebrowser', action: 'remove' })).json();
    assert.match(remove.stdout, /ACTION:rm -f filebrowser/);
    // Docker-side failures come back as ok:false with stderr, not a route error.
    const failed = await api(`/api/docker/${id}/action`, 'POST', { container: 'failcase', action: 'stop' });
    assert.equal(failed.status, 200);
    const failedResult = await failed.json();
    assert.equal(failedResult.ok, false);
    assert.match(failedResult.stderr, /cannot stop container: failcase/);

    // Logs render the stub output with timestamps.
    const logs = await api(`/api/docker/${id}/logs`, 'POST', { container: 'caddy', tail: 100 });
    assert.equal(logs.status, 200);
    const logsBody = await logs.json();
    assert.match(logsBody.logs, /stub log line 1\n.*stub log line 2/);

    // Regression (db069fc): aborting an in-flight docker listing (client
    // disconnect) must not poison the cooldown for the replacement request.
    // Slow the ps stub down so the abort lands while SSH is still running.
    await delay(1600);
    writeFileSync(join(binDir, 'docker'), stubLines.join('\n').replace('if [ "$1" = "ps" ]; then', 'if [ "$1" = "ps" ]; then\n  sleep 2') + '\n');
    let aborting = true;
    try {
      const aborter = new AbortController();
      const inflight = fetch(`${base}/api/docker/${id}/containers`, { signal: aborter.signal, headers: { Cookie: cookie, Origin: base } });
      await delay(400);
      aborter.abort();
      await inflight.catch(() => {});
      const replacement = await api(`/api/docker/${id}/containers`);
      if (replacement.status !== 200) throw new Error(`replacement after abort got ${replacement.status}: ${JSON.stringify(await replacement.json().catch(() => ({})))}`);
      assert.equal(replacement.status, 200);
      aborting = false;
    } finally {
      if (aborting) writeFileSync(join(binDir, 'docker'), stubLines.join('\n') + '\n');
    }
    writeFileSync(join(binDir, 'docker'), stubLines.join('\n') + '\n');

    // After the throttle window the list works again.
    await delay(1600);
    assert.equal((await api(`/api/docker/${id}/containers`)).status, 200);
  } finally {
    socket?.close(); await stop(panel); await stop(sshd); rmSync(directory, { recursive: true, force: true });
  }
});
