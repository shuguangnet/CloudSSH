// 服务器状态渲染层：弹窗（服务器列表入口）与实时抽屉（终端状态栏入口）
// 共用同一套格式化与指标渲染，避免两处展示同样的字段却算出不同的文本。
import { t } from './i18n';
import { escapeHtml } from './sftp-helpers';

export interface StatusCpu {
  cores: number | null;
  model: string | null;
  usage_percent: number | null;
  loadavg: number[] | null;
}

export interface StatusCounter {
  total_bytes: number | null;
  used_bytes: number | null;
  usage_percent: number | null;
  /** 仅磁盘返回：采集脚本上报的剩余空间 */
  available_bytes?: number | null;
}

export interface StatusNetwork {
  rx_bytes_per_sec: number | null;
  tx_bytes_per_sec: number | null;
}

/** 一次性采集（/api/automation/status/:id）与实时帧（/status/live/:id）的公共字段 */
export interface ServerStatusPayload {
  hostname: string | null;
  uptime_seconds: number | null;
  cpu: StatusCpu;
  memory: StatusCounter | null;
  swap: StatusCounter | null;
  disk: StatusCounter | null;
  network: StatusNetwork | null;
  os: string | null;
  latency_ms: number;
  /** 实时帧独有：采样周期与采样时刻（一次性采集为 collected_at） */
  interval_ms?: number;
  sampled_at?: string;
  collected_at?: string;
  server_id?: number;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  const kb = bytesPerSecond / 1024;
  if (kb < 1) return `${Math.round(bytesPerSecond)} B/s`;
  if (kb < 1024) return `${kb.toFixed(1)} KB/s`;
  return `${(kb / 1024).toFixed(2)} MB/s`;
}

/** 状态栏胶囊用的极简速率文本：省掉小数与空格，宽度敏感 */
export function formatRateCompact(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  const kb = bytesPerSecond / 1024;
  if (kb < 1) return `${Math.round(bytesPerSecond)}B/s`;
  if (kb < 1000) return `${Math.round(kb)}KB/s`;
  return `${(kb / 1024).toFixed(1)}MB/s`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return t('server.status.uptimeFormat', { days, hours, minutes });
}

