// Server dashboard: periodic concurrent status collection for every server
// with monitoring enabled, pushed to browsers over SSE and persisted into
// monitor_samples so CPU / memory / network history has the same retention
// and storage as the existing latency-only samples.
//
// Design notes:
// - Collections run concurrently across servers but staggered per server
//   (index * STAGGER_MS) so a fleet of 30 servers does not fan out 30 SSH
//   sessions in the same millisecond, and each server keeps its own chain
//   busy for at most one collection window.
// - Failures never throw out of a tick: a server whose SSH credentials went
//   bad shows up as an error snapshot on the wall instead of stalling the
//   others. Repeated failures keep the last good metrics with a fresh error.
// - The engine owns no HTTP surface; server.mjs subscribes SSE streams and
//   automation-api.mjs reads snapshots/history. That keeps the CF Worker
//   deployment (which has no scheduler) free of dashboard routes.

import { collectServerStatus } from './status.mjs';
import { savedServers as defaultSavedServers } from './operations.mjs';

const STAGGER_MS = 2000;
const DEFAULT_INTERVAL_SECONDS = 60;

function kbps(bytesPerSec) {
  return Number.isFinite(bytesPerSec) ? Math.max(0, Math.round(bytesPerSec / 1024)) : null;
}

export class DashboardEngine {
  constructor({ env, store, executeSaved, SSHSession, now = () => Date.now(), log = () => {}, intervalSeconds, savedServers = defaultSavedServers }) {
    this.env = env;
    this.store = store;
    this.executeSaved = executeSaved;
    this.SSHSession = SSHSession;
    this.now = now;
    this.log = log;
    this.intervalSeconds = Math.max(30, Number(intervalSeconds) || DEFAULT_INTERVAL_SECONDS);
    this.savedServers = savedServers;
    /** `${owner}:${serverId}` → latest snapshot (metrics merged with lastError). */
    this.latest = new Map();
    /** owner → Set<callback(snapshot)> */
    this.subscribers = new Map();
    /** `${owner}:${serverId}` → true while a collection is in flight. */
    this.inflight = new Set();
    this.timer = null;
    this.heartbeats = new Map(); // subscriber → interval (kept by server.mjs)
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalSeconds * 1000);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.pokeTimer = null;
    this.subscribers.clear();
  }

  /**
   * Monitor configs changed — collect again soon instead of waiting a full
   * interval, so a freshly enabled server shows up on the wall in seconds.
   * Debounced: a burst of monitor edits collapses into one extra tick, and
   * per-server inflight guards make an overlapping tick harmless.
   */
  poke() {
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.tick();
    }, 1000);
    this.pokeTimer.unref?.();
  }

  /** Snapshot list for one owner, newest collection first. */
  snapshots(owner) {
    return [...this.latest.entries()]
      .filter(([key]) => key.startsWith(`${owner}:`))
      .map(([, snapshot]) => snapshot);
  }

  subscribe(owner, callback) {
    let set = this.subscribers.get(owner);
    if (!set) this.subscribers.set(owner, (set = new Set()));
    set.add(callback);
    return () => set.delete(callback);
  }

  /** All monitoring-enabled identities: one row per (owner, server). */
  monitorTargets() {
    const configs = this.store.listEnabledMonitorIdentities();
    return configs;
  }

  async tick() {
    const targets = this.monitorTargets();
    // savedServers is per (github_id, user_id); group to avoid repeat lookups.
    const serversByIdentity = new Map();
    for (const target of targets) {
      const identityKey = `${target.github_id}:${target.user_id}`;
      if (serversByIdentity.has(identityKey)) continue;
      try {
        serversByIdentity.set(identityKey, await this.savedServers(this.env, { github_id: target.github_id, user_id: target.user_id }));
      } catch (caught) {
        this.log(`dashboard: server list for user ${target.user_id} failed: ${String(caught?.message || caught).slice(0, 120)}`);
        serversByIdentity.set(identityKey, []);
      }
    }
    let index = 0;
    const jobs = [];
    for (const target of targets) {
      const servers = serversByIdentity.get(`${target.github_id}:${target.user_id}`) || [];
      const server = servers.find((item) => item.id === target.server_id);
      if (!server) continue; // server deleted but monitor config lingers
      const delay = (index++ % 25) * STAGGER_MS;
      jobs.push(this.collectAfter(target, server, delay));
    }
    await Promise.all(jobs);
  }

  collectAfter(target, server, delayMs) {
    const run = () => this.collectOne(target, server);
    if (!delayMs) return run();
    return new Promise((resolve) => setTimeout(resolve, delayMs)).then(run);
  }

  async collectOne(target, server) {
    const { owner, server_id: serverId } = target;
    const key = `${owner}:${serverId}`;
    if (this.inflight.has(key)) return; // a slow server never doubles up
    this.inflight.add(key);
    const collectedAt = new Date().toISOString();
    let snapshot;
    try {
      const identity = { github_id: target.github_id, user_id: target.user_id };
      const status = await collectServerStatus(this.env, identity, serverId, this.executeSaved, this.SSHSession);
      const mem = status.memory || {};
      snapshot = {
        server_id: serverId,
        name: server.name,
        host: server.host,
        ok: true,
        error: null,
        latency_ms: status.latency_ms,
        cpu_percent: status.cpu?.usage_percent ?? null,
        cores: status.cpu?.cores ?? null,
        load1: Array.isArray(status.cpu?.loadavg) ? status.cpu.loadavg[0] : null,
        mem_percent: mem.usage_percent ?? null,
        mem_used_bytes: mem.used_bytes ?? null,
        mem_total_bytes: mem.total_bytes ?? null,
        disk_percent: status.disk?.usage_percent ?? null,
        rx_kbps: kbps(status.network?.rx_bytes_per_sec),
        tx_kbps: kbps(status.network?.tx_bytes_per_sec),
        uptime_seconds: status.uptime_seconds ?? null,
        os: status.os || null,
        collected_at: collectedAt,
      };
    } catch (caught) {
      const previous = this.latest.get(key);
      const message = String(caught?.message || caught).slice(0, 200);
      snapshot = {
        ...(previous || { server_id: serverId, name: server.name, host: server.host }),
        server_id: serverId,
        name: server.name,
        host: server.host,
        ok: false,
        error: message,
        latency_ms: null,
        rx_kbps: null,
        tx_kbps: null,
        collected_at: collectedAt,
      };
    } finally {
      this.inflight.delete(key);
    }
    // Persist alongside probe samples: ok + latency always, metrics when known.
    try {
      this.store.insertSample(owner, serverId, {
        ts: this.now(),
        ok: snapshot.ok,
        latency_ms: snapshot.ok ? snapshot.latency_ms : null,
        cpu_percent: snapshot.ok ? snapshot.cpu_percent : null,
        mem_percent: snapshot.ok ? snapshot.mem_percent : null,
        rx_kbps: snapshot.ok ? snapshot.rx_kbps : null,
        tx_kbps: snapshot.ok ? snapshot.tx_kbps : null,
      });
    } catch (caught) {
      this.log(`dashboard: sample insert failed for ${key}: ${String(caught?.message || caught).slice(0, 120)}`);
    }
    this.latest.set(key, snapshot);
    const set = this.subscribers.get(owner);
    if (set) for (const callback of set) {
      try { callback(snapshot); } catch { /* a dead SSE client must not kill the tick */ }
    }
  }
}
