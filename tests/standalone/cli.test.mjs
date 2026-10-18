// `cssh` CLI 的单元测试（不依赖 sshd / 面板）。
//
// 覆盖三块最容易写错的地方：
//   1. 主机密钥变更必须硬中断（安全关键，绝不允许自动信任）
//   2. 服务器匹配的「唯一命中才直连」语义 + 近似建议
//   3. 令牌落盘权限（0600）与 URL 校验（拒绝把令牌发往明文远端）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  configPath, readConfig, writeConfig, clearConfig, configFilePermissions,
  normalizeBaseUrl, resolveSettings, configDir,
} from '../../standalone/cli/config.mjs';
import { matchServers, nearestServers, normalize, editDistance } from '../../standalone/cli/match.mjs';
import { createClient, CliError, readNdjson } from '../../standalone/cli/api.mjs';
import { connectTerminal, TerminalError } from '../../standalone/cli/terminal.mjs';
import { truncate, displayWidth } from '../../standalone/cli/picker.mjs';

/** 假的 ws：只记录发出去的东西，并按剧本回放消息。 */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.send = (data, options) => { socket.sent.push({ data, options }); };
  socket.close = () => { socket.readyState = 3; socket.emit('close', 1000, Buffer.from('')); };
  socket.terminate = () => { socket.readyState = 3; };
  // 模拟服务端：构造后立刻 open，再按顺序吐消息。
  socket.emitScript = (messages) => {
    queueMicrotask(() => {
      socket.emit('open');
      for (const [payload, binary] of messages) {
        socket.emit('message', binary ? payload : Buffer.from(JSON.stringify(payload)), binary);
      }
    });
  };
  return socket;
}

function fakeWebSocketClass(socket) {
  return class {
    constructor() { queueMicrotask(() => socket.emit('open')); return socket; }
  };
}

// ==================== 主机密钥：安全关键 ====================

test('host_key_changed 硬中断连接，且绝不写入已知主机', async () => {
  const socket = fakeSocket();
  let knownHostWrites = 0;
  const events = [];
  const promise = connectTerminal({
    wsUrl: 'ws://panel/api/cli/ssh?server_id=1',
    token: 'cssh_test',
    cols: 80,
    rows: 24,
    wsImpl: fakeWebSocketClass(socket),
    onEvent: (event) => events.push(event),
    onOutput: () => {},
    onHostKeyVerified: () => { knownHostWrites++; },
  });
  socket.emitScript([
    [{ type: 'status', event: 'banner', message: '' }],
    [{
      type: 'status', event: 'host_key_changed',
      fingerprint: 'SHA256:NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW',
      expectedFingerprint: 'SHA256:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD',
      host: '10.0.0.5', displayHost: 'prod-web', keyType: 'ssh-ed25519',
    }],
  ]);
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof TerminalError, 'must be a TerminalError');
    assert.equal(error.exitCode, 3, 'host key change must use a dedicated non-zero exit code');
    // 必须把新旧指纹都打出来，否则人无法判断是重装还是被劫持。
    assert.match(error.message, /SHA256:NEWNEW/);
    assert.match(error.message, /SHA256:OLDOLD/);
    assert.match(error.message, /prod-web/);
    return true;
  });
  assert.equal(knownHostWrites, 0, 'host_key_changed must never auto-trust a fingerprint');
  assert.equal(socket.readyState, 3, 'socket must be closed, not left dangling');
});

test('host_key_changed 以 error 帧到达时同样硬中断（另一条真实路径）', async () => {
  const socket = fakeSocket();
  let knownHostWrites = 0;
  const promise = connectTerminal({
    wsUrl: 'ws://panel/api/cli/ssh?server_id=1', token: 'cssh_test', cols: 80, rows: 24,
    wsImpl: fakeWebSocketClass(socket),
    onEvent: () => {},
    onOutput: () => {},
    onHostKeyVerified: () => { knownHostWrites++; },
  });
  // sessionPolicy.allowHostKeyMutation === false 时服务端走 sendError 分支。
  socket.emitScript([[{ type: 'error', event: 'host_key_changed', message: '主机密钥已变更' }]]);
  await assert.rejects(promise, (error) => error instanceof TerminalError && error.exitCode === 3);
  assert.equal(knownHostWrites, 0);
});

