// Always-on server status sampling for the terminal status bar (self-hosted only).
//
// Why a hub instead of polling: the status bar must show live metrics without
// the user opening anything, and it must not cost one full SSH chain per
// viewer. One sampler runs per (owner, server) while at least one subscriber
// is attached, reusing the pooled chain from operations.mjs, and every viewer
// is served from the same in-memory frame plus the frames that follow.
//
// Cost control (this runs on the *server* being watched, often a 1-core VPS):
// - the regular tick is a pure /proc read (no `df`, no `hostname`, no `sleep`);
//   CPU and network rates are differenced against the previous tick, so we do
//   not pay the one-shot script's in-shell `sleep 1` every few seconds;
// - process-spawning facts (hostname, disk, OS, CPU model) refresh every
//   SLOW_REFRESH_TICKS ticks;
// - sampling stops IDLE_TTL_MS after the last viewer detaches, and the chain
//   goes back to the shared pool instead of being held.
import {
  buildLiveTickScript,
  buildLiveFirstFrameScript,
  buildLiveSlowRefreshScript,
  splitMarkers,
  parseCheapFields,
  parseSlowFields,
  parseRateFields,
} from './status-script.mjs';

export const DEFAULT_INTERVAL_MS = 3000;
export const MIN_INTERVAL_MS = 2000;
export const MAX_INTERVAL_MS = 10000;
const SLOW_REFRESH_TICKS = 10; // ~30s at the default interval
const IDLE_TTL_MS = 20000;const COMMAND_TIMEOUT_MS = 12000;
const MAX_SESSIONS_PER_OWNER = 6;
const MAX_SESSIONS = 48;
const MAX_CONSECUTIVE_FAILURES = 4;
// A long-poll viewer holds its request open for at most one refresh interval;
// the frontend reconnects immediately after each answer. This keeps the
// transport within any intermediate proxy's idle timeout while still giving
// push-like latency.
const LONG_POLL_TIMEOUT_MS = 15000;
const SSE_HEARTBEAT_MS = 15000;

/** Failures the user cannot fix by waiting: stop the stream instead of retrying. */
const FATAL_PATTERN = /fingerprint|authentication|access denied|unknown server|permission denied|not found/i;

