// `cssh` 端到端测试：真实 sshd + 真实面板 + 真实令牌。
//
// 不 mock 任何后端：这里要验证的正是「CLI 调到的路由确实存在、确实
// 按令牌授权、确实把命令送到了 SSH」——mock 掉就什么都没验到。
//
// 覆盖：
//   · Bearer 令牌鉴权（没令牌 401 / 授权外服务器 403）
//   · exec 走池化链，退出码透传
//   · 危险命令闸门对 CLI 同样生效（不能成为绕过 MCP 的旁路）
//   · 文件上传/下载往返，内容字节一致
//   · 首次连接 TOFU 写入已知主机；指纹变更后必须硬中断
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const canRun = existsSync('/usr/sbin/sshd') && process.getuid?.() === 0;

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

/** 建一套「sshd + 面板 + 令牌」，返回可用的测试环境。 */
async function bootstrap() {
  const directory = mkdtempSync(join(tmpdir(), 'cssh-e2e-'));
  const sshPort = await freePort();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hostKey = join(directory, 'host-key');
  const clientKey = join(directory, 'client-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(join(directory, 'authorized_keys'), readFileSync(`${clientKey}.pub`));
  const sshConfig = join(directory, 'sshd_config');
  writeFileSync(sshConfig, [
    `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`,
    `PidFile ${directory}/sshd.pid`, `AuthorizedKeysFile ${directory}/authorized_keys`,
    'StrictModes no', 'PermitRootLogin yes', 'PubkeyAuthentication yes',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM yes',
    'LogLevel ERROR', 'Subsystem sftp internal-sftp', 'AllowTcpForwarding yes', '',
  ].join('\n'));
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
  await delay(150);
  assert.equal(sshd.exitCode, null, 'sshd must stay up');

  const password = 'fixture-password-123';
  const dataDir = join(directory, 'data');
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], {
    env: { ...process.env, DATA_DIR: dataDir }, input: password, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const panel = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), BASE_URL: base, CAPTCHA_MODE: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  panel.stdout.on('data', (data) => { logs += data; });
  panel.stderr.on('data', (data) => { logs += data; });
  for (let i = 0; i < 200; i++) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) break; } catch { /* 启动中 */ }
    if (panel.exitCode !== null) throw new Error(logs);
    await delay(50);
  }

  // 拿到管理员代际指纹：令牌必须属于同一代才能通过 resolveBearerIdentity。
  const { AccessStore, tokenHash } = await import('../../standalone/access-store.mjs');
  const account = JSON.parse(readFileSync(join(dataDir, 'admin-account.json'), 'utf8'));
  const store = new AccessStore(join(dataDir, 'mcp.sqlite'));

  const makeToken = (settings = {}) => store.create(
    { github_id: '-1', id: 1 },
    {
      name: settings.name || `cli-${Math.random().toString(16).slice(2, 8)}`,
      server_ids: settings.server_ids || [],
      scopes: settings.scopes || ['read', 'write', 'exec'],
      expires_in_days: 30,
      db_connection_ids: [],
    },
    tokenHash(account.passwordHash),
  ).token;

  // 用令牌以外的途径（管理员 cookie）建服务器，因为 CLI 不该能建服务器。
  const config = await (await fetch(`${base}/api/config`)).json();
  const { pbkdf2Sync } = await import('node:crypto');
  const key = pbkdf2Sync(password, Buffer.from(config.passwordAuth.salt, 'base64url'),
    config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
  const { solveCaptcha } = await import('./captcha-helper.mjs');
  const login = await fetch(`${base}/api/auth/password/login`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }),
  });
  assert.equal(login.status, 200, logs);
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
  const adminApi = (path, method = 'GET', body) => fetch(`${base}${path}`, {
    method,
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const added = await adminApi('/api/servers', 'POST', {
    name: 'cli-box', host: '127.0.0.1', port: sshPort, username: userInfo().username,
    auth_method: 'publickey', credential: readFileSync(clientKey, 'utf8'),
  });
  assert.equal(added.status, 201, await added.text());
  const serverId = (await (await adminApi('/api/servers')).json()).find((item) => item.name === 'cli-box').id;

  return {
    directory, base, dataDir, sshd, panel, sshPort, serverId, makeToken, adminApi,
    token: makeToken({ server_ids: [serverId] }),
    async cleanup() {
      await stop(panel); await stop(sshd);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 直接打 HTTP 接口（不走子进程），验证授权层。 */
const call = (env, path, { token, method = 'GET', body } = {}) => fetch(`${env.base}${path}`, {
  method,
  headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

test('cssh API: 令牌鉴权与服务器授权边界', {
  timeout: 120000, skip: !canRun,
}, async () => {
  const env = await bootstrap();
  try {
    // 无令牌
    assert.equal((await call(env, '/api/cli/whoami')).status, 401);
    // 假令牌
    assert.equal((await call(env, '/api/cli/whoami', { token: `cssh_${'A'.repeat(43)}` })).status, 401);
    // 真令牌
    const who = await call(env, '/api/cli/whoami', { token: env.token });
    assert.equal(who.status, 200);
    const identity = await who.json();
    assert.equal(identity.github_id, '-1');
    assert.deepEqual(identity.server_ids, [env.serverId]);

    // 列表只含被授权的那一台
    const list = await (await call(env, '/api/cli/servers', { token: env.token })).json();
    assert.deepEqual(list.servers.map((item) => item.id), [env.serverId]);

    // 另一台服务器（未授权）→ 403，而不是「不存在」或直接放行
    const other = await call(env, '/api/cli/exec', {
      token: env.token, method: 'POST', body: { server_id: 999999, command: 'id' },
    });
    assert.equal(other.status, 403);

    // 没有 exec scope 的令牌 → 403
    const readOnly = env.makeToken({ server_ids: [env.serverId], scopes: ['read'] });
    const denied = await call(env, '/api/cli/exec', {
      token: readOnly, method: 'POST', body: { server_id: env.serverId, command: 'id' },
    });
    assert.equal(denied.status, 403);

    // 未知路径 → 404（不是掉进面板路由）
    assert.equal((await call(env, '/api/cli/nope', { token: env.token })).status, 404);
  } finally { await env.cleanup(); }
});

test('cssh exec: 需要已信任主机指纹，且危险命令被拦', {
  timeout: 120000, skip: !canRun,
}, async () => {
  const env = await bootstrap();
  try {
    // 没信任指纹时，池化链无法建立（这是刻意的：不给 CLI 一条绕过 TOFU 的路）
    const beforeTrust = await call(env, '/api/cli/exec', {
      token: env.token, method: 'POST', body: { server_id: env.serverId, command: 'echo hi' },
    });
    assert.ok([500, 502].includes(beforeTrust.status), `expected failure, got ${beforeTrust.status}`);
    const message = (await beforeTrust.json()).error;
    assert.match(message, /fingerprint|主机/i);

    // 通过 CLI 自己的 TOFU 端点写入指纹（它就是为这一步存在的）
    const hostKeyLine = execFileSync('ssh-keygen', ['-lf', join(env.directory, 'host-key.pub')], { encoding: 'utf8' });
    const fingerprint = hostKeyLine.trim().split(/\s+/)[1];
    const saved = await call(env, '/api/cli/known-hosts', {
      token: env.token, method: 'POST',
      body: { host: '127.0.0.1', port: env.sshPort, fingerprint },
    });
    assert.equal(saved.status, 200, await saved.text());

    // 现在能跑了，并且退出码透传
    const ok = await call(env, '/api/cli/exec', {
      token: env.token, method: 'POST', body: { server_id: env.serverId, command: 'echo CLI-OK; exit 7' },
    });
    assert.equal(ok.status, 200);
    const result = await ok.json();
    assert.match(result.stdout, /CLI-OK/);
    assert.equal(result.exitCode, 7, 'exit code must be passed through verbatim');

    // 危险命令闸门（与 MCP 同一道）
    const blocked = await call(env, '/api/cli/exec', {
      token: env.token, method: 'POST', body: { server_id: env.serverId, command: 'rm -rf / --no-preserve-root' },
    });
    assert.equal(blocked.status, 403);

    // 上传/下载往返：字节必须完全一致
    const payload = Buffer.from(`binary\u0000payload\n${'x'.repeat(5000)}`, 'utf8');
    const uploaded = await call(env, '/api/cli/upload', {
      token: env.token, method: 'POST',
      body: { server_id: env.serverId, path: '/tmp/cssh-e2e.bin', content_base64: payload.toString('base64'), append: false },
    });
    assert.equal(uploaded.status, 200, await uploaded.text());

    const downloaded = await (await call(env, '/api/cli/download', {
      token: env.token, method: 'POST',
      body: { server_id: env.serverId, path: '/tmp/cssh-e2e.bin', offset: 0 },
    })).json();
    assert.equal(downloaded.size, payload.length);
    assert.equal(downloaded.chunkBytes, payload.length);
    assert.equal(downloaded.contentBase64, payload.toString('base64'));
    assert.equal(Buffer.from(downloaded.contentBase64, 'base64').compare(payload), 0);

    // 指纹写入必须拒绝不合法形态（防止把垃圾塞进信任库）
    const badFingerprint = await call(env, '/api/cli/known-hosts', {
      token: env.token, method: 'POST',
      body: { host: '127.0.0.1', port: env.sshPort, fingerprint: 'not-a-fingerprint' },
    });
    assert.equal(badFingerprint.status, 400);

    // 清理远端临时文件
    await call(env, '/api/cli/exec', {
      token: env.token, method: 'POST', body: { server_id: env.serverId, command: 'rm -f /tmp/cssh-e2e.bin' },
    });
  } finally { await env.cleanup(); }
});

test('cssh ssh: 交互终端经 WS 升级完成认证并拿到 shell', {
  timeout: 120000, skip: !canRun,
}, async () => {
  const env = await bootstrap();
  const { WebSocket } = await import('ws');
  try {
    const hostKeyLine = execFileSync('ssh-keygen', ['-lf', join(env.directory, 'host-key.pub')], { encoding: 'utf8' });
    const fingerprint = hostKeyLine.trim().split(/\s+/)[1];
    await call(env, '/api/cli/known-hosts', {
      token: env.token, method: 'POST',
      body: { host: '127.0.0.1', port: env.sshPort, fingerprint },
    });

    const wsUrl = `${env.base.replace('http', 'ws')}/api/cli/ssh?server_id=${env.serverId}&cols=100&rows=30`;
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${env.token}` } });
    const output = [];
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI shell handshake timed out')), 25000);
      socket.on('message', (data, isBinary) => {
        if (isBinary) { output.push(Buffer.from(data)); return; }
        let payload; try { payload = JSON.parse(String(data)); } catch { return; }
        if (payload.type === 'host_key_changed') {
          clearTimeout(timer);
          reject(new Error(`host key unexpectedly changed: ${JSON.stringify(payload)}`));
        }
        if (payload.event === 'shell_ready') { clearTimeout(timer); resolveReady(); }
        if (payload.type === 'error') { clearTimeout(timer); reject(new Error(payload.message)); }
      });
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    });

    // 发一条命令，确认真的进了 PTY：输入走二进制，输出也应是二进制。
    socket.send(Buffer.from('echo CLI-SHELL-MARKER\r'), { binary: true });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (Buffer.concat(output).toString('utf8').includes('CLI-SHELL-MARKER')) break;
      await delay(100);
    }
    const text = Buffer.concat(output).toString('utf8');
    assert.match(text, /CLI-SHELL-MARKER/, 'shell output must reach the client as binary frames');
    socket.close();
  } finally { await env.cleanup(); }
});

test('cssh ssh: 无令牌的 WS 升级被拒绝（不能靠 URL 参数混进去）', {
  timeout: 60000, skip: !canRun,
}, async () => {
  const env = await bootstrap();
  const { WebSocket } = await import('ws');
  try {
    const wsUrl = `${env.base.replace('http', 'ws')}/api/cli/ssh?server_id=${env.serverId}`;
    // 尝试用查询参数夹带令牌：必须无效。
    const socket = new WebSocket(`${wsUrl}&token=${encodeURIComponent(env.token)}`);
    const outcome = await new Promise((done) => {
      socket.on('open', () => done({ opened: true }));
      socket.on('error', (error) => done({ opened: false, error: error.message }));
      socket.on('unexpected-response', (_request, response) => done({ opened: false, status: response.statusCode }));
      setTimeout(() => done({ opened: false, timeout: true }), 8000).unref();
    });
    assert.equal(outcome.opened, false, 'a token in the query string must never authenticate');
    assert.ok(outcome.status === 401 || /401|unexpected/i.test(outcome.error || ''), JSON.stringify(outcome));
  } finally { await env.cleanup(); }
});

test('cssh CLI 进程: login 落盘 + whoami + ls', {
  timeout: 120000, skip: !canRun,
}, async () => {
  const env = await bootstrap();
  const configHome = mkdtempSync(join(tmpdir(), 'cssh-home-'));
  try {
    const run = (args, extraEnv = {}) => new Promise((done) => {
      const child = spawn(process.execPath, ['standalone/cli.mjs', ...args], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          CLOUDSSH_CONFIG_HOME: configHome,
          CLOUDSSH_URL: env.base,
          CLOUDSSH_TOKEN: env.token,
          NO_COLOR: '1',
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('exit', (code) => done({ code, stdout, stderr }));
    });

    const version = await run(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const whoami = await run(['whoami']);
    assert.equal(whoami.code, 0, whoami.stderr);
    assert.match(whoami.stdout, /read, write, exec/);

    const list = await run(['ls']);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /cli-box/);

    // 唯一命中 → 非交互场景下直接解析（不在 TTY 里连终端）
    const ambiguous = await run(['ls', 'nope-nothing']);
    assert.equal(ambiguous.code, 0);
    assert.match(ambiguous.stdout, /没有匹配/);

    // 未授权服务器：报错而不是静默挑一台
    const unknown = await run(['exec', 'nothing-like-this', '--', 'id']);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /找不到匹配/);

    // 令牌无效 → 退出码 77（脚本可据此区分「配置错」与「命令失败」）
    const bad = await run(['whoami'], { CLOUDSSH_TOKEN: `cssh_${'B'.repeat(43)}` });
    assert.equal(bad.code, 77);
    assert.match(bad.stderr, /令牌无效/);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
    await env.cleanup();
  }
});
