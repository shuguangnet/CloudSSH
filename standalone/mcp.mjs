import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { executeSaved, savedServers, validatePath, shellQuote } from './operations.mjs';
import { tokenHash } from './access-store.mjs';
import { redactPreview } from './redact.mjs';
import { collectServerStatus } from './status.mjs';
import { registerDatabaseTools, databaseDescriptions } from './mcp-database.mjs';

const result = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError });
const serverIdSchema = z.number().int().positive();
const pathSchema = z.string().min(1).max(4096);
// Single-call transfer budget. The exec channel keeps the first 128 KiB plus a
// rolling 256 KiB tail (384 KiB contiguous before anything is dropped); a
// 256 KiB raw chunk stays under that even after base64 inflation (~350 KiB).
const TRANSFER_MAX_BYTES = 262144;
// Command-size budget: OpenSSH rejects transport packets above 256 KiB, and
// Linux caps a single argv string (sshd runs `bash -c <command>`) at 128 KiB
// (MAX_ARG_STRLEN), whichever binds first. A base64 payload of 128000 chars
// plus the shell wrapper stays under the argv limit with margin.
const TRANSFER_MAX_CHARS = 128000;

async function fetchSnippets(env, identity) {
  const stub = env.USER_DB.get(env.USER_DB.idFromName(identity.github_id));
  const response = await stub.fetch(new Request(`http://internal/internal/snippets?user_id=${identity.user_id}`));
  if (!response.ok) throw new Error('Unable to load command snippets');
  return await response.json();
}

/** Strict base64 guard so `base64 -d` on the server can never fail mid-stream
 * (a failed decode halfway through an append would leave a partial write). */
function decodeBase64Payload(value) {
  if (typeof value !== 'string') throw new Error('content_base64 is required');
  const encoded = value.replace(/\s+/g, '');
  if (encoded.length > TRANSFER_MAX_CHARS) throw new Error(`content_base64 exceeds ${TRANSFER_MAX_CHARS} characters`);
  if (encoded.length % 4 !== 0 || (encoded && !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))) {
    throw new Error('content_base64 is not valid base64');
  }
  return { encoded, decoded: Buffer.from(encoded, 'base64') };
}

