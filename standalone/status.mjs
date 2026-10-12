// On-demand server status collection for the self-hosted panel. A single POSIX
// shell script runs over the saved SSH credential (executeSaved, jump chains
// supported) and emits tagged markers; parseStatusOutput turns them into the
// JSON shape consumed by the frontend status dialog.
//
// The script and the marker parsers live in status-script.mjs because the
// always-on live stream (live-status.mjs) reuses both.
import { buildStatusScript, parseStatusOutput } from './status-script.mjs';

export { buildStatusScript, parseStatusOutput };

/**
 * Runs the collection script on one saved server and returns the parsed
 * metrics plus the wall-clock latency of the whole SSH round trip.
 * `authorize` rechecks token validity inside executeSaved after SSH
 * authentication (MCP passes its revocation recheck; panel routes keep the
 * default no-op because session auth was already enforced at the route).
 */
export async function collectServerStatus(env, identity, serverId, executeSaved, SSHSession, signal, authorize = () => {}) {
  const startedAt = Date.now();
  let result;
  try {
    result = await executeSaved(env, identity, serverId, buildStatusScript(), 20000, SSHSession, authorize, signal);
  } catch (caught) {
    // SSH-layer failures (fingerprint not trusted, auth refused, timeout…)
    // are upstream problems → 502.
    throw Object.assign(new Error(`Status collection failed: ${String(caught?.message || caught).slice(0, 300)}`), { status: 502 });
  }
  const latencyMs = Date.now() - startedAt;
  if (result.exitCode !== 0) {
    const detail = (result.stderr || '').trim().split(/\r?\n/)[0] || `exit code ${result.exitCode}`;
    throw Object.assign(new Error(`Status collection failed: ${detail}`), { status: 502 });
  }
  const status = parseStatusOutput(result.stdout || '');
  return { ...status, latency_ms: latencyMs };
}
