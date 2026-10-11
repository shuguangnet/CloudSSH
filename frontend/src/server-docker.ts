// Docker 容器管理弹窗：通过保存的 SSH 凭据远程执行 docker 命令。
// 列表（docker ps -a）默认每 5 秒自动刷新；动作（启动/重启/停止/删除）
// 走 POST 且服务端按服务器节流；日志单独弹窗查看，可选尾行数。
import { t, type TranslationKey } from './i18n';
import { notify, confirmAction } from './ui-feedback';
import { escapeHtml } from './sftp-helpers';

interface DockerContainer {
  id: string;
  short_id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  running_for: string;
  ports: string;
}

const REFRESH_INTERVAL_MS = 5000;

const STATE_BADGES: Record<string, { label: string; color: string }> = {
  running: { label: 'docker.state.running', color: 'var(--success, #4caf50)' },
  exited: { label: 'docker.state.exited', color: 'var(--error)' },
  paused: { label: 'docker.state.paused', color: 'var(--warning, #e6a23c)' },
  created: { label: 'docker.state.created', color: 'var(--accent-secondary)' },
  restarting: { label: 'docker.state.restarting', color: 'var(--warning, #e6a23c)' },
  dead: { label: 'docker.state.dead', color: 'var(--error)' },
};

function stateBadge(state: string): { label: string; color: string } {
  return STATE_BADGES[state] || { label: '', color: 'var(--error)' };
}

function stateLabel(state: string): string {
  const badge = STATE_BADGES[state];
  return badge ? t(badge.label as TranslationKey) : state;
}

function isRunning(state: string): boolean {
  return state === 'running' || state === 'restarting';
}

function actionButtons(container: DockerContainer): string {
  const running = isRunning(container.state);
  const button = (action: string, icon: string, label: string, disabled: boolean, danger = false) => `
    <button data-docker-action="${action}" data-docker-container="${escapeHtml(container.name)}" ${disabled ? 'disabled' : ''}
      class="cyber-button py-1 px-2 text-[10px] font-bold tracking-[0.05em] flex items-center gap-1 ${danger ? 'text-[var(--error)]' : 'text-primary'} disabled:opacity-40 disabled:cursor-not-allowed"
      title="${escapeHtml(label)}">
      <span class="material-symbols-outlined" style="font-size: 13px">${icon}</span>${escapeHtml(label)}
    </button>`;
  return `
    <div class="flex flex-wrap items-center gap-1.5">
      ${button('start', 'play_arrow', t('docker.start'), running)}
      ${button('restart', 'restart_alt', t('docker.restart'), container.state === 'created')}
      ${button('stop', 'stop', t('docker.stop'), !running)}
      ${button('logs', 'receipt_long', t('docker.logs'), false)}
      ${button('remove', 'delete', t('docker.delete'), false, true)}
    </div>`;
}

function containerCard(container: DockerContainer): string {
  const badge = stateBadge(container.state);
  const ports = container.ports
    ? container.ports.split(', ').filter(Boolean).map((port) => `<div class="font-mono">${escapeHtml(port)}</div>`).join('')
    : `<div class="text-dim">—</div>`;
  return `
    <div class="rounded-lg border border-dim bg-[var(--surface)] p-3.5 space-y-2.5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-bold text-primary truncate max-w-[220px]" title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</span>
            <span class="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1" style="color:${badge.color};border:1px solid ${badge.color}">
              <span class="inline-block w-1.5 h-1.5 rounded-full" style="background:${badge.color}"></span>${escapeHtml(stateLabel(container.state))}
            </span>
          </div>
          <div class="text-[10px] text-muted font-mono mt-1">${escapeHtml(container.short_id)}</div>
        </div>
        <div class="text-[10px] text-dim text-right shrink-0">
          <div title="${escapeHtml(container.status)}">${escapeHtml(container.running_for)}</div>
        </div>
      </div>
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
        <span class="text-dim">${escapeHtml(t('docker.image'))}</span>
        <span class="font-mono min-w-0 break-all">${escapeHtml(container.image)}</span>
        <span class="text-dim">${escapeHtml(t('docker.ports'))}</span>
        <span class="text-on-surface min-w-0">${ports}</span>
      </div>
      ${actionButtons(container)}
    </div>`;
}

export class DockerPanel {
  private serverId: number | null = null;
  private serverName = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;
  private busy = false;
  private pending = false;

