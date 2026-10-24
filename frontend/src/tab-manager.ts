import { AgentPanel } from './agent/agent-panel';
import { copyTextToClipboard } from './clipboard';
import { maskIPAddress } from './host-display';
import { t } from './i18n';
import { getNetworkQuality } from './network-quality';
import { SFTPPanel } from './sftp-panel';
import { SSHTerminal, type TerminalSelectionAnchor } from './terminal';
import { isTerminalCinemaActive } from './terminal-fullscreen';
import { notify } from './ui-feedback';

export type TabState = 'connecting' | 'connected' | 'disconnected';

export interface TabInfo {
  id: string;
  label: string;
  terminal: SSHTerminal;
  sftpPanel: SFTPPanel | null;
  agentPanel: AgentPanel | null;
  containerEl: HTMLElement;
  hostInfo?: { host: string; port: number; username?: string; serverId?: number };
  state: TabState;
  cfLatency?: number;
  cfColo?: string;
  wsLatency?: number;
  selectedText: string;
  selectionAnchor: TerminalSelectionAnchor | null;
  /** 连接就绪后自动展开 SFTP 抽屉（服务器卡片「文件」入口，消费一次即失效） */
  autoOpenSftp?: boolean;
}

/**
 * TabManager — 管理多个 SSH 会话标签页
 *
 * 每个标签页拥有独立的 SSHTerminal 实例和 SFTPPanel 实例。
 * 切换标签通过隐藏/显示对应的终端容器来实现，WebSocket 连接始终保持。
 *
 * 左右分屏（splitMode）：#terminal-area 切换为 flex 布局，拆为
 * 「左窗格 + 拖拽分隔条 + 右窗格」；每个窗格显示一个标签的容器。
 * activeTabId 恒为聚焦窗格中的标签（焦点窗格点击/切换标签即跟随），
 * 状态栏、SFTP/Agent 抽屉等“当前标签”能力均作用于聚焦窗格。
 */
export class TabManager {
  private tabs: Map<string, TabInfo> = new Map();
  private activeTabId: string | null = null;
  private tabBarEl: HTMLElement;
  private terminalAreaEl: HTMLElement;
  private tabCounter = 0;
  private _isLoggedIn: boolean = false;

  /** 左右分屏：是否开启；聚焦窗格；左右窗格各自显示的标签 ID（null = 空窗格） */
  private splitMode = false;
  private splitFocusedPane: 'left' | 'right' = 'left';
  private paneTabIds: { left: string | null; right: string | null } = { left: null, right: null };
  /** 最近访问的标签 ID（新的在前），用于分屏挑选“另一窗格”与回退标签 */
  private recentTabIds: string[] = [];

  /** 标签右键菜单的 document click 监听器（关闭菜单时统一移除，防止累积） */
  private tabCtxCloseHandler: ((e: MouseEvent) => void) | null = null;

  /** 当所有标签都被关闭时触发，外部可以用它来回到连接页面 */
  private onAllTabsClosed?: () => void;

  /** 连接后检测到远端操作系统时触发（用于更新服务器列表图标） */
  private onOSDetected?: (serverId: number, os: string) => void;

  /** 标签数量变化时触发（用于同步返回终端按钮显隐等） */
  private onTabsChanged?: () => void;

  /** 克隆会话请求回调 */
  private onDuplicateTab?: (tab: TabInfo) => void;
  private onSftpAutoOpen?: (tab: TabInfo) => void;

  constructor(tabBarId: string, terminalAreaId: string) {
    this.tabBarEl = document.getElementById(tabBarId)!;
    this.terminalAreaEl = document.getElementById(terminalAreaId)!;
  }

  setLoggedIn(loggedIn: boolean): void {
    this._isLoggedIn = loggedIn;
    this.updateSelectionAction();
  }

  setAllTabsClosedHandler(handler: () => void): void {
    this.onAllTabsClosed = handler;
  }

  setOSDetectedHandler(handler: (serverId: number, os: string) => void): void {
    this.onOSDetected = handler;
  }

  setTabsChangedHandler(handler: () => void): void {
    this.onTabsChanged = handler;
  }

  setDuplicateTabHandler(handler: (tab: TabInfo) => void): void {
    this.onDuplicateTab = handler;
  }

  /**
   * 标记指定标签在 SSH 就绪后自动展开 SFTP 抽屉。
   * 供主页面服务器卡片「文件」入口使用：连上即看文件，无需先手动开终端抽屉。
   */
  markSftpAutoOpen(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.autoOpenSftp = true;
  }

  /**
   * SSH 就绪且 SFTP 面板已初始化时回调（用于联动抽屉分段条）。
   * 仅在 autoOpenSftp 标记被消费时触发一次。
   */
  setSftpAutoOpenHandler(handler: (tab: TabInfo) => void): void {
    this.onSftpAutoOpen = handler;
  }

  // ==================== 创建标签 ====================

