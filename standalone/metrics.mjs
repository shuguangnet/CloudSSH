/**
 * /metrics：Prometheus 文本格式（self-hosted only）。
 *
 * 鉴权：未配置 METRICS_BEARER_TOKEN 时一律 404（不暴露端点存在性）；
 * 配置后必须携带匹配的 Authorization: Bearer。该令牌是运维监控专用，
 * 与面板会话/MCP 令牌体系完全独立，泄露只影响指标可读性。
 *
 * 指标均为进程内即时读数（gauge），不落盘、不加锁；抓取开销 O(1)。
 * HELP/TYPE 注释遵循 exposition format 规范。
 */
import { uptime, memoryUsage } from 'node:process';

function metric(name, help, value, type = 'gauge', extra = '') {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name}${extra} ${formatValue(value)}\n`;
}

function formatValue(value) {
  return Number.isFinite(value) ? String(value) : 'NaN';
}

/**
 * @param {{ wssClients: number, sshChainPoolIdle: number, liveStatus: {sessions:number,subscribers:number},
 *           cronTasks: number, monitors: number, mcpTokens: number, startedAt: number }} snapshot
 */
export function renderMetrics(snapshot) {
  const rss = memoryUsage().rss;
  const heapUsed = memoryUsage().heapUsed;
  const lines = [
    metric('cloudssh_up', 'Whether the panel process is serving requests.', 1),
    metric('cloudssh_uptime_seconds', 'Seconds since the panel process started.', Math.floor(uptime()), 'counter'),
    metric('cloudssh_start_time_seconds', 'Unix epoch seconds when the process started.', Math.floor(snapshot.startedAt / 1000)),
    metric('cloudssh_process_resident_memory_bytes', 'Resident memory of the panel process.', rss),
    metric('cloudssh_process_heap_used_bytes', 'V8 heap currently in use.', heapUsed),
    metric('cloudssh_ws_connections_active', 'Active WebSocket connections (terminal, SFTP, CLI).', snapshot.wssClients),
    metric('cloudssh_ssh_pool_idle_chains', 'Idle authenticated SSH chains kept warm for reuse.', snapshot.sshChainPoolIdle),
    metric('cloudssh_live_status_sessions', 'Active live-status sampler sessions (one per owner:server).', snapshot.liveStatus.sessions),
    metric('cloudssh_live_status_subscribers', 'Total viewers attached to live-status samplers.', snapshot.liveStatus.subscribers),
    metric('cloudssh_cron_tasks', 'Persisted automation cron tasks.', snapshot.cronTasks),
    metric('cloudssh_monitors', 'Persisted availability monitors.', snapshot.monitors),
    metric('cloudssh_mcp_tokens_active', 'Non-expired, non-revoked MCP tokens.', snapshot.mcpTokens),
  ];
  return lines.join('');
}

/** Bearer 校验：恒时语义不必要（令牌高熵、网络抖动噪声远大于比较耗时），但拒绝语义必须一致。 */
export function metricsAuthorized(configuredToken, header) {
  if (!configuredToken) return false;
  return header === `Bearer ${configuredToken}`;
}