  open(serverId: number, serverName: string): void {
    this.serverId = serverId;
    this.serverName = serverName;
    const modal = document.getElementById('docker-modal');
    const body = document.getElementById('docker-modal-body');
    if (!modal || !body) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted">
        <span class="material-symbols-outlined animate-spin" style="font-size: 16px">progress_activity</span>
        <span>${escapeHtml(t('docker.loading'))}</span>
      </div>`;
    void this.collect();
    this.stopTimer();
    this.timer = setInterval(() => {
      if ((document.getElementById('docker-auto-refresh') as HTMLInputElement | null)?.checked) {
        void this.collect();
      }
    }, REFRESH_INTERVAL_MS);
  }

  close(): void {
    this.stopTimer();
    this.controller?.abort();
    this.controller = null;
    this.serverId = null;
    const modal = document.getElementById('docker-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
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
    // One listing at a time: a tick while SSH is still running skips instead
    // of aborting + refetching — that combo used to trip the server-side
    // per-server throttle ("Too many requests" / "query already in progress").
    if (this.serverId === null || this.pending) return;
    this.pending = true;
    const controller = new AbortController();
    this.controller = controller;
    const serverId = this.serverId;
    try {
      const response = await fetch(`/api/docker/${serverId}/containers`, { signal: controller.signal });
      if (!response.ok) {
        const message = (await response.json().catch(() => ({}))).error || `HTTP ${response.status}`;
        throw Object.assign(new Error(message), { status: response.status });
      }
      const payload = (await response.json()) as { containers: DockerContainer[] };
      if (this.serverId !== serverId || controller.signal.aborted) return;
      this.render(payload.containers);
    } catch (error) {
      if (controller.signal.aborted || this.serverId !== serverId) return;
      // 429/409 are transient throttle replies; the next tick retries — do not
      // tear down the listing or disable auto-refresh over them.
      if ((error as { status?: number }).status === 429 || (error as { status?: number }).status === 409) return;
      this.renderError(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.controller === controller) this.controller = null;
      this.pending = false;
    }
  }

  private dockerHint(message: string): string {
    if (/command not found|not installed|docker: not found/i.test(message)) return t('docker.noDocker');
    if (/permission denied|access denied|cannot connect to the Docker daemon/i.test(message)) return t('docker.noPermission');
    return '';
  }

  private renderError(message: string): void {
    const body = document.getElementById('docker-modal-body');
    if (!body) return;
    const hint = this.dockerHint(message);
    const auto = document.getElementById('docker-auto-refresh') as HTMLInputElement | null;
    if (auto) auto.checked = false;
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="space-y-3 py-6">
        <div class="flex items-start gap-2 text-xs text-[var(--error)]">
          <span class="material-symbols-outlined shrink-0" style="font-size: 16px">error</span>
          <div class="min-w-0 break-all space-y-1">
            <div>${escapeHtml(t('docker.fetchFailed'))} ${escapeHtml(message)}</div>
            ${hint ? `<div class="text-muted">${escapeHtml(hint)}</div>` : ''}
          </div>
        </div>
        <button id="docker-retry-btn" class="cyber-button text-primary py-1.5 px-3 text-[10px] font-bold tracking-[0.1em]">
          ${escapeHtml(t('docker.retry'))}
        </button>
      </div>`;
    document.getElementById('docker-retry-btn')?.addEventListener('click', () => {
      const autoCheckbox = document.getElementById('docker-auto-refresh') as HTMLInputElement | null;
      if (autoCheckbox) autoCheckbox.checked = true;
      this.refresh();
    });
  }

