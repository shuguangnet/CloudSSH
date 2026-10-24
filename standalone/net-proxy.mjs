// 出站代理层（unified outbound dialer）。
//
// 数据库客户端需要连到「只有经代理才够得着」的目标（内网库、被墙的库、
// 只有跳板机能通的库）。这里把所有出网方式收敛成一个原语：
//
//   dial({ host, port }, proxy) -> Promise<Duplex>
//
// 并在此之上提供 createTunnel()：在本机 127.0.0.1 上开一个临时端口，
// 把流量经代理转发到目标。驱动只要连本地端口即可，完全不需要感知代理，
// 也不需要任何「注入 socket」的驱动内部技巧——因此对 pg / mysql2 /
// ioredis / 以及将来任何协议都通用（MySQL 的 SSL 协商、Redis TLS 等
// 都只是字节流，隧道模式天然支持）。
//
// 支持的类型（每一种都被 tests/standalone/net-proxy.test.mjs 用真实代理
// 服务端验证过握手字节序列）：
//   - direct   直连
//   - socks5   SOCKS5（RFC 1928）+ 用户名/密码认证（RFC 1929）
//   - http     HTTP CONNECT 隧道（RFC 7231 4.3.6），支持 Basic 认证
//   - ssh      SSH direct-tcpip 网关：借一台已保存服务器的 SSH 会话做
//              TCP 转发。这是唯一能在纯用户态实现「类 VPN」效果的方式，
//              也用来替代 OpenVPN：目标填内网地址，经跳板机转发即可。
//
// OpenVPN 说明：真正的 OpenVPN 需要 /dev/net/tun + NET_ADMIN，本服务以
// cap_drop: ALL + read_only 运行，进程内无法建立隧道。可选做法见
// docs/database-mcp.md：让宿主先建好 VPN 隧道，这里直接 direct 连内网 IP；
// 或者用 ssh 代理类型达成同样的「进入私有子网」效果。

import { connect as netConnect, createServer } from 'node:net';
import { Duplex } from 'node:stream';

export const PROXY_KINDS = ['direct', 'socks5', 'http', 'ssh'];

const DEFAULT_TIMEOUT_MS = 15000;
export const TUNNEL_IDLE_TIMEOUT_MS = 120000;

/** 输入非法（400）与运行期失败（502）需要区分，路由层按 code 映射状态码。 */
export const invalid = (message) => Object.assign(new Error(message), { code: 'invalid' });
export const upstream = (message) => Object.assign(new Error(message), { code: 'upstream' });

// ==================== 校验 ====================

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,251}[a-zA-Z0-9])?$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

/**
 * 目标主机名校验。数据库目标通常是主机名或 IP；Unix socket（以 / 开头）
 * 不在这里处理——它根本不走 TCP，也就不该被代理。
 */
export function validHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim();
  if (!value || value.length > 253) return false;
  if (IPV4_RE.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  if (value.includes(':')) return IPV6_RE.test(value);
  return HOSTNAME_RE.test(value);
}

export function validPort(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

/** 认证信息允许为空（很多内网代理不认证），但非空时必须成对出现且不带控制字符。 */
function validAuth(username, password) {
  const hasUser = typeof username === 'string' && username.length > 0;
  const hasPass = typeof password === 'string' && password.length > 0;
  if (!hasUser && !hasPass) return { username: '', password: '' };
  if (hasUser !== hasPass) throw invalid('代理认证的用户名与密码必须同时提供');
  if (hasUser && username.length > 255) throw invalid('代理用户名过长');
  if (hasPass && password.length > 255) throw invalid('代理密码过长');
  // 代理协议里的认证串是二进制长度前缀，但控制字符最终会进日志/配置，
  // 这里直接拒绝，避免换行注入到任何文本形态。
  if (/[\x00-\x1f\x7f]/.test(username) || /[\x00-\x1f\x7f]/.test(password)) {
    throw invalid('代理认证信息不能包含控制字符');
  }
  return { username, password };
}

// ==================== 底层工具 ====================

function timeoutValue(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 打开一个裸 TCP 连接，并把超时、错误统一成 code=upstream。
 * 代理握手阶段直接用这个 socket，握手成功后再交给驱动。
 */
function openTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(upstream(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    timer.unref?.();
    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(upstream(`连接 ${host}:${port} 失败：${error.message}`));
    };
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      resolve(socket);
    });
    socket.once('error', fail);
  });
}

