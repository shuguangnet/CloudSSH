// Docker container management over saved SSH credentials (self-hosted only).
// Every command is built here with strict input validation so the remote shell
// never sees unvetted bytes: docker container names/IDs are limited to
// [a-zA-Z0-9][a-zA-Z0-9_.-]* by docker itself, and we re-validate before
// quoting.

export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const ACTION_COMMANDS = {
  start: 'docker start',
  stop: 'docker stop',
  restart: 'docker restart',
  remove: 'docker rm -f',
};

export const DOCKER_ACTIONS = Object.keys(ACTION_COMMANDS);

// Action timeouts in ms. stop/restart/remove include docker's default 10s
// SIGKILL grace period, so give them generous headroom.
const ACTION_TIMEOUTS_MS = { start: 30000, stop: 60000, restart: 60000, remove: 60000 };

export function listContainersScript() {
  // --no-trunc keeps full container IDs and complete port lists.
  return `docker ps -a --no-trunc --format '{{json .}}'`;
}

export function parseContainerLines(stdout) {
  const containers = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue; // Tolerate a stray warning line mixed into the output.
    }
    if (!raw || typeof raw !== 'object' || !raw.Names || !raw.ID) continue;
    containers.push({
      id: String(raw.ID),
      short_id: String(raw.ID).slice(0, 12),
      name: String(raw.Names).split(',')[0],
      image: String(raw.Image || ''),
      state: String(raw.State || ''),
      status: String(raw.Status || ''),
      running_for: String(raw.RunningFor || '').replace(/ ago$/, ''),
      ports: String(raw.Ports || ''),
      created_at: String(raw.CreatedAt || ''),
    });
  }
  return containers;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildDockerAction(container, action) {
  if (!Object.prototype.hasOwnProperty.call(ACTION_COMMANDS, action)) {
    throw new Error(`Unsupported action: ${action}`);
  }
  if (!CONTAINER_NAME_RE.test(String(container || ''))) {
    throw new Error('Invalid container name or ID');
  }
  // The regex already rejects every shell metacharacter; quoting is defense
  // in depth for the remote exec channel.
  return {
    command: `${ACTION_COMMANDS[action]} ${shellQuote(container)}`,
    timeout: ACTION_TIMEOUTS_MS[action],
  };
}

export function buildDockerLogsCommand(container, tail = 200) {
  if (!CONTAINER_NAME_RE.test(String(container || ''))) {
    throw new Error('Invalid container name or ID');
  }
  const lines = Math.floor(Number(tail));
  if (!Number.isFinite(lines) || lines < 20 || lines > 2000) {
    throw new Error('Tail must be between 20 and 2000 lines');
  }
  return { command: `docker logs --timestamps --tail ${lines} ${shellQuote(container)} 2>&1`, timeout: 20000 };
}

export function statsScript() {
  return `docker stats --no-stream --format '{{json .}}'`;
}

export function imagesScript() {
  return `docker images --no-trunc --format '{{json .}}'`;
}

export function parseImageLines(stdout) {
  const images = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    if (!raw || typeof raw !== 'object' || !raw.ID) continue;
    const repository = String(raw.Repository || '');
    const tag = String(raw.Tag || '');
    images.push({
      id: String(raw.ID),
      short_id: String(raw.ID).replace(/^sha256:/, '').slice(0, 12),
      repository,
      tag,
      dangling: repository === '<none>' || tag === '<none>',
      size: String(raw.Size || ''),
      created_since: String(raw.CreatedSince || '').replace(/ ago$/, ''),
      created_at: String(raw.CreatedAt || ''),
      containers: Number(raw.Containers || 0) || 0,
      digest: String(raw.Digest || ''),
    });
  }
  return images;
}

// Image references: registry:port/name:tag or repo@sha256:… — docker's own
// charset, re-validated here so the remote shell never sees metacharacters.
const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]{0,300}$/;

const IMAGE_ACTION_COMMANDS = {
  pull: (ref) => `docker pull ${shellQuote(ref)}`,
  remove: (ref) => `docker rmi -f ${shellQuote(ref)}`,
};

export const IMAGE_PRUNE_ACTIONS = { 'prune-dangling': 'docker image prune -f', 'prune-all': 'docker image prune -a -f' };