export function clampInterval(value, floorMs = MIN_INTERVAL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(floorMs, DEFAULT_INTERVAL_MS);
  return Math.min(MAX_INTERVAL_MS, Math.max(floorMs, Math.round(parsed)));
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class LiveStatusSession {
  constructor(hub, { owner, identity, serverId, intervalMs }) {
    this.hub = hub;
    this.owner = owner;
    this.identity = identity;
    this.serverId = serverId;
    this.key = `${owner}:${serverId}`;
    this.intervalMs = intervalMs;
    this.idleTtlMs = hub.idleTtlMs ?? IDLE_TTL_MS;
    this.frames = null; // last good frame, replayed instantly to new viewers
    this.error = null;
    this.latencyMs = null;
    // Keyed by a per-attachment token rather than by the callback identity:
    // two transports that happen to pass an equivalent function are still two
    // independent viewers.
    this.subscribers = new Map();
    this.nextSubscriberToken = 1;
    // Transports that must be released when the sampler reaches a terminal
    // state (SSE has to flush a final frame and close, a long poll does not
    // care because it already answered).
    this.closeListeners = new Set();
    this.stopped = false;
    this.running = false;
    this.idleTimer = null;
    this.controller = null;
    this.consecutiveFailures = 0;
    this.slow = null;
    this.rates = null;
    this.tick = 0;
    this.startedAt = Date.now();
  }

  /**
   * Attaches a delivery callback (one per transport/viewer) and returns its
   * unsubscribe function. Sampling starts with the first attachment and is torn
   * down once the last one leaves.
   */
  attachSubscriber(callback) {
    const token = this.nextSubscriberToken++;
    this.subscribers.set(token, callback);
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const unsubscribe = () => {
      if (!this.subscribers.delete(token)) return;
      if (this.subscribers.size === 0) this.scheduleIdleStop();
    };
    if (!this.running) void this.run();
    return unsubscribe;
  }

  get clientCount() {
    return this.subscribers.size;
  }

  /** The frame a viewer should render right now (last good, or a failure). */
  currentFrame() {
    if (this.frames) return { ...this.frames, stale: false };
    if (this.error) return { type: 'error', server_id: this.serverId, ...this.error };
    return { type: 'pending', server_id: this.serverId, interval_ms: this.intervalMs };
  }

  /** Registers a transport teardown callback for terminal states. */
  onClose(listener) {
    if (this.stopped) {
      listener();
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Terminal state: sampling has ended and cannot resume. Subscribers are
   * dropped (after the final frame was emitted) and the hub entry is freed, so
   * a dead sampler never keeps an SSH chain or a slot alive.
   */
  terminate() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.controller?.abort();
    this.hub.remove(this);
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch { /* transport already gone */ }
    }
    this.closeListeners.clear();
    this.subscribers.clear();
  }

  scheduleIdleStop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // A viewer may have reattached (or a long poll returned) in the meantime.
      if (this.subscribers.size === 0) this.stop();
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  stop() {
    this.terminate();
  }

  emit(frame) {
    for (const [token, callback] of [...this.subscribers]) {
      try {
        callback(frame);
      } catch {
        // A broken transport must not stall the others (or leak its slot).
        this.subscribers.delete(token);
      }
    }
  }

  emitError(message, fatal) {
    this.error = { message: String(message).slice(0, 300), fatal: Boolean(fatal), at: new Date().toISOString() };
    this.emit({ type: 'error', server_id: this.serverId, ...this.error });
  }

  buildFrame(fields, latencyMs) {
    const cheap = parseCheapFields(fields);
    if (!this.slow) this.slow = parseSlowFields(fields);
    const slow = this.slow;
    const rates = parseRateFields(fields, this.rates);
    this.rates = rates.rates;
    return {
      type: 'status',
      server_id: this.serverId,
      hostname: slow.hostname ?? null,
      uptime_seconds: cheap.uptime_seconds,
      cpu: {
        cores: slow.cpu?.cores ?? null,
        model: slow.cpu?.model ?? null,
        usage_percent: rates.cpu_usage_percent,
        loadavg: cheap.loadavg,
      },
      memory: cheap.memory,
      swap: cheap.swap,
      disk: slow.disk,
      network: rates.network,
      os: slow.os ?? null,
      latency_ms: latencyMs,
      interval_ms: this.intervalMs,
      sampled_at: new Date().toISOString(),
    };
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    const { env, SSHSession, executeSaved } = this.hub;
    try {
      while (!this.stopped && this.subscribers.size > 0) {
        const first = this.tick === 0;
        const refreshSlow = first || !this.slow || this.tick % SLOW_REFRESH_TICKS === 0;
        const script = first
          ? buildLiveFirstFrameScript()
          : refreshSlow
            ? buildLiveSlowRefreshScript()
            : buildLiveTickScript();
        const startedAt = Date.now();
        let output;
        try {
          output = await executeSaved(env, this.identity, this.serverId, script, COMMAND_TIMEOUT_MS, SSHSession, undefined, this.controller.signal);
        } catch (caught) {
          if (this.stopped || this.controller.signal.aborted) break;
          this.consecutiveFailures++;
          const message = String(caught?.message || caught);
          const fatal = FATAL_PATTERN.test(message) || this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
          // A one-off blip keeps the stream (and the last known values) alive;
          // a fatal failure reports itself once and ends the sampler.
          this.emitError(message, fatal);
          if (fatal) {
            this.terminate();
            break;
          }
          await sleep(Math.min(8000, 500 * 2 ** this.consecutiveFailures));
          continue;
        }
        if (this.stopped || this.controller.signal.aborted) break;

        const latencyMs = Date.now() - startedAt;
        if (output.exitCode !== 0) {
          this.consecutiveFailures++;
          const detail = (output.stderr || output.stdout || `exit code ${output.exitCode}`).trim().split(/\r?\n/)[0].slice(0, 200);
          const fatalExit = this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
          this.emitError(`Status collection failed: ${detail}`, fatalExit);
          if (fatalExit) {
            this.terminate();
            break;
          }
          await sleep(Math.min(8000, 500 * 2 ** this.consecutiveFailures));
          continue;
        }

        try {
          const frame = this.buildFrame(splitMarkers(output.stdout || ''), latencyMs);
          this.consecutiveFailures = 0;
          this.latencyMs = latencyMs;
          this.error = null;
          this.frames = frame;
          this.emit(frame);
        } catch (caught) {
          // Unparseable output (empty markers) is a degrade, not a crash: report
          // it and keep the previous frame on screen.          this.consecutiveFailures++;
          const fatalParse = this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
          this.emitError(String(caught?.message || caught), fatalParse);
          if (fatalParse) {
            this.terminate();
            break;
          }
        }
        this.tick++;
        if (this.stopped || this.subscribers.size === 0) break;
        await sleep(this.intervalMs);
      }
    } finally {
      this.running = false;
      if (this.stopped) {
        this.hub.remove(this);
      } else if (this.subscribers.size === 0) {
        // Everyone left while a tick was in flight; honour the idle TTL so a
        // quick tab switch does not tear the SSH chain down and back up.
        this.scheduleIdleStop();
      }
    }
  }
}

/**
 * Creates the live-sampling hub. `executeSaved`/`SSHSession` are injected so
 * the hub stays testable and reuses the pooled SSH chains.
 */
export function createLiveStatusHub({ env, SSHSession, executeSaved, defaultIntervalMs = DEFAULT_INTERVAL_MS, intervalFloorMs = MIN_INTERVAL_MS, idleTtlMs = IDLE_TTL_MS }) {
  const sessions = new Map(); // `${owner}:${serverId}` → LiveStatusSession

  function remove(session) {
    if (sessions.get(session.key) === session) sessions.delete(session.key);
  }

  /** Keeps the session table bounded: idle sessions go first. */
  function evictIdle(owner) {
    const owned = [...sessions.values()].filter((session) => session.owner === owner);
    let excess = owned.length - MAX_SESSIONS_PER_OWNER;
    for (const session of owned) {
      if (excess <= 0) break;
      if (session.clientCount > 0) continue;
      session.stop();
      excess--;
    }
    while (sessions.size >= MAX_SESSIONS) {
      const victim = [...sessions.values()].find((session) => session.clientCount === 0);
      if (!victim) break;
      victim.stop();
    }
  }

  const hub = {
    env,
    SSHSession,
    executeSaved,
    defaultIntervalMs,
    idleTtlMs,
    remove,
    /**
     * Attaches a viewer to the live sampler for one owned server. The caller
     * must have already verified server ownership.
     */
    subscribe({ owner, identity, serverId, intervalMs }) {
      const key = `${owner}:${serverId}`;
      let session = sessions.get(key);
      // An interval change from the client restarts the sampler rather than
      // running a second one: only one SSH chain may exist per server.
      const wanted = clampInterval(intervalMs ?? defaultIntervalMs, intervalFloorMs);
      if (session && session.intervalMs !== wanted) {
        session.stop();
        session = undefined;
      }
      if (!session) {
        session = new LiveStatusSession(hub, { owner, identity, serverId, intervalMs: wanted });
        sessions.set(key, session);
        evictIdle(owner);
      }
      return session;
    },
    sessionCount: () => sessions.size,
    sessionsFor: (owner) => [...sessions.values()].filter((session) => session.owner === owner),

    /**
     * Transport 1: long poll. Resolves as soon as a fresh frame exists (or the
     * safety timeout expires, in which case the last known frame is resent).
     * `wait` is what makes the status bar update on its own instead of only on
     * page load; without it an idle bar would need a client-side timer.
     */
    async longPoll(session, request, { timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
      // A frame is already known (first contact, or a recovering stream): answer
      // instantly so the UI paints within one round trip.
      const immediate = session.currentFrame();
      if (immediate.type !== 'pending') return Response.json(immediate);
      const frame = await new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(value);
        };
        const timer = setTimeout(() => finish(session.currentFrame()), timeoutMs);
        timer.unref?.();
        const unsubscribe = session.attachSubscriber(finish);
        request.signal?.addEventListener('abort', () => finish(null), { once: true });
      });
      // The client navigated away: nothing to answer, and the hub must not
      // keep a subscriber for a request nobody will read.
      if (frame === null) return new Response(null, { status: 499 });
      return Response.json(frame);
    },

    /**
     * Transport 2: Server-Sent Events, for deployments where the proxy passes
     * streams through. Same frames as the long poll.
     */
    streamResponse(session, request) {
      const encoder = new TextEncoder();
      let unsubscribe = () => {};
      let unregisterClose = () => {};
      let heartbeat = null;
      const stream = new ReadableStream({
        start(controller) {
          const send = (frame) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            } catch { /* consumer vanished; close handler cleans up */ }
          };
          send(session.currentFrame());
          unsubscribe = session.attachSubscriber(send);
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch { /* closed below */ }
          }, SSE_HEARTBEAT_MS);
          heartbeat.unref?.();
          const close = () => {
            clearInterval(heartbeat);
            unsubscribe();
            try {
              controller.close();
            } catch { /* already closed */ }
          };
          request.signal?.addEventListener('abort', close, { once: true });
          // A fatal failure (untrusted fingerprint, revoked access) ends the
          // sampler: the viewer gets the error frame and the stream closes, so
          // EventSource/our own loop stops reconnecting to a dead server.
          unregisterClose = session.onClose(close);
        },
        cancel() {
          clearInterval(heartbeat);
          unsubscribe();
          unregisterClose();
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    },

    stopAll() {
      for (const session of [...sessions.values()]) session.stop();
    },

    /** /metrics 用：活跃采样会话数与订阅者数。 */
    stats() {
      let subscribers = 0;
      for (const session of sessions.values()) subscribers += session.clientCount;
      return { sessions: sessions.size, subscribers };
    },
  };
  return hub;
}