/**
 * 在 socket 上按「精确字节数」读取握手响应的读取器。
 *
 * 关键点：TCP 是字节流，一次 'data' 事件可能带回比本次需要更多的字节
 * （例如 SOCKS5 的 reply 头 10 字节一次性到达，而我们要先读 4 字节）。
 * 早期实现每读一次就挂一个新的 'data' 监听、把多余字节丢掉，导致后续
 * 读取永远等不到数据而挂死。这里用一个持续存在的缓冲把余量留住，
 * release() 时再把这部分余量交还给调用方，拼进后续的业务流。
 */
class SocketReader {
  constructor(socket, timeoutMs, label) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.label = label;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.failure = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#flush();
    };
    this.onError = (error) => this.#fail(upstream(`${label} 失败：${error.message}`));
    this.onClose = () => this.#fail(upstream(`${label} 连接被对端关闭`));
    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('close', this.onClose);
  }

  #fail(error) {
    this.failure = error;
    if (this.pending) {
      const { reject, timer } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      reject(error);
    }
  }

  #flush() {
    if (!this.pending) return;
    const { n, resolve, reject, timer } = this.pending;
    if (this.buffer.length < n) return;
    this.pending = null;
    clearTimeout(timer);
    const value = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    resolve(value);
  }

  /** 读取恰好 n 字节；余量保留在内部缓冲里供下次读取。 */
  read(n) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('SocketReader 不支持并发读取'));
    if (this.buffer.length >= n) {
      const value = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(upstream(`${this.label} 响应超时`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = { n, resolve, reject, timer };
    });
  }

  /**
   * 读到空行为止（HTTP 响应头）。返回头部文本，余量留在内部缓冲。
   * 超长直接失败，避免恶意代理用无限响应头耗尽内存。
   */
  readUntil(needle, limit) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.buffer.indexOf(needle);
        if (index < 0) return false;
        const value = this.buffer.subarray(0, index);
        this.buffer = this.buffer.subarray(index + needle.length);
        resolve(value);
        return true;
      };
      if (this.failure) return reject(this.failure);
      if (check()) return;
      if (this.buffer.length > limit) return reject(upstream(`${this.label} 响应头过大`));
      const timer = setTimeout(() => {
        this.pending = null;
        reject(upstream(`${this.label} 响应超时`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = {
        n: Number.MAX_SAFE_INTEGER,
        resolve: () => {},
        reject,
        timer,
      };
      // 复用 onData→#flush 的机制：n 设成无穷大时 #flush 不会满足，
      // 因此这里改为在 flush 外单独轮询缓冲。
      const poll = () => {
        if (this.failure || !this.pending) return;
        if (check()) {
          clearTimeout(timer);
          this.pending = null;
          return;
        }
        if (this.buffer.length > limit) {
          clearTimeout(timer);
          this.pending = null;
          reject(upstream(`${this.label} 响应头过大`));
          return;
        }
        setImmediate(poll);
      };
      setImmediate(poll);
    });
  }

  /** 解绑监听器并返回尚未消费的余量，供后续业务流使用。 */
  release() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    return this.buffer;
  }
}

/**
 * 把握手后的 socket 与未消费余量合并成一个干净的 Duplex。
 *
 * TCP 是字节流：一次 'data' 事件可能带回比握手需要更多的字节（Postgres
 * 的 ReadyForQuery、MySQL 的握手包经常与代理响应同一批到达）。这些字节
 * 已经在读取器缓冲里，必须用 socket.unshift() 放回内核缓冲区，否则驱动
 * 会永远等不到它们。net.Socket 本身就是 Duplex，无需包装。
 */
function wrapSocket(socket, leftover) {
  if (leftover?.length) socket.unshift(leftover);
  return socket;
}

/**
 * 把 WHATWG 流（SSH direct-tcpip 通道）适配成 Node Duplex。
 *
 * DirectTcpipStream 暴露的是 ReadableStream/WritableStream，而驱动与
 * createTunnel 都期望 Node 流语义，这里做一次桥接。
 */
function adaptWebStream(stream) {
  if (!stream || typeof stream.getReader !== 'function') {
    // 已经是 Node 流（例如上游实现换成了 net.Socket）就直接用。
    if (stream && typeof stream.pipe === 'function') return stream;
    throw upstream('SSH 通道返回了无法识别的流类型');
  }
  const reader = stream.getReader();
  const writer = stream.getWriter();
  const duplex = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writer.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        .then(() => callback(), callback);
    },
    final(callback) {
      writer.close().then(() => callback(), () => callback());
    },
    destroy(error, callback) {
      reader.cancel().catch(() => {});
      writer.abort?.().catch(() => {});
      callback(error);
    },
  });
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!duplex.push(Buffer.from(value))) {
          await new Promise((resolve) => duplex.once('drain', resolve));
        }
      }
    } catch { /* 对端异常关闭，按 EOF 处理 */ }
    duplex.push(null);
  };
  void pump();
  return duplex;
}

