import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { executeSaved, savedServers, validatePath, shellQuote } from './operations.mjs';
import { tokenHash } from './access-store.mjs';

const result = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError });
const serverIdSchema = z.number().int().positive();
const pathSchema = z.string().min(1).max(4096);

export function createMcpServer({ env, store, identity, SSHSession, isBlockedCommand, execute = executeSaved, signal }) {
  const server = new McpServer({ name: 'cloudssh', version: '2.6.2' });
  const authorize = (serverId, scope) => {
    if (!store.isActive(identity.id)) throw new Error('Token expired or revoked');
    if (serverId !== undefined && !identity.server_ids.includes(serverId)) throw new Error('Server is not authorized for this token');
    if (scope && !identity.scopes.includes(scope)) throw new Error('Operation is not authorized for this token');
  };
  const tool = (name, scope, inputSchema, handler) => {
    if (scope && !identity.scopes.includes(scope)) return;
    server.registerTool(name, {
      description: descriptions[name], inputSchema,
      annotations: { readOnlyHint: name === 'list_servers' || scope === 'read',
        destructiveHint: scope === 'exec' || scope === 'write', openWorldHint: true },
    }, async (args, extra) => {
      let started = false;
      try {
        authorize(args.server_id, scope);
        // Fail closed before dispatch if the audit cannot be written.
        store.audit(identity, name, args.server_id, 'started', {
          ...(args.command ? { command_sha256: tokenHash(args.command) } : {}),
          ...(args.path ? { path: args.path } : {}),
        });
        started = true;
        const callSignal = signal ? AbortSignal.any([signal, extra.signal]) : extra.signal;
        callSignal.throwIfAborted();
        const data = await handler(args, () => authorize(args.server_id, scope), callSignal);
        const failed = typeof data.exit_code === 'number' && data.exit_code !== 0;
        store.audit(identity, name, args.server_id, failed ? 'failed' : 'succeeded',
          typeof data.exit_code === 'number' ? { exit_code: data.exit_code } : {});
        return result(data, failed);
      } catch (error) {
        // Execution exceptions are uncertain outcomes: never advise blind replay.
        store.audit(identity, name, args.server_id, started ? 'unknown' : 'denied');
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
    server_id: serverIdSchema, path: pathSchema, content: z.string().max(262144),
  }, (args, check, callSignal) => {
    const path = validatePath(args.path);
    const encoded = Buffer.from(args.content, 'utf8').toString('base64');
    if (Buffer.byteLength(args.content, 'utf8') > 262144) throw new Error('File content exceeds 256 KiB');
    // Same-directory temporary file + rename; never follow a target symlink.
    return run(args, `set -eu; target=${path}; dir=$(dirname -- "$target"); ` +
      `tmp=$(mktemp "$dir/.cloudssh-mcp.XXXXXXXX"); trap 'rm -f -- "$tmp"' EXIT; ` +
      `printf '%s' ${shellQuote(encoded)} | base64 -d > "$tmp"; ` +
      `if [ -f "$target" ] && [ ! -L "$target" ]; then chmod --reference="$target" "$tmp"; fi; ` +
      `mv -f -- "$tmp" "$target"; trap - EXIT`, check, callSignal);
  });
  return server;
}

const descriptions = {
  list_servers: 'List authorized saved servers. Never returns passwords or private keys.',
  execute_command: 'Execute a shell command on an authorized server. Exec scope grants arbitrary SSH-user privileges. Do not blindly retry uncertain outcomes.',
  list_files: 'List an absolute directory on an authorized server (requires Unix ls).',
  read_file: 'Read up to max_bytes from a remote file as base64 (requires Unix head/base64).',
  write_file: 'Atomically replace a remote UTF-8 file with up to 256 KiB. Existing mode is retained; ownership belongs to the SSH user. Requires Unix mktemp/base64/chmod/mv.',
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
