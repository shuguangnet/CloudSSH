// 批量命令执行：多选服务器并发执行同一条命令，SSE 流式聚合各机输出与退出码。
// 复用 operations.mjs 的 SSH 链路池（跳板链、复用、陈旧链重试）与
// worker 的 streamExecCommand（stdout 字节流实时回传 + maxBytes 中止）。
import { originAllowed } from './origin.mjs';
import { savedServers, executeSavedStream } from './operations.mjs';

const MAX_BATCH_SERVERS = 20;
const MAX_PARALLEL = 8;
const MAX_COMMAND_LENGTH = 8000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 每机 stdout 上限，超出由 streamExecCommand 强制中止
const MAX_STDERR_CHARS = 4096;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 600;
const DEFAULT_TIMEOUT_S = 120;

const BAD_REQUEST = (message) => Response.json({ error: message }, { status: 400 });

/** 与 automation-api.mjs 的 ownerUser 一致：单管理员部署下 github_id 固定 '-1'。 */
function ownerUser(user) {
  return { identity: { github_id: String(user.github_id), user_id: user.id } };
}

export function createBatchRoutes({ env, getAuthenticatedUser, SSHSession }) {
  return async function batchRoutes(request, pathname) {
    if (pathname !== '/api/batch/exec' || request.method !== 'POST') return null;

    const user = await getAuthenticatedUser(request, env);
    if (!user) return Response.json({ error: 'Authentication required' }, { status: 401 });
    // 与主路由一致的 CSRF 规则：隧道（localhost）与反代（XFH）访问放行。
    if (!originAllowed(request.headers.get('Origin'), request.headers.get('Host'), request.headers.get('X-Forwarded-Host'), env.BASE_URL)) {
      return Response.json({ error: 'Invalid origin' }, { status: 403 });
    }

    let body;
    try { body = await request.json(); } catch { return BAD_REQUEST('Invalid JSON body'); }
    const rawIds = Array.isArray(body?.server_ids) ? body.server_ids : [];
    const serverIds = [...new Set(rawIds)];
    if (!serverIds.length || serverIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      return BAD_REQUEST('server_ids must be a non-empty array of server ids');
    }
    if (serverIds.length > MAX_BATCH_SERVERS) {
      return BAD_REQUEST(`At most ${MAX_BATCH_SERVERS} servers per run`);
    }
    const command = typeof body?.command === 'string' ? body.command.trim() : '';
    if (!command) return BAD_REQUEST('Command is required');
    if (command.length > MAX_COMMAND_LENGTH) return BAD_REQUEST(`Command exceeds ${MAX_COMMAND_LENGTH} characters`);
    let timeoutS = Number(body?.timeout);
    if (body?.timeout !== undefined && !Number.isFinite(timeoutS)) return BAD_REQUEST('timeout must be a number of seconds');
    if (!Number.isFinite(timeoutS)) timeoutS = DEFAULT_TIMEOUT_S;
    timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.floor(timeoutS)));

    const owned = await savedServers(env, { github_id: String(user.github_id), user_id: user.id });
    const unknown = serverIds.filter((id) => !owned.some((item) => item.id === id));
    if (unknown.length) return Response.json({ error: `Unknown server ids: ${unknown.join(', ')}` }, { status: 404 });
    if (!owned.some((item) => serverIds.includes(item.id) && item.host)) return BAD_REQUEST('Server entries lack host');

    const { identity } = ownerUser(user);
    const nameById = new Map(owned.map((item) => [item.id, item.name || `${item.host}`]));
    const timeoutMs = timeoutS * 1000;
    const requestSignal = request.signal;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let clientGone = false;
        const onAbort = () => { clientGone = true; };
        if (requestSignal) {
          if (requestSignal.aborted) clientGone = true;
          else requestSignal.addEventListener('abort', onAbort, { once: true });
        }
        const send = (payload) => {
          if (clientGone) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); }
          catch { clientGone = true; }
        };

        send({ type: 'run_start', total: serverIds.length });
        let cursor = 0;
        let finished = 0;
        const runOne = async (serverId) => {
          const started = Date.now();
          send({ type: 'server_start', server_id: serverId, name: nameById.get(serverId) ?? String(serverId) });
          // 每机独立解码器：UTF-8 序列可能被块边界切开，必须用流式解码。
          const decoder = new TextDecoder('utf-8', { fatal: false });
          let deliveredBytes = 0;
          try {
            const result = await executeSavedStream(env, identity, serverId, command, {
              timeout: timeoutMs,
              signal: requestSignal,
              maxBytes: MAX_OUTPUT_BYTES,
              onChunk: (data) => {
                deliveredBytes += data.length;
                const text = decoder.decode(data, { stream: true });
                if (text) send({ type: 'output', server_id: serverId, text });
              },
            }, SSHSession);
            const tail = decoder.decode();
            if (tail) send({ type: 'output', server_id: serverId, text: tail });
            send({
              type: 'server_done', server_id: serverId,
              exit_code: result.exitCode, bytes: deliveredBytes,
              truncated: !!result.truncated,
              stderr: String(result.stderr || '').slice(0, MAX_STDERR_CHARS),
              duration_ms: Date.now() - started,
            });
          } catch (caught) {
            const message = requestSignal?.aborted || clientGone
              ? 'Cancelled'
              : String(caught?.message || caught).slice(0, 300);
            send({ type: 'server_error', server_id: serverId, message, duration_ms: Date.now() - started });
          } finally {
            finished++;
          }
        };
        const worker = async () => {
          while (!clientGone) {
            const serverId = serverIds[cursor++];
            if (serverId === undefined) return;
            await runOne(serverId);
          }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, serverIds.length) }, worker));
        send({ type: 'run_done', completed: finished, requested: serverIds.length });
        if (requestSignal) requestSignal.removeEventListener('abort', onAbort);
        try { controller.close(); } catch { /* already closed */ }
      },
      cancel() {
        // 客户端取消读取（页面关闭/abort）→ requestFromNode 的 res close 已 abort signal，
        // 在途 exec 由各 runOne 的 signal 清理；这里仅标记停止排程。
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
}
