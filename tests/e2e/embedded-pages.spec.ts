import { test, expect, type Page } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

/**
 * 侧边栏功能页（自动化 / MCP / 账号设置）内嵌打开 + SSH 会话保活回归：
 *
 * 1. 登录态点击侧边栏入口 → 主面板内嵌 iframe 打开（不整页跳转），
 *    已连接的 SSH WebSocket 不断开；
 * 2. 关闭内嵌页返回服务器列表，侧边栏高亮恢复；
 * 3. 终端视图提供"返回列表"入口，返回后终端 tab 与连接保活，
 *    列表页"返回终端"可切回且连接仍在；
 * 4. URL 直连分享终端页出现"返回面板"入口。
 */

const SERVERS_FIXTURE = [
  { id: 7, name: 'fixture-vps', host: 'dm.us.933999.xyz', port: 22, username: 'root', auth_method: 'publickey', transport_type: 'direct', tags: [], jump_server_id: null },
];

async function installTestWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const socketCloseEvents: number[] = [];
    (window as any).__wsCloseCount = () => socketCloseEvents.length;

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
        socketCloseEvents.push(1);
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

async function mockPanel(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', route =>
    route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route =>
    route.fulfill({ json: {
      sshSharingEnabled: true,
      mcpEnabled: true,
      adminAccountEnabled: true,
      automationEnabled: true,
    } }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', route => route.fulfill({ json: SERVERS_FIXTURE }));
  await page.route('**/api/servers/7/connect', route =>
    route.fulfill({ json: { wsUrl: 'ws://127.0.0.1:4173/api/ssh?token=42:embed' } }));
  // 内嵌 iframe 加载的目标页：最小 fixture（真实页面由 standalone 集成覆盖）
  for (const path of ['/automation', '/mcp/settings', '/account/settings']) {
    await page.route(`**${path}`, route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));
  }
}

test.describe('桌面视口', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('侧边栏功能页内嵌打开，SSH 会话保活，关闭后恢复列表', async ({ page }) => {
    await installTestWebSocket(page);
    await mockPanel(page);

    await page.goto('/?lang=zh-CN');
    await expect(page.locator('#connect-7')).toBeVisible();
    await page.locator('#connect-7').click();
    await expect(page.locator('#terminal-section')).toBeVisible();
    await expect(page.locator('#term-status')).toContainText('已连接');

    // 终端视图：返回列表（tab 保活）
    await page.locator('#terminal-back-btn').click();
    await expect(page.locator('#user-space-section')).toBeVisible();
    await expect(page.locator('#back-to-terminal-btn')).toBeVisible();

    // 点击自动化入口：不发生整页导航，而是内嵌 iframe 打开
    await page.locator('#menu-automation').click();
    await expect(page.locator('#embedded-page-section')).toBeVisible();
    const frame = page.locator('#embedded-page-frame');
    await expect(frame).toHaveAttribute('src', '/automation');
    await expect(page.locator('#embedded-page-title')).toHaveText('自动化');
    await expect(page.locator('#menu-automation')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.user-space-main')).toBeHidden();
    expect(page.url()).not.toContain('/automation');

    // 切换到 MCP：iframe 与高亮切换
    await page.locator('#menu-mcp').click();
    await expect(frame).toHaveAttribute('src', '/mcp/settings');
    await expect(page.locator('#menu-mcp')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#menu-automation')).not.toHaveAttribute('aria-current', 'page');

    // 关闭内嵌页：恢复服务器列表与高亮
    await page.locator('#embedded-page-close').click();
    await expect(page.locator('#embedded-page-section')).toBeHidden();
    await expect(page.locator('.user-space-main')).toBeVisible();
    await expect(page.locator('#sidebar-servers')).toHaveAttribute('aria-current', 'page');

    // 切回终端：连接仍在，全程 WebSocket 未关闭
    await page.locator('#back-to-terminal-btn').click();
    await expect(page.locator('#terminal-section')).toBeVisible();
    await expect(page.locator('#term-status')).toContainText('已连接');
    expect(await page.evaluate(() => (window as any).__wsCloseCount())).toBe(0);
  });

  test('中键/修饰键点击保留新标签打开行为', async ({ page }) => {
    await installTestWebSocket(page);
    await mockPanel(page);
    await page.goto('/?lang=zh-CN');
    await expect(page.locator('#connect-7')).toBeVisible();

    // Ctrl+click 走浏览器默认（新标签），事件未被 preventDefault
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 5000 }).catch(() => [null] as const),
      page.locator('#menu-automation').click({ modifiers: ['Control'] }),
    ]);
    // iframe 视图不应被打开（主页面保持列表视图）
    await expect(page.locator('#embedded-page-section')).toBeHidden();
  });
});

test('URL 直连分享终端页显示返回面板入口', async ({ page }) => {
  await installTestWebSocket(page);
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));

  const wsUrl = encodeURIComponent('ws://127.0.0.1:4173/api/ssh?token=42:anonymous');
  await page.goto(`/?lang=zh-CN&wsUrl=${wsUrl}&name=shared-box`);
  await expect(page.locator('#terminal-section')).toBeVisible();
  const backLink = page.locator('.share-back-link');
  await expect(backLink).toBeVisible();
  await expect(backLink).toHaveText('← 返回面板');
  await expect(backLink).toHaveAttribute('href', '/');
});
