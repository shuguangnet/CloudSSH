import { test, expect, type Page } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

/**
 * 终端左右分屏回归：
 * 标签栏 ➕ 旁的分屏按钮把终端区拆为左右两个窗格，
 * 每个窗格显示一个标签的终端，可拖拽分隔条调整宽度。
 */

const SERVERS_FIXTURE = [
  { id: 7, name: 'fixture-vps', host: 'dm.us.933999.xyz', port: 22, username: 'root', auth_method: 'publickey', transport_type: 'direct', tags: [], jump_server_id: null },
  { id: 8, name: 'fixture-vps-2', host: 'alt.example.org', port: 22, username: 'root', auth_method: 'publickey', transport_type: 'direct', tags: [], jump_server_id: null },
];

async function installTestWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class TestWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = TestWebSocket.CONNECTING;
      binaryType = 'blob';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private ready = false;

      constructor(url: string | URL) {
        this.url = String(url);
        setTimeout(() => {
          this.readyState = TestWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        }, 0);
      }

      send(data: string): void {
        let message: any;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (message?.type === 'ping') {
          setTimeout(() => this.emitJSON({ type: 'pong', id: message.id }), 0);
          return;
        }
        if (message?.type === 'resize' && !this.ready) {
          this.ready = true;
          setTimeout(() => {
            this.emitJSON({ type: 'status', event: 'auth_success', message: '认证成功' });
            this.emitJSON({ type: 'status', event: 'shell_ready', message: 'Shell 已就绪' });
          }, 0);
        }
      }

      close(): void {
        if (this.readyState === TestWebSocket.CLOSED) return;
        this.readyState = TestWebSocket.CLOSED;
        setTimeout(() => this.onclose?.(new CloseEvent('close', { code: 1000, wasClean: true })), 0);
      }

      private emitJSON(message: unknown): void {
        if (this.readyState !== TestWebSocket.OPEN) return;
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: TestWebSocket,
    });
  });
}