/** 状态栏用的紧凑时长：只保留最大的两个单位 */
export function formatUptimeCompact(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${totalMinutes % 60}m`;
  return `${totalMinutes}m`;
}

/** 用量配色分档：与进度条、状态栏胶囊保持一致的红/黄/青语义 */
export type UsageLevel = 'ok' | 'warn' | 'danger';

export function usageLevel(percent: number | null | undefined): UsageLevel {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'ok';
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'ok';
}

export function usageColor(percent: number | null): string {
  const level = usageLevel(percent);
  if (level === 'danger') return 'var(--error)';
  if (level === 'warn') return 'var(--warning, #e6a23c)';
  return 'var(--accent-secondary)';
}

export function barStyle(percent: number | null): string {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return `width:${width.toFixed(1)}%;background:${usageColor(percent)};`;
}

export function percentText(percent: number | null): string {
  return percent === null ? '—' : `${percent.toFixed(1)}%`;
}

/** 状态栏胶囊文本：整数百分比，省宽度 */
export function percentCompact(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '—';
  return `${Math.round(percent)}%`;
}

export function metricRow(
  label: string,
  percent: number | null,
  valueText: string,
  showBar = true
): string {
  return `
    <div class="space-y-1">
      <div class="flex items-center justify-between gap-3 text-xs">
        <span class="text-dim shrink-0">${escapeHtml(label)}</span>
        <span class="text-on-surface font-mono text-right min-w-0 truncate">${escapeHtml(valueText)}</span>
      </div>
      ${showBar ? `<div class="h-1.5 rounded-full bg-[var(--border)] overflow-hidden"><div class="h-full rounded-full transition-[width] duration-500" style="${barStyle(percent)}"></div></div>` : ''}
    </div>`;
}

/**
 * 指标主体：抽屉与弹窗共用。`showDetails` 控制 CPU 型号/系统版本这类
 * 只读补充信息（状态栏抽屉空间更紧凑，但用户点开就是为了看全量）。
 */
export function renderStatusMetrics(payload: ServerStatusPayload, serverName: string): string {
  const load = payload.cpu.loadavg;
  const memory = payload.memory;
  const swap = payload.swap;
  const disk = payload.disk;
  const network = payload.network;
  const latency = payload.latency_ms > 0 ? `${Math.round(payload.latency_ms)}ms` : '—';

  return `
      <div class="space-y-3.5">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-bold text-primary truncate" title="${escapeHtml(payload.hostname ?? serverName)}">${escapeHtml(payload.hostname ?? serverName)}</div>
            <div class="text-[10px] text-dim truncate">${escapeHtml(serverName)}</div>
          </div>
          <span class="shrink-0 text-[10px] font-bold text-[var(--accent-secondary)] border border-dim px-2 py-0.5 flex items-center gap-1">
            <span class="material-symbols-outlined" style="font-size: 12px">speed</span>${escapeHtml(latency)}
          </span>
        </div>
        ${metricRow(t('server.status.uptime'), null, formatUptime(payload.uptime_seconds), false)}
        ${metricRow(t('server.status.cpu'), payload.cpu.usage_percent, `${percentText(payload.cpu.usage_percent)}${payload.cpu.cores ? ` (${t('server.status.cores', { n: payload.cpu.cores })})` : ''}`)}
        ${metricRow(t('server.status.load'), null, load ? load.map((value) => value.toFixed(2)).join(', ') : '—', false)}
        ${metricRow(t('server.status.memory'), memory?.usage_percent ?? null, memory ? `${percentText(memory.usage_percent)} · ${formatBytes(memory.used_bytes)}/${formatBytes(memory.total_bytes)}` : '—')}
        ${metricRow(t('server.status.swap'), swap?.usage_percent ?? null, swap ? `${percentText(swap.usage_percent)} · ${formatBytes(swap.used_bytes)}/${formatBytes(swap.total_bytes)}` : '—')}
        ${metricRow(t('server.status.disk'), disk?.usage_percent ?? null, disk ? `${percentText(disk.usage_percent)} · ${formatBytes(disk.used_bytes)}/${formatBytes(disk.total_bytes)}` : '—')}
        <div class="flex items-center justify-between gap-3 text-xs pt-1 border-t border-dim">
          <span class="text-dim shrink-0">${escapeHtml(t('server.status.network'))}</span>
          <span class="text-on-surface font-mono text-right flex items-center gap-3">
            <span class="flex items-center gap-1" title="${escapeHtml(t('server.status.download'))}"><span class="material-symbols-outlined text-[var(--accent-secondary)]" style="font-size: 13px">arrow_downward</span>${escapeHtml(formatRate(network?.rx_bytes_per_sec))}</span>
            <span class="flex items-center gap-1" title="${escapeHtml(t('server.status.upload'))}"><span class="material-symbols-outlined text-[var(--accent-secondary)]" style="font-size: 13px">arrow_upward</span>${escapeHtml(formatRate(network?.tx_bytes_per_sec))}</span>
          </span>
        </div>
        <div class="space-y-1.5 text-[10px] text-muted pt-1">
          ${payload.cpu.model ? `<div class="flex items-baseline gap-2"><span class="text-dim shrink-0">${escapeHtml(t('server.status.cpuModel'))}</span><span class="min-w-0 break-all">${escapeHtml(payload.cpu.model)}</span></div>` : ''}
          ${payload.os ? `<div class="flex items-baseline gap-2"><span class="text-dim shrink-0">${escapeHtml(t('server.status.os'))}</span><span class="min-w-0 break-all">${escapeHtml(payload.os)}</span></div>` : ''}
        </div>
      </div>`;
}

export function renderStatusError(message: string): string {
  return `
      <div class="space-y-3 py-6">
        <div class="flex items-start gap-2 text-xs text-[var(--error)]">
          <span class="material-symbols-outlined shrink-0" style="font-size: 16px">error</span>
          <span class="min-w-0 break-all">${escapeHtml(t('server.status.fetchFailed'))} ${escapeHtml(message)}</span>
        </div>
        <button type="button" class="status-retry-btn cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em]">
          ${escapeHtml(t('server.status.retry'))}
        </button>
      </div>`;
}

export function renderStatusLoading(label: string): string {
  return `
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted">
        <span class="material-symbols-outlined animate-spin" style="font-size: 16px">progress_activity</span>
        <span>${escapeHtml(label)}</span>
      </div>`;
}
