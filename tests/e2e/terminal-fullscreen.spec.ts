import { test, expect, type Page } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

/**
 * 终端影院全屏回归：
 * 标签栏的全屏按钮进入影院模式（隐藏应用头部/状态条/移动工具栏，保留标签栏），
 * Fullscreen API 不可用或被拒时回退 CSS 覆盖模式，Esc 退出回退形态。
 */

const SERVERS_FIXTURE = [
  { id: 7, name: 'fixture-vps', host: 'dm.us.933999.xyz', port: 22, username: 'root', auth_method: 'publickey', transport_type: 'direct', tags: [], jump_server_id: null },
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
        if (message?.type === 'resize') {
          (window as any).__resizeMessages = (window as any).__resizeMessages || [];
          (window as any).__resizeMessages.push(message);
          if (!this.ready) {
            this.ready = true;
            setTimeout(() => {
              this.emitJSON({ type: 'status', event: 'auth_success', message: '认证成功' });
              this.emitJSON({ type: 'status', event: 'shell_ready', message: 'Shell 已就绪' });
            }, 0);
          }
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
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { githubAuthEnabled: true, automationEnabled: false } }));
  await page.route('**/api/user/theme', (route) => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', (route) => route.fulfill({ json: SERVERS_FIXTURE }));
  await page.route('**/api/servers/7/connect', (route) =>
    route.fulfill({ json: { wsUrl: 'ws://127.0.0.1:4173/api/ssh?token=42:fs-7' } }));
}

test.use({ viewport: { width: 1440, height: 900 } });

test('全屏按钮进入影院模式并随 Esc 退出', async ({ page }) => {
  await installTestWebSocket(page);
  await mockSession(page);

  // Fullscreen API 在无手势环境会拒绝请求：禁用之，走 CSS 回退路径
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#connect-7').click();
  await expect(page.locator('#term-status')).toContainText('已连接');

  const section = page.locator('#terminal-section');
  const fsBtn = page.locator('#terminal-fullscreen-btn');
  await expect(fsBtn).toBeVisible();
  await expect(fsBtn).toHaveAttribute('title', '进入全屏');

  const headerBefore = await page.locator('.terminal-app-header').boundingBox();
  const areaBefore = await page.locator('#terminal-area').boundingBox();
  expect(headerBefore).not.toBeNull();

  // 进入全屏：影院类名落地，头部隐藏，终端区明显变高
  await fsBtn.click();
  await expect(section).toHaveClass(/terminal-cinema/);
  await expect(page.locator('.terminal-app-header')).toBeHidden();
  await expect(page.locator('.terminal-status-bar')).toBeHidden();
  // 标签栏保留（切标签 + 全屏按钮可达）
  await expect(page.locator('#tab-bar')).toBeVisible();
  await expect(fsBtn).toHaveAttribute('title', '退出全屏');
  const areaAfter = await page.locator('#terminal-area').boundingBox();
  expect(areaAfter!.height).toBeGreaterThan(areaBefore!.height + 40);

  // fit 后应下发更大的 rows（window-change）
  await page.waitForFunction(
    () => {
      const list = (window as any).__resizeMessages as Array<{ rows?: number }> | undefined;
      return Array.isArray(list) && list.some((m) => (m.rows ?? 0) > 24);
    },
    undefined,
    { timeout: 5_000 }
  );

  // Esc 退出 CSS 回退形态，恢复头部
  await page.keyboard.press('Escape');
  await expect(section).not.toHaveClass(/terminal-cinema/);
  await expect(page.locator('.terminal-app-header')).toBeVisible();
  await expect(fsBtn).toHaveAttribute('title', '进入全屏');
});

test('容器尺寸变化（非窗口 resize）也能触发重新 fit 并下发 window-change', async ({ page }) => {
  await installTestWebSocket(page);
  await mockSession(page);
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#connect-7').click();
  await expect(page.locator('#term-status')).toContainText('已连接');

  // 取连接时的初始行列作为基线
  const initial = await page.waitForFunction(() => {
    const list = (window as any).__resizeMessages as Array<{ rows?: number }> | undefined;
    return list && list.length ? (list[0].rows as number) : null;
  });
  const initialRows = await initial.jsonValue();
  expect(initialRows).toBeGreaterThan(0);

  // 不改窗口尺寸，直接压缩终端容器高度：只有 ResizeObserver 能捕捉到这种布局变化
  // （8cf9ed4 只声明了观察器字段未真正 observe，此用例守护接线不倒退）
  await page.evaluate(() => {
    const inner = document.querySelector<HTMLElement>('[id^="terminal-inner-"]');
    if (inner) inner.style.height = '45%';
  });

  await page.waitForFunction(
    (baseline: number) => {
      const list = (window as any).__resizeMessages as Array<{ rows?: number }> | undefined;
      return Array.isArray(list) && list.some((m, i) => i > 0 && (m.rows ?? 0) > 0 && (m.rows as number) < baseline);
    },
    initialRows as number,
    { timeout: 5_000 }
  );
});

test('无标签时全屏按钮隐藏，连接后出现', async ({ page }) => {
  await installTestWebSocket(page);
  await mockSession(page);
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#connect-7').click();
  await expect(page.locator('#term-status')).toContainText('已连接');
  await expect(page.locator('#terminal-fullscreen-btn')).toBeVisible();

  // 关闭最后一个标签 → 无会话 → 全屏按钮隐藏
  await page.locator('.tab-item .tab-close').first().click();
  await expect(page.locator('#terminal-fullscreen-btn')).toBeHidden();
});
