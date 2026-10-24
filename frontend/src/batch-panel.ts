// 批量命令执行：多选服务器 → 同一条命令 → SSE 流式聚合各机输出与退出码。
// 后端 /api/batch/exec 以 text/event-stream 逐台回传（并发 8、每机 1 MiB 上限、
// 独立超时）；本模块只做展示与中止，状态保存在闭包里，弹窗可反复打开。
import { t, onLocaleChange, type TranslationKey } from './i18n';
import { notify } from './ui-feedback';
import { createSseParser, capOutput, type BatchEvent } from './sse-stream';

interface BatchServer {
  id: number;
  name: string;
  host: string;
  port: number;
}

const OUTPUT_MAX = 256 * 1024;
void capOutput;

class BatchPanel {
  private modal: HTMLElement | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private cards = new Map<number, { card: HTMLElement; pre: HTMLElement; status: HTMLElement; meta: HTMLElement; text: string }>();
  private servers: BatchServer[] = [];

  constructor() {
    onLocaleChange(() => this.syncTranslations());
  }

  private el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  open(): void {
    this.modal = this.el('batch-modal');
    if (!this.modal) return;
    this.modal.classList.remove('hidden');
    this.modal.classList.add('flex');
    void this.loadServers();
  }

  close(): void {
    this.modal?.classList.add('hidden');
    this.modal?.classList.remove('flex');
  }

  private syncTranslations(): void {
    // data-i18n 静态文案由全局翻译器处理；动态状态在事件流里随 t() 实时取。
  }

