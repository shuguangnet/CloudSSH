// Standalone-only REST routes for scheduled tasks, uptime monitoring, notification
// channels and SSH keypair helpers. Mounted before worker.fetch in server.mjs.
import { savedServers } from './operations.mjs';
import { validateChannel, sendToChannels } from './notify.mjs';
import { parseCron, nextRun } from './cron-expr.mjs';
import { generateKeyPair, sanitizeComment, deployCommand, parsePublicKey } from './keys.mjs';
import { collectServerStatus } from './status.mjs';
import { listContainersScript, parseContainerLines, buildDockerAction, buildDockerLogsCommand, statsScript, parseStatsLines, imagesScript, parseImageLines, buildImageAction, performContainerUpgrade, assertValidUpgradeInput } from './docker.mjs';
import { generateVapidKeys } from './webpush.mjs';
import { originAllowed } from './origin.mjs';

const BAD_REQUEST = (message) => Response.json({ error: message }, { status: 400 });

async function readJson(request) {
  try { return await request.json(); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function ownerUser(user) {
  return { owner: String(user.github_id), identity: { github_id: String(user.github_id), user_id: user.id } };
}

export function createAutomationRoutes({ env, SSHSession, store, engine, dashboard = null, executeSaved, getAuthenticatedUser, liveStatus = null }) {
  // On-demand collections open a real SSH exec; keep at most one in flight per
  // server and space requests out so a polling UI cannot hammer it.
  const statusQueries = new Map();
  function acquireThrottledSlot(map, key, signal) {
    const now = Date.now();
    const entry = map.get(key);
    if (entry?.inflight) return { conflict: 409 };
    if (entry && now - entry.last < 1500) return { conflict: 429 };
    // Keep the pre-existing cooldown while inflight; an aborted request never
    // delivered a result, so releasing it must not push the cooldown forward
    // or the poll that replaced it gets answered with 429.
    const previousLast = entry?.last ?? 0;
    map.set(key, { last: previousLast, inflight: true });
    return {
      release() { map.set(key, { last: signal?.aborted ? previousLast : Date.now(), inflight: false }); },
    };
  }
  async function requireUser(request) {
    const user = await getAuthenticatedUser(request, env);
    if (!user) return { error: Response.json({ error: 'Authentication required' }, { status: 401 }) };
    if (request.method !== 'GET' && !originAllowed(request.headers.get('Origin'), request.headers.get('Host'), request.headers.get('X-Forwarded-Host'), env.BASE_URL)) {
      return { error: Response.json({ error: 'Invalid origin' }, { status: 403 }) };
    }
    return { user };
  }

  async function ownedServers(user) {
    return await savedServers(env, { github_id: String(user.github_id), user_id: user.id });
  }

  async function taskBody(user, body, existing) {
    const { owner, identity } = ownerUser(user);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: BAD_REQUEST('Invalid request body') };
    let cronExpr = typeof body.cron_expr === 'string' ? body.cron_expr.trim() : existing?.cron_expr;
    try { parseCron(cronExpr); } catch (error) { return { error: BAD_REQUEST(`Invalid cron expression: ${error.message}`) }; }
    const servers = await ownedServers(user);
    const serverId = body.server_id !== undefined ? body.server_id : existing?.server_id;
    if (!Number.isSafeInteger(serverId) || !servers.some((server) => server.id === serverId)) {
      return { error: BAD_REQUEST('Unknown server') };
    }
    return {
      task: {
        name: body.name, server_id: serverId, command: body.command, cron_expr: cronExpr,
        timeout_seconds: body.timeout_seconds,
        notify_on_failure: body.notify_on_failure,
        notify_on_change: typeof body.notify_on_change === 'boolean' ? body.notify_on_change : false,
        enabled: body.enabled,
      },
      owner, identity, servers, cronExpr,
    };
  }

  function taskResponse(row, servers) {
    const server = servers.find((item) => item.id === row.server_id);
    return { ...row, server_name: server?.name ?? null };
  }

  async function channelBody(request) {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid request body'), { status: 400 });
    const enabled = body.enabled !== undefined ? !!body.enabled : true;
    return { ...validateChannel(body.type, body.config ?? body.settings ?? {}), enabled };
  }

  return async function handle(request, pathname, url) {
    // ---------- config ----------
    if (pathname === '/api/automation/config' && request.method === 'GET') {
      const { error } = await requireUser(request);
      if (error) return error;
      return Response.json({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        limits: { timeout_seconds: [30, 600], interval_seconds: [60, 3600], failure_threshold: [1, 10], max_tasks: 100, max_channels: 16, sample_hours: 72 },
      });
    }

    // ---------- notification channels ----------
    if (pathname === '/api/automation/webpush/vapid' && request.method === 'GET') {
      const { error } = await requireUser(request);
      if (error) return error;
      return Response.json({ publicKey: store.getOrCreateVapid(generateVapidKeys).publicKey });
    }
    if (pathname === '/api/automation/notifications') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      if (request.method === 'GET') return Response.json({ channels: store.listChannels(owner) });
      if (request.method === 'POST') {
        let channel;
        try { channel = await channelBody(request); }
        catch (caught) { return Response.json({ error: caught.message }, { status: 400 }); }
        try { return Response.json(store.saveChannel(owner, channel), { status: 201 }); }
        catch (caught) { return Response.json({ error: caught.message }, { status: 400 }); }
      }
    }
    let match = pathname.match(/^\/api\/automation\/notifications\/(\d+)$/);
    if (match) {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      const id = Number(match[1]);
      if (request.method === 'PUT') {
        let channel;
        try { channel = await channelBody(request); }
        catch (caught) { return Response.json({ error: caught.message }, { status: 400 }); }
        try { return Response.json(store.saveChannel(owner, channel, id)); }
        catch (caught) { return Response.json({ error: caught.message }, { status: 400 }); }
      }
      if (request.method === 'DELETE') {
        return Response.json({ deleted: store.deleteChannel(owner, id) });
      }
    }
    if (pathname === '/api/automation/notifications/test' && request.method === 'POST') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      const channels = store.listChannels(owner, { enabledOnly: true });
      if (!channels.length) return Response.json({ error: 'No enabled notification channels' }, { status: 400 });
      const results = await sendToChannels(channels, {
        title: 'CloudSSH test notification',
        body: `Test from ${env.BASE_URL} at ${new Date().toLocaleString()}`,
      });
      return Response.json({ results });
    }

    // ---------- scheduled tasks ----------
    if (pathname === '/api/automation/cron') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      if (request.method === 'GET') {
        const servers = await ownedServers(user);
        return Response.json({ tasks: store.listTasks(owner).map((task) => taskResponse(task, servers)) });
      }
      if (request.method === 'POST') {
        let parsed;
        try { parsed = await taskBody(user, await readJson(request)); }
        catch (caught) { return Response.json({ error: caught.message }, { status: caught.status || 400 }); }
        if (parsed.error) return parsed.error;
        try {
          if (store.taskCount(owner) >= 100) return BAD_REQUEST('Maximum 100 tasks');
          const nextAt = parsed.task.enabled ? nextRun(parsed.cronExpr).getTime() : null;
          const { id } = store.createTask(owner, user, parsed.task, nextAt);
          return Response.json({ id }, { status: 201 });
        } catch (caught) { return Response.json({ error: caught.message }, { status: 400 }); }
      }
    }
    match = pathname.match(/^\/api\/automation\/cron\/(\d+)$/);
    if (match) {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      const id = Number(match[1]);
      const existing = store.taskById(owner, id);
      if (!existing) return Response.json({ error: 'Task not found' }, { status: 404 });
      if (request.method === 'PUT') {
        let parsed;
        try { parsed = await taskBody(user, await readJson(request), existing); }
        catch (caught) { return Response.json({ error: caught.message }, { status: caught.status || 400 }); }
        if (parsed.error) return parsed.error;
        try {
          const nextAt = parsed.task.enabled ? nextRun(parsed.cronExpr).getTime() : null;
          store.updateTask(owner, id, parsed.task, nextAt);
          return Response.json({ id });
        } catch (caught) { return Response.json({ error: caught.message }, { status: 400 }); }
      }
      if (request.method === 'DELETE') {
        return Response.json({ deleted: store.deleteTask(owner, id) });
      }
    }
    match = pathname.match(/^\/api\/automation\/cron\/(\d+)\/run$/);
    if (match && request.method === 'POST') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      const task = store.taskById(owner, Number(match[1]));
      if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
      if (engine.runningTasks.has(task.id)) return Response.json({ error: 'Task is already running' }, { status: 409 });
      const result = await engine.runTask(task, { trigger: 'manual' });
      return Response.json(result, { status: result.ok ? 200 : 500 });
    }
    match = pathname.match(/^\/api\/automation\/cron\/(\d+)\/runs$/);
    if (match && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) return BAD_REQUEST('Invalid cursor');
      return Response.json({ runs: store.listRuns(owner, Number(match[1]), before) });
    }

    // ---------- uptime monitors ----------
    if (pathname === '/api/automation/monitor' && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      const servers = await ownedServers(user);
      const monitors = store.listMonitors(owner);
      return Response.json({
        monitors: monitors.map((monitor) => ({
          ...monitor,
          server_name: servers.find((server) => server.id === monitor.server_id)?.name ?? null,
          monitorable: servers.some((server) => server.id === monitor.server_id
            && server.transport_type === 'direct' && !server.jump_server_id),
        })),
      });
    }
    match = pathname.match(/^\/api\/automation\/monitor\/(\d+)$/);
    if (match) {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner, identity } = ownerUser(user);
      const serverId = Number(match[1]);
      if (request.method === 'PUT') {
        let body;
        try { body = await readJson(request); }
        catch (caught) { return Response.json({ error: caught.message }, { status: caught.status || 400 }); }
        const interval = body?.interval_seconds;
        const threshold = body?.failure_threshold;
        if (!Number.isInteger(interval) || interval < 60 || interval > 3600) return BAD_REQUEST('Interval must be 60–3600 seconds');
        if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) return BAD_REQUEST('Failure threshold must be 1–10');
        const server = (await ownedServers(user)).find((item) => item.id === serverId);
        if (!server) return Response.json({ error: 'Unknown server' }, { status: 404 });
        if (server.transport_type !== 'direct' || server.jump_server_id) {
          return BAD_REQUEST('Monitoring requires a direct (non-jump, non-tunnel) connection');
        }
        store.saveMonitor(owner, user, serverId, { interval_seconds: interval, failure_threshold: threshold, enabled: body.enabled !== false });
        dashboard?.poke?.();
        return Response.json({ ok: true });
      }
      if (request.method === 'DELETE') {
        store.deleteMonitor(owner, serverId);
        dashboard?.poke?.();
        return Response.json({ ok: true });
      }
    }
    match = pathname.match(/^\/api\/automation\/monitor\/(\d+)\/samples$/);
    if (match && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const { owner } = ownerUser(user);
      const hours = Number(url.searchParams.get('hours') || 24);
      if (!Number.isFinite(hours) || hours < 1 || hours > 72) return BAD_REQUEST('Hours must be 1–72');
      const since = Date.now() - hours * 3600_000;
      return Response.json({ samples: store.listSamples(owner, Number(match[1]), since) });
    }

    match = pathname.match(/^\/api\/automation\/status\/(\d+)$/);
    if (match && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      const key = `${user.github_id}:${serverId}`;
      const slot = acquireThrottledSlot(statusQueries, key, request.signal);
      if (slot.conflict) return Response.json({ error: slot.conflict === 409 ? 'Status collection already in progress' : 'Too many status requests' }, { status: slot.conflict });
      try {
        const { identity } = ownerUser(user);
        const status = await collectServerStatus(env, identity, serverId, executeSaved, SSHSession, request.signal);
        return Response.json(status);
      } catch (caught) {
        return Response.json({ error: String(caught?.message || caught).slice(0, 300) }, { status: caught?.status || 500 });
      } finally {
        slot.release();
      }
    }

    // ---------- live status (terminal status bar, self-hosted only) ----------
    //
    // Two transports over one shared sampler, because the status bar must work
    // on every deployment rather than only where SSE survives the hop:
    //   GET /api/automation/status/live/:id       → one JSON frame (long-poll)
    //   GET /api/automation/status/live/:id/stream → text/event-stream
    //
    // Both share one sampler per (owner, server), so N viewers of the same
    // server cost one SSH session, and the sampling stops when the last viewer
    // detaches. Anonymous terminals are refused here (no owner, no audit trail)
    // — the frontend renders the local-only skeleton in that case.
    match = pathname.match(/^\/api\/automation\/status\/live\/(\d+)(\/stream)?$/);
    if (match && request.method === 'GET') {
      if (!liveStatus) return Response.json({ error: 'Live status requires the self-hosted deployment' }, { status: 404 });
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      const { identity } = ownerUser(user);
      const session = liveStatus.subscribe({
        owner: String(user.github_id), identity, serverId,
        intervalMs: url.searchParams.get('interval'),
      });
      if (match[2]) return liveStatus.streamResponse(session, request);
      return await liveStatus.longPoll(session, request);
    }

    // ---------- Docker container management (per saved server) ----------

    match = pathname.match(/^\/api\/docker\/(\d+)\/containers$/);
    if (match && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      const slot = acquireThrottledSlot(statusQueries, `${user.github_id}:docker:${serverId}`, request.signal);
      if (slot.conflict) return Response.json({ error: slot.conflict === 409 ? 'Docker query already in progress' : 'Too many requests' }, { status: slot.conflict });
      try {
        const { identity } = ownerUser(user);
        const output = await executeSaved(env, identity, serverId, listContainersScript(), 20000, SSHSession, undefined, request.signal);
        if (output.exitCode !== 0) {
          return Response.json({ error: (output.stderr || output.stdout || `docker ps exited with ${output.exitCode}`).trim().slice(0, 300) }, { status: 502 });
        }
        const containers = parseContainerLines(output.stdout);
        // Best-effort resource usage for the cards: a failing docker stats must
        // never break the container list itself.
        try {
          const statsOutput = await executeSaved(env, identity, serverId, statsScript(), 25000, SSHSession, undefined, request.signal);
          if (statsOutput.exitCode === 0) {
            const stats = parseStatsLines(statsOutput.stdout);
            for (const container of containers) {
              if (container.state !== 'running') continue;
              const usage = stats.get(container.name) || stats.get(container.id);
              if (usage) Object.assign(container, usage);
            }
          }
        } catch { /* stats unavailable — list still renders */ }
        return Response.json({ containers });
      } catch (caught) {
        return Response.json({ error: String(caught?.message || caught).slice(0, 300) }, { status: caught?.status || 502 });
      } finally {
        slot.release();
      }
    }

    // ---------- dashboard (standalone deployments only) ----------
    match = pathname.match(/^\/api\/dashboard\/snapshots$/);
    if (match && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      if (!dashboard) return Response.json({ error: 'Dashboard requires the self-hosted deployment' }, { status: 404 });
      return Response.json({ snapshots: dashboard.snapshots(String(user.github_id)), interval_seconds: dashboard.intervalSeconds });
    }

    match = pathname.match(/^\/api\/dashboard\/history$/);
    if (match && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      if (!dashboard) return Response.json({ error: 'Dashboard requires the self-hosted deployment' }, { status: 404 });
      const serverId = Number(url.searchParams.get('server_id'));
      const minutes = Math.min(24 * 60, Math.max(5, Number(url.searchParams.get('minutes')) || 60));
      if (!Number.isInteger(serverId) || serverId <= 0) return BAD_REQUEST('server_id is required');
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      const owner = String(user.github_id);
      return Response.json({ samples: store.listSamples(owner, serverId, Date.now() - minutes * 60_000) });
    }

    match = pathname.match(/^\/api\/docker\/(\d+)\/images$/);
    if (match && request.method === 'GET') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      const slot = acquireThrottledSlot(statusQueries, `${user.github_id}:docker-images:${serverId}`, request.signal);
      if (slot.conflict) return Response.json({ error: slot.conflict === 409 ? 'Docker query already in progress' : 'Too many requests' }, { status: slot.conflict });
      try {
        const { identity } = ownerUser(user);
        const output = await executeSaved(env, identity, serverId, imagesScript(), 20000, SSHSession, undefined, request.signal);
        if (output.exitCode !== 0) {
          return Response.json({ error: (output.stderr || output.stdout || `docker images exited with ${output.exitCode}`).trim().slice(0, 300) }, { status: 502 });
        }
        return Response.json({ images: parseImageLines(output.stdout) });
      } catch (caught) {
        return Response.json({ error: String(caught?.message || caught).slice(0, 300) }, { status: caught?.status || 502 });
      } finally {
        slot.release();
      }
    }

    match = pathname.match(/^\/api\/docker\/(\d+)\/image-action$/);
    if (match && request.method === 'POST') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      let body;
      try { body = await request.json(); } catch { return BAD_REQUEST('Invalid JSON body'); }
      let spec;
      try {
        spec = buildImageAction(body?.ref, body?.action);
      } catch (caught) {
        return BAD_REQUEST(caught.message);
      }
      try {
        const { identity } = ownerUser(user);
        const output = await executeSaved(env, identity, serverId, spec.command, spec.timeout, SSHSession);
        return Response.json({ ok: output.exitCode === 0, exit_code: output.exitCode, stdout: output.stdout, stderr: output.stderr });
      } catch (caught) {
        return Response.json({ ok: false, error: String(caught?.message || caught).slice(0, 300) }, { status: 200 });
      }
    }

    match = pathname.match(/^\/api\/docker\/(\d+)\/upgrade$/);
    if (match && request.method === 'POST') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      let body;
      try { body = await request.json(); } catch { return BAD_REQUEST('Invalid JSON body'); }
      const container = String(body?.container || '');
      const image = String(body?.image || '');
      try { assertValidUpgradeInput(container, image); } catch { return BAD_REQUEST('Invalid container or image'); }
      const slot = acquireThrottledSlot(statusQueries, `${user.github_id}:docker-upgrade:${serverId}`, request.signal);
      if (slot.conflict) return Response.json({ error: slot.conflict === 409 ? 'Docker upgrade already in progress' : 'Too many requests' }, { status: slot.conflict });
      try {
        const { identity } = ownerUser(user);
        const exec = (command, timeout) => executeSaved(env, identity, serverId, command, timeout, SSHSession, undefined, request.signal);
        const result = await performContainerUpgrade({ exec, container, image, keepBackup: Boolean(body?.keep_backup) });
        return Response.json(result, { status: result.ok ? 200 : 502 });
      } catch (caught) {
        return Response.json({ ok: false, error: String(caught?.message || caught).slice(0, 300) }, { status: 200 });
      } finally {
        slot.release();
      }
    }

    match = pathname.match(/^\/api\/docker\/(\d+)\/action$/);
    if (match && request.method === 'POST') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      let body;
      try { body = await request.json(); } catch { return BAD_REQUEST('Invalid JSON body'); }
      let spec;
      try {
        spec = buildDockerAction(body?.container, body?.action);
      } catch (caught) {
        return BAD_REQUEST(caught.message);
      }
      try {
        const { identity } = ownerUser(user);
        const output = await executeSaved(env, identity, serverId, spec.command, spec.timeout, SSHSession);
        return Response.json({ ok: output.exitCode === 0, exit_code: output.exitCode, stdout: output.stdout, stderr: output.stderr });
      } catch (caught) {
        return Response.json({ ok: false, error: String(caught?.message || caught).slice(0, 300) }, { status: 200 });
      }
    }

    match = pathname.match(/^\/api\/docker\/(\d+)\/logs$/);
    if (match && request.method === 'POST') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      const serverId = Number(match[1]);
      if (!(await ownedServers(user)).some((item) => item.id === serverId)) {
        return Response.json({ error: 'Unknown server' }, { status: 404 });
      }
      let body;
      try { body = await request.json(); } catch { return BAD_REQUEST('Invalid JSON body'); }
      let spec;
      try {
        spec = buildDockerLogsCommand(body?.container, body?.tail);
      } catch (caught) {
        return BAD_REQUEST(caught.message);
      }
      try {
        const { identity } = ownerUser(user);
        const output = await executeSaved(env, identity, serverId, spec.command, spec.timeout, SSHSession);
        if (output.exitCode !== 0) {
          return Response.json({ error: (output.stdout || `docker logs exited with ${output.exitCode}`).trim().slice(0, 300) }, { status: 502 });
        }
        return Response.json({ logs: output.stdout || '' });
      } catch (caught) {
        return Response.json({ error: String(caught?.message || caught).slice(0, 300) }, { status: caught?.status || 502 });
      }
    }

    // ---------- SSH keypair helpers ----------
    if (pathname === '/api/ssh/keys/generate' && request.method === 'POST') {
      const { error } = await requireUser(request);
      if (error) return error;
      let body;
      try { body = await readJson(request); } catch { body = {}; }
      const pair = generateKeyPair(sanitizeComment(body?.comment));
      return Response.json(pair);
    }
    if (pathname === '/api/ssh/keys/deploy' && request.method === 'POST') {
      const { error, user } = await requireUser(request);
      if (error) return error;
      let body;
      try { body = await readJson(request); }
      catch (caught) { return Response.json({ error: caught.message }, { status: caught.status || 400 }); }
      if (!Number.isSafeInteger(body?.server_id)) return BAD_REQUEST('Invalid server id');
      let command;
      try { command = deployCommand(body.public_key); }
      catch (caught) { return BAD_REQUEST(caught.message); }
      const { identity } = ownerUser(user);
      try {
        const output = await executeSaved(env, identity, body.server_id, command, 60000, SSHSession);
        return Response.json({ ok: output.exitCode === 0, exit_code: output.exitCode, stdout: output.stdout, stderr: output.stderr });
      } catch (caught) {
        return Response.json({ ok: false, error: String(caught?.message || caught).slice(0, 300) }, { status: 200 });
      }
    }

    return null;
  };
}
