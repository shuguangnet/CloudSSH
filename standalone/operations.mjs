import { connect } from './sockets.mjs';

export const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
export function validatePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || /[\x00-\x1f]/.test(path)) {
    throw new Error('An absolute path without control characters is required');
  }
  return shellQuote(path);
}

export async function savedServers(env, identity) {
  const stub = env.USER_DB.get(env.USER_DB.idFromName(identity.github_id));
  const response = await stub.fetch(new Request(`http://internal/internal/servers?user_id=${identity.user_id}`));
  if (!response.ok) throw new Error('Unable to load saved servers');
  const body = await response.json();
  return body;
}

export async function connectionConfig(env, identity, serverId) {
  const stub = env.USER_DB.get(env.USER_DB.idFromName(identity.github_id));
  const response = await stub.fetch(new Request(`http://internal/internal/servers/${serverId}/connect`, {
    method: 'POST', body: JSON.stringify({ user_id: identity.user_id }),
  }));
  if (!response.ok) throw new Error('Server unavailable or access denied');
  const { token } = await response.json();
  const consumed = await stub.fetch(new Request('http://internal/internal/connect-token/consume', {
    method: 'POST', body: JSON.stringify({ token }),
  }));
  if (!consumed.ok) throw new Error('Unable to open server connection');
  return await consumed.json();
}

/*
 * Pooled persistent SSH chains (standalone only).
 *
 * executeSaved used to open a full chain (TCP → KEX → auth) for every
 * command: status/docker polling, cron runs, monitor probes and MCP exec
 * each paid 1–3s of handshake. Chains are now pooled per (owner, server)
 * and reused — each command still gets its own exec channel (RFC 4254
 * session channel), the built-in 25s keepalive keeps pooled chains warm,
 * and dead links self-close so acquire/release detect them.
 *
 * Eviction policy (conservative on purpose):
 * - any command error that is not a client abort closes the chain — a flaky
 *   connection is never reused;
 * - a stale pooled chain rejected before dispatch ("not authenticated") is
 *   retried once on a fresh chain — the command provably never ran;
 * - idle chains close after SSH_POOL_IDLE_MS (default 90s); at most
 *   SSH_POOL_MAX_IDLE (default 16) idle chains are kept.
 */
const DEFAULT_POOL_IDLE_MS = 90_000;
const DEFAULT_POOL_MAX_IDLE = 16;
const idleChainPool = new Map(); // key → { key, busy, sessions, transports, finalSession, idleTimer }

