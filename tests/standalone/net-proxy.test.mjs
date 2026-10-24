// 出站代理层测试：直连、SOCKS5（含用户名/密码认证）、HTTP CONNECT（含
// Basic 认证）、SSH 网关注入、以及本地隧道 createTunnel 的端到端转发。
//
// 用真实的 TCP echo 服务当目标、真实实现的 SOCKS5/HTTP 代理当中间人，
// 这样才能真正验证握手字节序列；只测「直连能通」证明不了代理协议正确。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';

import {
  PROXY_KINDS, dial, createTunnel, validHost, validPort,
  TUNNEL_IDLE_TIMEOUT_MS,
} from '../../standalone/net-proxy.mjs';

// ==================== 测试脚手架 ====================

/** 一个把收到的字节原样回写的 TCP 服务，代表「数据库」。 */
async function startEchoServer() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/**
 * 最小的 SOCKS5 服务端：只实现 CONNECT + 可选用户名/密码认证。
 * 够严格——它按 RFC 逐字段校验客户端发的字节。
 */
async function startSocks5Server({ username, password } = {}) {
  const requireAuth = Boolean(username);
  const seen = { methods: [], auth: null, target: null };
  const server = createServer((socket) => {
    socket.on('error', () => {});
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const nMethods = buffer[1];
          if (buffer.length < 2 + nMethods) return;
          const methods = [...buffer.subarray(2, 2 + nMethods)];
          seen.methods = methods;
          buffer = buffer.subarray(2 + nMethods);
          const want = requireAuth ? 0x02 : 0x00;
          if (!methods.includes(want)) {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          socket.write(Buffer.from([0x05, want]));
          stage = requireAuth ? 'auth' : 'request';
          continue;
        }
        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const userLen = buffer[1];
          if (buffer.length < 2 + userLen + 1) return;
          const passLen = buffer[2 + userLen];
          if (buffer.length < 3 + userLen + passLen) return;
          const user = buffer.subarray(2, 2 + userLen).toString('utf8');
          const pass = buffer.subarray(3 + userLen, 3 + userLen + passLen).toString('utf8');
          seen.auth = { user, pass };
          buffer = buffer.subarray(3 + userLen + passLen);
          if (user !== username || pass !== password) {
            socket.end(Buffer.from([0x01, 0x01]));
            return;
          }
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
          continue;
        }
        // stage === 'request'：VER CMD RSV ATYP ADDR PORT
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let host;
        let offset;
        if (atyp === 0x01) {
          if (buffer.length < 4 + 4 + 2) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else if (atyp === 0x03) {
          const len = buffer[4];
          if (buffer.length < 5 + len + 2) return;
          host = buffer.subarray(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);
        seen.target = { host, port };
        socket.removeListener('data', onData);

        // 真的连到目标，然后把两条连接对接起来。
        const upstream = netConnect({ host, port });
        upstream.on('connect', () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buffer.length) upstream.write(buffer);
          socket.pipe(upstream);
          upstream.pipe(socket);
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
        });
        upstream.on('error', () => {
          socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        });
        return;
      }
    };
    socket.on('data', onData);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, seen, close: () => server.close() };
}

/** 最小 HTTP CONNECT 代理，可选 Basic 认证。 */
async function startHttpProxy({ username, password } = {}) {
  const seen = { authorization: null, target: null };
  const server = createHttpServer();
  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    seen.target = req.url;
    seen.authorization = req.headers['proxy-authorization'] ?? null;
    if (username) {
      const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      if (seen.authorization !== expected) {
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
    }
    const [host, port] = req.url.split(':');
    const upstream = netConnect({ host, port: Number(port) });
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, seen, close: () => server.close() };
}

/** 通过给定的出站连接跑一次 echo 往返，验证字节流真的打通了。 */
async function echoRoundTrip(connection, payload = 'hello-db') {
  await new Promise((resolve, reject) => {
    connection.once('error', reject);
    connection.write(payload, (error) => (error ? reject(error) : resolve()));
  });
  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('echo 超时')), 5000);
    connection.on('data', function onData(chunk) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= Buffer.byteLength(payload)) {
        clearTimeout(timer);
        connection.removeListener('data', onData);
        resolve();
      }
    });
  });
  return Buffer.concat(chunks).toString('utf8');
}

