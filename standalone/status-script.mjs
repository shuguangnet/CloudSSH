// Shared status collection script + parsers.
//
// Two consumers:
// - status.mjs (on-demand one-shot collection behind GET /api/automation/status/:id)
// - live-status.mjs (continuous low-cost collection behind the terminal status bar)
//
// The one-shot script pays for a full POSIX probe and derives CPU/network
// rates from two /proc samples separated by `sleep 1` inside the remote shell.
// An always-on live stream cannot afford that: `sleep 1` + ~15 command
// substitutions every 3 seconds is measurable load on a 1-core VPS. The live
// stream therefore runs a *light* tick (only /proc reads, no process spawns
// beyond the readers) and derives its deltas from the previous tick, using the
// two-sample shape only for the very first frame.
//
// Script lines are single-quoted JS strings on purpose: shell $(...) and
// $PRETTY_NAME must never be touched by JS template interpolation.
const SLOW_SCRIPT_LINES = [
  'echo "HOSTNAME:$(hostname 2>/dev/null || uname -n 2>/dev/null)"',
  'echo "DISK:$(df -B1 -P / 2>/dev/null | tail -n 1)"',
  'echo "CPUCORES:$(grep -c "^processor" /proc/cpuinfo 2>/dev/null)"',
  'echo "CPUMODEL:$(grep -m1 -E "model name|^Model[[:space:]]*:" /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed "s/^[[:space:]]*//")"',
  'echo "OSRELEASE:$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"',
  'echo "UNAME:$(uname -sr 2>/dev/null)"',
  'echo "ARCH:$(uname -m 2>/dev/null)"',
];

// Everything that changes every tick and costs only /proc reads.
const CHEAP_SCRIPT_LINES = [
  'echo "UPTIME:$(cut -d" " -f1 /proc/uptime 2>/dev/null)"',
  'echo "LOADAVG:$(cat /proc/loadavg 2>/dev/null)"',
  'echo "MEMINFO:$(grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null | tr "\\n" ";")"',
];

/** First (and one-shot) sample: two /proc samples one second apart. */
const FIRST_SAMPLE_LINES = [
  'echo "STAT1:$(grep "^cpu " /proc/stat 2>/dev/null)"',
  'echo "NET1:$(cat /proc/net/dev 2>/dev/null)"',
  'echo "UPTIME1:$(cut -d" " -f1 /proc/uptime 2>/dev/null)"',
  'sleep 1',
  'echo "STAT2:$(grep "^cpu " /proc/stat 2>/dev/null)"',
  'echo "NET2:$(cat /proc/net/dev 2>/dev/null)"',
  'echo "UPTIME2:$(cut -d" " -f1 /proc/uptime 2>/dev/null)"',
];

/** Live tick: one /proc sample whose deltas come from the previous tick. */
const RATE_SAMPLE_LINES = [
  'echo "STAT1:$(grep "^cpu " /proc/stat 2>/dev/null)"',
  'echo "NET1:$(cat /proc/net/dev 2>/dev/null)"',
  'echo "UPTIME1:$(cut -d" " -f1 /proc/uptime 2>/dev/null)"',
];

export function buildSlowStatusScript() {
  return [...SLOW_SCRIPT_LINES, 'exit 0'].join('\n');
}

/** Live tick: cheap /proc fields plus one rate sample. */
export function buildLiveTickScript() {
  return [...CHEAP_SCRIPT_LINES, ...RATE_SAMPLE_LINES, 'exit 0'].join('\n');
}

/**
 * Live tick that also refreshes the rarely-changing, process-spawning facts
 * (hostname, disk, OS, CPU model). Runs every SLOW_REFRESH_TICKS ticks.
 */
export function buildLiveSlowRefreshScript() {
  return [...SLOW_SCRIPT_LINES, ...CHEAP_SCRIPT_LINES, ...RATE_SAMPLE_LINES, 'exit 0'].join('\n');
}

/** Live first frame: slow facts + cheap facts + the two-sample rate window. */
export function buildLiveFirstFrameScript() {
  return [...SLOW_SCRIPT_LINES, ...CHEAP_SCRIPT_LINES, ...FIRST_SAMPLE_LINES, 'exit 0'].join('\n');
}