  private render(containers: DockerContainer[]): void {
    const body = document.getElementById('docker-modal-body');
    if (!body) return;
    const cards = containers.length
      ? containers.map(containerCard).join('')
      : `<div class="py-8 text-center text-xs text-muted">${escapeHtml(t('docker.none'))}</div>`;
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="space-y-2.5">
        <div class="text-[10px] text-dim">${escapeHtml(this.serverName)} · ${escapeHtml(t('docker.containerCount', { n: containers.length }))}</div>
        ${cards}
      </div>`;
    body.querySelectorAll<HTMLButtonElement>('button[data-docker-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.dockerAction;
        const container = button.dataset.dockerContainer;
        if (action && container) void this.handleAction(action, container);
      });
    });
  }

  private async handleAction(action: string, container: string): Promise<void> {
    if (this.serverId === null) return;
    if (action === 'logs') {
      this.openLogs(container);
      return;
    }
    if (action === 'remove') {
      const confirmed = await confirmAction({
        title: t('docker.delete'),
        message: t('docker.deleteConfirm', { name: container }),
        confirmText: t('common.delete'),
        cancelText: t('common.cancel'),
        variant: 'danger',
      });
      if (!confirmed) return;
    }
    if (this.busy) return;
    this.busy = true;
    const modalBody = document.getElementById('docker-modal-body');
    modalBody?.setAttribute('inert', '');
    try {
      const response = await fetch(`/api/docker/${this.serverId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, action }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; stderr?: string; stdout?: string };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || payload.stderr?.trim() || payload.stdout?.trim() || `HTTP ${response.status}`);
      }
      notify(t('docker.actionDone', { action: t(`docker.${action}` as TranslationKey), name: container }), { variant: 'success' });
    } catch (error) {
      notify(t('docker.actionFailed', { message: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
    } finally {
      this.busy = false;
      modalBody?.removeAttribute('inert');
      this.refresh();
    }
  }

  private openLogs(container: string): void {
    const modal = document.getElementById('docker-logs-modal');
    const nameSpan = document.getElementById('docker-logs-container-name');
    const body = document.getElementById('docker-logs-body');
    if (!modal || !body || !nameSpan || this.serverId === null) return;
    nameSpan.textContent = container;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    void this.fetchLogs(container);
  }

  closeLogs(): void {
    const modal = document.getElementById('docker-logs-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  async fetchLogs(container: string): Promise<void> {
    if (this.serverId === null) return;
    const body = document.getElementById('docker-logs-body');
    if (!body) return;
    body.setAttribute('inert', '');
    const tail = Number((document.getElementById('docker-logs-tail') as HTMLSelectElement | null)?.value || 500);
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted">
        <span class="material-symbols-outlined animate-spin" style="font-size: 16px">progress_activity</span>
        <span>${escapeHtml(t('docker.logsLoading'))}</span>
      </div>`;
    try {
      const response = await fetch(`/api/docker/${this.serverId}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, tail }),
      });
      const payload = (await response.json().catch(() => ({}))) as { logs?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const logs = (payload.logs || '').replace(/\s+$/, '');
      // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      body.innerHTML = logs
        ? `<pre class="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all">${escapeHtml(logs)}</pre>`
        : `<div class="py-8 text-center text-xs text-muted">${escapeHtml(t('docker.logsEmpty'))}</div>`;
    } catch (error) {
      // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      body.innerHTML = `
        <div class="flex items-start gap-2 py-6 text-xs text-[var(--error)]">
          <span class="material-symbols-outlined shrink-0" style="font-size: 16px">error</span>
          <span class="min-w-0 break-all">${escapeHtml(t('docker.logsFailed'))} ${escapeHtml(error instanceof Error ? error.message : String(error))}</span>
        </div>`;
    } finally {
      body.removeAttribute('inert');
      body.scrollTop = body.scrollHeight;
    }
  }
}

export const dockerPanel = new DockerPanel();

export function initDockerPanel(): void {
  document.getElementById('docker-modal-close-btn')?.addEventListener('click', () => dockerPanel.close());
  document.getElementById('docker-modal-backdrop')?.addEventListener('click', () => dockerPanel.close());
  document.getElementById('docker-refresh-btn')?.addEventListener('click', () => dockerPanel.refresh());
  document.getElementById('docker-logs-close-btn')?.addEventListener('click', () => dockerPanel.closeLogs());
  document.getElementById('docker-logs-modal-backdrop')?.addEventListener('click', () => dockerPanel.closeLogs());
  document.getElementById('docker-logs-refresh-btn')?.addEventListener('click', () => {
    const name = document.getElementById('docker-logs-container-name')?.textContent;
    if (name) void dockerPanel.fetchLogs(name);
  });
  document.getElementById('docker-logs-tail')?.addEventListener('change', () => {
    const name = document.getElementById('docker-logs-container-name')?.textContent;
    if (name) void dockerPanel.fetchLogs(name);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const logsModal = document.getElementById('docker-logs-modal');
      if (!logsModal?.classList.contains('hidden')) {
        dockerPanel.closeLogs();
        return;
      }
      dockerPanel.close();
    }
  });
}
