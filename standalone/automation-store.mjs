// SQLite persistence for scheduled tasks, uptime monitors and notification channels.
import { DatabaseSync } from 'node:sqlite';

const TASK_NAME_MAX = 50;
const COMMAND_MAX = 4000;

export class AutomationStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cron_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL, user_id INTEGER NOT NULL, github_id TEXT NOT NULL,
        name TEXT NOT NULL, server_id INTEGER NOT NULL, command TEXT NOT NULL,
        cron_expr TEXT NOT NULL, timeout_seconds INTEGER NOT NULL DEFAULT 120,
        notify_on_failure INTEGER NOT NULL DEFAULT 1, notify_on_change INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_output_sha TEXT);
      CREATE INDEX IF NOT EXISTS cron_tasks_due ON cron_tasks(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, github_id TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'schedule', started_at INTEGER NOT NULL,
        finished_at INTEGER, status TEXT NOT NULL, exit_code INTEGER,
        duration_ms INTEGER, error TEXT, output TEXT);
      CREATE INDEX IF NOT EXISTS cron_runs_task ON cron_runs(task_id, id DESC);
      CREATE TABLE IF NOT EXISTS notify_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
        type TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS monitor_config (
        owner TEXT NOT NULL, user_id INTEGER NOT NULL, github_id TEXT NOT NULL, server_id INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL, failure_threshold INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner, server_id));
      CREATE TABLE IF NOT EXISTS monitor_state (
        owner TEXT NOT NULL, server_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown', consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_probe_at INTEGER, last_latency_ms INTEGER, last_error TEXT,
        next_probe_at INTEGER, notified_status TEXT,
        PRIMARY KEY (owner, server_id));
      CREATE TABLE IF NOT EXISTS monitor_samples (
        owner TEXT NOT NULL, server_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, latency_ms INTEGER);
      CREATE INDEX IF NOT EXISTS monitor_samples_idx ON monitor_samples(owner, server_id, ts);
    `);
    // Migrations for databases created before notify-on-change existed.
    for (const column of ['notify_on_change INTEGER NOT NULL DEFAULT 0', 'last_output_sha TEXT']) {
      try { this.db.exec(`ALTER TABLE cron_tasks ADD COLUMN ${column}`); }
      catch (error) { if (!/duplicate column/i.test(String(error))) throw error; }
    }
  }

  ownerKey(user) {
    return String(user.github_id);
  }

  // ---------- notification channels ----------
  listChannels(owner, { enabledOnly = false } = {}) {
    const rows = enabledOnly
      ? this.db.prepare('SELECT * FROM notify_channels WHERE owner=? AND enabled=1').all(owner)
      : this.db.prepare('SELECT * FROM notify_channels WHERE owner=? ORDER BY id').all(owner);
    return rows.map(({ config, ...row }) => ({ ...row, config: JSON.parse(config) }));
  }

  channelById(owner, id) {
    const row = this.db.prepare('SELECT * FROM notify_channels WHERE owner=? AND id=?').get(owner, id);
    return row ? { ...row, config: JSON.parse(row.config) } : null;
  }

  saveChannel(owner, { type, config, enabled }, existingId) {
    const now = Date.now();
    if (existingId) {
      const result = this.db.prepare('UPDATE notify_channels SET type=?, config=?, enabled=?, updated_at=? WHERE owner=? AND id=?')
        .run(type, JSON.stringify(config), enabled ? 1 : 0, now, owner, existingId);
      if (!result.changes) throw new Error('Channel not found');
      return { id: existingId };
    }
    const count = this.db.prepare('SELECT count(*) AS n FROM notify_channels WHERE owner=?').get(owner).n;
    if (count >= 16) throw new Error('Maximum 16 channels');
    const result = this.db.prepare('INSERT INTO notify_channels (owner, type, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner, type, JSON.stringify(config), enabled ? 1 : 0, now, now);
    return { id: Number(result.lastInsertRowid) };
  }

  deleteChannel(owner, id) {
    return this.db.prepare('DELETE FROM notify_channels WHERE owner=? AND id=?').run(owner, id).changes > 0;
  }

  // ---------- scheduled tasks ----------
  listTasks(owner) {
    return this.db.prepare('SELECT * FROM cron_tasks WHERE owner=? ORDER BY id').all(owner);
  }

  taskById(owner, id) {
    return this.db.prepare('SELECT * FROM cron_tasks WHERE owner=? AND id=?').get(owner, id) || null;
  }

  taskCount(owner) {
    return this.db.prepare('SELECT count(*) AS n FROM cron_tasks WHERE owner=?').get(owner).n;
  }

  createTask(owner, user, { name, server_id, command, cron_expr, timeout_seconds, notify_on_failure, notify_on_change, enabled }, nextAt) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > TASK_NAME_MAX) {
      throw new Error('Task name must be 1–50 characters');
    }
    if (typeof command !== 'string' || !command.trim() || command.length > COMMAND_MAX) {
      throw new Error('Command must be 1–4000 characters');
    }
    if (!Number.isSafeInteger(server_id) || server_id <= 0) throw new Error('Invalid server id');
    if (!Number.isInteger(timeout_seconds) || timeout_seconds < 30 || timeout_seconds > 600) {
      throw new Error('Timeout must be 30–600 seconds');
    }
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO cron_tasks
      (owner, user_id, github_id, name, server_id, command, cron_expr, timeout_seconds, notify_on_failure, notify_on_change, enabled, created_at, updated_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(owner, user.id, String(user.github_id), name.trim(), server_id, command, cron_expr,
        timeout_seconds, notify_on_failure ? 1 : 0, notify_on_change ? 1 : 0, enabled ? 1 : 0, now, now, enabled ? nextAt : null);
    return { id: Number(result.lastInsertRowid) };
  }

  updateTask(owner, id, patch, nextAt) {
    const task = this.taskById(owner, id);
    if (!task) throw new Error('Task not found');
    const merged = {
      name: patch.name !== undefined ? patch.name : task.name,
      server_id: patch.server_id !== undefined ? patch.server_id : task.server_id,
      command: patch.command !== undefined ? patch.command : task.command,
      cron_expr: patch.cron_expr !== undefined ? patch.cron_expr : task.cron_expr,
      timeout_seconds: patch.timeout_seconds !== undefined ? patch.timeout_seconds : task.timeout_seconds,
      notify_on_failure: patch.notify_on_failure !== undefined ? (patch.notify_on_failure ? 1 : 0) : task.notify_on_failure,
      notify_on_change: patch.notify_on_change !== undefined ? (patch.notify_on_change ? 1 : 0) : task.notify_on_change,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : task.enabled,
    };
    if (typeof merged.name !== 'string' || !merged.name.trim() || merged.name.trim().length > TASK_NAME_MAX) {
      throw new Error('Task name must be 1–50 characters');
    }
    if (typeof merged.command !== 'string' || !merged.command.trim() || merged.command.length > COMMAND_MAX) {
      throw new Error('Command must be 1–4000 characters');
    }
    if (!Number.isSafeInteger(merged.server_id) || merged.server_id <= 0) throw new Error('Invalid server id');
    if (!Number.isInteger(merged.timeout_seconds) || merged.timeout_seconds < 30 || merged.timeout_seconds > 600) {
      throw new Error('Timeout must be 30–600 seconds');
    }
    // Changing the command replaces the output baseline: the first run of the
    // new command establishes a fresh baseline instead of alerting on the diff.
    const resetBaseline = merged.command !== task.command;
    this.db.prepare(`UPDATE cron_tasks SET name=?, server_id=?, command=?, cron_expr=?, timeout_seconds=?,
      notify_on_failure=?, notify_on_change=?, enabled=?, updated_at=?, next_run_at=?,
      last_output_sha=${resetBaseline ? 'NULL' : 'last_output_sha'} WHERE owner=? AND id=?`)
      .run(merged.name.trim(), merged.server_id, merged.command, merged.cron_expr, merged.timeout_seconds,
        merged.notify_on_failure, merged.notify_on_change, merged.enabled, Date.now(), merged.enabled ? nextAt : null, owner, id);
    return { id };
  }

  deleteTask(owner, id) {
    if (!this.db.prepare('DELETE FROM cron_tasks WHERE owner=? AND id=?').run(owner, id).changes) return false;
    this.db.prepare('DELETE FROM cron_runs WHERE task_id=?').run(id);
    return true;
  }

  updateTaskSchedule(id, { next_run_at }) {
    this.db.prepare('UPDATE cron_tasks SET next_run_at=? WHERE id=?').run(next_run_at, id);
  }

  updateTaskStatus(id, { last_run_at, last_status, last_output_sha }) {
    if (last_output_sha === undefined) {
      this.db.prepare('UPDATE cron_tasks SET last_run_at=?, last_status=? WHERE id=?').run(last_run_at, last_status, id);
      return;
    }
    this.db.prepare('UPDATE cron_tasks SET last_run_at=?, last_status=?, last_output_sha=? WHERE id=?')
      .run(last_run_at, last_status, last_output_sha, id);
  }

  dueTasks(now) {
    return this.db.prepare('SELECT * FROM cron_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?').all(now);
  }

  allTasks() {
    return this.db.prepare('SELECT * FROM cron_tasks').all();
  }

  // ---------- run history ----------
  recordRun(task, { started_at, trigger }) {
    const result = this.db.prepare('INSERT INTO cron_runs (task_id, github_id, trigger, started_at, status) VALUES (?, ?, ?, ?, ?)')
      .run(task.id, task.github_id, trigger, started_at, 'running');
    return Number(result.lastInsertRowid);
  }

  finishRun(id, { finished_at, status, exit_code, duration_ms, error, output }) {
    this.db.prepare('UPDATE cron_runs SET finished_at=?, status=?, exit_code=?, duration_ms=?, error=?, output=? WHERE id=?')
      .run(finished_at, status, exit_code ?? null, duration_ms ?? null, error ?? null, output ?? null, id);
  }

  listRuns(owner, taskId, before = Number.MAX_SAFE_INTEGER, limit = 20) {
    return this.db.prepare(`SELECT r.* FROM cron_runs r JOIN cron_tasks t ON t.id=r.task_id
      WHERE t.owner=? AND r.task_id=? AND r.id<? ORDER BY r.id DESC LIMIT ?`)
      .all(owner, taskId, before, limit);
  }

  pruneRuns(taskId, keep = 50) {
    const cutoff = this.db.prepare('SELECT id FROM cron_runs WHERE task_id=? ORDER BY id DESC LIMIT 1 OFFSET ?')
      .get(taskId, Math.max(0, keep - 1));
    if (cutoff) this.db.prepare('DELETE FROM cron_runs WHERE task_id=? AND id<?').run(taskId, cutoff.id);
  }

  // ---------- uptime monitors ----------
  listMonitors(owner) {
    return this.db.prepare(`SELECT c.*, s.status, s.consecutive_failures, s.last_probe_at, s.last_latency_ms,
      s.last_error, s.next_probe_at, s.notified_status FROM monitor_config c
      LEFT JOIN monitor_state s ON s.owner=c.owner AND s.server_id=c.server_id
      WHERE c.owner=? ORDER BY c.server_id`).all(owner);
  }

  monitorById(owner, serverId) {
    return this.db.prepare('SELECT * FROM monitor_config WHERE owner=? AND server_id=?').get(owner, serverId) || null;
  }

  saveMonitor(owner, user, serverId, { interval_seconds, failure_threshold, enabled }) {
    const existing = this.monitorById(owner, serverId);
    const now = Date.now();
    if (existing) {
      this.db.prepare('UPDATE monitor_config SET interval_seconds=?, failure_threshold=?, enabled=?, updated_at=? WHERE owner=? AND server_id=?')
        .run(interval_seconds, failure_threshold, enabled ? 1 : 0, now, owner, serverId);
    } else {
      this.db.prepare('INSERT INTO monitor_config (owner, user_id, github_id, server_id, interval_seconds, failure_threshold, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(owner, user.id, String(user.github_id), serverId, interval_seconds, failure_threshold, enabled ? 1 : 0, now, now);
      this.db.prepare('INSERT OR IGNORE INTO monitor_state (owner, server_id, next_probe_at) VALUES (?, ?, ?)')
        .run(owner, serverId, now);
    }
    if (!enabled) {
      this.db.prepare('UPDATE monitor_state SET next_probe_at=NULL WHERE owner=? AND server_id=?').run(owner, serverId);
    } else if (!existing || !existing.enabled) {
      this.db.prepare('UPDATE monitor_state SET next_probe_at=? WHERE owner=? AND server_id=?').run(now, owner, serverId);
    }
    return { owner, server_id: serverId };
  }

  deleteMonitor(owner, serverId) {
    this.db.prepare('DELETE FROM monitor_config WHERE owner=? AND server_id=?').run(owner, serverId);
    this.db.prepare('DELETE FROM monitor_state WHERE owner=? AND server_id=?').run(owner, serverId);
    this.db.prepare('DELETE FROM monitor_samples WHERE owner=? AND server_id=?').run(owner, serverId);
  }

  dueMonitors(now) {
    return this.db.prepare(`SELECT c.owner, c.user_id, c.github_id, c.server_id, c.interval_seconds, c.failure_threshold,
      s.status, s.consecutive_failures, s.notified_status FROM monitor_config c
      JOIN monitor_state s ON s.owner=c.owner AND s.server_id=c.server_id
      WHERE c.enabled=1 AND s.next_probe_at IS NOT NULL AND s.next_probe_at<=?`).all(now);
  }

  allMonitorConfigs() {
    return this.db.prepare(`SELECT c.*, s.status, s.consecutive_failures, s.last_probe_at, s.last_latency_ms,
      s.last_error, s.next_probe_at, s.notified_status FROM monitor_config c
      LEFT JOIN monitor_state s ON s.owner=c.owner AND s.server_id=c.server_id`).all();
  }

  updateMonitorNotified(owner, serverId, notifiedStatus) {
    this.db.prepare('UPDATE monitor_state SET notified_status=? WHERE owner=? AND server_id=?')
      .run(notifiedStatus, owner, serverId);
  }

  updateMonitorState(owner, serverId, state) {
    const existing = this.db.prepare('SELECT owner FROM monitor_state WHERE owner=? AND server_id=?').get(owner, serverId);
    if (!existing) {
      this.db.prepare('INSERT INTO monitor_state (owner, server_id, status, consecutive_failures, last_probe_at, last_latency_ms, last_error, next_probe_at, notified_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(owner, serverId, state.status, state.consecutive_failures, state.last_probe_at ?? null,
          state.last_latency_ms ?? null, state.last_error ?? null, state.next_probe_at ?? null, state.notified_status ?? null);
      return;
    }
    this.db.prepare(`UPDATE monitor_state SET status=?, consecutive_failures=?, last_probe_at=?, last_latency_ms=?,
      last_error=?, next_probe_at=?, notified_status=? WHERE owner=? AND server_id=?`)
      .run(state.status, state.consecutive_failures, state.last_probe_at ?? null, state.last_latency_ms ?? null,
        state.last_error ?? null, state.next_probe_at ?? null, state.notified_status ?? null, owner, serverId);
  }

  insertSample(owner, serverId, { ts, ok, latency_ms }) {
    this.db.prepare('INSERT INTO monitor_samples (owner, server_id, ts, ok, latency_ms) VALUES (?, ?, ?, ?, ?)')
      .run(owner, serverId, ts, ok ? 1 : 0, latency_ms ?? null);
  }

  listSamples(owner, serverId, since) {
    return this.db.prepare('SELECT ts, ok, latency_ms FROM monitor_samples WHERE owner=? AND server_id=? AND ts>=? ORDER BY ts')
      .all(owner, serverId, since);
  }

  pruneSamples(retainMs) {
    this.db.prepare('DELETE FROM monitor_samples WHERE ts<?').run(Date.now() - retainMs);
  }

  close() { this.db.close(); }
}
