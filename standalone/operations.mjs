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

/** Each call owns its full SSH chain and closes every socket on any outcome. */
export async function executeSaved(env, identity, serverId, command, timeout, SSHSession, authorize = () => {}, signal) {
  const config = await connectionConfig(env, identity, serverId);
  const nodes = [...(config.jumpHosts || []), config];
  if (nodes.some((node) => !node.expectedFingerprint)) {
    throw new Error('Connect through the panel first and verify the host fingerprint for every hop');
  }
  const sessions = [];
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    for (const session of sessions.slice().reverse()) session.close(true);
    transport?.close();
  };
  const timer = setTimeout(cancel, timeout + 20000);
  signal?.addEventListener('abort', cancel, { once: true });
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
    await transport.opened;
    for (let i = 0; i < nodes.length; i++) {
      if (controller.signal.aborted) throw new Error('SSH connection timed out');
      const session = new SSHSession(sink, transport, nodes[i], true, false,
        undefined, env, config.userId, config.githubId, {
          openShellOnAuth: false, ownsWebSocket: false,
          allowKeyboardInteractive: false, idleTimeoutMs: 0,
        });
      sessions.push(session);
      await session.startHandshake();
      try { await session.waitUntilAuthenticated(); } catch { throw new Error(sshError || 'SSH authentication failed'); }
      if (i < nodes.length - 1) transport = await session.openDirectTcpip(nodes[i + 1].host, nodes[i + 1].port);
    }
    authorize(); // Recheck expiry/revocation after authentication, before dispatch.
    return await sessions.at(-1).executeHeadlessCommand(command, timeout, controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    for (const session of sessions.reverse()) session.close(true);
    transport?.close();
  }
}