test('建链后首帧先对齐 PTY 尺寸（避免远端按默认 80x24 渲染）', async () => {
  const socket = fakeSocket();
  const promise = connectTerminal({
    wsUrl: 'ws://panel/api/cli/ssh?server_id=1', token: 'cssh_test', cols: 132, rows: 43,
    wsImpl: fakeWebSocketClass(socket),
    onEvent: () => {},
    onOutput: () => {},
  });
  socket.emitScript([[{ type: 'status', event: 'shell_ready', message: '' }]]);
  await promise;
  assert.equal(socket.sent.length >= 1, true, 'must send at least the resize frame');
  const first = JSON.parse(String(socket.sent[0].data ?? socket.sent[0]));
  assert.deepEqual(first, { type: 'resize', cols: 132, rows: 43 });
});

test('host_key_verified 才触发首次信任写入，且 shell_ready 前就可记录', async () => {
  const socket = fakeSocket();
  const recorded = [];
  const promise = connectTerminal({
    wsUrl: 'ws://panel/api/cli/ssh?server_id=1', token: 'cssh_test', cols: 100, rows: 40,
    wsImpl: fakeWebSocketClass(socket),
    onEvent: () => {},
    onOutput: () => {},
    onHostKeyVerified: (payload) => recorded.push(payload),
  });
  socket.emitScript([
    // 真实协议：host_key_verified 是独立消息类型（ssh-session.ts:1375），
    // 不是 status 事件的 error/event 字段。
    [{
      type: 'host_key_verified', firstSeen: true,
      fingerprint: 'SHA256:FRESH', keyType: 'ssh-ed25519',
      host: '10.0.0.9', port: 22, displayHost: 'prod-web',
    }],
    [{ type: 'status', event: 'shell_ready', message: '' }],
  ]);
  const session = await promise;
  assert.deepEqual(recorded.map((item) => item.fingerprint), ['SHA256:FRESH']);
  assert.ok(session.socket);
  session.close();
});

test('host_key_changed 在 shell_ready 之后到达仍然中断（不能只管握手阶段）', async () => {
  const socket = fakeSocket();
  const promise = connectTerminal({
    wsUrl: 'ws://panel/api/cli/ssh?server_id=1', token: 'cssh_test', cols: 80, rows: 24,
    wsImpl: fakeWebSocketClass(socket),
    onEvent: () => {},
    onOutput: () => {},
  });
  socket.emitScript([[{ type: 'status', event: 'shell_ready', message: '' }]]);
  await promise; // 会话已建立
  // 握手阶段签过了，但后续某次密钥交换发现指纹变化。
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'status', event: 'host_key_changed', fingerprint: 'SHA256:LATER',
  })), false);
  assert.equal(socket.readyState, 3);
});

// ==================== 终端协议：字节必须 1:1 ====================

test('PTY 输出以二进制原样写 stdout，不重新编码', async () => {
  const socket = fakeSocket();
  const output = [];
  const promise = connectTerminal({
    wsUrl: 'ws://panel/api/cli/ssh?server_id=1', token: 'cssh_test', cols: 80, rows: 24,
    wsImpl: fakeWebSocketClass(socket),
    onEvent: () => {},
    onOutput: (chunk) => output.push(chunk),
  });
  // 含 ANSI 转义与 UTF-8 多字节字符：任何「先转字符串再输出」都会破坏它。
  const payload = Buffer.from('\x1b[1;32m✓ 部署完成\x1b[0m\r\n', 'utf8');
  socket.emitScript([
    [{ type: 'status', event: 'shell_ready', message: '' }],
    [payload, true],
  ]);
  await promise;
  assert.equal(output.length, 1);
  assert.ok(Buffer.isBuffer(output[0]));
  assert.equal(output[0].toString('hex'), payload.toString('hex'));
});

// ==================== 服务器匹配 ====================

const SERVERS = [
  { id: 1, name: 'prod-web-01', host: '10.0.0.11', port: 22, username: 'deploy', tags: ['prod', 'web'] },
  { id: 2, name: 'prod-web-02', host: '10.0.0.12', port: 22, username: 'deploy', tags: ['prod', 'web'] },
  { id: 3, name: 'prod-db', host: '10.0.0.21', port: 5432, username: 'postgres', tags: ['prod', 'db'] },
  { id: 4, name: 'staging', host: '192.168.1.5', port: 22, username: 'ubuntu', tags: ['stage'] },
];

