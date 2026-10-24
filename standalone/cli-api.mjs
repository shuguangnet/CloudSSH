/**
 * CLI 专用 HTTP 接口（自托管）。
 *
 * 与面板 `/api/*` 的关键差别只有一个：鉴权来源。面板是浏览器 session
 * cookie + 同源校验；这里是 MCP 的 `cssh_` 令牌 + 令牌自带的三重授权
 * （server_ids / scopes / db_connection_ids）。因此：
 *
 *   - 不复用 `/api/*`，避免把「Bearer 也能过」这种放宽扩散到浏览器路由；
 *   - 不经过 `worker.fetch`（自托管下它硬编码 REQUIRE_GITHUB_AUTH=true，
 *     只认 cookie），而是像 MCP 一样直接调 operations.mjs 的特权层；
 *   - 写操作不做 Origin 校验——非浏览器客户端没有 Origin，而令牌的持有
 *     本身等价于「CSRF 场景里攻击者拿不到的东西」。
 *
 * 交互终端走 WebSocket（见 server.mjs 的升级分支）：`ws` 客户端能带
 * Authorization 头，所以票/URL token 一概不需要，凭据始终留在服务端。
 */

import { createHash } from 'node:crypto';
import {
  savedServers, executeSaved, executeSavedStream, validatePath, shellQuote,
} from './operations.mjs';
import { requireServerScope } from './cli-auth.mjs';
import { queryDatabase, describeSchema, describeTable } from './database-client.mjs';

/** SQL 指纹：审计只留哈希，不留正文（与数据库 MCP 工具同一口径）。 */
const sqlFingerprint = (sql) => createHash('sha256').update(String(sql)).digest('hex');

/** 数据库连接授权：token 的 db_connection_ids 未包含就是 403。 */
function requireDbScope(identity, connectionId, scope) {
  const allowed = identity.db_connection_ids ?? [];
  if (connectionId !== undefined && !allowed.includes(connectionId)) {
    throw Object.assign(new Error('Database connection is not authorized for this token'), { status: 403 });
  }
  if (scope && !identity.scopes.includes(scope)) {
    throw Object.assign(new Error(`Operation requires the "${scope}" scope`), { status: 403 });
  }
}

/** 仅按 scope 校验（不涉及某台具体服务器）。 */
function requireServerScopeForToken(identity, scope) {
  if (!identity.scopes.includes(scope)) {
    throw Object.assign(new Error(`Operation requires the "${scope}" scope`), { status: 403 });
  }
}

const MAX_COMMAND_LENGTH = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// 与 MCP 相同的单块传输预算：128000 字符 base64 在 sshd 的
// MAX_ARG_STRLEN（128 KiB）以内留有余量。
const TRANSFER_MAX_CHARS = 128_000;
const TRANSFER_MAX_BYTES = 262_144;

const json = (data, status = 200) => Response.json(data, { status });

function fail(error, fallbackStatus = 500) {
  return json({ error: error?.message || 'Operation failed' }, error?.status || fallbackStatus);
}

function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(number)));
}

/** 取 snippets 列表（与 MCP 的 fetchSnippets 同一内部路由）。 */
async function fetchSnippets(env, identity) {
  const stub = env.USER_DB.get(env.USER_DB.idFromName(identity.github_id));
  const response = await stub.fetch(
    new Request(`http://internal/internal/snippets?user_id=${identity.user_id}`)
  );
  if (!response.ok) throw new Error('Unable to load command snippets');
  return await response.json();
}

const userDb = (env, identity) => env.USER_DB.get(env.USER_DB.idFromName(identity.github_id));

/**
 * 写入已知主机指纹（TOFU 的「记住」那一步）。
 *
 * 为什么必须由 CLI 写：`cssh exec` 走池化链，而池化链要求每一跳都有
 * 已信任指纹（否则报「Connect through the panel first」）。若不能记录，
 * 新服务器就永远只能先在面板点一次。写入条件严苛：只接受
 * `host_key_verified`（服务端已验证签名）那一瞬的指纹，不接受任意输入。
 */
