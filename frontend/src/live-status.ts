// 终端状态栏实时监控：单一订阅源 + 顶栏胶囊 + 自动展开的状态抽屉。
//
// 后端为每个 (owner, server) 只跑一个采样器（见 standalone/live-status.mjs），
// 前端因此只开一条流：
//   1. 优先 SSE（/api/automation/status/live/:id/stream），断线后指数退避重连；
//   2. SSE 连不上（代理截流 / 事件源不被支持）时降级为长轮询
//      （/api/automation/status/live/:id），长轮询自带下一次请求，天然无限循环。
// 采样器在最后一个观众离开 IDLE_TTL 后自行停机、SSH 链回池，因此切走标签或
// 隐藏窗口时前端只要断开流，成本控制就交给后端，不需要前端再算节流。
import { onLocaleChange, t } from './i18n';
import {
  type ServerStatusPayload,
  formatRateCompact,
  formatUptimeCompact,
  percentCompact,
  renderStatusError,
  renderStatusLoading,
  renderStatusMetrics,
  usageLevel,
} from './status-view';
import { escapeHtml } from './sftp-helpers';

/** SSE 连续失败多少次后判定为“此路不通”，切长轮询 */
const SSE_FAILURE_THRESHOLD = 2;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** 超过这么长时间没新帧就标记“陈旧”（≈ 2 个默认采样周期） */
const STALE_AFTER_MS = 9000;
const STALE_CHECK_INTERVAL_MS = 2000;

type Connection = 'connecting' | 'live' | 'stale' | 'error';

export class LiveStatusMonitor {
  private serverId: number | null = null;
  private serverName = '';
  private controller: AbortController | null = null;
  private frame: ServerStatusPayload | null = null;
  private connection: Connection = 'connecting';
  private errorMessage = '';
  private sseFailures = 0;
  /** 本次监控是否已经首帧到达（首帧到达即自动展开抽屉） */
  private announced = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  /** 每次重新订阅自增；旧循环用它判断自己是否已过期 */
  private generation = 0;
  private waiters = new Set<() => void>();

  /** 是否正在监控某个服务器（决定顶栏胶囊与抽屉是否可用） */
  get active(): boolean {
    return this.serverId !== null;
  }

  get currentServerId(): number | null {
    return this.serverId;
  }

  get connectionState(): Connection {
    return this.connection;
  }

  /**
   * 切换监控目标。同一服务器重复调用是空操作：状态栏每次刷新都会同步一次，
   * 不能因此把正在跑的流断开重连。
   */
  watch(serverId: number | null, serverName: string): void {
    if (serverId === this.serverId) {
      this.serverName = serverName;
      return;
    }
    this.teardown();
    if (serverId === null) {
      this.render();
      return;
    }
    this.serverId = serverId;
    this.serverName = serverName;
    this.resetRunState();
    this.render();
    this.startStaleWatch();
    void this.connect();
  }

  stop(): void {
    this.teardown();
    this.render();
  }

  /** 语言切换后重新渲染（胶囊文本与抽屉标签是 JS 写入的，不在 data-i18n 体系内） */
  refreshLabels(): void {
    this.render();
  }

  /** 抽屉展开时补一次渲染（错误态下重新绑定重试按钮） */
  poke(): void {
    if (this.serverId === null || this.frame === null) this.render();
  }

  private resetRunState(): void {
    this.frame = null;
    this.connection = 'connecting';
    this.errorMessage = '';
    this.sseFailures = 0;
    this.announced = false;
    this.lastFrameAt = 0;
  }

  /** 断开当前传输但保留目标与最后一帧（窗口隐藏时用） */
  private suspend(): void {
    if (this.serverId === null) return;
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.clearReconnect();
    this.resolveWaiters();
    if (this.frame !== null) {
      this.connection = 'stale';
      this.render();
    }
  }