test('唯一命中时 exact 直接返回（快捷路径的核心）', () => {
  assert.equal(matchServers(SERVERS, 'prod-db').exact?.id, 3, 'exact name');
  assert.equal(matchServers(SERVERS, '3').exact?.id, 3, 'exact id');
  assert.equal(matchServers(SERVERS, 'staging').exact?.id, 4);
  assert.equal(matchServers(SERVERS, '10.0.0.21').exact?.id, 3, 'exact host');
});

test('多命中时 exact 为 null，交给上层选择（绝不猜）', () => {
  const result = matchServers(SERVERS, 'prod');
  assert.equal(result.exact, null, 'ambiguous query must never auto-connect');
  assert.ok(result.matches.length >= 3);
});

test('零命中时给近似建议', () => {
  assert.equal(matchServers(SERVERS, 'prod-wbe-01').matches.length, 0);
  const nearest = nearestServers(SERVERS, 'prod-wbe-01');
  assert.ok(nearest.some((item) => item.name === 'prod-web-01'), 'typo must suggest the intended server');
});

test('清空缓冲与归一化', () => {
  assert.equal(normalize('  prod_web  01 '), 'prod-web-01');
  assert.equal(editDistance('abc', 'abd'), 1);
  assert.equal(editDistance('', 'abc'), 3);
});

test('别名优先于模糊匹配', () => {
  const result = matchServers(SERVERS, 'db', { aliases: { db: 'prod-db' } });
  assert.equal(result.exact?.id, 3);
});

test('标签查询 @prod 只命中带该标签的机器', () => {
  const result = matchServers(SERVERS, '@db');
  assert.equal(result.exact?.id, 3);
  const prod = matchServers(SERVERS, '@prod');
  assert.equal(prod.exact, null);
  assert.equal(prod.matches.length, 3);
});

// ==================== 配置与令牌 ====================