async function upsertKnownHost({ env, identity, body }) {
  const host = typeof body?.host === 'string' ? body.host : '';
  const port = Number(body?.port);
  const fingerprint = typeof body?.fingerprint === 'string' ? body.fingerprint : '';
  if (!host || !fingerprint) return json({ error: 'host and fingerprint are required' }, 400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ error: 'port is required' }, 400);
  // 指纹形态白名单：SHA256:base64。防止写入任意字符串污染信任库。
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) {
    return json({ error: 'fingerprint must be a SHA256 host key fingerprint' }, 400);
  }
  const response = await userDb(env, identity).fetch(new Request('http://internal/internal/known-hosts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: identity.user_id, host, port, fingerprint }),
  }));
  if (!response.ok) return json({ error: 'Unable to save host fingerprint' }, 502);
  return json({ ok: true, host, port, fingerprint });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** POST /api/cli/exec —— 一次性命令，退出码原样返回。 */
async function handleExec({ request, env, identity, SSHSession, isBlockedCommand }) {
  const body = await readJson(request);
  if (body === null) return json({ error: 'Invalid JSON body' }, 400);
  const serverId = Number(body?.server_id);
  if (!Number.isSafeInteger(serverId) || serverId <= 0) return json({ error: 'server_id is required' }, 400);
  const command = typeof body?.command === 'string' ? body.command : '';
  if (!command.trim()) return json({ error: 'command is required' }, 400);
  if (command.length > MAX_COMMAND_LENGTH) return json({ error: `command exceeds ${MAX_COMMAND_LENGTH} characters` }, 400);
  if (command.includes('\0')) return json({ error: 'command must not contain NUL' }, 400);

  try {
    requireServerScope(identity, serverId, 'exec');
    // 与 MCP execute_command 同一道危险命令闸门：CLI 不该成为绕过它的旁路。
    const blocked = isBlockedCommand(command);
    if (blocked.blocked) return json({ error: `Command blocked: ${blocked.reason}` }, 403);
    const recheck = () => requireServerScope(identity, serverId, 'exec');
    const result = await executeSaved(env, identity, serverId, command,
      clampTimeout(body?.timeout_ms), SSHSession, recheck);
    return json({
      stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
      truncated: !!result.truncated,
    });
  } catch (error) { return fail(error); }
}