  private teardown(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.clearReconnect();
    this.resolveWaiters();
    if (this.staleTimer !== null) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.frame = null;
    this.serverId = null;
    this.lastFrameAt = 0;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resolveWaiters(): void {
    for (const done of [...this.waiters]) done();
    this.waiters.clear();
  }

  private startStaleWatch(): void {
    if (this.staleTimer !== null) clearInterval(this.staleTimer);
    // 采样器可能只是慢一拍（SSH 抖动、远端负载高）。超过两个周期没有新帧就
    // 把胶囊标成“陈旧”，但保留最后一次数值——比清空成“—”更有信息量。
    this.staleTimer = setInterval(() => {
      if (this.connection !== 'live' || this.frame === null) return;
      if (Date.now() - this.lastFrameAt > STALE_AFTER_MS) {
        this.connection = 'stale';
        this.render();
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  private async connect(): Promise<void> {
    if (this.serverId === null) return;
    if (document.visibilityState === 'hidden') return;
    const generation = this.generation;
    const serverId = this.serverId;
    if (this.sseFailures >= SSE_FAILURE_THRESHOLD) {
      await this.longPollLoop(serverId, generation);
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    let sawFrame = false;
    try {
      const response = await fetch(`/api/automation/status/live/${serverId}/stream`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      if (generation !== this.generation) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            if (this.consume(line.slice(6), generation)) sawFrame = true;
          }
          if (generation !== this.generation) return;
        }
      }
      if (generation !== this.generation) return;
      if (this.connection === 'error') return;
      if (sawFrame) {
        // 服务端或中间层主动收尾（空闲超时被切断、采样器换了一轮）。
        // 已经收到过帧说明这条路本来通，重新订阅即可；
        // 真正不可用的服务器会先送来 fatal 错误帧，落在上面的分支。
        this.sseFailures = 0;
        this.scheduleReconnect();
        return;
      }
      this.fail(t('server.status.streamEnded'));
      return;
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.sseFailures++;
      // 先如实报错，再交给长轮询兜底；不要让用户只看到“正在连接”。
      this.fail(error instanceof Error ? error.message : String(error));
      if (this.sseFailures >= SSE_FAILURE_THRESHOLD) {
        void this.connect();
        return;
      }
      this.scheduleReconnect();
      return;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
    if (generation !== this.generation) return;
    if (!sawFrame) this.sseFailures++;
    this.scheduleReconnect();
  }

  /**
   * 长轮询：每次请求拿到一帧（服务端最多挂一个采样周期），返回后立刻发下一发。
   * 它不依赖连接保持，因此 SSE 被中间层截断时仍能持续刷新。
   */
  private async longPollLoop(serverId: number, generation: number): Promise<void> {
    while (generation === this.generation && this.serverId === serverId) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const response = await fetch(`/api/automation/status/live/${serverId}`, { signal: controller.signal });
        if (generation !== this.generation) return;
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        const frame = (await response.json()) as Record<string, unknown>;
        if (generation !== this.generation) return;
        if (frame.type === 'pending') continue;
        if (frame.type === 'error') {
          this.fail(String(frame.message ?? t('server.status.fetchFailed')));
          // 终止态（指纹/权限）不重试；普通失败退避后继续。
          if (frame.fatal) return;
          await this.wait(RECONNECT_BASE_MS);
          continue;
        }
        this.accept(frame as unknown as ServerStatusPayload, generation);
      } catch (error) {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.fail(error instanceof Error ? error.message : String(error));
        await this.wait(RECONNECT_BASE_MS);
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    }
  }

  /** 等待时也要能被 teardown/suspend 立刻叫醒，否则旧循环会永久挂住 */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private consume(raw: string, generation: number): boolean {
    if (generation !== this.generation) return false;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (parsed.type === 'pending') return false;
    if (parsed.type === 'error') {
      this.fail(String(parsed.message ?? t('server.status.fetchFailed')));
      return false;
    }
    this.accept(parsed as unknown as ServerStatusPayload, generation);
    return true;
  }

  private accept(frame: ServerStatusPayload, generation: number): void {
    if (generation !== this.generation) return;
    this.frame = frame;
    this.connection = 'live';
    this.errorMessage = '';
    this.sseFailures = 0;
    this.lastFrameAt = Date.now();
    const first = !this.announced;
    this.announced = true;
    this.render();
    // 首帧到达即自动展开抽屉：用户点开终端就能看到实时状态，不必再找按钮。
    if (first) statusDrawer.autoShow();
  }

  private fail(message: string): void {
    this.connection = 'error';
    this.errorMessage = message;
    this.render();
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const generation = this.generation;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, this.sseFailures - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.generation) return;
      void this.connect();
    }, delay);
  }

  /** 切到后台就断开流（后端随之停机），回到前台再续上 */
  handleVisibility(): void {
    if (this.serverId === null) return;
    if (document.visibilityState === 'hidden') {
      this.suspend();
      return;
    }
    if (this.connection === 'stale' || this.controller === null) {
      this.connection = 'connecting';
      this.render();
      void this.connect();
    }
  }

  // ==================== 渲染：状态栏胶囊 + 抽屉主体 ====================

  private render(): void {
    this.renderPills();
    this.renderDrawer();
  }

  private renderPills(): void {
    const pills = document.getElementById('term-live-pills');
    if (!pills) return;
    if (this.serverId === null) {
      // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      pills.innerHTML = '';
      pills.classList.add('hidden');
      return;
    }
    pills.classList.remove('hidden');
    const frame = this.frame;
    const state = this.connection === 'error' ? 'error' : this.connection === 'stale' ? 'stale' : 'live';
    const items: string[] = [];
    if (frame) {
      items.push(pill('memory', percentCompact(frame.memory?.usage_percent), usageLevel(frame.memory?.usage_percent)));
      items.push(pill('hard_drive', percentCompact(frame.disk?.usage_percent), usageLevel(frame.disk?.usage_percent)));
      items.push(pill('arrow_downward', formatRateCompact(frame.network?.rx_bytes_per_sec), 'ok'));
      items.push(pill('arrow_upward', formatRateCompact(frame.network?.tx_bytes_per_sec), 'ok'));
      items.push(pill('schedule', formatUptimeCompact(frame.uptime_seconds), 'ok'));
    } else {
      items.push(pill('progress_activity', t('server.status.connecting'), 'ok', true));
    }
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    pills.innerHTML = items.join('');
    pills.dataset.state = state;
  }

  private renderDrawer(): void {
    const body = document.getElementById('status-panel-body');
    const title = document.getElementById('status-panel-host');
    const badge = document.getElementById('status-panel-badge');
    if (title) title.textContent = this.serverName;
    if (badge) {
      badge.textContent =
        this.connection === 'error'
          ? t('server.status.stateError')
          : this.connection === 'stale'
            ? t('server.status.stateStale')
            : this.connection === 'live'
              ? t('server.status.stateLive')
              : t('server.status.connecting');
      badge.dataset.state = this.connection;
    }
    if (!body) return;
    if (this.frame === null) {
      // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
      body.innerHTML =
        this.connection === 'error'
          ? renderStatusError(this.errorMessage || t('server.status.fetchFailed'))
          : renderStatusLoading(t('server.status.collecting'));
      body.querySelector('.status-retry-btn')?.addEventListener('click', () => {
        this.sseFailures = 0;
        this.connection = 'connecting';
        this.render();
        void this.connect();
      });
      return;
    }
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    const note =
      this.frame.network?.rx_bytes_per_sec === null && this.frame.network?.tx_bytes_per_sec === null
        ? `<p class="status-panel-note">${escapeHtml(t('server.status.firstSample'))}</p>`
        : '';
    body.innerHTML = renderStatusMetrics(this.frame, this.serverName) + note;
  }
}

function pill(icon: string, text: string, level: string, spinning = false): string {
  return `<span class="term-live-pill" data-level="${level}"><span class="material-symbols-outlined${spinning ? ' animate-spin' : ''}" aria-hidden="true">${icon}</span><span class="term-live-pill-text">${escapeHtml(text)}</span></span>`;
}

export const liveStatusMonitor = new LiveStatusMonitor();

// ==================== 状态抽屉开合 ====================

class StatusDrawer {
  private open = false;
  /** 用户主动收起后不再自动展开（直到切换服务器或手动再打开） */
  private dismissed = false;