  private async loadServers(): Promise<void> {
    const list = this.el('batch-server-list');
    if (!list) return;
    list.innerHTML = '';
    try {
      const response = await fetch('/api/servers');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.servers = (await response.json()) as BatchServer[];
    } catch (error) {
      list.innerHTML = `<div class="px-3 py-3 text-xs text-[var(--error)]">${escapeHtml(t('batch.connectFailed'))}${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
      return;
    }
    if (!this.servers.length) {
      list.innerHTML = `<div class="px-3 py-3 text-xs text-muted">${escapeHtml(t('batch.needServers'))}</div>`;
      return;
    }
    for (const server of this.servers) {
      const row = document.createElement('label');
      row.className = 'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-surface-variant transition-colors';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'batch-server-check accent-[var(--primary)] cursor-pointer';
      checkbox.dataset.serverId = String(server.id);
      const label = document.createElement('span');
      label.className = 'truncate text-on-surface';
      label.textContent = `${server.name || server.host} · ${server.host}:${server.port}`;
      row.append(checkbox, label);
      list.appendChild(row);
    }
  }

  private selectedIds(): number[] {
    return Array.from(document.querySelectorAll<HTMLInputElement>('.batch-server-check'))
      .filter((box) => box.checked)
      .map((box) => Number(box.dataset.serverId));
  }

  private setRunning(running: boolean): void {
    this.running = running;
    const run = this.el<HTMLButtonElement>('batch-run-btn');
    const stop = this.el('batch-stop-btn');
    if (run) run.disabled = running;
    if (stop) stop.classList.toggle('hidden', !running);
    for (const box of document.querySelectorAll<HTMLInputElement>('.batch-server-check')) box.disabled = running;
  }

  private statusBadge(state: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'): string {
    const map: Record<typeof state, { cls: string; icon: string; key: TranslationKey }> = {
      pending: { cls: 'text-muted', icon: 'hourglass_empty', key: 'batch.pending' },
      running: { cls: 'text-primary', icon: 'progress_activity animate-spin', key: 'batch.running' },
      success: { cls: 'text-[var(--success)]', icon: 'check_circle', key: 'batch.success' },
      failed: { cls: 'text-[var(--error)]', icon: 'error', key: 'batch.failed' },
      cancelled: { cls: 'text-muted', icon: 'cancel', key: 'batch.cancelled' },
    };
    const item = map[state];
    return `<span class="inline-flex items-center gap-1 ${item.cls}"><span class="material-symbols-outlined" style="font-size:14px">${item.icon}</span><span class="text-[10px] font-bold uppercase tracking-wider">${escapeHtml(t(item.key))}</span></span>`;
  }

  private ensureCard(serverId: number, name: string): { pre: HTMLElement; status: HTMLElement; meta: HTMLElement } {
    const existing = this.cards.get(serverId);
    if (existing) return existing;
    const container = this.el('batch-result-cards');
    if (!container) throw new Error('batch result container missing');
    const card = document.createElement('div');
    card.className = 'border border-dim rounded overflow-hidden';
    card.innerHTML = `
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 bg-surface-variant">
        <span class="text-xs font-bold text-on-surface truncate max-w-[16rem]">${escapeHtml(name)}</span>
        <span class="batch-status"></span>
        <span class="batch-meta text-[10px] text-muted ml-auto tabular-nums"></span>
      </div>
      <pre class="batch-output hidden m-0 px-3 py-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto custom-scrollbar text-on-surface"></pre>`;
    container.appendChild(card);
    const entry = {
      card,
      pre: card.querySelector('.batch-output') as HTMLElement,
      status: card.querySelector('.batch-status') as HTMLElement,
      meta: card.querySelector('.batch-meta') as HTMLElement,
      text: '',
    };
    this.cards.set(serverId, entry);
    return entry;
  }

  private appendOutput(serverId: number, text: string): void {
    const entry = this.cards.get(serverId);
    if (!entry || !text) return;
    entry.text = capOutput(entry.text + text, OUTPUT_MAX);
    entry.pre.textContent = entry.text;
    entry.pre.classList.remove('hidden');
    entry.pre.scrollTop = entry.pre.scrollHeight;
  }

  private setMeta(serverId: number, extra: string): void {
    const entry = this.cards.get(serverId);
    if (!entry) return;
    entry.meta.textContent = extra;
  }

  private handleEvent(event: BatchEvent): void {
    switch (event.type) {
      case 'run_start':
        break;
      case 'server_start':
        if (event.server_id === undefined) break;
        {
          const entry = this.ensureCard(event.server_id, event.name || String(event.server_id));
          entry.status.innerHTML = this.statusBadge('running');
        }
        break;
      case 'output':
        if (event.server_id !== undefined && event.text) this.appendOutput(event.server_id, event.text);
        break;
      case 'server_done': {
        if (event.server_id === undefined) break;
        this.ensureCard(event.server_id, event.name || String(event.server_id));
        const ok = event.exit_code === 0;
        const entry = this.cards.get(event.server_id);
        if (entry) entry.status.innerHTML = this.statusBadge(ok ? 'success' : 'failed');
        const bits = [`${t('batch.exitCode')}: ${event.exit_code ?? '—'}`];
        if (event.duration_ms !== undefined) bits.push(`${t('batch.duration')}: ${formatDuration(event.duration_ms)}`);
        if (event.bytes !== undefined) bits.push(`${(event.bytes / 1024).toFixed(1)} KiB`);
        if (event.truncated) bits.push(t('batch.truncated'));
        this.setMeta(event.server_id, bits.join(' · '));
        if (!ok && event.stderr) this.appendOutput(event.server_id, `\n[stderr]\n${event.stderr}`);
        break;
      }
      case 'server_error': {
        if (event.server_id === undefined) break;
        const entry = this.ensureCard(event.server_id, event.name || String(event.server_id));
        entry.status.innerHTML = this.statusBadge(this.controller?.signal.aborted ? 'cancelled' : 'failed');
        if (event.message) this.appendOutput(event.server_id, `[${event.message}]`);
        if (event.duration_ms !== undefined) this.setMeta(event.server_id, `${t('batch.duration')}: ${formatDuration(event.duration_ms)}`);
        break;
      }
      case 'run_done':
        this.setRunning(false);
        this.controller = null;
        break;
    }
  }

  async run(): Promise<void> {
    if (this.running) return;
    const serverIds = this.selectedIds();
    const commandEl = this.el<HTMLTextAreaElement>('batch-command');
    const command = (commandEl?.value || '').trim();
    const timeout = Number(this.el<HTMLSelectElement>('batch-timeout')?.value || 120);
    if (!serverIds.length) { notify(t('batch.needServers'), { variant: 'danger' }); return; }
    if (!command) { notify(t('batch.needCommand'), { variant: 'danger' }); return; }

    const container = this.el('batch-result-cards');
    const results = this.el('batch-results');
    if (container && results) {
      container.innerHTML = '';
      results.classList.remove('hidden');
    }
    this.cards.clear();
    this.controller = new AbortController();
    this.setRunning(true);
    try {
      const response = await fetch('/api/batch/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.controller.signal,
        body: JSON.stringify({ server_ids: serverIds, command, timeout }),
      });
      if (!response.ok || !response.body) {
        // Worker 部署没有该路由（404）：明示功能仅自托管可用，别暴露裸状态码。
        if (response.status === 404) throw new Error(t('batch.standaloneOnly'));
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      const parser = createSseParser((event) => this.handleEvent(event));
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.end();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        notify(`${t('batch.connectFailed')}${error instanceof Error ? error.message : String(error)}`, { variant: 'danger' });
      }
      // 中止：把仍在 running 的卡片标记为已中断。
      for (const [serverId, entry] of this.cards) {
        if (entry.status.querySelector('.animate-spin')) {
          entry.status.innerHTML = this.statusBadge('cancelled');
          void serverId;
        }
      }
    } finally {
      this.setRunning(false);
      this.controller = null;
    }
  }

  stop(): void {
    this.controller?.abort();
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string
  ));
}

export const batchPanel = new BatchPanel();

export function initBatchPanel(): void {
  document.getElementById('batch-exec-btn')?.addEventListener('click', () => batchPanel.open());
  document.getElementById('batch-modal-close-btn')?.addEventListener('click', () => batchPanel.close());
  document.getElementById('batch-modal-backdrop')?.addEventListener('click', () => batchPanel.close());
  document.getElementById('batch-run-btn')?.addEventListener('click', () => { void batchPanel.run(); });
  document.getElementById('batch-stop-btn')?.addEventListener('click', () => batchPanel.stop());
  document.getElementById('batch-select-all-btn')?.addEventListener('click', () => {
    for (const box of document.querySelectorAll<HTMLInputElement>('.batch-server-check')) box.checked = true;
  });
  document.getElementById('batch-clear-btn')?.addEventListener('click', () => {
    for (const box of document.querySelectorAll<HTMLInputElement>('.batch-server-check')) box.checked = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const modal = document.getElementById('batch-modal');
      if (modal && !modal.classList.contains('hidden')) batchPanel.close();
    }
  });
}
