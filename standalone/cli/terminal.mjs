/**
 * `cssh ssh` —— 全屏交互终端。
 *
 * 协议契约（与 src/worker/ssh-session.ts 严格对齐）：
 *   客户端 → 服务端
 *     · **二进制帧**   → 直接进 PTY（`handleWebSocketMessage` 的 ArrayBuffer 分支）
 *     · **字符串帧**   → 先尝试 JSON 控制（resize / ping / auth_*），否则当 PTY 输入
 *   服务端 → 客户端
 *     · **二进制帧**   → PTY 输出，原样写 stdout
 *     · **字符串帧**   → JSON 控制/状态事件
 *
 * 因此按键一律发**二进制**：若发字符串，用户输入 `{"type":"resize"...}`
 * 这种内容就会被当成控制帧吞掉。二进制路径没有这个歧义。
 *
 * 主机密钥（安全关键）：
 *   host_key_changed 代表「指纹变了」，可能是重装，也可能是中间人。
 *   此处一律**硬中断**并打印新旧指纹，要求人工到面板确认，绝不自动
 *   接受。只有 host_key_verified（首次连接且签名已验证）才允许自动写入
 *   known-hosts——那正是 TOFU 的定义，不构成降级。
 */

import { WebSocket } from 'ws';

const RTT_HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_RESPONSE_TIMEOUT_MS = 10000;

const CSI = '\x1b[';
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

/**
 * 是否「主机指纹变了」。
 *
 * 真实协议里这个信号有两个形状（见 ssh-session.ts finalizeHostKeyTrust）：
 *   { type: 'host_key_changed', fingerprint, expectedFingerprint }   ← 独立类型
 *   { type: 'error', event: 'host_key_changed', message }           ← 伴随的 error 帧
 * 只要跟 host_key_changed 沾边就一律当作硬中断，宁可多拦一次也不错放。
 */
function isHostKeyChanged(payload) {
  return payload.type === 'host_key_changed'
    || payload.event === 'host_key_changed'
    || payload.code === 'host_key_changed';
}

export class TerminalError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * 建立 WebSocket。返回一个 Promise，在 shell_ready 后 resolve。
 *
 * @param {object} options
 * @param {string} options.wsUrl         ws(s)://…/api/cli/ssh?server_id=N&cols=&rows=
 * @param {string} options.token         Bearer 令牌（走握手头，不进 URL）
 * @param {(event:object)=>void} options.onEvent   控制事件回调（状态提示等）
 * @param {(chunk:Buffer)=>void} options.onOutput  PTY 输出回调
 * @param {number} options.cols
 * @param {number} options.rows
 */
export function connectTerminal({
  wsUrl, token, onEvent = () => {}, onOutput, cols, rows, insecure = false, wsImpl = WebSocket,
  onHostKeyVerified,
}) {
  return new Promise((resolve, reject) => {
    // 自签证书：ws 用的是独立的 TLS 校验开关，必须与 HTTP 侧口径一致。
    const socket = new wsImpl(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
      rejectUnauthorized: !insecure,
      perMessageDeflate: false,
    });

    let settled = false;
    let heartbeat = null;
    let heartbeatDeadline = null;

    const cleanupTimers = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (heartbeatDeadline) { clearTimeout(heartbeatDeadline); heartbeatDeadline = null; }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      try { socket.terminate(); } catch { /* 已断开 */ }
      reject(error);
    };

    socket.on('open', () => {
      // 首帧先对齐尺寸，避免远端以 80x24 默认值启动后立刻重排。
      if (cols && rows) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      // 心跳：面板据此判断链路是否活着（服务端回 pong）。
      // 同时在本地起一个应答超时：NAT/中间设备静默断链时 TCP 可能
      // 很久才报错，没有这个计时器终端就会假死。
      heartbeat = setInterval(() => {
        if (socket.readyState !== 1) return;
        try { socket.send(JSON.stringify({ type: 'ping', id: String(Date.now()) })); } catch { /* 忽略 */ }
        if (!heartbeatDeadline) {
          heartbeatDeadline = setTimeout(() => {
            heartbeatDeadline = null;
            cleanupTimers();
            try { socket.close(); } catch { /* 已断开 */ }
            fail(new TerminalError('连接超时：面板无响应（网络可能已中断）', 1));
          }, HEARTBEAT_RESPONSE_TIMEOUT_MS);
          heartbeatDeadline.unref?.();
        }
      }, RTT_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) { onOutput(Buffer.from(data)); return; }
      let payload;
      try { payload = JSON.parse(String(data)); } catch { return; }
      if (!payload || typeof payload !== 'object') return;

      // 最高优先级：指纹变了就断。放在 switch 之前，保证任何形状都拦得住。
      if (isHostKeyChanged(payload)) {
        // 关键安全路径：不询问、不重试、不自动信任。直接中断。
        //
        // 顺序很重要：先 fail 再 close。close() 会同步触发 'close' 监听器，
        // 那个监听器用「关闭码」当退出码，会把 3 换成 0（“正常退出”），
        // 于是上层脚本看到的是成功——安全事故就这样被吞成成功。
        cleanupTimers();
        fail(new TerminalError(buildHostKeyChangedMessage(payload), 3));
        try { socket.close(); } catch { /* 已断开 */ }
        return;
      }

      switch (payload.type) {
        case 'pong':
          return;
        case 'status':
          onEvent(payload);
          // shell_ready 意味着 PTY 已经可用，此时才把控制权交给终端。
          if (payload.event === 'shell_ready' && !settled) {
            settled = true;
            resolve({ socket, close: () => { cleanupTimers(); } });
          }
          return;
        case 'host_key_verified':
          // 首次连接 + 签名已验证 = 标准 TOFU，可以记录。
          //
          // 调用方（main.mjs）负责真正写入；这里只上报、不自行改信任库，
          // 保证「谁写入」在调用链上只有一处。
          onHostKeyVerified?.(payload);
          onEvent(payload);
          return;
        case 'error':
          if (!settled) fail(new TerminalError(payload.message || '连接失败', 1));
          else onEvent(payload);
          return;
        case 'rtt':
          onEvent(payload);
          return;
        default:
          onEvent(payload);
      }
    });

    socket.on('close', (code, reason) => {
      cleanupTimers();
      if (!settled) {
        settled = true;
        reject(new TerminalError(
          reason?.toString() || `连接已断开 (code ${code})`,
          code === 1000 ? 0 : 1
        ));
        return;
      }
      // 已 resolve 后的关闭由主循环通过 'closed' 事件处理。
      socket.emit('terminal-close', code, reason?.toString?.() || '');
    });

    socket.on('error', (error) => {
      if (!settled) {
        fail(new TerminalError(`WebSocket 错误：${error.message}`));
        return;
      }
      socket.emit('terminal-close', 1006, error.message);
    });
  });
}