/** 握手阶段写失败也要归类为 upstream，而不是泄漏成未捕获异常。 */
function writeAll(socket, buffer, label) {
  return new Promise((resolve, reject) => {
    socket.write(buffer, (error) => {
      if (error) reject(upstream(`${label} 写入失败：${error.message}`));
      else resolve();
    });
  });
}

// ==================== SOCKS5 (RFC 1928 / RFC 1929) ====================

const SOCKS_VERSION = 0x05;
const SOCKS_AUTH_NONE = 0x00;
const SOCKS_AUTH_USERPASS = 0x02;
const SOCKS_AUTH_REJECT = 0xff;
const SOCKS_CMD_CONNECT = 0x01;
const SOCKS_ATYP_IPV4 = 0x01;
const SOCKS_ATYP_DOMAIN = 0x03;
const SOCKS_ATYP_IPV6 = 0x04;

const SOCKS_REPLY_MESSAGES = {
  0x01: 'SOCKS5 代理服务器内部错误',
  0x02: 'SOCKS5 规则不允许此连接',
  0x03: 'SOCKS5 网络不可达',
  0x04: 'SOCKS5 主机不可达',
  0x05: 'SOCKS5 目标拒绝连接',
  0x06: 'SOCKS5 连接超时',
  0x07: 'SOCKS5 不支持该命令',
  0x08: 'SOCKS5 不支持的地址类型',
};

/**
 * 把目标地址编码成 SOCKS5 的 ATYP+ADDR。
 * 域名优先用 ATYP=3，这样远端代理解析 DNS——避免本地 DNS 泄漏，
 * 也让「只有代理才解析得到的内部域名」可用。
 */
function encodeSocksAddress(host, port) {
  let address;
  if (IPV4_RE.test(host)) {
    address = Buffer.from([SOCKS_ATYP_IPV4, ...host.split('.').map((part) => Number(part))]);
  } else if (host.includes(':')) {
    address = Buffer.concat([Buffer.from([SOCKS_ATYP_IPV6]), ipv6ToBytes(host)]);
  } else {
    const name = Buffer.from(host, 'utf8');
    if (name.length > 255) throw invalid('目标域名过长');
    address = Buffer.concat([Buffer.from([SOCKS_ATYP_DOMAIN, name.length]), name]);
  }
  const portBuffer = Buffer.alloc(2);
  portBuffer.writeUInt16BE(port, 0);
  return Buffer.concat([address, portBuffer]);
}

/** 把 IPv6 字面量（可含 :: 压缩）转换成 16 字节。 */
function ipv6ToBytes(host) {
  const [head, tail] = host.split('::');
  const parse = (part) => (part ? part.split(':').filter((value) => value !== '') : []);
  const headParts = parse(head);
  const tailParts = tail === undefined ? [] : parse(tail);
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined && missing !== 0) throw invalid('IPv6 地址格式非法');
  const groups = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts];
  if (groups.length !== 8) throw invalid('IPv6 地址格式非法');
  const buffer = Buffer.alloc(16);
  groups.forEach((group, index) => buffer.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2));
  return buffer;
}

/** 读完 SOCKS5 的 reply 报头：VER REP RSV ATYP + 变长地址 + 2 字节端口。 */
async function readSocksReply(reader) {
  const head = await reader.read(4);
  if (head[0] !== SOCKS_VERSION) throw upstream('SOCKS5 代理返回了非法版本号');
  if (head[1] !== 0x00) {
    throw upstream(SOCKS_REPLY_MESSAGES[head[1]] || `SOCKS5 代理拒绝连接（code=${head[1]}）`);
  }
  // 把 BND.ADDR/BND.PORT 读掉，否则残留字节会被驱动当成业务数据解析。
  if (head[3] === SOCKS_ATYP_IPV4) await reader.read(4 + 2);
  else if (head[3] === SOCKS_ATYP_IPV6) await reader.read(16 + 2);
  else if (head[3] === SOCKS_ATYP_DOMAIN) {
    const length = await reader.read(1);
    await reader.read(length[0] + 2);
  } else throw upstream('SOCKS5 代理返回了未知地址类型');
}