test('令牌落盘权限为 0600，目录 0700', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cssh-config-'));
  try {
    const env = { CLOUDSSH_CONFIG_HOME: directory };
    writeConfig({ baseUrl: 'https://panel.example.com', token: 'cssh_secret' }, env);
    assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);
    assert.equal(statSync(configDir(env)).mode & 0o777, 0o700);
    assert.equal(readConfig(env).token, 'cssh_secret');
    assert.deepEqual(configFilePermissions(env), { mode: 0o600, tooOpen: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('权限过宽的配置文件被标记 tooOpen（提示用户收紧）', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cssh-config-'));
  try {
    const env = { CLOUDSSH_CONFIG_HOME: directory };
    writeConfig({ baseUrl: 'https://panel.example.com', token: 'cssh_secret' }, env);
    chmodSync(configPath(env), 0o644);
    assert.equal(configFilePermissions(env)?.tooOpen, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('logout 删除配置文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cssh-config-'));
  try {
    const env = { CLOUDSSH_CONFIG_HOME: directory };
    writeConfig({ baseUrl: 'https://panel.example.com', token: 'cssh_secret' }, env);
    assert.equal(clearConfig(env), true);
    assert.equal(existsSync(configPath(env)), false);
    assert.equal(clearConfig(env), false, 'second logout is a no-op');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('明文 HTTP 只允许回环地址，除非显式 --insecure', () => {
  // normalizeBaseUrl 返回 origin 字符串本身（不是 URL 对象）。
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
  assert.equal(normalizeBaseUrl('http://localhost:8788'), 'http://localhost:8788');
  assert.throws(() => normalizeBaseUrl('http://5.175.220.95:8788'), /HTTPS|insecure/i);
  assert.equal(
    normalizeBaseUrl('http://5.175.220.95:8788', { allowInsecure: true }),
    'http://5.175.220.95:8788',
  );
});

test('URL 里不允许带路径/查询/用户信息（避免把令牌发到奇怪的地方）', () => {
  assert.throws(() => normalizeBaseUrl('https://panel.example.com/admin'), /路径|path|域名/i);
  assert.throws(() => normalizeBaseUrl('https://user:pass@panel.example.com'), /用户名|user/i);
  assert.throws(() => normalizeBaseUrl('https://panel.example.com/?x=1'), /路径|查询|域名/i);
});

test('令牌来源优先级：flag > env > file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cssh-config-'));
  try {
    const env = { CLOUDSSH_CONFIG_HOME: directory, ...process.env };
    writeConfig({ baseUrl: 'https://file.example.com', token: 'cssh_file' }, env);
    const fromFile = resolveSettings({ flags: {}, env: { ...env, CLOUDSSH_TOKEN: '', CLOUDSSH_URL: '' } });
    assert.equal(fromFile.token, 'cssh_file');
    assert.equal(fromFile.source, 'file');

    const fromEnv = resolveSettings({ flags: {}, env: { ...env, CLOUDSSH_TOKEN: 'cssh_env' } });
    assert.equal(fromEnv.token, 'cssh_env');
    assert.equal(fromEnv.source, 'env');

    const fromFlag = resolveSettings({ flags: { token: 'cssh_flag' }, env: { ...env, CLOUDSSH_TOKEN: 'cssh_env' } });
    assert.equal(fromFlag.token, 'cssh_flag');
    assert.equal(fromFlag.source, 'flag');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('未配置时 resolveSettings 返回空而不抛异常（由调用方给友好提示）', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cssh-config-'));
  try {
    const settings = resolveSettings({ flags: {}, env: { CLOUDSSH_CONFIG_HOME: directory } });
    assert.equal(settings.token, '');
    assert.equal(settings.source, 'none');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ==================== HTTP 客户端 ====================

test('401 被翻译成中文可执行提示，而不是英文原样透出', async () => {
  const api = createClient({
    baseUrl: 'https://panel.example.com',
    token: 'cssh_x',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Invalid, expired, revoked or disabled access token' }), { status: 401 }),
  });
  await assert.rejects(api.whoami(), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.status, 401);
    assert.match(error.message, /令牌无效/);
    return true;
  });
});

test('403 提示权限范围而非「服务器不存在」', async () => {
  const api = createClient({
    baseUrl: 'https://panel.example.com', token: 'cssh_x',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Server is not authorized for this token' }), { status: 403 }),
  });
  await assert.rejects(api.exec(7, 'uptime'), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /权限|授权/);
    return true;
  });
});

test('Bearer 令牌走 Authorization 头，绝不进 URL', async () => {
  const seen = [];
  const api = createClient({
    baseUrl: 'https://panel.example.com', token: 'cssh_secret_token',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      return new Response(JSON.stringify({ servers: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await api.servers();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.Authorization, 'Bearer cssh_secret_token');
  assert.doesNotMatch(seen[0].url, /cssh_secret_token/, 'token must never appear in a URL (logs, proxies)');
});

test('NDJSON 流按行重组，跨块的行不会丢', async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      // 故意在 JSON 中间切断，验证有缓冲重组。
      controller.enqueue(encoder.encode('{"type":"output","text":"ab'));
      controller.enqueue(encoder.encode('c"}\n{"type":"done","exitCode":0}\n'));
      controller.close();
    },
  }));
  const events = [];
  for await (const event of readNdjson(response)) events.push(event);
  assert.deepEqual(events, [
    { type: 'output', text: 'abc' },
    { type: 'done', exitCode: 0 },
  ]);
});

// ==================== 终端宽度截断 ====================

test('截断：装得下就原样返回，装不下用 … 顶替且不溢出', () => {
  assert.equal(truncate('abc', 3), 'abc', 'exactly fitting must not gain an ellipsis');
  assert.equal(truncate('ab', 3), 'ab');
  assert.equal(truncate('abcdef', 3), 'ab…');
  assert.equal(truncate('', 3), '');
  // 中文按两列算：3 列 = 1 个汉字 + 省略号。
  assert.equal(truncate('中文测试', 3), '中…');
  assert.equal(truncate('中文字', 3), '中…');
  // 渲染宽度绝不超过预算，否则表格会错位。
  for (const [text, width] of [['abcdef', 3], ['中文测试', 3], ['a中b', 4], ['ab', 1]]) {
    assert.ok(displayWidth(truncate(text, width)) <= width, `${text}@${width}`);
  }
});

test('截断不会让 ANSI 颜色漏到后续行', () => {
  const colored = truncate('\x1b[31mabcdef\x1b[0m', 3);
  // 尾部 reset 被截掉时，必须补一个，否则后面所有输出都会继承红色。
  assert.ok(colored.endsWith('\x1b[0m'), `missing reset: ${JSON.stringify(colored)}`);
  assert.equal(displayWidth(colored), 3);
});
