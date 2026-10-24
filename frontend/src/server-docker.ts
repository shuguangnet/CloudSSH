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
  /** docker stats --no-stream 一次性采样，尽力而为：缺失时不渲染。 */
  cpu_percent?: string;
  mem_usage?: string;
  mem_percent?: string;
  net_io?: string;
  block_io?: string;
}

/** 与后端 CONTAINER_NAME_RE 一致，拼接终端命令前再次校验。 */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

interface DockerImage {
  id: string;
  short_id: string;
  repository: string;
  tag: string;
  dangling: boolean;
  size: string;
  created_since: string;
  created_at: string;
  containers: number;
  digest: string;
}

type DockerView = 'containers' | 'images';

function imageCard(image: DockerImage): string {
  const ref = image.dangling ? image.id : `${image.repository}:${image.tag}`;
  const title = image.dangling ? `<span class="font-mono">${escapeHtml(image.id.slice(0, 19))}…</span>`
    : `${escapeHtml(image.repository)}<span class="text-dim">:${escapeHtml(image.tag)}</span>`;
  return `
    <div class="panel px-3 py-2.5 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0 text-xs">
          <span class="material-symbols-outlined text-primary shrink-0" style="font-size: 16px">layers</span>
          <span class="truncate font-bold">${title}</span>
          ${image.dangling ? `<span class="px-1.5 py-0.5 text-[9px] rounded bg-[var(--warn)]/15 text-[var(--warn)]">${escapeHtml(t('docker.dangling'))}</span>` : ''}
          ${image.containers > 0 ? `<span class="px-1.5 py-0.5 text-[9px] rounded bg-primary/15 text-primary">${escapeHtml(t('docker.imageInUse'))} ${image.containers}</span>` : ''}
        </div>
        <button data-docker-image-ref="${escapeHtml(ref)}" class="cyber-button py-1 px-2 text-[10px] font-bold tracking-[0.05em] text-[var(--error)] flex items-center gap-1">
          <span class="material-symbols-outlined" style="font-size: 13px">delete</span>${escapeHtml(t('docker.removeImage'))}
        </button>
      </div>
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px]">
        <span class="text-dim">${escapeHtml(t('docker.size'))}</span>
        <span class="font-mono">${escapeHtml(image.size)}</span>
        <span class="text-dim">${escapeHtml(t('docker.created'))}</span>
        <span class="text-on-surface">${escapeHtml(image.created_since)}</span>
        <span class="text-dim">ID</span>
        <span class="font-mono">${escapeHtml(image.short_id)}</span>
      </div>
    </div>`;
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

function actionButtons(container: DockerContainer, supportsExec: boolean): string {
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
      ${supportsExec ? button('terminal', 'terminal', t('docker.terminal'), !running) : ''}
      ${button('upgrade', 'system_update_alt', t('docker.upgrade'), false)}
      ${button('remove', 'delete', t('docker.delete'), false, true)}
    </div>`;
}

function containerCard(container: DockerContainer, supportsExec: boolean): string {
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
        ${container.cpu_percent !== undefined ? `
        <span class="text-dim">${escapeHtml(t('docker.cpu'))}</span>
        <span class="font-mono">${escapeHtml(container.cpu_percent)}</span>
        <span class="text-dim">${escapeHtml(t('docker.memory'))}</span>
        <span class="font-mono min-w-0 break-all">${escapeHtml(container.mem_usage || '—')}${container.mem_percent ? ` <span class="text-dim">(${escapeHtml(container.mem_percent)})</span>` : ''}</span>` : ''}
      </div>
      ${actionButtons(container, supportsExec)}
    </div>`;
}

export class DockerPanel {
  private serverId: number | null = null;
  private serverName = '';
  private view: DockerView = 'containers';
  private images: DockerImage[] = [];
  private imagesLoaded = false;
  /** 最近一次容器列表（升级弹窗预填当前镜像用）。 */
  private containers: DockerContainer[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;
  private busy = false;
  private pending = false;
  private pendingImages = false;
  /** 终端页打开时可注入命令的活动终端；服务器列表页无终端则为 null。 */
  private getTerminal: (() => { insertSnippet(command: string, run: boolean): boolean } | null) | null = null;

  open(serverId: number, serverName: string, getTerminal?: () => { insertSnippet(command: string, run: boolean): boolean } | null): void {
    this.serverId = serverId;
    this.serverName = serverName;
    this.getTerminal = getTerminal ?? null;
    this.view = 'containers';
    this.images = [];
    this.imagesLoaded = false;
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
      if (!(document.getElementById('docker-auto-refresh') as HTMLInputElement | null)?.checked) return;
      if (this.view === 'images') void this.collectImages();
      else void this.collect();
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

  private async collectImages(): Promise<void> {
    if (this.serverId === null || this.pendingImages) return;
    this.pendingImages = true;
    const controller = new AbortController();
    this.controller = controller;
    const serverId = this.serverId;
    try {
      const response = await fetch(`/api/docker/${serverId}/images`, { signal: controller.signal });
      if (!response.ok) {
        const message = (await response.json().catch(() => ({}))).error || `HTTP ${response.status}`;
        throw Object.assign(new Error(message), { status: response.status });
      }
      const payload = (await response.json()) as { images: DockerImage[] };
      if (this.serverId !== serverId || controller.signal.aborted) return;
      this.images = payload.images;
      this.imagesLoaded = true;
      this.renderImages();
    } catch (error) {
      if (controller.signal.aborted || this.serverId !== serverId) return;
      if ((error as { status?: number }).status === 429 || (error as { status?: number }).status === 409) return;
      this.renderError(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.controller === controller) this.controller = null;
      this.pendingImages = false;
    }
  }

  /** 面板顶部的容器/镜像视图切换。 */
  private viewBar(): string {
    const tab = (view: DockerView, icon: string, label: string) => `
      <button data-docker-view="${view}" class="cyber-button py-1 px-2.5 text-[10px] font-bold tracking-[0.05em] flex items-center gap-1
        ${this.view === view ? 'text-primary' : 'text-muted'}">
        <span class="material-symbols-outlined" style="font-size: 13px">${icon}</span>${escapeHtml(label)}
      </button>`;
    const actions = this.view === 'images' ? `
      <button id="docker-prune-dangling-btn" class="cyber-button py-1 px-2 text-[10px] font-bold text-muted flex items-center gap-1">
        <span class="material-symbols-outlined" style="font-size: 13px">mop</span>${escapeHtml(t('docker.pruneDangling'))}
      </button>
      <button id="docker-prune-all-btn" class="cyber-button py-1 px-2 text-[10px] font-bold text-[var(--error)] flex items-center gap-1">
        <span class="material-symbols-outlined" style="font-size: 13px">delete_sweep</span>${escapeHtml(t('docker.pruneAll'))}
      </button>` : '';
    return `
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex gap-1">
          ${tab('containers', 'view_in_ar', t('docker.tabContainers'))}
          ${tab('images', 'layers', t('docker.images'))}
        </div>
        <div class="flex gap-1">${actions}</div>
      </div>`;
  }

  private bindViewBar(): void {
    const body = document.getElementById('docker-modal-body');
    body?.querySelectorAll<HTMLButtonElement>('button[data-docker-view]').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.dockerView as DockerView;
        if (!view || view === this.view) return;
        this.view = view;
        if (view === 'images') {
          this.renderImages();
          void this.collectImages();
        } else {
          this.refresh();
        }
      });
    });
    document.getElementById('docker-pull-btn')?.addEventListener('click', () => {
      const input = document.getElementById('docker-pull-input') as HTMLInputElement | null;
      const ref = input?.value.trim();
      if (ref) void this.handleImageAction(ref, 'pull');
    });
    document.getElementById('docker-prune-dangling-btn')?.addEventListener('click', () => void this.confirmImageAction('prune-dangling', t('docker.pruneDanglingConfirm')));
    document.getElementById('docker-prune-all-btn')?.addEventListener('click', () => void this.confirmImageAction('prune-all', t('docker.pruneAllConfirm')));
    body?.querySelectorAll<HTMLButtonElement>('button[data-docker-image-ref]').forEach((button) => {
      button.addEventListener('click', () => {
        const ref = button.dataset.dockerImageRef;
        if (ref) void this.confirmImageAction('remove', t('docker.removeImageConfirm', { ref }), ref);
      });
    });
  }

  private async confirmImageAction(action: string, message: string, ref?: string): Promise<void> {
    const confirmed = await confirmAction({
      title: t(action === 'prune-all' ? 'docker.pruneAll' : action === 'prune-dangling' ? 'docker.pruneDangling' : 'docker.removeImage'),
      message,
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
      variant: 'danger',
    });
    if (confirmed) await this.handleImageAction(ref ?? '', action);
  }

  private async handleImageAction(ref: string, action: string): Promise<void> {
    if (this.serverId === null || this.busy) return;
    this.busy = true;
    const modalBody = document.getElementById('docker-modal-body');
    modalBody?.setAttribute('inert', '');
    const actionLabel = t(`docker.${action === 'pull' ? 'pull' : action === 'remove' ? 'removeImage' : action === 'prune-all' ? 'pruneAll' : 'pruneDangling'}` as TranslationKey);
    try {
      const response = await fetch(`/api/docker/${this.serverId}/image-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, action }),
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; stderr?: string; stdout?: string };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || payload.stderr?.trim() || payload.stdout?.trim() || `HTTP ${response.status}`);
      }
      notify(t('docker.actionDone', { action: actionLabel, name: ref || this.serverName }), { variant: 'success' });
      const input = document.getElementById('docker-pull-input') as HTMLInputElement | null;
      if (input && action === 'pull') input.value = '';
    } catch (error) {
      notify(t('docker.actionFailed', { message: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
    } finally {
      this.busy = false;
      modalBody?.removeAttribute('inert');
      void this.collectImages();
    }
  }

  private renderImages(): void {
    const body = document.getElementById('docker-modal-body');
    if (!body) return;
    const content = !this.imagesLoaded
      ? `<div class="flex items-center justify-center gap-2 py-8 text-xs text-muted">
          <span class="material-symbols-outlined animate-spin" style="font-size: 16px">progress_activity</span>
          <span>${escapeHtml(t('docker.loading'))}</span>
        </div>`
      : this.images.length
        ? this.images.map(imageCard).join('')
        : `<div class="py-8 text-center text-xs text-muted">${escapeHtml(t('docker.imageNone'))}</div>`;
    const danglingCount = this.images.filter((image) => image.dangling).length;
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="space-y-2.5">
        ${this.viewBar()}
        <div class="text-[10px] text-dim">${escapeHtml(this.serverName)} · ${escapeHtml(t('docker.imageCount', { n: this.images.length }))}${danglingCount ? ` · ${escapeHtml(t('docker.dangling'))} ${danglingCount}` : ''}</div>
        <div class="flex gap-1.5">
          <input id="docker-pull-input" type="text" placeholder="${escapeHtml(t('docker.pullPlaceholder'))}"
            class="flex-1 min-w-0 bg-surface-2 border border-outline px-2 py-1.5 text-[11px] rounded focus:border-primary outline-none" />
          <button id="docker-pull-btn" class="cyber-button py-1 px-2.5 text-[10px] font-bold text-primary flex items-center gap-1 shrink-0">
            <span class="material-symbols-outlined" style="font-size: 13px">download</span>${escapeHtml(t('docker.pull'))}
          </button>
        </div>
        ${content}
      </div>`;
    this.bindViewBar();
  }

  private render(containers: DockerContainer[]): void {
    const body = document.getElementById('docker-modal-body');
    if (!body) return;
    this.containers = containers;
    const supportsExec = this.getTerminal !== null;
    const cards = containers.length
      ? containers.map((container) => containerCard(container, supportsExec)).join('')
      : `<div class="py-8 text-center text-xs text-muted">${escapeHtml(t('docker.none'))}</div>`;
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = `
      <div class="space-y-2.5">
        ${this.viewBar()}
        <div class="text-[10px] text-dim">${escapeHtml(this.serverName)} · ${escapeHtml(t('docker.containerCount', { n: containers.length }))}</div>
        ${cards}
      </div>`;
    this.bindViewBar();
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
    if (action === 'upgrade') {
      this.openUpgrade(container);
      return;
    }
    if (action === 'terminal') {
      this.execIntoContainer(container);
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

  /** 在当前活动终端里执行 docker exec -it 进入容器，优先 bash、缺失时回落 sh。 */
  private execIntoContainer(container: string): void {
    const terminal = this.getTerminal?.() ?? null;
    if (!terminal) {
      notify(t('docker.terminalUnavailable'), { variant: 'danger' });
      return;
    }
    if (!CONTAINER_NAME_RE.test(container)) return; // 名称来自 API 响应，仍防御性复验
    const command = `docker exec -it ${container} sh -c 'exec bash 2>/dev/null || exec sh'`;
    if (!terminal.insertSnippet(command, true)) {
      notify(t('docker.terminalUnavailable'), { variant: 'danger' });
      return;
    }
    this.close();
  }

  /** 打开容器升级弹窗：预填当前镜像，用户可改版本号或保持不变（拉取后重建）。 */
  openUpgrade(container: string): void {
    if (this.serverId === null) return;
    const modal = document.getElementById('docker-upgrade-modal');
    const nameSpan = document.getElementById('docker-upgrade-container-name');
    const imageSpan = document.getElementById('docker-upgrade-current-image');
    const input = document.getElementById('docker-upgrade-image-input') as HTMLInputElement | null;
    const progress = document.getElementById('docker-upgrade-progress');
    const keepBackup = document.getElementById('docker-upgrade-keep-backup') as HTMLInputElement | null;
    const confirmBtn = document.getElementById('docker-upgrade-confirm-btn') as HTMLButtonElement | null;
    if (!modal || !nameSpan || !imageSpan || !input || !progress) return;
    const current = this.containers.find((item) => item.name === container)?.image ?? '';
    nameSpan.textContent = container;
    imageSpan.textContent = current || '—';
    input.value = current;
    progress.classList.add('hidden');
    progress.textContent = '';
    if (keepBackup) keepBackup.checked = false;
    confirmBtn?.removeAttribute('disabled');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    input.focus();
  }

  closeUpgrade(): void {
    const modal = document.getElementById('docker-upgrade-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  private async handleUpgrade(): Promise<void> {
    if (this.serverId === null || this.busy) return;
    const modal = document.getElementById('docker-upgrade-modal');
    const nameSpan = document.getElementById('docker-upgrade-container-name');
    const input = document.getElementById('docker-upgrade-image-input') as HTMLInputElement | null;
    const keepBackup = document.getElementById('docker-upgrade-keep-backup') as HTMLInputElement | null;
    const progress = document.getElementById('docker-upgrade-progress');
    const confirmBtn = document.getElementById('docker-upgrade-confirm-btn') as HTMLButtonElement | null;
    const container = nameSpan?.textContent?.trim() || '';
    const image = input?.value.trim() || '';
    if (!container || !image || !progress) return;
    if (!CONTAINER_NAME_RE.test(container)) return;
    this.busy = true;
    confirmBtn?.setAttribute('disabled', '');
    modal?.setAttribute('inert', '');
    progress.classList.remove('hidden');
    progress.textContent = `${t('docker.upgradeRunning')}\n`;
    try {
      const response = await fetch(`/api/docker/${this.serverId}/upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container, image, keep_backup: keepBackup?.checked ?? false }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; steps?: string[]; rolledBack?: boolean; logs?: string;
        backupRemoved?: boolean; backupName?: string; keepBackup?: boolean;
      };
      const stepsText = (payload.steps || []).map((line) => `· ${line}`).join('\n');
      if (!response.ok || payload.ok !== true) {
        progress.textContent = `${stepsText}\n✗ ${payload.error || `HTTP ${response.status}`}`;
        if (payload.logs) progress.textContent += `\n${payload.logs}`;
        const notice = payload.rolledBack
          ? t('docker.upgradeRolledBack', { message: payload.error || '' })
          : t('docker.actionFailed', { message: payload.error || `HTTP ${response.status}` });
        progress.textContent += `\n↩ ${notice}`;
        notify(notice, { variant: 'danger' });
      } else {
        const kept = payload.keepBackup || !payload.backupRemoved;
        progress.textContent = `${stepsText}\n✓ ${kept && payload.backupName ? t('docker.backupKept', { name: payload.backupName }) : t('docker.upgradeDone')}`;
        notify(t('docker.actionDone', { action: t('docker.upgrade'), name: container }), { variant: 'success' });
        this.closeUpgrade();
      }
    } catch (error) {
      progress.textContent += `✗ ${error instanceof Error ? error.message : String(error)}`;
      notify(t('docker.actionFailed', { message: error instanceof Error ? error.message : String(error) }), { variant: 'danger' });
    } finally {
      this.busy = false;
      confirmBtn?.removeAttribute('disabled');
      modal?.removeAttribute('inert');
      this.refresh();
    }
  }

  /** 升级弹窗确认按钮入口（public 供 initDockerPanel 绑定）。 */
  handleUpgradePublic(): Promise<void> {
    return this.handleUpgrade();
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
  document.getElementById('docker-upgrade-close-btn')?.addEventListener('click', () => dockerPanel.closeUpgrade());
  document.getElementById('docker-upgrade-cancel-btn')?.addEventListener('click', () => dockerPanel.closeUpgrade());
  document.getElementById('docker-upgrade-modal-backdrop')?.addEventListener('click', () => dockerPanel.closeUpgrade());
  document.getElementById('docker-upgrade-confirm-btn')?.addEventListener('click', () => void dockerPanel.handleUpgradePublic());
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
      const upgradeModal = document.getElementById('docker-upgrade-modal');
      if (!upgradeModal?.classList.contains('hidden')) {
        dockerPanel.closeUpgrade();
        return;
      }
      dockerPanel.close();
    }
  });
}
