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
