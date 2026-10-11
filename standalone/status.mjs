// On-demand server status collection for the self-hosted panel. A single POSIX
// shell script runs over the saved SSH credential (executeSaved, jump chains
// supported) and emits tagged markers; parseStatusOutput turns them into the
// JSON shape consumed by the frontend status dialog.

// One exec, two samples of /proc/stat and /proc/net/dev separated by sleep 1 so
// CPU usage and network rates can be derived from deltas. Lines are joined as
// single-quoted JS strings on purpose: shell $(...) and $VAR must never be
// touched by JS template interpolation.
const STATUS_SCRIPT_LINES = [
  'echo "HOSTNAME:$(hostname 2>/dev/null || uname -n 2>/dev/null)"',
  'echo "UPTIME:$(cut -d" " -f1 /proc/uptime 2>/dev/null)"',
  'echo "LOADAVG:$(cat /proc/loadavg 2>/dev/null)"',
  'echo "MEMINFO:$(grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null | tr "\\n" ";")"',
  'echo "DISK:$(df -B1 -P / 2>/dev/null | tail -n 1)"',
  'echo "CPUCORES:$(grep -c "^processor" /proc/cpuinfo 2>/dev/null)"',
  'echo "CPUMODEL:$(grep -m1 -E "model name|^Model[[:space:]]*:" /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed "s/^[[:space:]]*//")"',
  'echo "OSRELEASE:$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"',
  'echo "UNAME:$(uname -sr 2>/dev/null)"',
  'echo "ARCH:$(uname -m 2>/dev/null)"',
  'echo "STAT1:$(grep "^cpu " /proc/stat 2>/dev/null)"',
  'echo "NET1:$(cat /proc/net/dev 2>/dev/null)"',
  'sleep 1',
  'echo "STAT2:$(grep "^cpu " /proc/stat 2>/dev/null)"',
  'echo "NET2:$(cat /proc/net/dev 2>/dev/null)"',
  'echo "UPTIME2:$(cut -d" " -f1 /proc/uptime 2>/dev/null)"',
  'exit 0',
];

export function buildStatusScript() {
  return STATUS_SCRIPT_LINES.join('\n');
}

const MARKERS = ['HOSTNAME', 'UPTIME', 'LOADAVG', 'MEMINFO', 'DISK', 'CPUCORES', 'CPUMODEL', 'OSRELEASE', 'UNAME', 'ARCH', 'STAT1', 'NET1', 'STAT2', 'NET2', 'UPTIME2'];

// Marker values may themselves be multi-line (NET1/NET2 contain the whole
// /proc/net/dev table), so continuation lines append to the previous marker.
function splitMarkers(stdout) {
  const fields = {};
  let current = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9]+):(.*)$/);
    if (match && MARKERS.includes(match[1])) {
      current = match[1];
      fields[current] = match[2];
    } else if (current && line !== '') {
      fields[current] += `\n${line}`;
    }
  }
  return fields;
}

function parseCpuLine(value) {
  if (!value) return null;
  const numbers = value.trim().split(/\s+/).slice(1).map(Number);
  if (numbers.length < 5 || numbers.some((item) => !Number.isFinite(item))) return null;
  // user nice system idle iowait irq softirq steal guest guest_nice
  const total = numbers.slice(0, 8).reduce((sum, item) => sum + item, 0);
  const idle = numbers[3] + numbers[4];
  return { total, idle };
}

function cpuUsagePercent(sample1, sample2) {
  const a = parseCpuLine(sample1);
  const b = parseCpuLine(sample2);
  if (!a || !b) return null;
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

// Sum rx/tx bytes across physical interfaces (loopback excluded).
function networkTotals(value) {
  if (!value) return null;
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9._-]+):\s*(.*)$/);
    if (!match) continue;
    seen = true;
    if (match[1] === 'lo') continue;
    const columns = match[2].trim().split(/\s+/).map(Number);
    if (columns.length >= 10 && Number.isFinite(columns[0]) && Number.isFinite(columns[8])) {
      rx += columns[0];
      tx += columns[8];
    }
  }
  return seen ? { rx, tx } : null;
}

