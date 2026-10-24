/**
 * CLI 的 HTTP 客户端。
 *
 * 只做三件事：拼 URL、带 Bearer 头、把服务端错误翻成中文。
 * 业务规则一律留在服务端——CLI 若自己复制一份授权判断，两份逻辑
 * 迟早分叉，而分叉的那一天就是越权的那一天。
 */

export class CliError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 服务端英文错误 → 中文提示。未收录的保留原文，避免「翻译丢信息」。 */
const MESSAGES = {
  'Invalid, expired, revoked or disabled access token':
    '访问令牌无效、已过期或已被撤销。请在面板「MCP 令牌」中重新创建，然后执行 cssh login',
  'Server is not authorized for this token': '该令牌未被授权访问这台服务器',
  'Operation requires the "exec" scope': '该令牌缺少 exec 权限（只能读取，不能执行命令）',
  'Operation requires the "write" scope': '该令牌缺少 write 权限（不能上传文件）',
  'Operation requires the "read" scope': '该令牌缺少 read 权限',
  'Database connection is not authorized for this token': '该令牌未被授权访问这个数据库连接',
  'Server unavailable or access denied': '服务器不存在或无权访问',
  'Unable to open server connection': '无法建立服务器连接（凭据解析失败）',
  'Unable to load saved servers': '无法读取服务器列表',
};

function localize(message, status) {
  if (MESSAGES[message]) return MESSAGES[message];
  if (status === 401) return '鉴权失败：访问令牌无效或已被撤销';
  if (status === 403) return message ? `权限不足：${message}` : '权限不足';
  if (status === 404) return '接口不存在：请确认面板版本支持 CLI（需 2.6.x 自托管版）';
  if (status === 429) return '请求过于频繁，请稍后再试';
  return message || `请求失败 (HTTP ${status})`;
}

export function createClient({ baseUrl, token, insecure = false, fetchImpl = fetch }) {
  if (!baseUrl) throw new CliError('未配置面板地址。请先执行 cssh login <面板地址>');
  if (!token) throw new CliError('未登录。请执行 cssh login <面板地址> 并粘贴访问令牌');

  // 自签证书面板：--insecure 只影响本进程。Node 的 fetch 没有『单次请求
  // 跳过证书校验』的公开开关（要自己造 undici Dispatcher），而 CLI 是短命
  // 进程，所以直接改本进程的环境变量——但对用户必须先明确告警，否则
  // 「静默不校验证书」比校验证书失败危险得多。
  if (insecure && /^https:/i.test(baseUrl) && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.stderr.write('⚠ 已关闭 TLS 证书校验（--insecure）：仅应用于你完全信任的自签面板\n');
  }

  async function request(path, { method = 'GET', body, signal, expectStream = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const reason = error?.cause?.code || error?.code || error?.message || '未知错误';
      throw new CliError(`无法连接面板 ${baseUrl}（${reason}）`);
    }

    if (!response.ok) {
      // 先按文本读，再尝试 JSON：错误响应体可能为空（403/429 常见）。
      let payload = null;
      const text = await response.text().catch(() => '');
      if (text) { try { payload = JSON.parse(text); } catch { /* 非 JSON 错误体 */ } }
      const message = payload?.error || text.slice(0, 200);
      throw new CliError(localize(message, response.status), {
        status: response.status, code: payload?.code || '',
      });
    }
    if (expectStream) return response;
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new CliError('服务端返回了非 JSON 响应'); }
  }

  return {
    baseUrl,
    token,

    whoami: () => request('/api/cli/whoami'),
    servers: () => request('/api/cli/servers').then((data) => data?.servers ?? []),

    exec: (serverId, command, { timeoutMs, signal } = {}) =>
      request('/api/cli/exec', {
        method: 'POST', signal,
        body: { server_id: serverId, command, timeout_ms: timeoutMs },
      }),

    execStream: (serverId, command, { timeoutMs, signal } = {}) =>
      request('/api/cli/exec/stream', {
        method: 'POST', signal, expectStream: true,
        body: { server_id: serverId, command, timeout_ms: timeoutMs },
      }),

    upload: (serverId, path, contentBase64, { append = false, timeoutMs, signal } = {}) =>
      request('/api/cli/upload', {
        method: 'POST', signal,
        body: {
          server_id: serverId, path, content_base64: contentBase64,
          append, timeout_ms: timeoutMs,
        },
      }),

    download: (serverId, path, { offset = 0, maxBytes, signal } = {}) =>
      request('/api/cli/download', {
        method: 'POST', signal,
        body: { server_id: serverId, path, offset, max_bytes: maxBytes },
      }),

    snippets: () => request('/api/cli/snippets').then((data) => data?.snippets ?? []),

    // 已知主机：首次信任（写入）与手动遗忘（删除）。
    // 修改指纹的路径**不存在** —— host_key_changed 必须回面板手动处理。
    saveKnownHost: ({ host, port, fingerprint }) =>
      request('/api/cli/known-hosts', { method: 'POST', body: { host, port, fingerprint } }),
    forgetKnownHost: ({ host, port }) =>
      request('/api/cli/known-hosts', { method: 'DELETE', body: { host, port } }),

    dbConnections: () => request('/api/cli/db/connections').then((data) => data?.connections ?? []),
    dbSchema: (connectionId, { table, schema } = {}) =>
      request('/api/cli/db/schema', {
        method: 'POST', body: { connection_id: connectionId, table, schema },
      }),
    dbQuery: (connectionId, sql, { params, timeoutMs } = {}) =>
      request('/api/cli/db/query', {
        method: 'POST', body: { connection_id: connectionId, sql, params, timeout_ms: timeoutMs },
      }),
  };
}

/**
 * 逐行解析 NDJSON 流。调用方拿到的是已经解析好的对象，
 * 不需要关心分块边界——服务端按行 flush，这里按行重组。
 */
export async function* readNdjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { /* 跳过无法解析的行 */ }
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) { try { yield JSON.parse(tail); } catch { /* 同上 */ } }
  } finally {
    reader.cancel().catch(() => {});
  }
}