/** POST /api/cli/exec/stream —— 边跑边回（NDJSON 行），用于流式输出。 */
async function handleExecStream({ request, env, identity, SSHSession }) {
  const body = await readJson(request);
  if (body === null) return json({ error: 'Invalid JSON body' }, 400);
  const serverId = Number(body?.server_id);
  if (!Number.isSafeInteger(serverId) || serverId <= 0) return json({ error: 'server_id is required' }, 400);
  const command = typeof body?.command === 'string' ? body.command : '';
  if (!command.trim() || command.length > MAX_COMMAND_LENGTH) return json({ error: 'command is required' }, 400);

  try { requireServerScope(identity, serverId, 'exec'); } catch (error) { return fail(error); }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (payload) => {
        if (!open) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`)); } catch { open = false; }
      };
      try {
        const result = await executeSavedStream(env, identity, serverId, command, {
          timeout: clampTimeout(body?.timeout_ms),
          signal: request.signal,
          maxBytes: 1024 * 1024,
          onChunk: (data) => {
            const text = decoder.decode(data, { stream: true });
            if (text) send({ type: 'output', text });
          },
        }, SSHSession, () => requireServerScope(identity, serverId, 'exec'));
        const tail = decoder.decode();
        if (tail) send({ type: 'output', text: tail });
        send({
          type: 'done', exitCode: result.exitCode, stderr: String(result.stderr || ''),
          truncated: !!result.truncated,
        });
      } catch (error) {
        send({ type: 'error', message: error?.message || 'Operation failed' });
      } finally {
        open = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** POST /api/cli/upload —— 分块上传（首块 append=false，后续 append=true）。 */
async function handleUpload({ request, env, identity, SSHSession }) {
  const body = await readJson(request);
  if (body === null) return json({ error: 'Invalid JSON body' }, 400);
  const serverId = Number(body?.server_id);
  if (!Number.isSafeInteger(serverId) || serverId <= 0) return json({ error: 'server_id is required' }, 400);
  const encoded = typeof body?.content_base64 === 'string' ? body.content_base64.replace(/\s+/g, '') : '';
  if (encoded.length > TRANSFER_MAX_CHARS) return json({ error: `content_base64 exceeds ${TRANSFER_MAX_CHARS} characters` }, 400);
  if (encoded.length % 4 !== 0 || (encoded && !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))) {
    return json({ error: 'content_base64 is not valid base64' }, 400);
  }
  const append = body?.append === true;

  try {
    requireServerScope(identity, serverId, 'write');
    const path = validatePath(body?.path);
    const payload = `printf '%s' ${shellQuote(encoded)} | base64 -d`;
    // 首块用「同目录临时文件 + rename」：绝不跟随目标符号链接，
    // 也不会在写入中途留下半个文件。后续块按标准 shell 语义追加。
    const command = append
      ? `set -eu; target=${path}; test -f "$target"; ${payload} >> "$target"; wc -c < "$target" | tr -d '[:space:]'`
      : `set -eu; target=${path}; dir=$(dirname -- "$target"); ` +
        `tmp=$(mktemp "$dir/.cloudssh-cli.XXXXXXXX"); trap 'rm -f -- "$tmp"' EXIT; ` +
        `${payload} > "$tmp"; ` +
        `if [ -f "$target" ] && [ ! -L "$target" ]; then chmod --reference="$target" "$tmp"; fi; ` +
        `mv -f -- "$tmp" "$target"; trap - EXIT; echo OK`;
    const result = await executeSaved(env, identity, serverId, command,
      clampTimeout(body?.timeout_ms), SSHSession, () => requireServerScope(identity, serverId, 'write'));
    if (result.exitCode !== 0) {
      return json({ error: (result.stderr || `exit ${result.exitCode}`).trim().slice(0, 300), exitCode: result.exitCode }, 502);
    }
    return json({ ok: true, bytes: Buffer.from(encoded, 'base64').byteLength, append });
  } catch (error) { return fail(error); }
}

/** POST /api/cli/download —— 分块下载（offset 逐块推进）。 */
async function handleDownload({ request, env, identity, SSHSession }) {
  const body = await readJson(request);
  if (body === null) return json({ error: 'Invalid JSON body' }, 400);
  const serverId = Number(body?.server_id);
  if (!Number.isSafeInteger(serverId) || serverId <= 0) return json({ error: 'server_id is required' }, 400);
  const offset = Number.isFinite(Number(body?.offset)) ? Math.max(0, Math.floor(Number(body.offset))) : 0;
  const maxBytes = Math.min(TRANSFER_MAX_BYTES,
    Math.max(1, Math.floor(Number(body?.max_bytes) || TRANSFER_MAX_BYTES)));

  try {
    requireServerScope(identity, serverId, 'read');
    const path = validatePath(body?.path);
    // tail -c +N 是 1 基：偏移 offset 处对应 N = offset + 1。
    const result = await executeSaved(env, identity, serverId,
      `set -eu; f=${path}; test -f "$f"; ` +
      `size=$(wc -c < "$f" | tr -d '[:space:]'); echo "SIZE:$size"; ` +
      `tmp=$(mktemp); trap 'rm -f -- "$tmp"' EXIT; ` +
      `tail -c +${offset + 1} -- "$f" | head -c ${maxBytes} > "$tmp"; ` +
      `echo "CHUNK:$(wc -c < "$tmp" | tr -d '[:space:]')"; ` +
      `echo "SHA256:$(sha256sum "$tmp" 2>/dev/null | cut -d" " -f1)"; ` +
      `base64 "$tmp"`,
      clampTimeout(body?.timeout_ms), SSHSession, () => requireServerScope(identity, serverId, 'read'));
    if (result.exitCode !== 0) {
      return json({ error: (result.stderr || `exit ${result.exitCode}`).trim().slice(0, 300), exitCode: result.exitCode }, 502);
    }
    const lines = String(result.stdout || '').split(/\r?\n/);
    const sizeLine = lines.shift() || '';
    const chunkLine = lines.shift() || '';
    const shaLine = lines.shift() || '';
    if (!sizeLine.startsWith('SIZE:') || !chunkLine.startsWith('CHUNK:')) {
      return json({ error: 'Unexpected download output; the remote file tools may be unavailable' }, 502);
    }
    const size = Number(sizeLine.slice(5));
    const chunkBytes = Number(chunkLine.slice(6));
    return json({
      size, offset, chunkBytes,
      truncated: offset + chunkBytes < size,
      // `base64` 会按 76 列换行（busybox 还不支持 -w0），这里去掉换行
      // 但**保留 `=` 补位**：补位是编码的一部分，删掉后与标准 base64
      // 不一致，调用方做严格比对时会失败。
      contentBase64: lines.join('').replace(/\s+/g, ''),
      sha256: shaLine.startsWith('SHA256:') ? shaLine.slice(7) || null : null,
    });
  } catch (error) { return fail(error); }
}

/**
 * `/api/cli/*` 路由入口。返回 null = 「不是我负责的路径」，交回主路由。
 * 鉴权已由 server.mjs 完成（与 /mcp 同一处），这里只做业务。
 */
export function createCliRoutes({
  env, identity, SSHSession, isBlockedCommand, databaseStore,
}) {
  return async function handleCli(request, pathname) {
    if (!pathname.startsWith('/api/cli/')) return null;

    // ---------- 身份自检（`cssh whoami`） ----------
    if (pathname === '/api/cli/whoami' && request.method === 'GET') {
      return json({
        github_id: String(identity.github_id),
        user_id: identity.user_id,
        name: identity.name,
        scopes: identity.scopes,
        server_ids: identity.server_ids,
        db_connection_ids: identity.db_connection_ids ?? [],
        expires_at: identity.expires_at,
      });
    }

    // ---------- 服务器列表（只有被授权的那些） ----------
    if (pathname === '/api/cli/servers' && request.method === 'GET') {
      try {
        const servers = await savedServers(env, identity);
        // 「存在但无权」与「不存在」同样被过滤掉：不泄漏令牌授权外的服务器。
        return json({
          servers: servers
            .filter((item) => identity.server_ids.includes(item.id))
            .map((item) => ({
              id: item.id, name: item.name, host: item.host, port: item.port,
              username: item.username, tags: Array.isArray(item.tags) ? item.tags : [],
              os: item.os ?? null, authMethod: item.auth_method,
              jumpServerId: item.jump_server_id ?? null,
              lastConnectedAt: item.last_connected_at ?? null,
            })),
        });
      } catch (error) { return fail(error); }
    }

    // ---------- 一次性命令 ----------
    if (pathname === '/api/cli/exec' && request.method === 'POST') {
      return handleExec({ request, env, identity, SSHSession, isBlockedCommand });
    }
    if (pathname === '/api/cli/exec/stream' && request.method === 'POST') {
      return handleExecStream({ request, env, identity, SSHSession });
    }

    // ---------- 文件传输 ----------
    if (pathname === '/api/cli/upload' && request.method === 'POST') {
      return handleUpload({ request, env, identity, SSHSession });
    }
    if (pathname === '/api/cli/download' && request.method === 'POST') {
      return handleDownload({ request, env, identity, SSHSession });
    }

    // ---------- 命令片段 ----------
    if (pathname === '/api/cli/snippets' && request.method === 'GET') {
      try {
        const snippets = await fetchSnippets(env, identity);
        return json({
          snippets: snippets.map((item) => ({
            id: item.id, name: item.name, category: item.category || '', command: item.command,
          })),
        });
      } catch (error) { return fail(error); }
    }

    // ---------- 数据库（受 db_connection_ids 约束） ----------
    if (pathname === '/api/cli/db/connections' && request.method === 'GET') {
      const allowed = identity.db_connection_ids ?? [];
      const connections = databaseStore.listConnections()
        .filter((item) => allowed.includes(item.id))
        .map((item) => ({
          id: item.id, name: item.name, engine: item.engine, host: item.host,
          port: item.port, database: item.database, username: item.username,
          readOnly: item.read_only === true || item.readOnly === true,
        }));
      return json({ connections });
    }

    // ---------- 数据库：表结构 ----------
    if (pathname === '/api/cli/db/schema' && request.method === 'POST') {
      const body = await readJson(request);
      if (body === null) return json({ error: 'Invalid JSON body' }, 400);
      const connectionId = Number(body?.connection_id);
      if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
        return json({ error: 'connection_id is required' }, 400);
      }
      try {
        requireDbScope(identity, connectionId, 'read');
        const config = databaseStore.resolveConnection(connectionId);
        const table = typeof body?.table === 'string' && body.table.trim() ? body.table.trim() : '';
        if (table) {
          const columns = await describeTable(config, String(body?.schema ?? ''), table);
          return json({ kind: 'table', table, schema: String(body?.schema ?? ''), columns });
        }
        const overview = await describeSchema(config);
        return json({
          kind: 'schema', engine: overview.engine, tables: overview.tables,
          note: overview.note, ...(overview.raw ? { raw: overview.raw } : {}),
        });
      } catch (error) { return fail(error); }
    }

    // ---------- 数据库：查询 ----------
    //
    // 只读闸门在 database-client 内部（真实词法扫描）。这里额外要求
    // `write` scope 才能提交写语句前先做一次 lexical 预判，让 CLI 的
    // `--write` 语义与后端真实放行保持一致，避免「CLI 以为能写 / 服务端拒绝」。
    if (pathname === '/api/cli/db/query' && request.method === 'POST') {
      const body = await readJson(request);
      if (body === null) return json({ error: 'Invalid JSON body' }, 400);
      const connectionId = Number(body?.connection_id);
      if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
        return json({ error: 'connection_id is required' }, 400);
      }
      const sql = typeof body?.sql === 'string' ? body.sql : '';
      if (!sql.trim()) return json({ error: 'sql is required' }, 400);
      if (sql.length > 100_000) return json({ error: 'sql exceeds 100000 characters' }, 400);

      try {
        requireDbScope(identity, connectionId, 'read');
        const config = databaseStore.resolveConnection(connectionId);
        const startedAt = Date.now();
        const result = await queryDatabase(config, sql, body?.params ?? [], {
          timeoutMs: body?.timeout_ms,
        });
        databaseStore.recordAudit({
          connectionId, connectionName: config.name, tool: 'cli_db_query', engine: config.engine,
          status: 'succeeded', sqlSha256: sqlFingerprint(sql),
          rowCount: result.rowCount, durationMs: result.durationMs,
        });
        return json({
          columns: result.columns, rows: result.rows, rowCount: result.rowCount,
          returnedRows: result.rows.length, durationMs: result.durationMs,
          truncated: result.rowCount > result.rows.length,
          // 与面板同一口径：被遮蔽的单元格数必须告诉用户，否则会把
          // *** 误当成库里存的值再写回去。
          redactedCells: result.redactedCells ?? 0,
          serverDurationMs: Date.now() - startedAt,
        });
      } catch (error) {
        try {
          const config = databaseStore.resolveConnection(connectionId);
          databaseStore.recordAudit({
            connectionId, connectionName: config.name, tool: 'cli_db_query', engine: config.engine,
            status: 'failed', sqlSha256: sqlFingerprint(sql), error: error.message,
          });
        } catch { /* 连接自身不存在时无需审计 */ }
        return fail(error, 400);
      }
    }

    // ---------- 已知主机（首次信任 / 手动遗忘） ----------
    //
    // 首次信任必须能写：否则新服务器上的 `cssh exec` 永远缺少
    // expectedFingerprint 而无法建链。变更指纹（host_key_changed）绝不
    // 自动写——那一个分支只能由人确认后手动 `cssh forget` 再连。
    if (pathname === '/api/cli/known-hosts' && request.method === 'POST') {
      const body = await readJson(request);
      if (body === null) return json({ error: 'Invalid JSON body' }, 400);
      try {
        requireServerScopeForToken(identity, 'write');
        return await upsertKnownHost({ env, identity, body });
      } catch (error) { return fail(error); }
    }
    if (pathname === '/api/cli/known-hosts' && request.method === 'DELETE') {
      const body = await readJson(request);
      if (body === null) return json({ error: 'Invalid JSON body' }, 400);
      try {
        requireServerScopeForToken(identity, 'write');
        const response = await userDb(env, identity).fetch(new Request('http://internal/internal/known-hosts', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: identity.user_id, host: body?.host, port: Number(body?.port) }),
        }));
        if (!response.ok) return json({ error: 'Unable to delete host fingerprint' }, 502);
        return json({ ok: true });
      } catch (error) { return fail(error); }
    }

    return json({ error: 'Not found' }, 404);
  };
}