function meminfoValue(fields, key) {
  const match = fields.MEMINFO?.match(new RegExp(`(?:^|;)${key}:\\s*(\\d+) kB`));
  return match ? Number(match[1]) * 1024 : null;
}

function parseDisk(fields) {
  const parts = (fields.DISK || '').trim().split(/\s+/);
  if (parts.length < 6) return null;
  const total = Number(parts[1]);
  const used = Number(parts[2]);
  const available = Number(parts[3]);
  const percent = Number(String(parts[4]).replace(/%$/, ''));
  if (![total, used, available, percent].every(Number.isFinite)) return null;
  return { total_bytes: total, used_bytes: used, available_bytes: available, usage_percent: percent };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function parseStatusOutput(stdout) {
  const fields = splitMarkers(stdout);
  if (!fields.UPTIME && !fields.STAT1 && !fields.MEMINFO) {
    throw new Error('Status output did not contain any recognizable markers');
  }

  const hostname = fields.HOSTNAME?.trim() || null;
  const uptimeSeconds = Number(fields.UPTIME);
  const uptime = Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0 ? Math.floor(uptimeSeconds) : null;

  const loadavg = (fields.LOADAVG || '').trim().split(/\s+/).slice(0, 3).map(Number);
  const load = loadavg.length === 3 && loadavg.every(Number.isFinite) ? loadavg : null;

  const memTotal = meminfoValue(fields, 'MemTotal');
  const memAvailable = meminfoValue(fields, 'MemAvailable');
  let memory = null;
  if (memTotal !== null && memAvailable !== null) {
    const used = Math.max(0, memTotal - memAvailable);
    memory = { total_bytes: memTotal, used_bytes: used, usage_percent: memTotal > 0 ? round((used / memTotal) * 100, 1) : null };
  }
  const swapTotal = meminfoValue(fields, 'SwapTotal');
  const swapFree = meminfoValue(fields, 'SwapFree');
  let swap = null;
  if (swapTotal !== null && swapFree !== null) {
    const used = Math.max(0, swapTotal - swapFree);
    swap = { total_bytes: swapTotal, used_bytes: used, usage_percent: swapTotal > 0 ? round((used / swapTotal) * 100, 1) : 0 };
  }

  const cores = Number(fields.CPUCORES);
  const cpuModel = fields.CPUMODEL?.trim() || null;
  const cpuUsage = cpuUsagePercent(fields.STAT1, fields.STAT2);

  // Elapsed between samples comes from /proc/uptime deltas (second resolution
  // is enough because the script sleeps a full second between samples).
  const uptime2 = Number(fields.UPTIME2);
  let elapsed = Number.isFinite(uptime2) && Number.isFinite(uptimeSeconds) ? uptime2 - uptimeSeconds : 0;
  if (!Number.isFinite(elapsed) || elapsed < 0.2) elapsed = 1;

  const net1 = networkTotals(fields.NET1);
  const net2 = networkTotals(fields.NET2);
  let network = null;
  if (net1 && net2) {
    network = {
      rx_bytes_per_sec: Math.max(0, Math.round((net2.rx - net1.rx) / elapsed)),
      tx_bytes_per_sec: Math.max(0, Math.round((net2.tx - net1.tx) / elapsed)),
    };
  }

  const os = fields.OSRELEASE?.trim() || fields.UNAME?.trim() || null;
  const arch = fields.ARCH?.trim() || null;

  return {
    hostname,
    uptime_seconds: uptime,
    cpu: {
      cores: Number.isFinite(cores) && cores > 0 ? cores : null,
      model: cpuModel,
      usage_percent: cpuUsage === null ? null : round(cpuUsage, 1),
      loadavg: load,
    },
    memory,
    swap,
    disk: parseDisk(fields),
    network,
    os: os ? `${os}${arch ? ` ${arch}` : ''}` : null,
    collected_at: new Date().toISOString(),
  };
}

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
