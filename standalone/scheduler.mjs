// Automation engine: cron scheduler + uptime prober, driven by AutomationStore state.
import { savedServers, executeSaved } from './operations.mjs';
import { sendToChannels } from './notify.mjs';
import { createHash } from 'node:crypto';
import { nextRun } from './cron-expr.mjs';
import { connect } from './sockets.mjs';

const CRON_TICK_MS = 20_000;
const PROBE_TICK_MS = 10_000;
const OVERDUE_SKIP_MS = 10 * 60_000;
const RUN_HISTORY_KEEP = 50;
const SAMPLE_RETAIN_MS = 3 * 24 * 3600_000;
const OUTPUT_MAX = 6000;

function briefError(error) {
  return String(error?.message || error?.cause?.message || error || 'unknown error').split('\n')[0].slice(0, 300);
}

function truncateOutput(output) {
  if (!output) return null;
  const combined = `stdout:\n${output.stdout || ''}\nstderr:\n${output.stderr || ''}`;
  return combined.length > OUTPUT_MAX
    ? `${combined.slice(0, OUTPUT_MAX / 2)}\n…\n${combined.slice(-OUTPUT_MAX / 2)}`
    : combined;
}

async function readBanner(stream, timeoutMs) {
  const reader = stream.getReader();
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSH banner timed out')), timeoutMs)),
    ]).then((chunk) => Buffer.from(chunk.value || '').toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

/** TCP connect + SSH banner probe; no authentication, so probes cannot trip fail2ban. */
export async function probeServer({ host, port }, now = () => Date.now()) {
  const start = now();
  let socket;
  try {
    socket = connect({ hostname: host, port });
    await socket.opened;
    const banner = await readBanner(socket.readable, 5000);
    return banner.startsWith('SSH-')
      ? { ok: true, latencyMs: now() - start }
      : { ok: false, latencyMs: now() - start, error: `unexpected banner: ${banner.slice(0, 40)}` };
  } catch (error) {
    return { ok: false, latencyMs: now() - start, error: briefError(error) };
  } finally {
    try { socket?.close(); } catch { /* already closed */ }
  }
}

export class AutomationEngine {
  constructor({
    store, env, SSHSession,
    execute = executeSaved,
    notify = sendToChannels,
    probe = probeServer,
    log = () => {},
    now = () => Date.now(),
  } = {}) {
    this.store = store;
    this.env = env;
    this.SSHSession = SSHSession;
    this.execute = execute;
    this.notify = notify;
    this.probe = probe;
    this.log = log;
    this.now = now;
    this.timers = [];
    this.runningTasks = new Set();
    this.probing = new Set();
    this.serverCache = new Map(); // owner -> { fetchedAt, servers }
    this.serverCacheTtlMs = 60_000;
  }

  start() {
    this.rescheduleMissedTasks();
    this.timers.push(setInterval(() => { void this.cronTick(); }, CRON_TICK_MS));
    this.timers.push(setInterval(() => { void this.probeTick(); }, PROBE_TICK_MS));
    this.pruneTimer = setInterval(() => {
      try { this.store.pruneSamples(SAMPLE_RETAIN_MS); } catch (error) { this.log(`sample prune failed: ${briefError(error)}`); }
    }, 3600_000);
    this.pruneTimer.unref?.();
    void this.cronTick();
    void this.probeTick();
  }

  stop() {
    [...this.timers, this.pruneTimer].forEach((timer) => timer && clearInterval(timer));
    this.timers = [];
    this.pruneTimer = null;
  }

  /** On boot: skip runs missed while the panel was down; refresh schedules for recurring expressions. */
  rescheduleMissedTasks() {
    const now = this.now();
    for (const task of this.store.allTasks()) {
      if (!task.enabled) continue;
      if (task.next_run_at === null || task.next_run_at === undefined || task.next_run_at < now - OVERDUE_SKIP_MS) {
        const nextAt = nextRun(task.cron_expr, new Date(now))?.getTime() ?? null;
        this.store.updateTaskSchedule(task.id, { next_run_at: nextAt });
      }
    }
  }

  async cronTick() {
    const now = this.now();
    for (const task of this.store.dueTasks(now)) {
      if (this.runningTasks.has(task.id)) continue;
      this.runningTasks.add(task.id);
      const nextAt = nextRun(task.cron_expr, new Date(now))?.getTime() ?? null;
      // Advance the schedule before executing: a crash mid-run loses that run instead of re-running it.
      this.store.updateTaskSchedule(task.id, { next_run_at: nextAt });
      if (now - task.next_run_at > OVERDUE_SKIP_MS) {
        this.runningTasks.delete(task.id);
        continue;
      }
      void this.runTask(task, { trigger: 'schedule' }).finally(() => this.runningTasks.delete(task.id));
    }
  }

  async runTask(task, { trigger = 'manual' } = {}) {
    const startedAt = this.now();
    const runId = this.store.recordRun(task, { started_at: startedAt, trigger });
    let ok = false;
    let output = null;
    let error = null;
    try {
      output = await this.execute(this.env, { github_id: task.github_id, user_id: task.user_id },
        task.server_id, task.command, task.timeout_seconds * 1000, this.SSHSession);
      ok = output.exitCode === 0;
    } catch (caught) {
      error = briefError(caught);
    }
    const storedOutput = truncateOutput(output);
    this.store.finishRun(runId, {
      finished_at: this.now(),
      status: ok ? 'succeeded' : 'failed',
      exit_code: output?.exitCode ?? null,
      duration_ms: this.now() - startedAt,
      error,
      output: storedOutput,
    });
    // Output-change detection hashes the exact truncated snapshot stored in
    // cron_runs, so notifications always match what the history page shows.
    // The first successful run only establishes the baseline; failed runs keep
    // the previous baseline so recovery does not silently reset it.
    const outputSha = ok && storedOutput !== null
      ? createHash('sha256').update(storedOutput).digest('hex') : null;
    this.store.updateTaskStatus(task.id, {
      last_run_at: startedAt, last_status: ok ? 'succeeded' : 'failed',
      ...(outputSha !== null ? { last_output_sha: outputSha } : {}),
    });
    this.store.pruneRuns(task.id, RUN_HISTORY_KEEP);
    if (!ok && task.notify_on_failure) await this.notifyTaskFailure(task, { error, output });
    if (ok && task.notify_on_change && task.last_output_sha && outputSha && task.last_output_sha !== outputSha) {
      await this.notifyTaskOutputChange(task, output);
    }
    return { ok, error, output };
  }

  async notifyTaskFailure(task, { error, output }) {
    const channels = this.store.listChannels(task.owner, { enabledOnly: true });
    if (!channels.length) return [];
    const serverName = await this.serverName(task.owner, { github_id: task.github_id, user_id: task.user_id }, task.server_id);
    const detail = [error ? `Error: ${error}` : `Exit code: ${output?.exitCode}`,
      output?.stderr || output?.stdout || ''].join('\n').slice(0, 1500);
    const body = [
      `Task: ${task.name}`,
      `Server: ${serverName} (#${task.server_id})`,
      detail,
      `Time: ${new Date(this.now()).toLocaleString()}`,
    ].filter(Boolean).join('\n');
    return await this.notify(channels, { title: `⏰ CloudSSH task failed: ${task.name}`, body });
  }

  async notifyTaskOutputChange(task, output) {
    const channels = this.store.listChannels(task.owner, { enabledOnly: true });
    if (!channels.length) return [];
    const serverName = await this.serverName(task.owner, { github_id: task.github_id, user_id: task.user_id }, task.server_id);
    const detail = (output?.stderr || output?.stdout || '').slice(0, 1500);
    const body = [
      `Task: ${task.name}`,
      `Server: ${serverName} (#${task.server_id})`,
      detail,
      `Time: ${new Date(this.now()).toLocaleString()}`,
    ].filter(Boolean).join('\n');
    return await this.notify(channels, { title: `🔄 CloudSSH task output changed: ${task.name}`, body });
  }

  async ownerServers(owner, identity) {
    const cached = this.serverCache.get(owner);
    if (cached && this.now() - cached.fetchedAt < this.serverCacheTtlMs) return cached.servers;
    const servers = await savedServers(this.env, identity);
    this.serverCache.set(owner, { fetchedAt: this.now(), servers });
    return servers;
  }

  async serverName(owner, identity, serverId) {
    try {
      const servers = await this.ownerServers(owner, identity);
      return servers.find((server) => server.id === serverId)?.name || `#${serverId}`;
    } catch {
      return `#${serverId}`;
    }
  }

  async probeTick() {
    const now = this.now();
    for (const config of this.store.dueMonitors(now)) {
      const key = `${config.owner}:${config.server_id}`;
      if (this.probing.has(key)) continue;
      this.probing.add(key);
      void this.probeOne(config).finally(() => this.probing.delete(key));
    }
  }

  async probeOne(config) {
    const now = this.now();
    const identity = { github_id: config.github_id, user_id: config.user_id };
    let server = null;
    try {
      const servers = await this.ownerServers(config.owner, identity);
      server = servers.find((item) => item.id === config.server_id) || null;
    } catch (error) {
      this.log(`monitor server list failed: ${briefError(error)}`);
    }
    if (!server) {
      this.store.updateMonitorState(config.owner, config.server_id, {
        status: config.status || 'unknown',
        consecutive_failures: config.consecutive_failures || 0,
        last_probe_at: now,
        last_latency_ms: null,
        last_error: 'server not found',
        next_probe_at: now + 3600_000,
        notified_status: config.notified_status ?? null,
      });
      return;
    }
    if (server.transport_type !== 'direct' || server.jump_server_id) {
      this.store.updateMonitorState(config.owner, config.server_id, {
        status: config.status || 'unknown',
        consecutive_failures: config.consecutive_failures || 0,
        last_probe_at: now,
        last_latency_ms: null,
        last_error: 'monitoring requires a direct (non-jump, non-tunnel) connection',
        next_probe_at: now + 3600_000,
        notified_status: config.notified_status ?? null,
      });
      return;
    }
    const result = await this.probe(server, this.now);
    const intervalMs = config.interval_seconds * 1000;
    const failures = result.ok ? 0 : (config.consecutive_failures || 0) + 1;
    const wasStatus = config.status || 'unknown';
    const isDown = !result.ok && failures >= config.failure_threshold;
    const newStatus = result.ok ? 'up' : isDown ? 'down' : wasStatus === 'down' ? 'degraded' : wasStatus;
    this.store.insertSample(config.owner, config.server_id, { ts: now, ok: result.ok, latency_ms: result.latencyMs });
    this.store.updateMonitorState(config.owner, config.server_id, {
      status: newStatus,
      consecutive_failures: failures,
      last_probe_at: now,
      last_latency_ms: result.ok ? result.latencyMs : null,
      last_error: result.ok ? null : result.error,
      next_probe_at: now + intervalMs,
      notified_status: config.notified_status ?? null,
    });
    if (isDown && config.notified_status !== 'down') {
      await this.dispatchMonitorNotification(config, server, {
        title: `⚠️ CloudSSH server unreachable: ${server.name}`,
        body: [
          `${server.host}:${server.port} failed ${failures} consecutive probes`,
          `Error: ${result.error}`,
          `Time: ${new Date(now).toLocaleString()}`,
        ].join('\n'),
      }, 'down');
    } else if (result.ok && config.notified_status === 'down') {
      await this.dispatchMonitorNotification(config, server, {
        title: `✅ CloudSSH server recovered: ${server.name}`,
        body: [
          `${server.host}:${server.port} is reachable again (${result.latencyMs}ms)`,
          `Time: ${new Date(now).toLocaleString()}`,
        ].join('\n'),
      }, 'up');
    }
  }

  async dispatchMonitorNotification(config, server, message, notifiedStatus) {
    const channels = this.store.listChannels(config.owner, { enabledOnly: true });
    try {
      if (channels.length) await this.notify(channels, message);
    } catch (error) {
      this.log(`monitor notify failed: ${briefError(error)}`);
    }
    this.store.updateMonitorNotified(config.owner, server.id, notifiedStatus);
  }
}
