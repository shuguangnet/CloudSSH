// 服务器状态弹窗：按需通过 /api/automation/status/:id 采集实时系统指标
// （运行时长 / CPU / 负载 / 内存 / 交换 / 磁盘 / 网络速率 / CPU 型号 / 系统），
// 打开期间默认每 5 秒自动刷新，关闭即停止轮询并中止在途请求。
// 指标主体来自 status-view.ts：终端状态栏的实时抽屉复用同一套渲染。
import { t } from './i18n';
import { notify } from './ui-feedback';
import {
  type ServerStatusPayload,
  renderStatusError,
  renderStatusLoading,
  renderStatusMetrics,
} from './status-view';

const REFRESH_INTERVAL_MS = 5000;

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
    body.innerHTML = renderStatusLoading(t('server.status.collecting'));
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
    body.innerHTML = renderStatusError(message);
    // 抽屉与弹窗共用同一段错误视图，ID 由各自的使用方补上（避免同时存在时重复 ID）。
    const retry = body.querySelector<HTMLButtonElement>('.status-retry-btn');
    if (retry) {
      retry.id = 'status-retry-btn';
      retry.addEventListener('click', () => this.refresh());
    }
    if (this.failures >= 2) {
      const auto = document.getElementById('status-auto-refresh') as HTMLInputElement | null;
      if (auto) auto.checked = false;
      notify(t('server.status.fetchFailed'), { variant: 'danger' });
    }
  }

  private render(payload: ServerStatusPayload): void {
    const body = document.getElementById('status-modal-body');
    if (!body) return;
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    body.innerHTML = renderStatusMetrics(payload, this.serverName);
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