export function createMcpServer({
  env, store, identity, SSHSession, isBlockedCommand, execute = executeSaved, signal,
  databaseStore, clientIp = null,
}) {
  const server = new McpServer({ name: 'cloudssh', version: '2.6.2' });
  const authorize = (serverId, scope) => {
    if (!store.isActive(identity.id)) throw new Error('Token expired or disabled');
    if (serverId !== undefined && !identity.server_ids.includes(serverId)) throw new Error('Server is not authorized for this token');
    if (scope && !identity.scopes.includes(scope)) throw new Error('Operation is not authorized for this token');
  };
  // 审计明细：记录「执行了什么」——命令/SQL/路径等参数摘要。入库前经
  // redactPreview 脱敏（命令里经常捎带 PASSWORD=xxx / token，不能整段入库）
  // 并限长。command_sha256 保留：需要取证比对时可用原文重算。
  const argDetails = (args, extra = {}) => {
    const details = { ...extra };
    if (typeof args.path === 'string') details.path = args.path;
    if (typeof args.command === 'string') {
      details.command = redactPreview(args.command);
      details.command_sha256 = tokenHash(args.command);
    }
    if (args.snippet_id !== undefined) details.snippet_id = args.snippet_id;
    if (args.max_bytes !== undefined) details.max_bytes = args.max_bytes;
    if (args.offset !== undefined) details.offset = args.offset;
    if (typeof args.content === 'string') details.bytes = Buffer.byteLength(args.content, 'utf8');
    if (typeof args.append === 'boolean') details.append = args.append;
    return details;
  };
  const tool = (name, scope, inputSchema, handler, prepare = null) => {
    if (scope && !identity.scopes.includes(scope)) return;
    server.registerTool(name, {
      description: descriptions[name], inputSchema,
      annotations: { readOnlyHint: name === 'list_servers' || name === 'list_snippets' || scope === 'read',
        destructiveHint: scope === 'exec' || scope === 'write', openWorldHint: true },
    }, async (args, extra) => {
      let started = false;
      let summary = {};
      try {
        authorize(args.server_id, scope);
        // 先用调用参数本身构建摘要（denied 行也能看清「想执行什么」），
        // prepare 成功后再并入服务端解析出的补充信息（如片段名/命令正文）。
        summary = argDetails(args);
        const prepared = prepare ? await prepare(args) : null;
        if (prepared?.details) summary = argDetails(args, prepared.details);
        // Fail closed before dispatch if the audit cannot be written.
        store.audit(identity, name, args.server_id, 'started', summary, clientIp);
        started = true;
        const callSignal = signal ? AbortSignal.any([signal, extra.signal]) : extra.signal;
        callSignal.throwIfAborted();
        const data = await handler(args, () => authorize(args.server_id, scope), callSignal, prepared?.value);
        const failed = typeof data.exit_code === 'number' && data.exit_code !== 0;
        // 完成行复述参数摘要：按状态筛审计时每行都能看清「干了什么」。
        store.audit(identity, name, args.server_id, failed ? 'failed' : 'succeeded',
          { ...summary, ...(typeof data.exit_code === 'number' ? { exit_code: data.exit_code } : {}) }, clientIp);
        return result(data, failed);
      } catch (error) {
        // Execution exceptions are uncertain outcomes: never advise blind replay.
        store.audit(identity, name, args.server_id, started ? 'unknown' : 'denied',
          { ...summary, error: redactPreview(error instanceof Error ? error.message : 'Operation failed', 512) }, clientIp);
        return result({ error: error instanceof Error ? error.message : 'Operation failed',
          ...(started ? { instruction: 'Inspect remote state before retrying a modifying operation.' } : {}) }, true);
      }
    });
  };
  const run = async (args, command, authorizeAgain, callSignal) => {
    const data = await execute(env, identity, args.server_id, command,
      args.timeout_ms ?? 30000, SSHSession, authorizeAgain, callSignal);
    return { stdout: data.stdout, stderr: data.stderr, exit_code: data.exitCode };
  };
  tool('list_servers', null, {}, async () => {
    const servers = await savedServers(env, identity);
    return { servers: servers.filter((item) => identity.server_ids.includes(item.id)).map((item) => ({
      id: item.id, name: item.name, host: item.host, port: item.port,
      username: item.username, tags: item.tags, os: item.os,
    })) };
  });
  tool('execute_command', 'exec', {
    server_id: serverIdSchema, command: z.string().min(1).max(16000).refine((s) => !s.includes('\0')),
    timeout_ms: z.number().int().min(1000).max(180000).optional(),
  }, async (args, check, callSignal) => {
    const blocked = isBlockedCommand(args.command);
    if (blocked.blocked) throw new Error(`Command blocked: ${blocked.reason}`);
    return run(args, args.command, check, callSignal);
  });
  tool('list_files', 'read', { server_id: serverIdSchema, path: pathSchema }, (args, check, callSignal) =>
    run(args, `LC_ALL=C ls -la -- ${validatePath(args.path)}`, check, callSignal));
  tool('read_file', 'read', {
    server_id: serverIdSchema, path: pathSchema,
    max_bytes: z.number().int().min(1).max(262144).default(65536),
  }, (args, check, callSignal) => run(args,
    `set -eu; tmp=$(mktemp); trap 'rm -f -- "$tmp"' EXIT; ` +
    `test -f ${validatePath(args.path)}; head -c ${args.max_bytes} -- ${validatePath(args.path)} > "$tmp"; base64 "$tmp"`, check, callSignal).then((data) => ({
      ...data, encoding: 'base64', max_bytes: args.max_bytes,
      instruction: 'The file may be truncated at max_bytes; decode stdout as base64.',
    })));
  tool('write_file', 'write', {
    server_id: serverIdSchema, path: pathSchema, content: z.string().max(96000),
  }, (args, check, callSignal) => {
    const path = validatePath(args.path);
    const encoded = Buffer.from(args.content, 'utf8').toString('base64');
    if (encoded.length > TRANSFER_MAX_CHARS) throw new Error('File content exceeds the single-call transfer budget; use upload_file chunks');
    // Same-directory temporary file + rename; never follow a target symlink.
    return run(args, `set -eu; target=${path}; dir=$(dirname -- "$target"); ` +
      `tmp=$(mktemp "$dir/.cloudssh-mcp.XXXXXXXX"); trap 'rm -f -- "$tmp"' EXIT; ` +
      `printf '%s' ${shellQuote(encoded)} | base64 -d > "$tmp"; ` +
      `if [ -f "$target" ] && [ ! -L "$target" ]; then chmod --reference="$target" "$tmp"; fi; ` +
      `mv -f -- "$tmp" "$target"; trap - EXIT`, check, callSignal);
  });

  // ==================== 面板命令片段 ====================

  tool('list_snippets', null, {}, async () => {
    const snippets = await fetchSnippets(env, identity);
    return { snippets: snippets.map((item) => ({
      id: item.id, name: item.name, category: item.category || '', command: item.command,
    })) };
  });

  tool('run_snippet', 'exec', {
    server_id: serverIdSchema, snippet_id: z.number().int().positive(),
    timeout_ms: z.number().int().min(1000).max(180000).optional(),
  }, async (args, check, callSignal, snippet) => {
    const blocked = isBlockedCommand(snippet.command);
    if (blocked.blocked) throw new Error(`Snippet command blocked: ${blocked.reason}`);
    const data = await run(args, snippet.command, check, callSignal);
    return { ...data, snippet_id: snippet.id, snippet_name: snippet.name };
  }, async (args) => {
    // prepare：解析片段一次，审计与执行共用，避免重复拉取片段库。
    const snippets = await fetchSnippets(env, identity);
    const snippet = snippets.find((item) => item.id === args.snippet_id);
    if (!snippet) throw new Error(`Snippet ${args.snippet_id} not found for this user`);
    return {
      value: snippet,
      details: { snippet_name: snippet.name, command: redactPreview(snippet.command), command_sha256: tokenHash(snippet.command) },
    };
  });

  // ==================== 大文件传输（分块） ====================

  tool('download_file', 'read', {
    server_id: serverIdSchema, path: pathSchema,
    offset: z.number().int().min(0).max(2 ** 48).default(0),
    max_bytes: z.number().int().min(1).max(TRANSFER_MAX_BYTES).default(TRANSFER_MAX_BYTES),
  }, (args, check, callSignal) => {
    const path = validatePath(args.path);
    // tail -c +N is 1-based: byte `offset` of the file is N = offset + 1.
    return run(args,
      `set -eu; f=${path}; test -f "$f"; ` +
      `size=$(wc -c < "$f" | tr -d '[:space:]'); echo "SIZE:$size"; ` +
      `tmp=$(mktemp); trap 'rm -f -- "$tmp"' EXIT; ` +
      `tail -c +${args.offset + 1} -- "$f" | head -c ${args.max_bytes} > "$tmp"; ` +
      `echo "CHUNK:$(wc -c < "$tmp" | tr -d '[:space:]')"; ` +
      `echo "SHA256:$(sha256sum "$tmp" 2>/dev/null | cut -d" " -f1)"; ` +
      `base64 "$tmp"`, check, callSignal).then((data) => {
        if (data.exit_code !== 0) return data; // e.g. missing file: wrapper marks failed with stderr
        const lines = (data.stdout || '').split(/\r?\n/);
        const sizeLine = lines.shift() || '';
        const chunkLine = lines.shift() || '';
        const shaLine = lines.shift() || '';
        const size = Number(sizeLine.replace(/^SIZE:/, ''));
        const chunkBytes = Number(chunkLine.replace(/^CHUNK:/, ''));
        if (!sizeLine.startsWith('SIZE:') || !chunkLine.startsWith('CHUNK:') || !shaLine.startsWith('SHA256:') ||
            !Number.isFinite(size) || !Number.isFinite(chunkBytes)) {
          throw new Error('Unexpected download output; the remote file tools may be unavailable');
        }
        const sha256 = shaLine.slice('SHA256:'.length) || null; // null when sha256sum is unavailable
        const content = lines.join('\n').replace(/\n$/, '');
        return {
          size_bytes: size, offset: args.offset, chunk_bytes: chunkBytes,
          truncated: args.offset + chunkBytes < size,
          content_base64: content, content_sha256: sha256, encoding: 'base64', exit_code: data.exit_code,
          instruction: chunkBytes > 0 && args.offset + chunkBytes < size
            ? 'More data follows: call download_file again with offset += chunk_bytes and verify each chunk against content_sha256.'
            : 'Decode content_base64 as base64; compare content_sha256 after decoding to verify integrity.',
        };
      });
  });

  tool('upload_file', 'write', {
    server_id: serverIdSchema, path: pathSchema,
    content_base64: z.string().min(0).max(TRANSFER_MAX_CHARS),
    append: z.boolean().default(false),
  }, (args, check, callSignal) => {
    const path = validatePath(args.path);
    const { encoded, decoded } = decodeBase64Payload(args.content_base64);
    const payload = `printf '%s' ${shellQuote(encoded)} | base64 -d`;
    const command = args.append
      // Append keeps standard shell semantics: the target must already exist
      // (create it with a non-append call first); symlinks are followed.
      ? `set -eu; target=${path}; test -f "$target"; ${payload} >> "$target"; wc -c < "$target" | tr -d '[:space:]'`
      // First chunk: same atomic temp+rename path as write_file.
      : `set -eu; target=${path}; dir=$(dirname -- "$target"); ` +
        `tmp=$(mktemp "$dir/.cloudssh-mcp.XXXXXXXX"); trap 'rm -f -- "$tmp"' EXIT; ` +
        `${payload} > "$tmp"; ` +
        `if [ -f "$target" ] && [ ! -L "$target" ]; then chmod --reference="$target" "$tmp"; fi; ` +
        `mv -f -- "$tmp" "$target"; trap - EXIT; echo "BYTES:${decoded.byteLength}"`;
    return run(args, command, check, callSignal).then((data) => ({
      ...data, bytes_written: decoded.byteLength, append: Boolean(args.append),
      instruction: 'Chunked upload: call with append=false for the first chunk, then append=true; ' +
        'keep each content_base64 within 128000 characters. Verify with download_file or sha256sum afterwards.',
    }));
  });

  // ==================== 服务器信息概览 ====================

  tool('get_server_info', 'read', { server_id: serverIdSchema }, async (args, check, callSignal) =>
    collectServerStatus(env, identity, args.server_id, execute, SSHSession, callSignal, check));

  // ==================== 数据库连接 ====================

  // 数据库工具走独立的授权维度（connection_id），因此不复用上面的 tool()
  // 包装——那个包装假定第一个参数是 server_id 并据此做主机授权。两者共用
  // 同一套 scope 与审计表，语义保持一致。
  registerDatabaseTools(server, {
    store: databaseStore,
    identity,
    authorize: (connectionId, scope) => {
      if (!store.isActive(identity.id)) throw new Error('Token expired or disabled');
      if (connectionId !== undefined && connectionId !== null) {
        const allowed = identity.db_connection_ids ?? [];
        if (!allowed.includes(connectionId)) throw new Error('Database connection is not authorized for this token');
      }
      if (scope && !identity.scopes.includes(scope)) throw new Error('Operation is not authorized for this token');
    },
    audit: (toolName, connectionId, status, details = {}) => {
      // 复用 mcp_audit 表：server_id 留空，连接信息进 details，来源 IP 一并落库。
      store.audit(identity, toolName, undefined, status, { connection_id: connectionId, ...details }, clientIp);
    },
    descriptions: databaseDescriptions,
  });
  return server;
}