function buildHostKeyChangedMessage(payload) {
  const lines = [
    '✗ 主机密钥已变更，连接被强制中断。',
    '',
    `  主机：${payload.displayHost || payload.host || '?'}`,
  ];
  if (payload.expectedFingerprint) lines.push(`  已知指纹：${payload.expectedFingerprint}`);
  if (payload.fingerprint) lines.push(`  实际指纹：${payload.fingerprint}${payload.keyType ? ` (${payload.keyType})` : ''}`);
  lines.push(
    '',
    '出现这种情况通常有两种原因：',
    '  1. 服务器重装系统或更换过 SSH 密钥（正常操作）',
    '  2. 有人正在中间人攻击这条连接（危险）',
    '',
    '请先通过面板或其他可信渠道核对上面的「实际指纹」。确认无误后，',
    '到面板删除这台服务器的已知主机记录，再重新连接。'
  );
  return lines.join('\n');
}

/** 首次信任：把指纹写入面板的 known-hosts。失败不阻断连接（仅提示）。 */
export async function recordKnownHost(api, server, payload) {
  if (!payload?.fingerprint) return false;
  // 写入的 host 必须是服务端给出的 knownHostIdentity（跳板链场景下
  // 与显示用 host 不同），否则指纹会挂错条目。
  const host = payload.host || server?.host;
  const port = Number(payload.port || server?.port);
  if (!host || !Number.isInteger(port)) return false;
  try {
    await api.saveKnownHost({ host, port, fingerprint: payload.fingerprint });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把终端接到 WebSocket 上，直到会话结束。
 * 返回远端会话的退出信息（WebSocket 关闭码）。
 */
export function runTerminal({ socket, input = process.stdin, output = process.stdout, onEvent = () => {} }) {
  return new Promise((resolve) => {
    const restore = () => {
      if (input.isTTY) {
        try { input.setRawMode(false); } catch { /* 已恢复 */ }
      }
      input.pause();
      output.write(SHOW_CURSOR);
      output.write(ALT_SCREEN_OFF);
    };

    const send = (buffer) => {
      if (socket.readyState !== 1) return;
      try { socket.send(buffer, { binary: true }); } catch { /* 通道已关 */ }
    };

    const onInput = (chunk) => send(chunk);

    const onResize = () => {
      if (socket.readyState !== 1) return;
      const cols = output.columns || 80;
      const rows = output.rows || 24;
      try { socket.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* 忽略 */ }
    };

    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      process.removeListener('SIGWINCH', onResize);
      input.removeListener('data', onInput);
      restore();
      resolve(code);
    };

    // 进入备用屏：退出时原样恢复原终端内容，不污染回滚缓冲。
    output.write(ALT_SCREEN_ON);
    output.write(HIDE_CURSOR);

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on('data', onInput);
    process.on('SIGWINCH', onResize);

    // 服务端主动关闭
    socket.on('terminal-close', (code) => finish(code === 1000 ? 0 : 1));
    socket.on('close', (code) => finish(code === 1000 ? 0 : 1));

    // 本地 Ctrl+C 由终端自己处理（raw mode 下不会产生 SIGINT），
    // 所以不需要额外监听；SIGINT 只在非 raw 场景下才到达。
    process.once('SIGINT', () => {
      try { socket.close(); } catch { /* 忽略 */ }
      finish(130);
    });

    onEvent({ type: 'status', event: 'terminal_attached', message: '' });
    onResize();
  });
}