export function buildImageAction(ref, action) {
  if (Object.prototype.hasOwnProperty.call(IMAGE_PRUNE_ACTIONS, action)) {
    return { command: IMAGE_PRUNE_ACTIONS[action], timeout: 120000 };
  }
  if (!Object.prototype.hasOwnProperty.call(IMAGE_ACTION_COMMANDS, action)) {
    throw new Error(`Unsupported action: ${action}`);
  }
  if (typeof ref !== 'string' || !IMAGE_REF_RE.test(ref) || ref.includes('..')) {
    throw new Error('Invalid image reference');
  }
  // Pulls stream layer progress for large images; removal resolves quickly.
  return { command: IMAGE_ACTION_COMMANDS[action](ref), timeout: action === 'pull' ? 300000 : 60000 };
}

export function parseStatsLines(stdout) {
  // docker stats reports one JSON object per running container; keyed by the
  // primary name with full container ID as fallback.
  const stats = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try { raw = JSON.parse(trimmed); } catch { continue; }
    if (!raw || typeof raw !== 'object' || !raw.Name) continue;
    stats.set(String(raw.Name).replace(/^\/+/, '').split(',')[0], {
      cpu_percent: String(raw.CPUPerc || ''),
      mem_usage: String(raw.MemUsage || ''),
      mem_percent: String(raw.MemPerc || ''),
      net_io: String(raw.NetIO || ''),
      block_io: String(raw.BlockIO || ''),
    });
  }
  return stats;
}

// ==================== Container upgrade (recreate with a new image) ====================
// Watchtower-style recreate: inspect the live container, rebuild an equivalent
// `docker run` from its config, swap the image reference, and keep the old
// container around as a rollback target until the replacement proves healthy.

/** Route-level fail-fast validation for the upgrade endpoint (400 before any SSH work). */
export function assertValidUpgradeInput(container, image) {
  if (!CONTAINER_NAME_RE.test(String(container || ''))) throw new Error('Invalid container name or ID');
  if (typeof image !== 'string' || !IMAGE_REF_RE.test(image) || image.includes('..')) {
    throw new Error('Invalid image reference');
  }
}

export function inspectScript(container) {
  if (!CONTAINER_NAME_RE.test(String(container || ''))) {
    throw new Error('Invalid container name or ID');
  }
  return { command: `docker inspect ${shellQuote(container)}`, timeout: 20000 };
}

export function parseInspectOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object') {
      return parsed[0];
    }
  } catch { /* fall through */ }
  // Tolerate mixed warning lines by retrying on the outermost [ … ] window.
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      const parsed = JSON.parse(text.slice(arrStart, arrEnd + 1));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Rebuild `docker run` arguments from a `docker inspect` object. Best-effort
 * parity with watchtower: env, ports, volumes (binds + named volumes), restart
 * policy, networks, user/workdir/hostname/domainname, entrypoint, cmd, labels,
 * privileged, devices and extra hosts. Anonymous volumes and exotic runtime
 * options (resource limits, cap add/drop, healthchecks from the old config)
 * are NOT migrated — a hint in the upgrade dialog says exactly that.
 * Pure function: unit-tested without SSH.
 */