// ==================== 校验函数 ====================

test('validHost 接受 IPv4/域名/IPv6，拒绝注入与控制字符', () => {
  for (const host of ['127.0.0.1', 'db.example.com', 'my-db_1.internal', '::1', '2001:db8::1']) {
    assert.equal(validHost(host), true, `${host} 应当合法`);
  }
  for (const host of ['', ' ', 'a b', 'db\nhost', 'host:port', '../etc', '-bad', 'x'.repeat(300), '999.1.1.1']) {
    assert.equal(validHost(host), false, `${JSON.stringify(host)} 应当非法`);
  }
  assert.equal(validHost(null), false);
  assert.equal(validHost(123), false);
});

test('validPort 只接受 1-65535 的整数', () => {
  for (const port of [1, 80, 3306, 5432, 65535]) assert.equal(validPort(port), true);
  for (const port of [0, -1, 65536, 1.5, '3306', null, NaN]) assert.equal(validPort(port), false);
});

test('PROXY_KINDS 覆盖 direct/socks5/http/ssh', () => {
  assert.deepEqual([...PROXY_KINDS].sort(), ['direct', 'http', 'socks5', 'ssh']);
});

test('dial 拒绝非法目标与非法的代理类型', async () => {
  await assert.rejects(dial({ host: 'bad host', port: 1 }), /目标主机名非法/);
  await assert.rejects(dial({ host: '127.0.0.1', port: 0 }), /目标端口非法/);
  await assert.rejects(dial({ host: '127.0.0.1', port: 1 }, { kind: 'openvpn' }), /不支持的代理类型/);
});

test('dial 对非法输入抛出 code=invalid，对网络失败抛出 code=upstream', async () => {
  await assert.rejects(dial({ host: 'bad host', port: 1 }), (error) => error.code === 'invalid');
  // 127.0.0.1:1 通常无人监听 → 连接失败应当是 upstream，而不是 invalid。
  await assert.rejects(
    dial({ host: '127.0.0.1', port: 1 }, null, { timeoutMs: 2000 }),
    (error) => error.code === 'upstream',
  );
});

// ==================== direct ====================

test('direct 代理直连目标并完成 echo 往返', async () => {
  const echo = await startEchoServer();
  const connection = await dial({ host: '127.0.0.1', port: echo.port }, null);
  assert.equal(await echoRoundTrip(connection), 'hello-db');
  connection.destroy();
  echo.close();
});

// ==================== SOCKS5 ====================

test('socks5 无认证：握手后数据双向转发', async () => {
  const echo = await startEchoServer();
  const proxy = await startSocks5Server();
  const connection = await dial(
    { host: '127.0.0.1', port: echo.port },
    { kind: 'socks5', host: '127.0.0.1', port: proxy.port },
  );
  assert.deepEqual(proxy.seen.methods, [0x00], '应当只声明「无认证」');
  assert.deepEqual(proxy.seen.target, { host: '127.0.0.1', port: echo.port });
  assert.equal(await echoRoundTrip(connection, 'through-socks5'), 'through-socks5');
  connection.destroy();
  proxy.close();
  echo.close();
});

test('socks5 用户名密码认证：走 RFC 1929 子协商', async () => {
  const echo = await startEchoServer();
  const proxy = await startSocks5Server({ username: 'ops', password: 's3cret' });
  const connection = await dial(
    { host: '127.0.0.1', port: echo.port },
    { kind: 'socks5', host: '127.0.0.1', port: proxy.port, username: 'ops', password: 's3cret' },
  );
  assert.deepEqual(proxy.seen.methods, [0x02], '应当声明「用户名密码」');
  assert.deepEqual(proxy.seen.auth, { user: 'ops', pass: 's3cret' });
  assert.equal(await echoRoundTrip(connection, 'auth-ok'), 'auth-ok');
  connection.destroy();
  proxy.close();
  echo.close();
});