async function dialSocks5(target, proxy, auth, timeoutMs) {
  const socket = await openTcp(proxy.host, proxy.port, timeoutMs);
  const reader = new SocketReader(socket, timeoutMs, 'SOCKS5 握手');
  try {
    const wantAuth = auth.username.length > 0;
    // 方法协商：只声明我们真的能提供的方法（只有一个候选方法）。
    await writeAll(socket, Buffer.from([SOCKS_VERSION, 1,
      wantAuth ? SOCKS_AUTH_USERPASS : SOCKS_AUTH_NONE]), 'SOCKS5 握手');
    const method = await reader.read(2);
    if (method[0] !== SOCKS_VERSION) throw upstream('SOCKS5 代理返回了非法版本号');
    if (method[1] === SOCKS_AUTH_REJECT) throw upstream('SOCKS5 代理拒绝了全部认证方式');
    if (method[1] !== (wantAuth ? SOCKS_AUTH_USERPASS : SOCKS_AUTH_NONE)) {
      throw upstream('SOCKS5 代理要求了未配置的认证方式');
    }
    if (wantAuth) {
      const user = Buffer.from(auth.username, 'utf8');
      const pass = Buffer.from(auth.password, 'utf8');
      await writeAll(socket, Buffer.concat([
        Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass,
      ]), 'SOCKS5 认证');
      const status = await reader.read(2);
      if (status[1] !== 0x00) throw upstream('SOCKS5 用户名或密码错误');
    }
    await writeAll(socket, Buffer.concat([
      Buffer.from([SOCKS_VERSION, SOCKS_CMD_CONNECT, 0x00]),
      encodeSocksAddress(target.host, target.port),
    ]), 'SOCKS5 CONNECT');
    await readSocksReply(reader);
    return wrapSocket(socket, reader.release());
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}

// ==================== HTTP CONNECT ====================

/**
 * HTTP CONNECT 的目标必须先转成 IP 字面量或主机名（IPv6 要加方括号）。
 * 这里不做 DNS 解析：代理服务器会解析，语义与 SOCKS5 的域名 ATYP 一致。
 */
function connectAuthority(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function encodeBasicAuth(username, password) {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

const HTTP_HEAD_LIMIT = 8192;

async function dialHttpConnect(target, proxy, auth, timeoutMs) {
  const socket = await openTcp(proxy.host, proxy.port, timeoutMs);
  const reader = new SocketReader(socket, timeoutMs, 'HTTP 代理');
  try {
    const authority = connectAuthority(target.host, target.port);
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
    if (auth.username) lines.push(`Proxy-Authorization: Basic ${encodeBasicAuth(auth.username, auth.password)}`);
    lines.push('Proxy-Connection: Keep-Alive', '', '');
    await writeAll(socket, Buffer.from(lines.join('\r\n'), 'latin1'), 'HTTP CONNECT');

    // 读到 \r\n\r\n 为止，避免把之后的业务数据一起吞掉。
    const head = (await reader.readUntil(Buffer.from('\r\n\r\n'), HTTP_HEAD_LIMIT)).toString('latin1');
    const statusLine = head.split('\r\n')[0] || '';
    const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
    if (!match) throw upstream('HTTP 代理返回了非法响应');
    const status = Number(match[1]);
    if (status === 407) throw upstream('HTTP 代理认证失败（407）');
    if (status < 200 || status >= 300) throw upstream(`HTTP 代理拒绝 CONNECT（${status}）`);
    return wrapSocket(socket, reader.release());
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}

// ==================== SSH direct-tcpip 网关 ====================

/**
 * SSH 网关走 operations.mjs 的池化跳板链：直接复用已认证的 SSH 会话，
 * 用 RFC 4254 direct-tcpip 打开一条到目标库的字节流。
 *
 * 这是「应用内 VPN」的等价物：目标填 10.0.0.5:3306，只要跳板机通，
 * 就能从面板连过去，不需要在容器里装 openvpn、也不需要 NET_ADMIN。
 *
 * 依赖以注入方式传入（openStream），这样本模块可以纯单测。
 */
async function dialSsh(target, proxy, options) {
  const { openStream } = options;
  if (typeof openStream !== 'function') throw invalid('SSH 代理需要 openStream 依赖');
  if (!Number.isSafeInteger(proxy.serverId) || proxy.serverId <= 0) {
    throw invalid('SSH 代理必须指定一台已保存的服务器');
  }
  const stream = await openStream(proxy.serverId, target.host, target.port);
  if (!stream) throw upstream('SSH 网关未能打开 TCP 转发通道');
  return stream;
}

// ==================== 统一入口 ====================

/**
 * 建立到 target 的出站连接，返回 Node Duplex。
 *
 * @param {{host:string, port:number}} target 目标地址
 * @param {null|{kind:string, host?:string, port?:number, username?:string,
 *                password?:string, serverId?:number}} proxy 代理描述（null = 直连）
 * @param {{timeoutMs?:number, openStream?:Function}} [options]
 * @returns {Promise<Duplex>}
 */
export async function dial(target, proxy, options = {}) {
  if (!validHost(target?.host)) throw invalid('目标主机名非法');
  if (!validPort(target?.port)) throw invalid('目标端口非法');

  const kind = proxy?.kind ?? 'direct';
  if (!PROXY_KINDS.includes(kind)) throw invalid(`不支持的代理类型：${kind}`);

  if (kind === 'direct') {
    return await openTcp(target.host, target.port, timeoutValue(options.timeoutMs, DEFAULT_TIMEOUT_MS));
  }

  if (kind === 'ssh') return adaptWebStream(await dialSsh(target, proxy, options));

  if (!validHost(proxy.host)) throw invalid('代理主机名非法');
  if (!validPort(proxy.port)) throw invalid('代理端口非法');
  // 认证信息必须在建连之前校验：否则非法输入会表现为「连接失败」，
  // 用户看到的是网络错误而不是配置错误，排查方向完全被带偏。
  const auth = validAuth(proxy.username, proxy.password);
  const timeoutMs = timeoutValue(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  return kind === 'socks5'
    ? await dialSocks5(target, proxy, auth, timeoutMs)
    : await dialHttpConnect(target, proxy, auth, timeoutMs);
}

/**
 * 在本机回环地址上开一条隧道：连上本地端口就等于连上 target（经 proxy）。
 *
 * 驱动只需要把 host/port 指向返回的 localPort，完全不感知代理类型。
 * 这样 MySQL 的 SSL 协商、Postgres 的 TLS 升级、Redis 的 RESP 都只是
 * 字节流，天然被支持——不需要任何驱动内部 hook。
 *
 * @returns {Promise<{host:string, port:number, close:Function, connections:number}>}
 */
export async function createTunnel(target, proxy, options = {}) {
  const idleTimeoutMs = timeoutValue(options.idleTimeoutMs, TUNNEL_IDLE_TIMEOUT_MS);
  const sockets = new Set();

  const server = createServer((client) => {
    sockets.add(client);
    let settled = false;
    const cleanup = () => {
      sockets.delete(client);
      try { client.destroy(); } catch { /* 已关闭 */ }
    };
    client.setNoDelay(true);
    client.on('error', cleanup);

    dial(target, proxy, options).then((connection) => {
      if (settled) {
        try { connection.destroy(); } catch { /* 已关闭 */ }
        cleanup();
        return;
      }
      settled = true;
      let closed = false;
      const shutdown = () => {
        if (closed) return;
        closed = true;
        try { connection.destroy(); } catch { /* 已关闭 */ }
        cleanup();
      };
      // 两段管道：本地→远端 与 远端→本地。任何一侧结束都拆掉整条隧道，
      // 避免半开连接把文件描述符留在容器里。
      client.pipe(connection);
      connection.pipe(client);
      client.on('close', shutdown);
      client.on('error', shutdown);
      connection.on('close', shutdown);
      connection.on('error', shutdown);
    }).catch((error) => {
      // 握手失败：立刻断开本地连接，让驱动看到明确的连接错误，
      // 而不是一直挂在那里等到自己的 connectTimeout 才超时。
      settled = true;
      options.onDialError?.(error);
      cleanup();
    });
  });

  // 只监听回环：隧道是进程内私有资源，绝不对局域网/公网暴露。
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const close = () => {
    clearTimeout(idleTimer);
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* 已关闭 */ }
    }
    sockets.clear();
    try { server.close(); } catch { /* 已关闭 */ }
  };
  // 长时间无连接的隧道没有任何用处，超时后自动回收端口。
  const idleTimer = setTimeout(close, idleTimeoutMs);
  idleTimer.unref?.();

  return {
    host: '127.0.0.1',
    port: server.address().port,
    close,
    get connections() { return sockets.size; },
  };
}