export function buildRunArgsFromInspect(inspect, newImageRef) {
  if (!inspect || typeof inspect !== 'object') throw new Error('Invalid inspect payload');
  const config = inspect.Config || {};
  const hostConfig = inspect.HostConfig || {};
  const rawName = String(inspect.Name || '').replace(/^\/+/, '');
  if (!CONTAINER_NAME_RE.test(rawName)) throw new Error('Invalid container name in inspect payload');
  if (typeof newImageRef !== 'string' || !IMAGE_REF_RE.test(newImageRef) || newImageRef.includes('..')) {
    throw new Error('Invalid image reference');
  }

  const args = ['run', '-d', '--name', rawName];

  // hostname / domainname / user / workdir
  if (config.Hostname && config.Hostname !== rawName.slice(0, 12)) args.push('--hostname', config.Hostname);
  if (config.Domainname) args.push('--domainname', config.Domainname);
  if (config.User) args.push('--user', config.User);
  if (config.WorkingDir) args.push('--workdir', config.WorkingDir);

  if (hostConfig.Privileged) args.push('--privileged');

  // environment
  for (const entry of Array.isArray(config.Env) ? config.Env : []) {
    if (typeof entry === 'string' && entry.includes('=')) args.push('-e', entry);
  }

  // labels (skip empty values object)
  const labels = config.Labels;
  if (labels && typeof labels === 'object') {
    for (const [key, value] of Object.entries(labels)) {
      args.push('-l', value === null || value === undefined ? key : `${key}=${value}`);
    }
  }

  // port bindings: "80/tcp": [{HostIp, HostPort}] → -p [ip:]host:container[/proto]
  const bindings = hostConfig.PortBindings || {};
  for (const [containerPortProto, hosts] of Object.entries(bindings)) {
    if (!Array.isArray(hosts)) continue;
    for (const binding of hosts) {
      const hostIp = String(binding?.HostIp || '').trim();
      const hostPort = String(binding?.HostPort || '').trim();
      if (!hostPort) continue; // -P style (auto-assign) cannot be reproduced faithfully
      const spec = hostIp ? `${hostIp}:${hostPort}:${containerPortProto}` : `${hostPort}:${containerPortProto}`;
      args.push('-p', spec);
    }
  }

  // volumes: binds + named volumes arrive as strings ("dest:ro", "name:dest:ro")
  for (const bind of Array.isArray(hostConfig.Binds) ? hostConfig.Binds : []) {
    if (typeof bind === 'string' && bind) args.push('-v', bind);
  }

  // devices
  for (const device of Array.isArray(hostConfig.Devices) ? hostConfig.Devices : []) {
    const source = String(device?.PathOnHost || '').trim();
    const target = String(device?.PathInContainer || '').trim();
    if (source && target) args.push('--device', `${source}:${target}`);
  }

  // extra hosts
  for (const extra of Array.isArray(hostConfig.ExtraHosts) ? hostConfig.ExtraHosts : []) {
    if (typeof extra === 'string' && extra.includes(':')) args.push('--add-host', extra);
  }

  // restart policy
  const restart = String(hostConfig.RestartPolicy?.Name || '');
  if (restart && restart !== 'no') {
    const maxRetries = Number(hostConfig.RestartPolicy?.MaximumRetryCount || 0);
    args.push('--restart', restart === 'on-failure' && maxRetries > 0 ? `on-failure:${maxRetries}` : restart);
  }

  // networks: every non-default attachment (multiple --network supported since Docker 18.03)
  const networks = inspect.NetworkSettings?.Networks;
  if (networks && typeof networks === 'object') {
    const names = Object.keys(networks).filter((name) => name && name !== 'bridge' && name !== 'default');
    for (const name of names) args.push('--network', name);
  } else if (hostConfig.NetworkMode && hostConfig.NetworkMode !== 'default' && hostConfig.NetworkMode !== 'bridge') {
    args.push('--network', hostConfig.NetworkMode);
  }

  // entrypoint: CLI --entrypoint takes a single value; a JSON array's tail
  // elements become leading command arguments (watchtower does the same).
  const entrypoint = Array.isArray(config.Entrypoint) ? config.Entrypoint.filter((part) => typeof part === 'string') : [];
  let cmd = Array.isArray(config.Cmd) ? config.Cmd.filter((part) => typeof part === 'string') : [];
  if (entrypoint.length > 0) {
    args.push('--entrypoint', entrypoint[0]);
    cmd = entrypoint.slice(1).concat(cmd);
  }

  args.push(newImageRef);
  for (const part of cmd) args.push(part);
  return args;
}

// Tokens made exclusively of these characters need no shell quoting; anything
// else (spaces, $, quotes, glob chars, newlines…) goes through shellQuote.
const SAFE_TOKEN_RE = /^[A-Za-z0-9_.:@/=-]+$/;

export function buildRunCommand(args) {
  if (!Array.isArray(args) || args.length === 0 || args[0] !== 'run') {
    throw new Error('Invalid docker run args');
  }
  return `docker ${args.map((token) => (SAFE_TOKEN_RE.test(token) ? token : shellQuote(token))).join(' ')}`;
}

export function backupNameFor(name, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  // Docker caps names at 128 chars: base + '-bak-' (5) + stamp (14) <= 128.
  const base = String(name || '').slice(0, 128 - 19).replace(/[^a-zA-Z0-9_.-]/g, '');
  const candidate = `${base}-bak-${stamp}`;
  if (!CONTAINER_NAME_RE.test(candidate)) throw new Error('Invalid backup container name');
  return candidate;
}

/**
 * Full upgrade orchestration over an injected `exec(cmd, timeoutMs)` runner
 * (the route binds it to executeSaved). Sequencing contract:
 *   1. inspect      — abort on failure (nothing touched yet)
 *   2. pull         — abort on failure (nothing touched yet)
 *   3. stop         — only when running; abort leaves container stopped only if
 *                     stop itself half-failed (docker keeps it recoverable)
 *   4. rename → <name>-bak-<stamp>
 *   5. run new      — on failure: rename backup back + start it (rollback)
 *   6. verify State.Running — not running: capture logs, rm -f the replacement,
 *                     rename backup back + start it (rollback)
 *   7. success      — remove the backup unless keepBackup was requested
 *
 * `steps` in the result is a human-readable audit trail for the dialog.
 */