  init(): void {
    document.getElementById('status-panel-close-btn')?.addEventListener('click', () => this.hide());
    document.getElementById('status-panel-backdrop')?.addEventListener('click', () => this.hide());
    document.getElementById('term-live-pills')?.addEventListener('click', () => this.toggle());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.open) this.hide();
    });
    onLocaleChange(() => liveStatusMonitor.refreshLabels());
    this.sync();
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) {
      this.hide();
      return;
    }
    this.show();
  }

  show(): void {
    this.dismissed = false;
    this.setOpen(true);
  }

  /** 用户主动收起：记住这个选择，本次连接内不再自动弹出 */
  hide(): void {
    this.dismissed = true;
    this.setOpen(false);
  }

  /** 首帧到达后的自动展开：不覆盖用户已收起的意愿 */
  autoShow(): void {
    if (this.open || this.dismissed) return;
    this.setOpen(true);
  }

  /** 切换终端标签时重置：新连接的自动展开应重新生效 */
  reset(): void {
    this.dismissed = false;
    this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    if (this.open === open) {
      this.sync();
      return;
    }
    this.open = open;
    this.sync();
    if (open) liveStatusMonitor.poke();
  }

  private sync(): void {
    const panel = document.getElementById('status-panel');
    const pills = document.getElementById('term-live-pills');
    pills?.setAttribute('aria-expanded', String(this.open));
    if (!panel) return;
    panel.classList.toggle('is-open', this.open);
    panel.setAttribute('aria-hidden', String(!this.open));
    // 用 display 而不是仅靠 transform：抽屉内是实时滚动的指标，
    // 收起后没有理由继续参与布局与无障碍树。
    panel.style.display = this.open ? 'flex' : 'none';
  }
}

export const statusDrawer = new StatusDrawer();

/**
 * 状态栏与抽屉的唯一同步入口：由 main.ts 在活跃标签/自动化开关变化时调用。
 * eligible 为 false（非自托管、URL 直连、无 serverId）时停表并清空胶囊。
 */
export function syncLiveStatus(serverId: number | null, serverName: string): void {
  if (serverId === null) {
    if (liveStatusMonitor.active) liveStatusMonitor.stop();
    statusDrawer.reset();
    return;
  }
  if (liveStatusMonitor.currentServerId !== serverId) statusDrawer.reset();
  liveStatusMonitor.watch(serverId, serverName);
}

export function initLiveStatus(): void {
  statusDrawer.init();
  document.addEventListener('visibilitychange', () => liveStatusMonitor.handleVisibility());
}