const descriptions = {
  list_servers: 'List authorized saved servers. Never returns passwords or private keys.',
  execute_command: 'Execute a shell command on an authorized server. Exec scope grants arbitrary SSH-user privileges. Do not blindly retry uncertain outcomes.',
  list_files: 'List an absolute directory on an authorized server (requires Unix ls).',
  read_file: 'Read up to max_bytes from a remote file as base64 (requires Unix head/base64).',
  write_file: 'Atomically replace a remote UTF-8 file with up to 96000 bytes per call. Existing mode is retained; ownership belongs to the SSH user. Requires Unix mktemp/base64/chmod/mv. Use upload_file for larger or binary content.',
  list_snippets: 'List the command snippets saved in the panel for this account, with their full commands. Use with run_snippet to reuse the one-click scripts.',
  run_snippet: 'Run one of the command snippets saved in the panel (see list_snippets for IDs). Requires exec scope; the snippet command runs verbatim on the chosen server.',
  download_file: 'Download a remote file in verifiable chunks: returns size_bytes, one base64 chunk of up to 256 KiB at offset, its sha256 and a truncated flag. Repeat with offset += chunk_bytes until truncated is false. Requires Unix tail/head/base64/sha256sum.',
  upload_file: 'Upload or append a file in up to 96000-byte decoded chunks (base64). First call with append=false atomically creates/replaces the target (mode retained, symlinks not followed); continue with append=true. Verify with download_file or sha256sum afterwards.',
  get_server_info: 'One-shot server overview over SSH: CPU model/cores/usage, load average, memory, swap, root disk usage, network rates, OS version and uptime (takes about 1-2 s due to CPU sampling).',
};

export async function handleMcp(req, res, context, body) {
  const controller = new AbortController();
  const server = createMcpServer({ ...context, signal: controller.signal });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
  });
  res.once('close', () => { controller.abort(); void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
