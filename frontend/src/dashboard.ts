// Server dashboard wall: live cards for every monitoring-enabled server.
//
// Standalone deployments push snapshots over SSE (one event per collected
// server); the CF Worker has no scheduler, so /api/dashboard/snapshots
// answers 404 there and the wall shows a standalone-only notice instead.
// Polling fallback keeps the wall alive if the stream cannot be established.

import { t } from './i18n';
import { escapeHtml } from './sftp-helpers';

export interface DashboardSnapshot {
  server_id: number;
  name: string;
  host: string;
  ok: boolean;
  error: string | null;
  latency_ms?: number | null;
  cpu_percent?: number | null;
  cores?: number | null;
  load1?: number | null;
  mem_percent?: number | null;
  mem_used_bytes?: number | null;
  mem_total_bytes?: number | null;
  disk_percent?: number | null;
  rx_kbps?: number | null;
  tx_kbps?: number | null;
  uptime_seconds?: number | null;
  os?: string | null;
  collected_at: string;
}

interface Sample {
  ts: number;
  ok: number;
  latency_ms: number | null;
  cpu_percent: number | null;
  mem_percent: number | null;
  rx_kbps: number | null;
  tx_kbps: number | null;
}

const HISTORY_TTL_MS = 25_000;

function formatKbps(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined) return '—';
  if (kbps >= 1024 * 1024) return `${(kbps / 1024 / 1024).toFixed(1)} GB/s`;
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${kbps} KB/s`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function meterBar(label: string, percent: number | null | undefined, detail: string): string {
  const value = percent ?? 0;
  const danger = value >= 90 ? 'var(--error)' : value >= 75 ? 'var(--warn)' : 'var(--primary)';
  return `
    <div class="space-y-1">
      <div class="flex justify-between text-[10px]"><span class="text-dim">${escapeHtml(label)}</span>
        <span class="font-mono">${percent === null || percent === undefined ? '—' : `${percent.toFixed(percent >= 10 ? 0 : 1)}%`}</span></div>
      <div class="h-1.5 rounded bg-surface-2 overflow-hidden"><div class="h-full rounded" style="width:${Math.min(100, value)}%;background:${danger}"></div></div>
      ${detail ? `<div class="text-[9px] text-muted font-mono">${escapeHtml(detail)}</div>` : ''}
    </div>`;
}

/** Tiny dependency-free SVG sparkline. */
function sparkline(values: number[], color: string, unit: string): string {
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) return `<div class="text-[9px] text-muted py-2 text-center">—</div>`;
  const width = 150;
  const height = 28;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const coords = points.map((value, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `
    <svg viewBox="0 0 ${width} ${height}" class="w-full" style="height:28px" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="text-[9px] text-muted text-right font-mono">${escapeHtml(unit)}</div>`;
}

export class DashboardPanel {
  private snapshots = new Map<number, DashboardSnapshot>();
  private expanded: number | null = null;
  private historyCache = new Map<number, { at: number; samples: Sample[] }>();
  private stream: EventSource | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private available = true;
  private intervalSeconds = 60;

  start(): void {
    void this.fetchSnapshots();
    this.connectStream();
  }

  stop(): void {
    this.stream?.close();
    this.stream = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private connectStream(): void {
    if (typeof EventSource === 'undefined') { this.startPolling(); return; }
    try {
      const stream = new EventSource('/api/dashboard/stream');
      this.stream = stream;
      stream.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { type?: string; snapshots?: DashboardSnapshot[]; snapshot?: DashboardSnapshot; interval_seconds?: number };
          if (payload.interval_seconds) this.intervalSeconds = payload.interval_seconds;
          if (payload.type === 'snapshot' && Array.isArray(payload.snapshots)) {
            this.snapshots.clear();
            for (const snapshot of payload.snapshots) this.snapshots.set(snapshot.server_id, snapshot);
          } else if (payload.type === 'update' && payload.snapshot) {
            this.snapshots.set(payload.snapshot.server_id, payload.snapshot);
          } else return;
          this.render();
        } catch { /* malformed frame — next event re-renders */ }
      };
      stream.onerror = () => { this.startPolling(); };
    } catch { this.startPolling(); }
  }

  /** The SSE stream failed — degrade to a slow poll instead of a dead wall. */
  private startPolling(): void {
    this.stream?.close();
    this.stream = null;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.fetchSnapshots(), 30_000);
  }

  private async fetchSnapshots(): Promise<void> {
    try {
      const response = await fetch('/api/dashboard/snapshots');
      if (response.status === 404) {
        this.available = false;
        this.render();
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json()) as { snapshots: DashboardSnapshot[]; interval_seconds?: number };
      this.available = true;
      if (payload.interval_seconds) this.intervalSeconds = payload.interval_seconds;
      this.snapshots.clear();
      for (const snapshot of payload.snapshots || []) this.snapshots.set(snapshot.server_id, snapshot);
      this.render();
    } catch { /* transient network issue — keep the last render */ }
  }

  toggle(): void {
    const section = document.getElementById('dashboard-section');
    if (!section) return;
    const hiddenNow = section.classList.toggle('hidden');
    const button = document.getElementById('dashboard-toggle-btn');
    if (button) button.classList.toggle('text-primary', !hiddenNow);
    // Live only while visible: a hidden wall must not hold an SSE stream open.
    if (hiddenNow) this.stop();
    else if (this.stream === null && this.pollTimer === null) this.start();
  }

  private async history(serverId: number): Promise<Sample[]> {
    const cached = this.historyCache.get(serverId);
    if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.samples;
    const response = await fetch(`/api/dashboard/history?server_id=${serverId}&minutes=60`);
    if (!response.ok) return cached?.samples ?? [];
    const samples = ((await response.json()) as { samples: Sample[] }).samples || [];
    this.historyCache.set(serverId, { at: Date.now(), samples });
    return samples;
  }

  private historyBlock(serverId: number): string {
    const cached = this.historyCache.get(serverId);
    const samples = cached?.samples ?? [];
    const cpu = samples.map((sample) => sample.cpu_percent ?? NaN).filter((value) => Number.isFinite(value));
    const mem = samples.map((sample) => sample.mem_percent ?? NaN).filter((value) => Number.isFinite(value));
    const net = samples.map((sample) => (sample.rx_kbps ?? 0) + (sample.tx_kbps ?? 0)).filter((value) => Number.isFinite(value));
    const latency = samples.map((sample) => sample.latency_ms ?? NaN).filter((value) => Number.isFinite(value));
    if (!cached) return `<div class="text-[10px] text-muted py-2">${escapeHtml(t('dashboard.loading'))}</div>`;
    if (samples.length === 0 || (cpu.length + mem.length + net.length) === 0) {
      return `<div class="text-[10px] text-muted py-2">${escapeHtml(t('dashboard.noHistory'))}</div>`;
    }
    const chart = (title: string, values: number[], color: string, unit: string) => `
      <div>
        <div class="text-[9px] text-dim mb-0.5">${escapeHtml(title)}</div>
        ${sparkline(values, color, unit)}
      </div>`;
    return `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-outline/50">
        ${chart(t('dashboard.cpu'), cpu, 'var(--primary)', cpu.length ? `${cpu[cpu.length - 1].toFixed(0)}%` : '')}
        ${chart(t('dashboard.memory'), mem, '#7dd3fc', mem.length ? `${mem[mem.length - 1].toFixed(0)}%` : '')}
        ${chart(t('dashboard.network'), net, '#a3e635', formatKbps(net[net.length - 1] ?? null))}
        ${chart(t('dashboard.latency'), latency, '#fbbf24', latency.length ? `${Math.round(latency[latency.length - 1])}ms` : '')}
      </div>`;
  }

  render(): void {
    const cards = document.getElementById('dashboard-cards');
    const notice = document.getElementById('dashboard-notice');
    if (!cards || !notice) return;
    if (!this.available) {
      notice.textContent = t('dashboard.standaloneOnly');
      notice.classList.remove('hidden');
      cards.innerHTML = '';
      return;
    }
    notice.classList.add('hidden');
    const list = [...this.snapshots.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) {
      cards.innerHTML = `<div class="text-xs text-muted py-3">${escapeHtml(t('dashboard.none'))}</div>`;
      return;
    }
    cards.innerHTML = list.map((snapshot) => this.card(snapshot)).join('');
    cards.querySelectorAll<HTMLElement>('[data-dashboard-server]').forEach((element) => {
      element.addEventListener('click', () => void this.toggleHistory(Number(element.dataset.dashboardServer), element));
    });
  }

  private async toggleHistory(serverId: number, element: HTMLElement): Promise<void> {
    if (this.expanded === serverId) { this.expanded = null; this.render(); return; }
    this.expanded = serverId;
    this.historyCache.delete(serverId);
    this.render();
    await this.history(serverId);
    if (this.expanded === serverId) this.render();
    element.scrollIntoView?.({ block: 'nearest' });
  }

  private card(snapshot: DashboardSnapshot): string {
    const statusDot = `<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${snapshot.ok ? 'var(--ok)' : 'var(--error)'}"></span>`;
    const errorLine = !snapshot.ok && snapshot.error
      ? `<div class="text-[9px] text-[var(--error)] break-all mt-1">${escapeHtml(t('dashboard.collectFailed'))} · ${escapeHtml(snapshot.error)}</div>` : '';
    const detail = `
      <div class="flex items-center gap-3 text-[10px] text-muted pt-1">
        <span class="font-mono">${escapeHtml(snapshot.host)}</span>
        ${snapshot.latency_ms !== null && snapshot.latency_ms !== undefined ? `<span class="font-mono">${snapshot.latency_ms}ms</span>` : ''}
        ${snapshot.uptime_seconds ? `<span>${escapeHtml(t('dashboard.uptime'))} ${escapeHtml(formatUptime(snapshot.uptime_seconds))}</span>` : ''}
      </div>
      <div class="flex items-center gap-3 text-[10px] text-muted">
        <span>${escapeHtml(t('dashboard.network'))} ↓${escapeHtml(formatKbps(snapshot.rx_kbps))} ↑${escapeHtml(formatKbps(snapshot.tx_kbps))}</span>
        ${snapshot.load1 !== null && snapshot.load1 !== undefined ? `<span>${escapeHtml(t('dashboard.load'))} <span class="font-mono">${snapshot.load1.toFixed(2)}${snapshot.cores ? `/${snapshot.cores}` : ''}</span></span>` : ''}
      </div>`;
    const history = this.expanded === snapshot.server_id ? this.historyBlock(snapshot.server_id) : '';
    return `
      <div data-dashboard-server="${snapshot.server_id}" class="panel p-3 cursor-pointer hover:border-primary/50 transition-colors space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            ${statusDot}
            <span class="text-xs font-bold truncate">${escapeHtml(snapshot.name)}</span>
          </div>
          <span class="text-[9px] text-muted shrink-0">${escapeHtml(new Date(snapshot.collected_at).toLocaleTimeString())}</span>
        </div>
        ${detail}
        <div class="grid grid-cols-2 gap-2">
          ${meterBar(t('dashboard.cpu'), snapshot.cpu_percent, '')}
          ${meterBar(t('dashboard.memory'), snapshot.mem_percent, `${formatBytes(snapshot.mem_used_bytes)} / ${formatBytes(snapshot.mem_total_bytes)}`)}
        </div>
        ${meterBar(t('dashboard.disk'), snapshot.disk_percent, '')}
        ${errorLine}
        ${history}
      </div>`;
  }
}

export const dashboardPanel = new DashboardPanel();