export function buildStatusScript() {
  return [...SLOW_SCRIPT_LINES, ...CHEAP_SCRIPT_LINES, ...FIRST_SAMPLE_LINES, 'exit 0'].join('\n');
}

export const MARKERS = [
  'HOSTNAME', 'UPTIME', 'LOADAVG', 'MEMINFO', 'DISK', 'CPUCORES', 'CPUMODEL', 'OSRELEASE',
  'UNAME', 'ARCH', 'STAT1', 'NET1', 'UPTIME1', 'STAT2', 'NET2', 'UPTIME2',
];

// Marker values may themselves be multi-line (NET1/NET2 contain the whole
// /proc/net/dev table), so continuation lines append to the previous marker.
export function splitMarkers(stdout) {
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

/** CPU busy percentage between two /proc/stat cpu lines. */
export function cpuUsagePercent(sample1, sample2) {
  const a = parseCpuLine(sample1);
  const b = parseCpuLine(sample2);
  return cpuUsageBetween(a, b);
}

function cpuUsageBetween(a, b) {
  if (!a || !b) return null;
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}

// Sum rx/tx bytes across physical interfaces (loopback excluded).
export function networkTotals(value) {
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

/**
 * Marker values are shell output and can carry trailing noise (a folded
 * multi-line value, a stray line appended by splitMarkers). Take the leading
 * numeric token instead of failing the whole parse on it.
 */
function firstNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^\s*[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function parseUptime(fields) {
  const seconds = firstNumber(fields.UPTIME ?? fields.UPTIME1);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
}

/**
 * Fields cheap enough to refresh on every live tick (single /proc file reads):
 * memory, swap, load average and uptime.
 */
export function parseCheapFields(fields) {
  // NOTE: `fields` may carry folded multi-line values (see splitMarkers).
  const memTotal = meminfoValue(fields, 'MemTotal');
  const memAvailable = meminfoValue(fields, 'MemAvailable');
  let memory = null;
  if (memTotal !== null && memAvailable !== null) {
    const used = Math.max(0, memTotal - memAvailable);
    memory = {
      total_bytes: memTotal,
      used_bytes: used,
      usage_percent: memTotal > 0 ? round((used / memTotal) * 100, 1) : null,
    };
  }
  const swapTotal = meminfoValue(fields, 'SwapTotal');
  const swapFree = meminfoValue(fields, 'SwapFree');
  let swap = null;
  if (swapTotal !== null && swapFree !== null) {
    const used = Math.max(0, swapTotal - swapFree);
    swap = {
      total_bytes: swapTotal,
      used_bytes: used,
      usage_percent: swapTotal > 0 ? round((used / swapTotal) * 100, 1) : 0,
    };
  }
  const loadavg = (fields.LOADAVG || '').trim().split(/\s+/).slice(0, 3).map(Number);
  return {
    uptime_seconds: parseUptime(fields),
    loadavg: loadavg.length === 3 && loadavg.every(Number.isFinite) ? loadavg : null,
    memory,
    swap,
  };
}

/**
 * Fields that only change on reboot / package upgrade and that cost a process
 * spawn to read (`df`, `hostname`): refreshed rarely by the live stream.
 */
export function parseSlowFields(fields) {
  const cores = Number(fields.CPUCORES);
  const os = fields.OSRELEASE?.trim() || fields.UNAME?.trim() || null;
  const arch = fields.ARCH?.trim() || null;
  return {
    hostname: fields.HOSTNAME?.trim() || null,
    cpu: {
      cores: Number.isFinite(cores) && cores > 0 ? cores : null,
      model: fields.CPUMODEL?.trim() || null,
    },
    disk: parseDisk(fields),
    os: os ? `${os}${arch ? ` ${arch}` : ''}` : null,
    // The cheap markers ride along in the slow-refresh script so the merged
    // frame keeps memory/load even if parseCheapFields sees nothing this tick.
    ...parseCheapFields(fields),
  };
}

/**
 * Everything the one-shot collection reports: slow fields + cheap fields.
 * Returns null when the output carries no recognizable marker at all.
 */
export function parseStaticFields(fields) {
  if (!fields.UPTIME && !fields.UPTIME1 && !fields.STAT1 && !fields.MEMINFO) return null;
  return { ...parseSlowFields(fields), ...parseCheapFields(fields) };
}
/**
 * Rate markers: either a self-contained pair (STAT1..STAT2, the one-shot /
 * first-frame shape) or one sample to be differenced against `previous`.
 *
 * Returns { rates, payload } where `rates` is the state the next tick needs:
 * { stat, net, uptime, sampledAt }. Counters that went backwards (reboot,
 * interface reset) yield null for that tick instead of a bogus spike.
 */
export function parseRateFields(fields, previous = null, now = Date.now()) {
  const paired = Boolean(fields.STAT2 || fields.NET2);
  // UPTIME1 is the sample immediately before `sleep 1`; older fixtures/scripts
  // only carry the static UPTIME, which is equally valid as a window start.
  const firstUptime = firstNumber(fields.UPTIME1 ?? fields.UPTIME);
  const startSample = {
    stat: parseCpuLine(fields.STAT1),
    net: networkTotals(fields.NET1),
    uptime: Number.isFinite(firstUptime) ? firstUptime : null,
    sampledAt: now,
  };
  const endUptimeRaw = paired ? firstNumber(fields.UPTIME2 ?? fields.UPTIME1 ?? fields.UPTIME) : firstUptime;
  const endSample = paired
    ? {
        stat: parseCpuLine(fields.STAT2),
        net: networkTotals(fields.NET2),
        uptime: Number.isFinite(endUptimeRaw) ? endUptimeRaw : null,
        sampledAt: now,
      }
    : startSample;

  // A rate needs two samples from two different instants: either the paired
  // STAT1→STAT2 window of the one-shot script (and of the live stream's first
  // frame), or the previous live tick. A lone sample has no rate — reporting
  // 0 B/s there would be a lie, not a degradation.
  const base = paired ? startSample : previous;

  let cpuUsage = cpuUsageBetween(base?.stat, endSample.stat);
  let network = null;
  if (base?.net && endSample.net) {
    // Elapsed between samples comes from /proc/uptime deltas where possible
    // (second resolution is enough), falling back to wall clock so a tick
    // without /proc/uptime still produces a rate.
    let elapsed = endSample.uptime - base.uptime;
    if (!Number.isFinite(elapsed) || elapsed < 0.2) {
      elapsed = (endSample.sampledAt - base.sampledAt) / 1000;
    }
    if (!Number.isFinite(elapsed) || elapsed < 0.2) elapsed = 1;
    const rx = endSample.net.rx - base.net.rx;
    const tx = endSample.net.tx - base.net.tx;
    // Counters that went backwards mean a reboot or an interface reset; the
    // tick reports no rate instead of a bogus spike.
    if (rx >= 0 && tx >= 0) {
      network = {
        rx_bytes_per_sec: Math.round(rx / elapsed),
        tx_bytes_per_sec: Math.round(tx / elapsed),
      };
    }
  }

  return {
    rates: endSample,
    cpu_usage_percent: cpuUsage === null ? null : round(cpuUsage, 1),
    network,
  };
}

/** Full status payload from parsed markers (one-shot script shape). */
export function parseStatusOutput(stdout) {
  const fields = splitMarkers(stdout);
  const statics = parseStaticFields(fields);
  if (!statics) throw new Error('Status output did not contain any recognizable markers');
  const rates = parseRateFields(fields, null);
  return {
    hostname: statics.hostname,
    uptime_seconds: statics.uptime_seconds,
    cpu: {
      cores: statics.cpu.cores,
      model: statics.cpu.model,
      usage_percent: rates.cpu_usage_percent,
      loadavg: statics.loadavg,
    },
    memory: statics.memory,
    swap: statics.swap,
    disk: statics.disk,
    network: rates.network,
    os: statics.os,
    collected_at: new Date().toISOString(),
  };
}