export async function performContainerUpgrade({ exec, container, image, keepBackup = false }) {
  const steps = [];
  const record = (step, detail = '') => steps.push(detail ? `${step}: ${detail}` : step);

  const inspectSpec = inspectScript(container);
  const inspectOut = await exec(inspectSpec.command, inspectSpec.timeout);
  if (inspectOut.exitCode !== 0) {
    return { ok: false, step: 'inspect', error: (inspectOut.stderr || inspectOut.stdout || 'docker inspect failed').trim().slice(0, 300), steps };
  }
  const inspect = parseInspectOutput(inspectOut.stdout);
  if (!inspect) {
    return { ok: false, step: 'inspect', error: `docker inspect returned no JSON payload (stdout: ${String(inspectOut.stdout || '').trim().slice(0, 200)})`, steps };
  }
  record('inspect', `${String(inspect.Name || '').replace(/^\/+/, '')} (${String(inspect.Config?.Image || '')})`);

  const runCommand = buildRunCommand(buildRunArgsFromInspect(inspect, image));
  const backupName = backupNameFor(String(inspect.Name || '').replace(/^\/+/, ''));

  const pullSpec = buildImageAction(image, 'pull');
  record('pull', image);
  const pullOut = await exec(pullSpec.command, pullSpec.timeout);
  if (pullOut.exitCode !== 0) {
    return { ok: false, step: 'pull', error: (pullOut.stderr || pullOut.stdout || 'docker pull failed').trim().slice(0, 300), steps };
  }

  const wasRunning = String(inspect.State?.Running || '') === 'true';
  if (wasRunning) {
    record('stop', container);
    const stopOut = await exec(`docker stop ${shellQuote(container)}`, 60000);
    if (stopOut.exitCode !== 0) {
      return { ok: false, step: 'stop', error: (stopOut.stderr || stopOut.stdout || 'docker stop failed').trim().slice(0, 300), steps };
    }
  }

  record('rename', backupName);
  const renameOut = await exec(`docker rename ${shellQuote(container)} ${shellQuote(backupName)}`, 20000);
  if (renameOut.exitCode !== 0) {
    // Old container still exists under its original name — no rollback needed.
    return { ok: false, step: 'rename', error: (renameOut.stderr || renameOut.stdout || 'docker rename failed').trim().slice(0, 300), steps };
  }

  const rollback = async (reason, extraLogs = '') => {
    record('rollback', reason);
    await exec(`docker rm -f ${shellQuote(container)}`, 30000).catch(() => undefined);
    await exec(`docker rename ${shellQuote(backupName)} ${shellQuote(container)}`, 20000).catch(() => undefined);
    await exec(`docker start ${shellQuote(container)}`, 60000).catch(() => undefined);
    return { ok: false, step: 'run', rolledBack: true, error: reason, logs: extraLogs, steps, backupName };
  };

  record('run', image);
  const runOut = await exec(runCommand, 60000);
  if (runOut.exitCode !== 0) {
    return rollback((runOut.stderr || runOut.stdout || 'docker run failed').trim().slice(0, 300));
  }

  record('verify', 'State.Running');
  const verifyOut = await exec(`docker inspect -f '{{.State.Running}}' ${shellQuote(container)}`, 20000);
  const running = String(verifyOut.stdout || '').trim() === 'true';
  if (verifyOut.exitCode !== 0 || !running) {
    const logsOut = await exec(`docker logs --tail 50 ${shellQuote(container)} 2>&1`, 20000).catch(() => ({ stdout: '' }));
    return rollback('replacement container is not running', String(logsOut.stdout || '').slice(0, 4000));
  }

  let backupRemoved = false;
  if (keepBackup) {
    record('backup-kept', backupName);
  } else {
    const rmOut = await exec(`docker rm ${shellQuote(backupName)}`, 30000).catch(() => ({ exitCode: 1 }));
    backupRemoved = rmOut.exitCode === 0;
    record(backupRemoved ? 'backup-removed' : 'backup-remove-failed', backupName);
  }

  return { ok: true, steps, backupRemoved, backupName, keepBackup: Boolean(keepBackup) };
}