test('socks5 密码错误时抛出明确的认证失败错误', async () => {
  const echo = await startEchoServer();
  const proxy = await startSocks5Server({ username: 'ops', password: 'right' });
  await assert.rejects(
    dial({ host: '127.0.0.1', port: echo.port },
      { kind: 'socks5', host: '127.0.0.1', port: proxy.port, username: 'ops', password: 'wrong' }),
    /SOCKS5 用户名或密码错误/,
  );
  proxy.close();
  echo.close();
});

test('socks5 只配一半认证信息时拒绝（避免静默降级）', async () => {
  await assert.rejects(
    dial({ host: '127.0.0.1', port: 1 },
      { kind: 'socks5', host: '127.0.0.1', port: 1080, username: 'ops' }),
    /用户名与密码必须同时提供/,
  );
});

test('socks5 目标为域名时用 ATYP=DOMAIN 交给代理解析 DNS', async () => {
  const echo = await startEchoServer();
  const proxy = await startSocks5Server();
  // localhost 不是 IPv4 字面量，应当走域名分支。
  const connection = await dial(
    { host: 'localhost', port: echo.port },
    { kind: 'socks5', host: '127.0.0.1', port: proxy.port },
  );
  assert.equal(proxy.seen.target.host, 'localhost');
  connection.destroy();
  proxy.close();
  echo.close();
});

test('socks5 代理拒绝连接时把 code 翻译成可读错误', async () => {
  const echo = await startEchoServer();
  const proxy = await startSocks5Server();
  // 目标端口无人监听 → 代理回 REP=0x05（connection refused）。
  await assert.rejects(
    dial({ host: '127.0.0.1', port: 1 },
      { kind: 'socks5', host: '127.0.0.1', port: proxy.port }),
    /SOCKS5 目标拒绝连接/,
  );
  proxy.close();
  echo.close();
});

// ==================== HTTP CONNECT ====================

test('http CONNECT 无认证：隧道打通并转发数据', async () => {
  const echo = await startEchoServer();
  const proxy = await startHttpProxy();
  const connection = await dial(
    { host: '127.0.0.1', port: echo.port },
    { kind: 'http', host: '127.0.0.1', port: proxy.port },
  );
  assert.equal(proxy.seen.target, `127.0.0.1:${echo.port}`);
  assert.equal(proxy.seen.authorization, null);
  assert.equal(await echoRoundTrip(connection, 'through-http'), 'through-http');
  connection.destroy();
  proxy.close();
  echo.close();
});

test('http CONNECT 带 Basic 认证时设置 Proxy-Authorization', async () => {
  const echo = await startEchoServer();
  const proxy = await startHttpProxy({ username: 'ops', password: 'p@ss' });
  const connection = await dial(
    { host: '127.0.0.1', port: echo.port },
    { kind: 'http', host: '127.0.0.1', port: proxy.port, username: 'ops', password: 'p@ss' },
  );
  assert.equal(proxy.seen.authorization, `Basic ${Buffer.from('ops:p@ss').toString('base64')}`);
  assert.equal(await echoRoundTrip(connection, 'http-auth'), 'http-auth');
  connection.destroy();
  proxy.close();
  echo.close();
});

test('http CONNECT 认证失败时报告 407', async () => {
  const echo = await startEchoServer();
  const proxy = await startHttpProxy({ username: 'ops', password: 'right' });
  await assert.rejects(
    dial({ host: '127.0.0.1', port: echo.port },
      { kind: 'http', host: '127.0.0.1', port: proxy.port, username: 'ops', password: 'wrong' }),
    /认证失败（407）/,
  );
  proxy.close();
  echo.close();
});

// ==================== SSH 网关 ====================

