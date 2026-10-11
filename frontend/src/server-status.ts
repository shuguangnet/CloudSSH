// 服务器状态弹窗：按需通过 /api/automation/status/:id 采集实时系统指标
// （运行时长 / CPU / 负载 / 内存 / 交换 / 磁盘 / 网络速率 / CPU 型号 / 系统），
// 打开期间默认每 5 秒自动刷新，关闭即停止轮询并中止在途请求。
import { t } from './i18n';
import { notify } from './ui-feedback';
import { escapeHtml } from './sftp-helpers';

interface StatusCpu {
  cores: number | null;
  model: string | null;
  usage_percent: number | null;
  loadavg: number[] | null;
}

interface StatusCounter {
  total_bytes: number | null;
  used_bytes: number | null;
  usage_percent: number | null;
}

interface ServerStatusPayload {
  hostname: string | null;
  uptime_seconds: number | null;
  cpu: StatusCpu;
  memory: StatusCounter | null;
  swap: StatusCounter | null;
  disk: StatusCounter | null;
  network: { rx_bytes_per_sec: number; tx_bytes_per_sec: number } | null;
  os: string | null;
  latency_ms: number;
}

const REFRESH_INTERVAL_MS = 5000;

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  const kb = bytesPerSecond / 1024;
  if (kb < 1) return `${Math.round(bytesPerSecond)} B/s`;
  if (kb < 1024) return `${kb.toFixed(1)} KB/s`;
  return `${(kb / 1024).toFixed(2)} MB/s`;
}

function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return t('server.status.uptimeFormat', { days, hours, minutes });
}

function usageColor(percent: number | null): string {
  if (percent === null) return 'var(--accent-secondary)';
  if (percent >= 90) return 'var(--error)';
  if (percent >= 70) return 'var(--warning, #e6a23c)';
  return 'var(--accent-secondary)';
}

function barStyle(percent: number | null): string {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return `width:${width.toFixed(1)}%;background:${usageColor(percent)};`;
}

function percentText(percent: number | null): string {
  return percent === null ? '—' : `${percent.toFixed(1)}%`;
}

function metricRow(
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

export class ServerStatusPanel {
  private serverId: number | null = null;
  private serverName = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;
  private failures = 0;
  private pending = false;

  open(serverId: number, serverName: string): void {
    this.serverId = serverId;
    this.serverName = serverName;
    this.failures = 0;
    const modal = document.getElementById('status-modal');
    const body = document.getElementById('status-modal-body');
    if (!modal || !body) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted">
        <span class="material-symbols-outlined animate-spin" style="font-size: 16px">progress_activity</span>
        <span>${escapeHtml(t('server.status.collecting'))}</span>
      </div>`;
    void this.collect();
    this.stopTimer();
    this.timer = setInterval(() => {
      if ((document.getElementById('status-auto-refresh') as HTMLInputElement | null)?.checked) {
        void this.collect();
      }
    }, REFRESH_INTERVAL_MS);
  }

  close(): void {
    this.stopTimer();
    this.controller?.abort();
    this.controller = null;
    this.serverId = null;
    const modal = document.getElementById('status-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  isOpen(): boolean {
    return this.serverId !== null;
  }

  refresh(): void {
    if (this.serverId !== null) void this.collect();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async collect(): Promise<void> {
    // One collection at a time: a tick while SSH is still running skips instead
    // of aborting + refetching — that combo used to trip the server-side
    // per-server throttle ("Too many status requests" / "already in progress").
    if (this.serverId === null || this.pending) return;
    this.pending = true;
    const controller = new AbortController();
    this.controller = controller;
    const serverId = this.serverId;
    try {
      const response = await fetch(`/api/automation/status/${serverId}`, { signal: controller.signal });
      if (!response.ok) {
        const message = (await response.json().catch(() => ({}))).error || `HTTP ${response.status}`;
        throw Object.assign(new Error(message), { status: response.status });
      }
      const payload = (await response.json()) as ServerStatusPayload;
      if (this.serverId !== serverId || controller.signal.aborted) return;
      this.failures = 0;
      this.render(payload);
    } catch (error) {
      if (controller.signal.aborted || this.serverId !== serverId) return;
      // 429/409 are transient throttle replies (server still busy with the
      // previous collection); the next tick retries — not a panel failure.
      if ((error as { status?: number }).status === 429 || (error as { status?: number }).status === 409) return;
      this.failures++;
      this.renderError(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.controller === controller) this.controller = null;
      this.pending = false;
    }
  }

  private renderError(message: string): void {
    const body = document.getElementById('status-modal-body');
    if (!body) return;
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="space-y-3 py-6">
        <div class="flex items-start gap-2 text-xs text-[var(--error)]">
          <span class="material-symbols-outlined shrink-0" style="font-size: 16px">error</span>
          <span class="min-w-0 break-all">${escapeHtml(t('server.status.fetchFailed'))} ${escapeHtml(message)}</span>
        </div>
        <button id="status-retry-btn" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em]">
          ${escapeHtml(t('server.status.retry'))}
        </button>
      </div>`;
    document.getElementById('status-retry-btn')?.addEventListener('click', () => {
      this.refresh();
    });
    if (this.failures >= 2) {
      const auto = document.getElementById('status-auto-refresh') as HTMLInputElement | null;
      if (auto) auto.checked = false;
      notify(t('server.status.fetchFailed'), { variant: 'danger' });
    }
  }

  private render(payload: ServerStatusPayload): void {
    const body = document.getElementById('status-modal-body');
    if (!body) return;
    const serverName = this.serverName;
    const load = payload.cpu.loadavg;
    const memory = payload.memory;
    const swap = payload.swap;
    const disk = payload.disk;
    const network = payload.network;
    const latency = payload.latency_ms > 0 ? `${Math.round(payload.latency_ms)}ms` : '—';

    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
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
}

export const serverStatusPanel = new ServerStatusPanel();

export function initServerStatusPanel(): void {
  document.getElementById('status-modal-close-btn')?.addEventListener('click', () => serverStatusPanel.close());
  document.getElementById('status-modal-backdrop')?.addEventListener('click', () => serverStatusPanel.close());
  document.getElementById('status-refresh-btn')?.addEventListener('click', () => serverStatusPanel.refresh());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') serverStatusPanel.close();
  });
}
