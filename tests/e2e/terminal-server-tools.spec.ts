import { test, expect, type Page } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

/**
 * 终端页服务器工具入口回归：
 * 服务器状态面板与 Docker 容器管理不仅要从服务器列表进入，
 * SSH 终端界面顶栏（桌面）与“更多操作”菜单（移动端）也必须有入口。
 *
 * 1. 桌面端：连接已保存服务器后顶栏出现 状态/Docker 按钮，可打开对应弹窗。
 * 2. URL 直连模式（无 serverId）不显示按钮。
 * 3. 移动端：更多操作菜单出现 服务器状态/Docker 容器管理，可打开弹窗。
 */

const STATUS_FIXTURE = {
  hostname: 'dm.us.933999.xyz',
  uptime_seconds: 2824574,
  cpu: { cores: 1, model: 'AMD EPYC 9654 96-Core Processor', usage_percent: 10.2, loadavg: [0.04, 0.03, 0.04] },
  memory: { total_bytes: 1011819008, used_bytes: 539860992, usage_percent: 53.4 },
  swap: { total_bytes: 1073741824, used_bytes: 214748365, usage_percent: 20 },
  disk: { total_bytes: 21003583488, used_bytes: 13730463744, available_bytes: 6226698240, usage_percent: 73 },
  network: { rx_bytes_per_sec: 46198, tx_bytes_per_sec: 52429 },
  os: 'Debian GNU/Linux 11 (bullseye) x86_64',
  latency_ms: 203,
  collected_at: '2026-10-11T00:00:00.000Z',
};

const CONTAINERS_FIXTURE = [
  {
    id: 'e16e50103cf4abcdef0123456789abcdef0123456789abcdef0123456789',
    short_id: 'e16e50103cf4',
    name: 'filebrowser',
    image: 'filebrowser/filebrowser:latest',
    state: 'running',
    status: 'Up 7 days',
    running_for: '7 days',
    ports: '0.0.0.0:8060->80/tcp',
    created_at: '2026-10-04 12:00:00 +0000 UTC',
  },
];

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

async function mockServerTools(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', route =>
    route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route =>
    route.fulfill({ json: { githubAuthEnabled: true, turnstileEnabled: false, automationEnabled: true } }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', route => route.fulfill({ json: SERVERS_FIXTURE }));
  await page.route('**/api/servers/7/connect', route =>
    route.fulfill({ json: { wsUrl: 'ws://127.0.0.1:4173/api/ssh?token=42:tools' } }));
  await page.route('**/api/automation/status/*', route => route.fulfill({ json: STATUS_FIXTURE }));
  await page.route('**/api/docker/*/containers', route =>
    route.fulfill({ json: { containers: CONTAINERS_FIXTURE } }));
}

test.describe('桌面视口', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('连接已保存服务器后顶栏可打开状态面板与 Docker 管理', async ({ page }) => {
    await installTestWebSocket(page);
    await mockServerTools(page);

    await page.goto('/?lang=zh-CN');
    await expect(page.locator('#connect-7')).toBeVisible();
    await page.locator('#connect-7').click();
    await expect(page.locator('#terminal-section')).toBeVisible();
    await expect(page.locator('#term-status')).toContainText('已连接');

    // 顶栏按钮随活跃标签（已保存服务器）出现
    const statusBtn = page.locator('#terminal-status-btn');
    const dockerBtn = page.locator('#terminal-docker-btn');
    await expect(statusBtn).toBeVisible();
    await expect(dockerBtn).toBeVisible();

    // 状态弹窗：标题带服务器名，指标正常渲染
    await statusBtn.click();
    await expect(page.locator('#status-modal')).toBeVisible();
    const statusBody = page.locator('#status-modal-body');
    await expect(statusBody).toContainText('fixture-vps');
    await expect(statusBody).toContainText('32天16时36分');
    await expect(statusBody).toContainText('AMD EPYC 9654 96-Core Processor');
    await page.keyboard.press('Escape');
    await expect(page.locator('#status-modal')).toBeHidden();

    // Docker 弹窗：容器列表正常渲染
    await dockerBtn.click();
    await expect(page.locator('#docker-modal')).toBeVisible();
    const dockerBody = page.locator('#docker-modal-body');
    await expect(dockerBody).toContainText('fixture-vps');
    await expect(dockerBody).toContainText('共 1 个容器');
    await expect(dockerBody).toContainText('filebrowser');
    await expect(dockerBody).toContainText('运行中');
    await page.keyboard.press('Escape');
    await expect(page.locator('#docker-modal')).toBeHidden();
  });

  test('URL 直连模式（未保存服务器）不显示工具按钮', async ({ page }) => {
    await installTestWebSocket(page);
    await mockServerTools(page);
    const wsUrl = encodeURIComponent('ws://127.0.0.1:4173/api/ssh?token=42:anonymous');

    await page.goto(`/?wsUrl=${wsUrl}&name=DirectTab&host=127.0.0.1&port=22&lang=zh-CN`);
    await expect(page.locator('.terminal-app-header')).toBeVisible();
    await expect(page.locator('#terminal-status-btn')).toBeHidden();
    await expect(page.locator('#terminal-docker-btn')).toBeHidden();
  });
});

test.describe('移动视口', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('更多操作菜单提供状态/Docker 入口并打开弹窗', async ({ page }) => {
    await installTestWebSocket(page);
    await mockServerTools(page);

    await page.goto('/?lang=zh-CN');
    await page.locator('#connect-7').click();
    await expect(page.locator('#terminal-section')).toBeVisible();
    await expect(page.locator('#term-status')).toContainText('已连接');

    await page.locator('#mobile-more-btn').click();
    const menu = page.locator('#mobile-more-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('#mobile-status-btn')).toBeVisible();
    await expect(menu.locator('#mobile-docker-btn')).toBeVisible();

    // 打开状态弹窗后菜单自动收起
    await menu.locator('#mobile-status-btn').click();
    await expect(page.locator('#status-modal')).toBeVisible();
    await expect(page.locator('#status-modal-body')).toContainText('fixture-vps');
    await expect(menu).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator('#status-modal')).toBeHidden();
  });
});