function poolIdleMs(env) {
  const value = Number(env?.SSH_POOL_IDLE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POOL_IDLE_MS;
}
function poolMaxIdle(env) {
  const value = Number(env?.SSH_POOL_MAX_IDLE);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POOL_MAX_IDLE;
}

function closeChain(entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  for (const session of entry.sessions.slice().reverse()) {
    try { session.close(true); } catch { /* already closed */ }
  }
  for (const transport of entry.transports.slice().reverse()) {
    try { transport.close(); } catch { /* already closed */ }
  }
}

function releaseChain(env, entry) {
  entry.busy = false;
  if (entry.finalSession.closed || idleChainPool.size >= poolMaxIdle(env) || idleChainPool.has(entry.key)) {
    closeChain(entry);
    return;
  }
  idleChainPool.set(entry.key, entry);
  entry.idleTimer = setTimeout(() => {
    if (idleChainPool.get(entry.key) === entry) idleChainPool.delete(entry.key);
    closeChain(entry);
  }, poolIdleMs(env));
  entry.idleTimer.unref?.();
}

/** Close every pooled chain now (graceful shutdown / tests). */
export function drainSshChainPool() {
  for (const entry of [...idleChainPool.values()]) {
    idleChainPool.delete(entry.key);
    closeChain(entry);
  }
}

async function acquireChain(env, identity, serverId, SSHSession, signal) {
  // user_id is part of the key: server ids are per-owner rows and two user
  // rows under one owner must never share each other's authenticated chain.
  const key = `${identity.github_id}:${identity.user_id}:${serverId}`;
  const pooled = idleChainPool.get(key);
  if (pooled) {
    idleChainPool.delete(key);
    clearTimeout(pooled.idleTimer);
    pooled.idleTimer = null;
    if (!pooled.busy && !pooled.finalSession.closed) {
      pooled.busy = true;
      return { entry: pooled, reused: true };
    }
    closeChain(pooled);
  }
  return { entry: await buildChain(env, identity, serverId, SSHSession, key, signal), reused: false };
}

/** Opens (and fully authenticates) one complete SSH chain; throws on failure. */
async function buildChain(env, identity, serverId, SSHSession, key, signal) {
  const config = await connectionConfig(env, identity, serverId);
  const nodes = [...(config.jumpHosts || []), config];
  if (nodes.some((node) => !node.expectedFingerprint)) {
    throw new Error('Connect through the panel first and verify the host fingerprint for every hop');
  }
  const entry = { key, busy: true, sessions: [], transports: [], finalSession: null, idleTimer: null };
  let transport;
  let sshError;
  const sink = {
    readyState: 1,
    send(data) {
      if (typeof data !== 'string') return;
      try {
        const message = JSON.parse(data);
        if (message.type === 'error') sshError = message.message;
      } catch { /* Binary terminal output is not used for MCP. */ }
    },
    close() {},
  };
  try {
    if (signal?.aborted) throw new Error('Operation cancelled');
    const outer = nodes[0];
    if (config.transportType === 'cf_tunnel') {
      if (nodes.length !== 1) throw new Error('Tunnel connections cannot use jump hosts');
      const headers = { Upgrade: 'websocket' };
      if (config.cfAccessClientId) headers['CF-Access-Client-Id'] = config.cfAccessClientId;
      if (config.cfAccessClientSecret) headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
      const response = await fetch(`https://${config.cfTunnelHost || config.host}/`, { headers, redirect: 'manual' });
      if (!response.webSocket) throw new Error(`SSH tunnel handshake rejected (HTTP ${response.status})`);
      response.webSocket.accept();
      const { TunnelWebSocketStream } = await import('../dist/worker.mjs');
      transport = new TunnelWebSocketStream(response.webSocket);
    } else {
      transport = connect({ hostname: outer.host, port: outer.port });
    }
    entry.transports.push(transport);
    await transport.opened;
    for (let i = 0; i < nodes.length; i++) {
      if (signal?.aborted) throw new Error('Operation cancelled');
      const session = new SSHSession(sink, transport, nodes[i], true, false,
        undefined, env, config.userId, config.githubId, {
          openShellOnAuth: false, ownsWebSocket: false,
          allowKeyboardInteractive: false, idleTimeoutMs: 0,
        });
      entry.sessions.push(session);
      await session.startHandshake();
      try { await session.waitUntilAuthenticated(); } catch { throw new Error(sshError || 'SSH authentication failed'); }
      if (i < nodes.length - 1) {
        transport = await session.openDirectTcpip(nodes[i + 1].host, nodes[i + 1].port);
        entry.transports.push(transport);
      }
    }
    entry.finalSession = entry.sessions.at(-1);
    return entry;
  } catch (caught) {
    closeChain(entry);
    throw caught;
  }
}

/** Runs one command on a held chain; never releases/evicts on its own. */
async function runOnChain(entry, command, timeout, signal, authorize) {
  if (signal?.aborted) throw new Error('Operation cancelled');
  // Same per-dispatch guarantee the fresh-chain code had between auth and
  // first dispatch: MCP rechecks token revocation/expiry right before exec.
  authorize();
  // Belt-and-braces: if the exec hangs past its own timeout, tear the chain
  // down like the pre-pool code did instead of leaking a zombie channel.
  const hardKill = setTimeout(() => closeChain(entry), timeout + 20000);
  hardKill.unref?.();
  try {
    return await entry.finalSession.executeHeadlessCommand(command, timeout, signal);
  } finally {
    clearTimeout(hardKill);
  }
}

/** Executes a command over a pooled-or-fresh SSH chain for one saved server. */
export async function executeSaved(env, identity, serverId, command, timeout, SSHSession, authorize = () => {}, signal) {
  const { entry, reused } = await acquireChain(env, identity, serverId, SSHSession, signal);
  let result;
  try {
    result = await runOnChain(entry, command, timeout, signal, authorize);
  } catch (caught) {
    const message = String(caught?.message || caught);
    // A pooled chain can go stale between commands (server dropped it, NAT
    // timeout…). The pre-dispatch check rejects before the command ran, so
    // retrying once on a fresh chain can never double-execute.
    if (reused && /not authenticated/i.test(message)) {
      closeChain(entry);
      const fresh = await acquireChain(env, identity, serverId, SSHSession, signal);
      try {
        const retried = await runOnChain(fresh.entry, command, timeout, signal, authorize);
        releaseChain(env, fresh.entry);
        return retried;
      } catch (second) {
        closeChain(fresh.entry);
        throw second;
      }
    }
    // A client abort only kills its own exec channel; the chain is still
    // healthy and can serve the next poll. Any other failure is chain-level
    // risk — evict so the next call reconnects.
    if (signal?.aborted) releaseChain(env, entry);
    else closeChain(entry);
    throw caught;
  }
  releaseChain(env, entry);
  return result;
}