async function mockSession(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', route =>
    route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route =>
    route.fulfill({ json: { githubAuthEnabled: true, turnstileEnabled: false, automationEnabled: false } }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', route => route.fulfill({ json: SERVERS_FIXTURE }));
  await page.route('**/api/servers/7/connect', route =>
    route.fulfill({ json: { wsUrl: 'ws://127.0.0.1:4173/api/ssh?token=42:split-7' } }));
  await page.route('**/api/servers/8/connect', route =>
    route.fulfill({ json: { wsUrl: 'ws://127.0.0.1:4173/api/ssh?token=42:split-8' } }));
}

/** 连接两台服务器形成两个标签（后连接的为当前标签） */
async function connectBothServers(page: Page): Promise<void> {
  await page.goto('/?lang=zh-CN');
  await page.locator('#connect-7').click();
  await expect(page.locator('#terminal-section')).toBeVisible();
  await expect(page.locator('#term-status')).toContainText('已连接');
  // 从连接页回到服务器列表再连第二台
  await page.locator('#new-tab-btn').click();
  await expect(page.locator('#user-space-section')).toBeVisible();
  await page.locator('#connect-8').click();
  await expect(page.locator('#term-status')).toContainText('已连接');
  await expect(page.locator('#tab-bar .tab-item')).toHaveCount(2);
}

test.use({ viewport: { width: 1440, height: 900 } });

test('分屏显示两个标签并在窗格间切换焦点', async ({ page }) => {
  await installTestWebSocket(page);
  await mockSession(page);
  await connectBothServers(page);

  // 开启分屏：当前标签在左窗格，另一标签在右窗格
  const splitBtn = page.locator('#split-view-btn');
  await expect(splitBtn).toBeVisible();
  await splitBtn.click();

  const area = page.locator('#terminal-area');
  await expect(area).toHaveClass(/split-active/);
  const leftPane = page.locator('#split-pane-left');
  const rightPane = page.locator('#split-pane-right');
  await expect(leftPane).toBeVisible();
  await expect(rightPane).toBeVisible();
  await expect(page.locator('.split-empty-pane')).toHaveCount(0);

  // 左窗格显示当前标签（fixture-vps-2），右窗格显示另一个标签
  const activeTabId = await page.locator('.tab-item.active').getAttribute('data-tab-id');
  await expect(leftPane.locator(`#terminal-container-${activeTabId}`)).toHaveCount(1);
  const otherTab = page.locator('.tab-item.in-split-pane');
  await expect(otherTab).toHaveCount(1);
  const otherTabId = await otherTab.getAttribute('data-tab-id');
  await expect(rightPane.locator(`#terminal-container-${otherTabId}`)).toHaveCount(1);
  // 状态栏当前显示左窗格（聚焦）标签的主机
  await expect(page.locator('#term-host')).toContainText('alt.example.org');

  // 点击右窗格：焦点切换，状态栏跟随，标签栏 active 变化
  await rightPane.click({ position: { x: 60, y: 120 } });
  await expect(page.locator('.tab-item.active')).toHaveAttribute('data-tab-id', otherTabId!);
  await expect(page.locator('#term-host')).toContainText('dm.us.933999.xyz');
  await expect(rightPane).toHaveClass(/split-pane-focused/);

  // 点击标签栏中左窗格的标签 → 焦点切回左窗格（不改变布局）
  await page.locator(`.tab-item[data-tab-id="${activeTabId}"]`).click();
  await expect(page.locator('.tab-item.active')).toHaveAttribute('data-tab-id', activeTabId!);
  await expect(page.locator('#term-host')).toContainText('alt.example.org');
  await expect(leftPane.locator(`#terminal-container-${activeTabId}`)).toHaveCount(1);

  // 退出分屏：恢复单栏，仅当前标签可见
  await splitBtn.click();
  await expect(area).not.toHaveClass(/split-active/);
  await expect(page.locator('#split-pane-left')).toHaveCount(0);
  await expect(page.locator('#split-divider')).toHaveCount(0);
  await expect(page.locator('#split-pane-right')).toHaveCount(0);
  await expect(page.locator(`#terminal-container-${activeTabId}`)).toBeVisible();
  await expect(page.locator(`#terminal-container-${otherTabId}`)).toBeHidden();
});

test('空窗格可通过新建连接填充，关闭窗格标签自动回退', async ({ page }) => {
  await installTestWebSocket(page);
  await mockSession(page);

  // 只连接一台服务器后分屏：右窗格为空
  await page.goto('/?lang=zh-CN');
  await page.locator('#connect-7').click();
  await expect(page.locator('#term-status')).toContainText('已连接');
  await page.locator('#split-view-btn').click();
  await expect(page.locator('#split-pane-left')).toBeVisible();
  const rightPane = page.locator('#split-pane-right');
  await expect(rightPane.locator('.split-empty-pane')).toBeVisible();
  await expect(rightPane.locator('.split-empty-new-btn')).toContainText('新建连接到此分栏');

  // 空窗格按钮 → 连接页 → 连接第二台服务器：新标签落在右窗格
  await rightPane.locator('.split-empty-new-btn').click();
  await expect(page.locator('#user-space-section')).toBeVisible();
  await page.locator('#connect-8').click();
  await expect(page.locator('#terminal-section')).toBeVisible();
  await expect(rightPane.locator('.split-empty-pane')).toHaveCount(0);
  const activeTabId = await page.locator('.tab-item.active').getAttribute('data-tab-id');
  await expect(rightPane.locator(`#terminal-container-${activeTabId}`)).toHaveCount(1);
  await expect(page.locator('.split-empty-pane')).toHaveCount(0);

  // 关闭右窗格的标签：右窗格回退为空窗格（仅两标签且左窗格仍占用一个）
  await page.locator(`.tab-item[data-tab-id="${activeTabId}"] .tab-close`).click();
  await expect(rightPane.locator('.split-empty-pane')).toBeVisible();
  await expect(page.locator('#tab-bar .tab-item')).toHaveCount(1);
  // 焦点回到左窗格标签
  await expect(page.locator('.tab-item.active .tab-label')).toHaveText('fixture-vps');
  await expect(page.locator('#term-host')).toContainText('dm.us.933999.xyz');

  // 关闭最后一个标签：自动退出分屏并回到连接页
  await page.locator('.tab-item .tab-close').click();
  await expect(page.locator('#terminal-area')).not.toHaveClass(/split-active/);
  await expect(page.locator('#split-pane-left')).toHaveCount(0);
  await expect(page.locator('#user-space-section')).toBeVisible();
});

test('拖拽分隔条调整窗格宽度', async ({ page }) => {
  await installTestWebSocket(page);
  await mockSession(page);
  await connectBothServers(page);

  await page.locator('#split-view-btn').click();
  const leftPane = page.locator('#split-pane-left');
  const divider = page.locator('#split-divider');
  await expect(leftPane).toBeVisible();
  await expect(divider).toBeVisible();

  const before = (await leftPane.boundingBox())!.width;
  const dividerBox = (await divider.boundingBox())!;

  // 拖到约 30% 宽度位置
  const areaBox = (await page.locator('#terminal-area').boundingBox())!;
  const targetX = areaBox.x + areaBox.width * 0.3;
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, dividerBox.y + 10, { steps: 8 });
  await page.mouse.up();

  const after = (await leftPane.boundingBox())!.width;
  expect(after).toBeLessThan(before - 100); // 明显变窄（20% 钳制内）
  expect(after).toBeGreaterThan(areaBox.width * 0.15);

  // 双击分隔条复位 50/50
  await divider.dblclick();
  const reset = (await leftPane.boundingBox())!.width;
  expect(Math.abs(reset - areaBox.width / 2)).toBeLessThan(10);
});