test('ssh 代理把请求委托给注入的 openStream', async () => {
  const echo = await startEchoServer();
  const calls = [];
  const connection = await dial(
    { host: '10.0.0.5', port: 3306 },
    { kind: 'ssh', serverId: 42 },
    {
      openStream: async (serverId, host, port) => {
        calls.push({ serverId, host, port });
        // 用真实 socket 假装是 SSH direct-tcpip 通道。
        const socket = netConnect({ host: '127.0.0.1', port: echo.port });
        await once(socket, 'connect');
        return socket;
      },
    },
  );
  assert.deepEqual(calls, [{ serverId: 42, host: '10.0.0.5', port: 3306 }]);
  assert.equal(await echoRoundTrip(connection, 'via-ssh'), 'via-ssh');
  connection.destroy();
  echo.close();
});

test('ssh 代理缺少 openStream 或 serverId 时拒绝', async () => {
  await assert.rejects(
    dial({ host: '10.0.0.5', port: 3306 }, { kind: 'ssh', serverId: 1 }),
    /openStream/,
  );
  await assert.rejects(
    dial({ host: '10.0.0.5', port: 3306 }, { kind: 'ssh' }, { openStream: async () => null }),
    /必须指定一台已保存的服务器/,
  );
});

// ==================== createTunnel ====================

test('createTunnel 在回环上开端口，经 SOCKS5 转发到目标', async () => {
  const echo = await startEchoServer();
  const proxy = await startSocks5Server({ username: 'u', password: 'p' });
  const tunnel = await createTunnel(
    { host: '127.0.0.1', port: echo.port },
    { kind: 'socks5', host: '127.0.0.1', port: proxy.port, username: 'u', password: 'p' },
  );
  try {
    assert.equal(tunnel.host, '127.0.0.1', '隧道必须只监听回环');
    assert.ok(tunnel.port > 0);

    const client = netConnect({ host: tunnel.host, port: tunnel.port });
    await once(client, 'connect');
    assert.equal(await echoRoundTrip(client, 'tunneled'), 'tunneled');
    client.destroy();
  } finally {
    tunnel.close();
    proxy.close();
    echo.close();
  }
});

test('createTunnel 支持多条并发连接（驱动连接池场景）', async () => {
  const echo = await startEchoServer();
  const tunnel = await createTunnel({ host: '127.0.0.1', port: echo.port }, null);
  try {
    const results = await Promise.all(Array.from({ length: 4 }, async (_unused, index) => {
      const client = netConnect({ host: tunnel.host, port: tunnel.port });
      await once(client, 'connect');
      const value = await echoRoundTrip(client, `conn-${index}`);
      client.destroy();
      return value;
    }));
    assert.deepEqual(results.sort(), ['conn-0', 'conn-1', 'conn-2', 'conn-3']);
  } finally {
    tunnel.close();
    echo.close();
  }
});

test('createTunnel 在代理握手失败时断开本地连接而不是挂起', async () => {
  // 指向一个无人监听的端口当「代理」。
  const tunnel = await createTunnel({ host: '127.0.0.1', port: 1 }, { kind: 'socks5', host: '127.0.0.1', port: 1 });
  try {
    const client = netConnect({ host: tunnel.host, port: tunnel.port });
    await once(client, 'connect');
    // 隧道对端应当很快关闭；若实现有 bug 会一直挂着直到测试超时。
    await Promise.race([
      once(client, 'close'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('隧道未在失败后关闭')), 8000)),
    ]);
  } finally {
    tunnel.close();
  }
});

test('createTunnel 关闭后不再接受新连接', async () => {
  const echo = await startEchoServer();
  const tunnel = await createTunnel({ host: '127.0.0.1', port: echo.port }, null);
  const { port } = tunnel;
  tunnel.close();
  await assert.rejects(
    new Promise((resolve, reject) => {
      const client = netConnect({ host: '127.0.0.1', port });
      client.once('connect', () => { client.destroy(); resolve(); });
      client.once('error', reject);
    }),
  );
  echo.close();
});

test('TUNNEL_IDLE_TIMEOUT_MS 是有限的正数（避免隧道永久占用端口）', () => {
  assert.ok(Number.isFinite(TUNNEL_IDLE_TIMEOUT_MS) && TUNNEL_IDLE_TIMEOUT_MS > 0);
});