  createTab(
    label: string,
    hostInfo?: { host: string; port: number; username?: string; serverId?: number }
  ): TabInfo {
    const id = `tab-${++this.tabCounter}-${Date.now()}`;

    // 创建终端容器（flex 布局，支持 AgentPanel 右侧分栏）
    const containerEl = document.createElement('div');
    containerEl.id = `terminal-container-${id}`;
    containerEl.className = 'absolute inset-0 overflow-hidden flex flex-row';
    containerEl.style.display = 'none';
    this.terminalAreaEl.appendChild(containerEl);

    // 内部终端包装器（flex-1 占满剩余空间）
    const terminalInner = document.createElement('div');
    terminalInner.id = `terminal-inner-${id}`;
    terminalInner.className = 'flex-1 min-w-0 relative overflow-hidden';
    containerEl.appendChild(terminalInner);

    // 创建 SSHTerminal 实例（挂在内部包装器上）
    const terminal = new SSHTerminal(terminalInner.id);

    // 设置会话关闭回调
    terminal.setSessionClosedHandler((_event, willReconnect) => {
      const tab = this.tabs.get(id);
      if (tab) {
        tab.state = willReconnect ? 'connecting' : 'disconnected';
        this.renderTabBar();
        if (this.activeTabId === id) {
          this.updateStatusBar(tab);
        }

        // 清理该标签的 SFTP 面板
        if (tab.sftpPanel) {
          tab.sftpPanel.dispose();
          tab.sftpPanel = null;
        }
        // 清理该标签的 Agent 面板
        if (tab.agentPanel) {
          tab.agentPanel.dispose();
          tab.agentPanel = null;
        }
        tab.selectedText = '';
        tab.selectionAnchor = null;
        this.updateSelectionAction(tab);
      }
    });

    // 设置 SSH 就绪回调：初始化 SFTP 面板 + Agent 面板
    terminal.setSessionReadyHandler(() => {
      const tab = this.tabs.get(id);
      if (tab) {
        tab.state = 'connected';
        this.renderTabBar();
        if (this.activeTabId === id) {
          this.updateStatusBar(tab);
        }

        // 初始化 SFTP 面板
        if (!tab.sftpPanel) {
          tab.sftpPanel = new SFTPPanel(
            () => tab.terminal.getSFTPWebSocketUrl(),
            () => tab.hostInfo?.serverId ?? null
          );
          tab.sftpPanel.bindEvents();
        }
        tab.sftpPanel.handleSSHReady();

        // 「文件」入口：就绪后自动展开 SFTP 抽屉（一次性消费）
        if (tab.autoOpenSftp) {
          tab.autoOpenSftp = false;
          this.onSftpAutoOpen?.(tab);
        }

        // 初始化 Agent 面板（仅登录用户）
        if (this._isLoggedIn && !tab.agentPanel) {
          tab.agentPanel = new AgentPanel(document.body, true, tab.hostInfo?.serverId);
          tab.agentPanel.render();
          tab.agentPanel.setWebSocketSend((data: string) =>
            tab.terminal.sendWebSocketMessage(data)
          );
          tab.agentPanel.setTerminalFillHandler(
            () => ({
              label: this.getTerminalTargetLabel(tab),
              available: this.activeTabId === tab.id && tab.state === 'connected',
            }),
            (command: string) => {
              const activeTab = this.getActiveTab();
              if (activeTab?.id !== tab.id || tab.state !== 'connected') return false;
              return tab.terminal.fillInput(command);
            }
          );
          tab.terminal.setAgentFrameHandler((msg: any) => {
            tab.agentPanel?.handleAgentFrame(msg);
          });
          // 互斥联动：Agent 打开前自动收起 SFTP 面板
          tab.agentPanel.setBeforeShowHandler(() => {
            tab.sftpPanel?.hide();
          });
          // AgentPanel 展开/收起时触发终端重新适配尺寸
          tab.agentPanel.setLayoutChangeHandler(() => tab.terminal.fit());
          this.updateSelectionAction(tab);
        }
      }
    });

    // 连接后检测到远端操作系统 → 通知外部更新服务器列表图标
    terminal.setOSDetectedHandler((serverId, os) => {
      this.onOSDetected?.(serverId, os);
    });

    // 设置延迟监测更新回调
    terminal.setLatencyUpdatedHandler((cfLatency, cfColo, wsLatency) => {
      const t = this.tabs.get(id);
      if (t) {
        t.cfLatency = cfLatency ?? undefined;
        t.cfColo = cfColo ?? undefined;
        t.wsLatency = wsLatency ?? undefined;
        if (this.activeTabId === id) {
          this.updateStatusBar(t);
        }
      }
    });

    const tab: TabInfo = {
      id,
      label,
      terminal,
      sftpPanel: null,
      agentPanel: null,
      containerEl,
      hostInfo,
      state: 'connecting',
      selectedText: '',
      selectionAnchor: null,
    };

    this.tabs.set(id, tab);
    this.recentTabIds.unshift(id);
    terminal.setSelectionChangeHandler((selection, anchor) => {
      const currentTab = this.tabs.get(id);
      if (!currentTab) return;
      currentTab.selectedText = selection;
      currentTab.selectionAnchor = anchor;
      if (this.activeTabId === id) {
        this.updateSelectionAction(currentTab);
      }
    });
    this.switchTab(id);
    this.renderTabBar();
    this.tabsChanged();

    return tab;
  }

  // ==================== 切换标签 ====================

  switchTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // 分屏模式：点击的标签进入聚焦窗格（或已显示在另一窗格时直接切换焦点）
    if (this.splitMode) {
      this.switchTabInSplit(tabId);
      return;
    }

    if (this.activeTabId === tabId) return;

    // 隐藏当前活跃标签的 SFTP 面板与 Agent 面板，以及容器本身
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prevTab = this.tabs.get(this.activeTabId);
      if (prevTab) {
        prevTab.agentPanel?.rejectPendingConfirmation(false);
        prevTab.agentPanel?.hide();
        prevTab.containerEl.style.display = 'none';
        prevTab.sftpPanel?.hide();
      }
    }

    // 显示目标标签
    tab.containerEl.style.display = 'flex';
    this.setActiveTab(tabId);
  }

  /**
   * 统一的“置为当前标签”内部入口：收起前一标签的抽屉、派发
   * cloudssh:active-terminal-change、挂载终端并同步状态栏/标签栏。
   * 不负责容器的显示与隐藏（单栏/分屏由各自调用方处理）。
   */
  private setActiveTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    if (this.activeTabId && this.activeTabId !== tabId) {
      const prevTab = this.tabs.get(this.activeTabId);
      if (prevTab) {
        prevTab.agentPanel?.rejectPendingConfirmation(false);
        prevTab.agentPanel?.hide();
        prevTab.sftpPanel?.hide();
      }
    }

    this.activeTabId = tabId;
    const recentIdx = this.recentTabIds.indexOf(tabId);
    if (recentIdx >= 0) this.recentTabIds.splice(recentIdx, 1);
    this.recentTabIds.unshift(tabId);

    document.body.classList.toggle('agent-panel-open', tab.agentPanel?.isOpen ?? false);
    document.dispatchEvent(new Event('cloudssh:active-terminal-change'));

    tab.terminal.mount();
    this.updateStatusBar(tab);
    this.updateSelectionAction(tab);
    this.renderTabBar();
  }

  // ==================== 左右分屏 ====================

  isSplitMode(): boolean {
    return this.splitMode;
  }

  /** 切换左右分屏（无标签时忽略） */
  toggleSplit(): void {
    if (this.splitMode) this.exitSplitMode();
    else this.enterSplitMode();
  }

  /** 焦点切到指定窗格（点击窗格内部时触发），该窗格标签成为当前标签 */
  focusPane(pane: 'left' | 'right'): void {
    if (!this.splitMode) return;
    if (this.splitFocusedPane !== pane) {
      this.splitFocusedPane = pane;
      const tabId = this.paneTabIds[pane];
      if (tabId && this.activeTabId !== tabId) this.setActiveTab(tabId);
    }
    this.renderSplitPanes();
  }

  private enterSplitMode(): void {
    if (this.splitMode) return;
    const active = this.getActiveTab();
    if (!active) return;

    this.splitMode = true;
    this.splitFocusedPane = 'left';
    // 当前标签留在左窗格；右窗格显示最近访问的另一个标签，没有则为空窗格
    this.paneTabIds = { left: active.id, right: this.pickReplacementTabId(active.id) };

    const left = document.createElement('div');
    left.id = 'split-pane-left';
    left.className = 'split-pane';
    left.addEventListener('mousedown', () => this.focusPane('left'), true);

    const divider = document.createElement('div');
    divider.id = 'split-divider';
    divider.className = 'split-divider';
    const handle = document.createElement('div');
    handle.className = 'split-divider-handle';
    divider.appendChild(handle);

    const right = document.createElement('div');
    right.id = 'split-pane-right';
    right.className = 'split-pane';
    right.addEventListener('mousedown', () => this.focusPane('right'), true);

    this.terminalAreaEl.append(left, divider, right);
    this.terminalAreaEl.classList.add('split-active');

    this.setupDividerDrag(divider);
    this.renderSplitPanes();
    this.renderTabBar();
    this.fitVisibleTerminals();
  }

  private exitSplitMode(): void {
    if (!this.splitMode) return;
    this.splitMode = false;
    this.terminalAreaEl.classList.remove('split-active');
    for (const id of ['split-pane-left', 'split-divider', 'split-pane-right']) {
      document.getElementById(id)?.remove();
    }
    // 所有容器回到终端区并隐藏，仅恢复显示当前标签
    for (const tab of this.tabs.values()) {
      this.terminalAreaEl.appendChild(tab.containerEl);
      tab.containerEl.style.display = 'none';
    }
    const active = this.getActiveTab();
    if (active) {
      active.containerEl.style.display = 'flex';
      active.terminal.mount();
    }
    this.paneTabIds = { left: null, right: null };
    this.renderTabBar();
    this.fitVisibleTerminals();
  }

  /** 分屏下点击标签：目标标签进入聚焦窗格；若已显示在另一窗格则只切换焦点 */
  private switchTabInSplit(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const focusedPane = this.splitFocusedPane;
    const otherPane = focusedPane === 'left' ? 'right' : 'left';

    if (this.paneTabIds[otherPane] === tabId) {
      // 已在另一窗格显示：焦点切过去，布局不变
      this.splitFocusedPane = otherPane;
      if (this.activeTabId !== tabId) this.setActiveTab(tabId);
      this.renderSplitPanes();
      return;
    }

    if (this.activeTabId === tabId) {
      // 就是聚焦窗格当前显示的标签：仅确保焦点样式同步
      this.renderSplitPanes();
      return;
    }

    // 新标签替换聚焦窗格内容；原窗格标签退回后台
    this.paneTabIds[focusedPane] = tabId;
    this.setActiveTab(tabId);
    this.renderSplitPanes();
    this.fitVisibleTerminals();
  }

  /** 按窗格状态同步两个窗格的 DOM（容器移动 / 空窗格占位 / 焦点高亮） */
  private renderSplitPanes(): void {
    const left = document.getElementById('split-pane-left');
    const right = document.getElementById('split-pane-right');
    if (!left || !right) return;

    // 兜底：active 标签不在任何窗格（异常状态）时放回聚焦窗格；
    // 焦点在空窗格时保留空占位，不得把 active 标签复制进来
    if (
      this.activeTabId &&
      this.activeTabId !== this.paneTabIds.left &&
      this.activeTabId !== this.paneTabIds.right
    ) {
      this.paneTabIds[this.splitFocusedPane] = this.activeTabId;
    }

    this.fillSplitPane(left, this.paneTabIds.left, 'left');
    this.fillSplitPane(right, this.paneTabIds.right, 'right');
    left.classList.toggle('split-pane-focused', this.splitFocusedPane === 'left');
    right.classList.toggle('split-pane-focused', this.splitFocusedPane === 'right');
  }

  private fillSplitPane(wrap: HTMLElement, tabId: string | null, pane: 'left' | 'right'): void {
    const tab = tabId ? this.tabs.get(tabId) ?? null : null;
    if (tab) {
      if (tab.containerEl.parentElement !== wrap) wrap.replaceChildren(tab.containerEl);
      tab.containerEl.style.display = 'flex';
    } else if (!wrap.querySelector('.split-empty-pane')) {
      // 已有空占位则不重建，避免把用户正在点击的按钮换掉（mousedown→重渲染→click 丢失）
      wrap.replaceChildren(this.createEmptyPaneEl(pane));
    }
  }

  /** 空窗格占位：提示文字 + 「新建连接」（复用标签栏 ➕ 的事件委托） */
  private createEmptyPaneEl(pane: 'left' | 'right'): HTMLElement {
    const el = document.createElement('div');
    el.className = 'split-empty-pane';
    el.appendChild(this.createIcon('splitscreen', '32px'));
    const text = document.createElement('div');
    text.className = 'split-empty-text';
    text.textContent = t('terminal.splitEmptyPane');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'split-empty-new-btn';
    btn.textContent = t('terminal.splitNewConnection');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 先把焦点切到空窗格，新建的标签会落在聚焦窗格
      this.focusPane(pane);
      document.getElementById('new-tab-btn')?.click();
    });
    el.append(text, btn);
    return el;
  }

  /** 分隔条拖拽：pointer capture 跟随，拖动结束后统一 fit，双击复位 50/50 */
  private setupDividerDrag(divider: HTMLElement): void {
    let dragging = false;
    const left = document.getElementById('split-pane-left');
    if (!left) return;

    const applyFromClientX = (clientX: number) => {
      const rect = this.terminalAreaEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(80, Math.max(20, pct));
      left.style.width = `${clamped.toFixed(2)}%`;
    };
    const stopDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        divider.releasePointerCapture(e.pointerId);
      } catch {
        /* 指针可能已释放 */
      }
      document.body.classList.remove('split-dragging');
      this.fitVisibleTerminals();
    };

    divider.addEventListener('pointerdown', (e) => {
      dragging = true;
      divider.setPointerCapture(e.pointerId);
      document.body.classList.add('split-dragging');
      e.preventDefault();
    });
    divider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      applyFromClientX(e.clientX);
    });
    divider.addEventListener('pointerup', stopDrag);
    divider.addEventListener('pointercancel', stopDrag);
    divider.addEventListener('dblclick', () => {
      left.style.width = '50%';
      this.fitVisibleTerminals();
    });
  }

  /** 全屏切换等外部入口：重算当前可见终端尺寸并下发 resize */
  fitTerminals(): void {
    this.fitVisibleTerminals();
  }

  /** 对分屏两个窗格（或单栏的当前标签）统一 fit；隐藏/未挂载的终端自动跳过 */
  private fitVisibleTerminals(): void {
    requestAnimationFrame(() => {
      if (this.splitMode) {
        for (const id of [this.paneTabIds.left, this.paneTabIds.right]) {
          if (!id) continue;
          this.tabs.get(id)?.terminal.fit();
        }
      } else {
        this.getActiveTab()?.terminal.fit();
      }
    });
  }

  /** 挑一个排除指定标签后最近访问的标签（用于另一窗格 / 窗格回退） */
  private pickReplacementTabId(excludeId: string | null): string | null {
    for (const id of this.recentTabIds) {
      if (!this.tabs.has(id)) continue;
      if (excludeId && id === excludeId) continue;
      return id;
    }
    return null;
  }

  private isInPane(tabId: string): boolean {
    return this.splitMode && (this.paneTabIds.left === tabId || this.paneTabIds.right === tabId);
  }

  // ==================== 关闭标签 ====================

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // 清理资源
    if (tab.sftpPanel) {
      tab.sftpPanel.dispose();
      tab.sftpPanel = null;
    }
    if (tab.agentPanel) {
      tab.agentPanel.dispose();
      tab.agentPanel = null;
    }
    tab.terminal.dispose();
    tab.containerEl.remove();
    this.tabs.delete(tabId);
    const recentIdx = this.recentTabIds.indexOf(tabId);
    if (recentIdx >= 0) this.recentTabIds.splice(recentIdx, 1);

    // 分屏模式：窗格回退/焦点迁移由分屏逻辑处理
    if (this.splitMode) {
      this.closeTabInSplit(tabId);
      this.renderTabBar();
      this.updateSelectionAction();
      this.tabsChanged();
      return;
    }

    // 如果关闭的是当前活跃标签，切换到其他标签
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      const remaining = Array.from(this.tabs.keys());
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        document.body.classList.remove('agent-panel-open');
        this.onAllTabsClosed?.();
      }
    }

    this.renderTabBar();
    this.updateSelectionAction();
    this.tabsChanged();
  }

  /** 分屏下关闭标签：被关窗格回退到最近的后台标签（无则空窗格），
   * 关闭当前标签时焦点留在同窗格的接替标签，否则迁到另一窗格；两窗格
   * 全空时自动退出分屏。 */
  private closeTabInSplit(closedTabId: string): void {
    const pane =
      this.paneTabIds.left === closedTabId
        ? 'left'
        : this.paneTabIds.right === closedTabId
          ? 'right'
          : null;

    if (pane) {
      const otherPane = pane === 'left' ? 'right' : 'left';
      this.paneTabIds[pane] = this.pickReplacementTabId(this.paneTabIds[otherPane]);
    }

    if (this.activeTabId === closedTabId) {
      this.activeTabId = null;
      const successorPane = pane ?? this.splitFocusedPane;
      const successorId = pane ? this.paneTabIds[pane] : null;
      if (successorId) {
        // 同窗格的接替标签直接接管焦点
        this.splitFocusedPane = successorPane;
        this.setActiveTab(successorId);
      } else {
        const otherPane = successorPane === 'left' ? 'right' : 'left';
        const otherTabId = this.paneTabIds[otherPane];
        if (otherTabId) {
          this.splitFocusedPane = otherPane;
          this.setActiveTab(otherTabId);
        } else if (!this.hasAnyTab()) {
          // 最后一个标签被关闭：退出分屏并回到连接页
          this.exitSplitMode();
          document.body.classList.remove('agent-panel-open');
          this.onAllTabsClosed?.();
          return;
        } else {
          this.exitSplitMode();
        }
      }
    }

    // 两个窗格都空（仍有后台标签）→ 退出分屏，切到最近标签
    if (!this.paneTabIds.left && !this.paneTabIds.right) {
      this.exitSplitMode();
      const fallback = this.pickReplacementTabId(null);
      if (fallback) this.switchTab(fallback);
    } else {
      this.renderSplitPanes();
      this.fitVisibleTerminals();
    }
  }

  closeAllTabs(): void {
    // 分屏窗格直接拆除，容器由下方循环统一清理
    if (this.splitMode) {
      this.splitMode = false;
      this.terminalAreaEl.classList.remove('split-active');
      for (const id of ['split-pane-left', 'split-divider', 'split-pane-right']) {
        document.getElementById(id)?.remove();
      }
      this.paneTabIds = { left: null, right: null };
    }
    this.recentTabIds = [];
    const tabIds = Array.from(this.tabs.keys());
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId);
      if (!tab) continue;

      if (tab.sftpPanel) {
        tab.sftpPanel.dispose();
        tab.sftpPanel = null;
      }
      if (tab.agentPanel) {
        tab.agentPanel.dispose();
        tab.agentPanel = null;
      }
      tab.terminal.dispose();
      tab.containerEl.remove();
    }

    this.tabs.clear();
    this.activeTabId = null;
    document.body.classList.remove('agent-panel-open');
    this.renderTabBar();
    this.updateSelectionAction();
    this.onAllTabsClosed?.();
    this.tabsChanged();
  }

  // ==================== 获取当前活跃标签 ====================

  getActiveTab(): TabInfo | null {
    if (!this.activeTabId) return null;
    return this.tabs.get(this.activeTabId) || null;
  }

  getTabCount(): number {
    return this.tabs.size;
  }

  hasAnyTab(): boolean {
    return this.tabs.size > 0;
  }

  /** 收起所有标签页的侧边抽屉（SFTP 面板与 AI Agent 面板） */
  closeAllDrawers(): void {
    for (const tab of this.tabs.values()) {
      tab.agentPanel?.rejectPendingConfirmation(false);
      tab.agentPanel?.hide();
      tab.sftpPanel?.hide();
    }
    document.body.classList.remove('agent-panel-open');
  }

  private getTerminalTargetLabel(tab: TabInfo): string {
    if (!tab.hostInfo) return tab.label;
    const userPrefix = tab.hostInfo.username ? `${tab.hostInfo.username}@` : '';
    return `${tab.label} · ${userPrefix}${tab.hostInfo.host}:${tab.hostInfo.port}`;
  }

  refreshTranslations(): void {
    this.renderTabBar();
    const activeTab = this.getActiveTab();
    if (activeTab) this.updateStatusBar(activeTab);
  }

  // ==================== 关闭当前活跃标签 ====================

  closeActiveTab(): void {
    if (this.activeTabId) {
      this.closeTab(this.activeTabId);
    }
  }

  // ==================== 断开当前标签的连接 ====================

  disconnectActiveTab(): void {
    const tab = this.getActiveTab();
    if (!tab) return;

    if (tab.sftpPanel) {
      tab.sftpPanel.hide();
    }
    tab.agentPanel?.rejectPendingConfirmation(false);
    tab.agentPanel?.clearTerminalSelectionContext();
    tab.terminal.disconnect();
    tab.state = 'disconnected';
    tab.selectedText = '';
    tab.selectionAnchor = null;
    this.updateSelectionAction(tab);
    this.renderTabBar();
  }

  /** 将当前终端选区附加到 Agent 输入区，等待用户补充问题后发送。 */
  askAIAboutActiveSelection(): boolean {
    const tab = this.getActiveTab();
    const selection = tab?.selectedText || '';
    if (!tab?.agentPanel || !selection.trim()) return false;

    tab.sftpPanel?.hide();
    const attached = tab.agentPanel.attachTerminalSelection(
      selection,
      this.getTerminalTargetLabel(tab)
    );
    if (attached) {
      tab.terminal.clearSelection();
    }
    return attached;
  }

  // ==================== 渲染标签栏 ====================

  renderTabBar(): void {
    // 保留 new-tab-btn、split-view-btn 与全屏按钮，清除其他标签按钮
    const newTabBtn = this.tabBarEl.querySelector('#new-tab-btn');
    const existingSplitBtn = this.tabBarEl.querySelector('#split-view-btn');
    const existingFullscreenBtn = this.tabBarEl.querySelector('#terminal-fullscreen-btn');
    this.tabBarEl.replaceChildren();

    for (const tab of this.tabs.values()) {
      const inOtherPane = this.isInPane(tab.id) && tab.id !== this.activeTabId;
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item${tab.id === this.activeTabId ? ' active' : ''}${tab.state === 'disconnected' ? ' disconnected' : ''}${inOtherPane ? ' in-split-pane' : ''}`;
      tabEl.dataset.tabId = tab.id;

      // 状态指示点
      const dot = document.createElement('span');
      dot.className = `tab-dot ${this.tabDotClass(tab.state)}`;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.label;
      label.title = inOtherPane
        ? `${t('terminal.splitPaneHint')} · ${t('terminal.doubleClickToRename')}: ${tab.label}`
        : `${t('terminal.doubleClickToRename')}: ${tab.label}`;

      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.startRenameTab(tab, label);
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.title = t('terminal.closeTab');
      closeBtn.appendChild(this.createIcon('close', '14px'));

      tabEl.append(dot, label, closeBtn);

      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showTabContextMenu(tab, e.clientX, e.clientY);
      });

      // 点击标签切换
      tabEl.addEventListener('click', (e) => {
        // 如果点击的是关闭按钮，不触发切换
        if ((e.target as HTMLElement).closest('.tab-close')) return;
        this.switchTab(tab.id);
      });

      // 关闭按钮
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });

      this.tabBarEl.appendChild(tabEl);
    }

    // 追加 new-tab-btn
    if (newTabBtn) {
      this.tabBarEl.appendChild(newTabBtn);
    } else {
      const btn = document.createElement('button');
      btn.id = 'new-tab-btn';
      btn.className = 'tab-new-btn';
      btn.title = t('terminal.newConnection');
      btn.appendChild(this.createIcon('add', '16px'));
      this.tabBarEl.appendChild(btn);
    }

    // 追加左右分屏切换按钮（桌面端；desktop-terminal-action 在移动/平板隐藏）
    let splitBtn = existingSplitBtn as HTMLButtonElement | null;
    if (!splitBtn) {
      splitBtn = document.createElement('button');
      splitBtn.id = 'split-view-btn';
      splitBtn.type = 'button';
      splitBtn.className = 'tab-new-btn desktop-terminal-action';
      splitBtn.appendChild(this.createIcon('vertical_split', '16px'));
      splitBtn.addEventListener('click', () => this.toggleSplit());
    }
    splitBtn.title = this.splitMode ? t('terminal.exitSplitScreen') : t('terminal.splitScreen');
    splitBtn.setAttribute('aria-pressed', String(this.splitMode));
    splitBtn.classList.toggle('tab-split-active', this.splitMode);
    splitBtn.classList.toggle('hidden', this.tabs.size === 0);
    this.tabBarEl.appendChild(splitBtn);

    // 追加终端全屏按钮（桌面+移动通用；点击逻辑由 terminal-fullscreen 控制器委托处理）
    let fullscreenBtn = existingFullscreenBtn as HTMLButtonElement | null;
    if (!fullscreenBtn) {
      fullscreenBtn = document.createElement('button');
      fullscreenBtn.id = 'terminal-fullscreen-btn';
      fullscreenBtn.type = 'button';
      fullscreenBtn.className = 'tab-new-btn';
      fullscreenBtn.appendChild(this.createIcon('fullscreen', '16px'));
    }
    const cinemaActive = isTerminalCinemaActive();
    fullscreenBtn.title = cinemaActive ? t('terminal.exitFullscreen') : t('terminal.fullscreen');
    fullscreenBtn.setAttribute('aria-label', fullscreenBtn.title);
    fullscreenBtn.setAttribute('aria-pressed', String(cinemaActive));
    fullscreenBtn.classList.toggle('hidden', this.tabs.size === 0);
    this.tabBarEl.appendChild(fullscreenBtn);
  }

  private tabDotClass(state: TabState): string {
    if (state === 'connected') return 'tab-dot-connected';
    if (state === 'connecting') return 'tab-dot-connecting';
    return 'tab-dot-disconnected';
  }

  // ==================== 标签重命名与右键菜单 ====================

  renameTab(tabId: string, newLabel: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const trimmed = newLabel.trim();
    if (trimmed) tab.label = trimmed;
    // 空值/未变更时同样重新渲染，恢复原标签显示（避免重命名输入框卡在标签栏）
    this.renderTabBar();
    if (this.activeTabId === tabId) {
      this.updateStatusBar(tab);
    }
  }

  private startRenameTab(tab: TabInfo, labelEl: HTMLElement): void {
    const currentName = tab.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className =
      'tab-rename-input terminal-input px-1 py-0 text-xs w-28 bg-surface border border-outline-variant';
    input.value = currentName;
    input.maxLength = 40;

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      this.renameTab(tab.id, input.value);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        this.renderTabBar();
      }
    });
    input.addEventListener('blur', () => commit());
    input.addEventListener('click', (e) => e.stopPropagation());

    labelEl.replaceWith(input);
    input.focus();
    input.select();
  }

  closeOtherTabs(keepTabId: string): void {
    for (const tab of Array.from(this.tabs.values())) {
      if (tab.id !== keepTabId) {
        this.closeTab(tab.id);
      }
    }
  }

  private showTabContextMenu(tab: TabInfo, x: number, y: number): void {
    this.hideTabContextMenu();

    const menu = document.createElement('div');
    menu.id = 'tab-context-menu';
    menu.className =
      'fixed z-[100] cyber-box py-1 shadow-2xl text-xs bg-surface border border-outline-variant text-on-surface';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const items = [
      {
        label: t('terminal.renameTab'),
        icon: 'edit',
        action: () => {
          const tabEl = this.tabBarEl.querySelector(`[data-tab-id="${tab.id}"]`);
          const labelEl = tabEl?.querySelector('.tab-label') as HTMLElement | null;
          if (labelEl) this.startRenameTab(tab, labelEl);
        },
      },
      {
        label: t('terminal.duplicateTab'),
        icon: 'content_copy',
        action: () => {
          this.onDuplicateTab?.(tab);
        },
      },
      {
        label: t('terminal.closeOtherTabs'),
        icon: 'close_fullscreen',
        action: () => {
          this.closeOtherTabs(tab.id);
        },
      },
      {
        label: t('terminal.closeTab'),
        icon: 'close',
        action: () => {
          this.closeTab(tab.id);
        },
        className: 'text-error',
      },
    ];

    for (const item of items) {
      const itemEl = document.createElement('div');
      itemEl.className = `flex items-center gap-2 px-3 py-1.5 hover:bg-surface-variant cursor-pointer ${item.className || ''}`;
      itemEl.appendChild(this.createIcon(item.icon, '14px'));
      itemEl.appendChild(document.createTextNode(item.label));
      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hideTabContextMenu();
        item.action();
      });
      menu.appendChild(itemEl);
    }

    document.body.appendChild(menu);

    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.hideTabContextMenu();
      }
    };
    // capture 阶段挂载，确保菜单项等内部 stopPropagation 不影响包含性判断；
    // setTimeout(0) 避开部分平台 contextmenu 后紧跟的合成 click
    this.tabCtxCloseHandler = closeHandler;
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }

  private hideTabContextMenu(): void {
    // 统一移除 document 监听器：菜单项点击（stopPropagation）与外部点击均不残留
    if (this.tabCtxCloseHandler) {
      document.removeEventListener('click', this.tabCtxCloseHandler, true);
      this.tabCtxCloseHandler = null;
    }
    const existing = document.getElementById('tab-context-menu');
    existing?.remove();
  }

  private createIcon(name: string, size: string): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.style.fontSize = size;
    icon.textContent = name;
    return icon;
  }

  private setStatusIndicator(el: HTMLElement | null, dotClass: string, text: string): void {
    if (!el) return;
    const dot = document.createElement('span');
    dot.className = `${dotClass} inline-block`;
    el.replaceChildren(dot, document.createTextNode(text));
  }

  // ==================== 状态栏同步 ====================

  private updateStatusBar(tab: TabInfo): void {
    const termHost = document.getElementById('term-host');
    const termUser = document.getElementById('term-user');
    const termPort = document.getElementById('term-port');
    const termStatus = document.getElementById('term-status');
    const statusText = document.getElementById('status-text');

    if (tab.hostInfo) {
      if (termHost) {
        const masked = maskIPAddress(tab.hostInfo.host);
        if (masked) {
          const copyIPLabel = t('terminal.clickToCopyIP');
          const badge = document.createElement('button');
          badge.type = 'button';
          badge.className = 'host-ip-badge';
          badge.title = copyIPLabel;
          badge.setAttribute('aria-label', copyIPLabel);
          badge.textContent = masked;
          termHost.replaceChildren(document.createTextNode(t('terminal.hostLabel')), badge);
          badge.addEventListener('click', async () => {
            const ok = await copyTextToClipboard(tab.hostInfo!.host);
            if (ok) {
              badge.classList.add('host-ip-copied');
              setTimeout(() => badge.classList.remove('host-ip-copied'), 800);
              notify(t('terminal.ipCopied'), { variant: 'success', duration: 1500 });
            } else {
              notify(t('terminal.ipCopyFailed'), { variant: 'danger' });
            }
          });
        } else {
          termHost.textContent = t('terminal.host', { value: tab.hostInfo.host });
        }
      }
      if (termUser)
        termUser.textContent = tab.hostInfo.username
          ? t('terminal.user', { value: tab.hostInfo.username })
          : '';
      if (termPort) termPort.textContent = t('terminal.port', { value: tab.hostInfo.port });
    } else {
      if (termHost) termHost.textContent = t('terminal.server', { value: tab.label });
      if (termUser) termUser.textContent = '';
      if (termPort) termPort.textContent = '';
    }

    if (tab.state === 'connected') {
      this.setStatusIndicator(termStatus, 'w-2 h-2 bg-primary-container', t('terminal.connected'));
      this.setStatusIndicator(
        statusText,
        'w-2 h-2 bg-[var(--accent)] animate-pulse',
        t('auth.statusOnline')
      );
    } else if (tab.state === 'connecting') {
      this.setStatusIndicator(
        termStatus,
        'w-2 h-2 bg-primary-container animate-pulse',
        t('terminal.connecting')
      );
    } else {
      this.setStatusIndicator(termStatus, 'w-2 h-2 bg-[var(--error)]', t('terminal.disconnected'));
      this.setStatusIndicator(statusText, 'w-2 h-2 bg-surface-dot', t('auth.statusOffline'));
    }

    // 更新状态栏显示延迟信息
    const termInfo = document.getElementById('term-info');
    if (termInfo) {
      if (tab.state === 'connected') {
        const latencyItems: { label: string; quality: string }[] = [];
        if (tab.cfLatency !== undefined) {
          latencyItems.push({
            label: `CF-${tab.cfColo || 'UNK'}: ${tab.cfLatency}ms`,
            quality: getNetworkQuality(tab.cfLatency, 'cf'),
          });
        }
        if (tab.wsLatency !== undefined) {
          latencyItems.push({
            label: `RTT: ${tab.wsLatency}ms`,
            quality: getNetworkQuality(tab.wsLatency, 'ws'),
          });
        }
        if (latencyItems.length > 0) {
          const fragment = document.createDocumentFragment();
          fragment.appendChild(document.createTextNode('⚡ '));
          for (const [index, item] of latencyItems.entries()) {
            if (index > 0) {
              const separator = document.createElement('span');
              separator.className = 'network-latency-separator';
              separator.setAttribute('aria-hidden', 'true');
              separator.textContent = '|';
              fragment.appendChild(separator);
            }
            const itemEl = document.createElement('span');
            itemEl.className = 'network-latency-item';
            const dot = document.createElement('span');
            dot.className = `network-quality-dot network-quality-${item.quality}`;
            dot.setAttribute('aria-hidden', 'true');
            itemEl.append(dot, document.createTextNode(item.label));
            fragment.appendChild(itemEl);
          }
          termInfo.replaceChildren(fragment);
        } else {
          termInfo.textContent = '';
        }
      } else {
        termInfo.textContent = '';
      }
    }
  }

  private updateSelectionAction(tab: TabInfo | null = this.getActiveTab()): void {
    const button = document.getElementById('ask-ai-selection-btn');
    if (!button) return;
    const visible = !!(
      this._isLoggedIn &&
      tab &&
      tab.id === this.activeTabId &&
      tab.state === 'connected' &&
      tab.agentPanel &&
      tab.selectedText.trim() &&
      tab.selectionAnchor
    );
    button.classList.toggle('hidden', !visible);
    if (!visible || !tab?.selectionAnchor) return;

    const gap = 12;
    const viewportPadding = 8;
    const { clientX, clientY } = tab.selectionAnchor;
    const terminalBounds = tab.containerEl.getBoundingClientRect();
    let left = clientX + gap;
    let top = clientY + gap;

    if (left + button.offsetWidth > terminalBounds.right - viewportPadding) {
      left = clientX - button.offsetWidth - gap;
    }
    if (top + button.offsetHeight > terminalBounds.bottom - viewportPadding) {
      top = clientY - button.offsetHeight - gap;
    }

    button.style.left = `${Math.max(terminalBounds.left + viewportPadding, left)}px`;
    button.style.top = `${Math.max(terminalBounds.top + viewportPadding, top)}px`;
  }

  private tabsChanged(): void {
    this.onTabsChanged?.();
  }
}
