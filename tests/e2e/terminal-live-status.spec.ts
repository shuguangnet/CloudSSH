import { test, expect, type Page, type Route } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

/**
 * 终端状态栏实时监控回归：
 * 连上已保存服务器后，状态栏直接出现实时胶囊，并自动展开状态抽屉，
 * 不需要用户先去顶栏找按钮、再打开弹窗。
 *
 * 1. 桌面端：胶囊渲染出内存/磁盘/网络/运行时长，抽屉自动展开且指标完整。
 * 2. 用户收起抽屉后不再自动弹出（点击胶囊可再次展开）。
 * 3. URL 直连（无 serverId）与 Workers 部署都不出现胶囊，也不订阅实时流。
 * 4. SSE 建不起来时降级为长轮询，仍能持续刷新。
 */

const STATUS_FIXTURE = {
  type: 'status',
  hostname: 'dm.us.933999.xyz',
  uptime_seconds: 2824574,
  cpu: { cores: 1, model: 'AMD EPYC 9654 96-Core Processor', usage_percent: 10.2, loadavg: [0.04, 0.03, 0.04] },
  memory: { total_bytes: 1011819008, used_bytes: 539860992, usage_percent: 53.4 },
  swap: { total_bytes: 1073741824, used_bytes: 214748365, usage_percent: 20 },
  disk: { total_bytes: 21003583488, used_bytes: 13730463744, available_bytes: 6226698240, usage_percent: 73 },
  network: { rx_bytes_per_sec: 46198, tx_bytes_per_sec: 52429 },
  os: 'Debian GNU/Linux 11 (bullseye) x86_64',
  latency_ms: 203,
  interval_ms: 3000,
  sampled_at: '2026-10-11T00:00:00.000Z',
};

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

/**
 * 实时状态 mock：`/live/:id/stream` 走 SSE（只在请求真正接受 text/event-stream
 * 时才会命中），`/live/:id` 走长轮询。两个端点由一个 handler 分流，
 * 避免 Playwright 的“后注册者优先”让通配的 /live/* 吃掉 /stream 请求。
 */
/** 已发生的 SSE 订阅轮次；指标值随它递增，用来证明前端在持续刷新 */
let streamRounds = 0;

async function mockLiveStatus(
  page: Page,
  options: { automationEnabled: boolean; sseBroken?: boolean; onPoll?: () => void; onStream?: () => void },
): Promise<void> {
  // 每次 mock 重置轮次：同一文件里多个用例共享模块级状态
  streamRounds = 0;
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route => route.fulfill({ json: { githubAuthEnabled: true, automationEnabled: options.automationEnabled } }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', route => route.fulfill({ json: SERVERS_FIXTURE }));
  await page.route('**/api/servers/7/connect', route => route.fulfill({ json: { wsUrl: 'ws://127.0.0.1:4173/api/ssh?token=42:live' } }));
  await page.route('**/api/automation/status/live/**', (route: Route) => {
    const url = route.request().url();
    if (url.includes('/stream')) {
      if (options.sseBroken) return route.fulfill({ status: 502, body: 'bad gateway' });
      // 有限长度的 SSE 响应：Playwright 的 route.fulfill 会一直缓冲到流结束，
      // 用永不关闭的 ReadableStream 会让 fetch 永远停在 connecting。
      // 每次订阅发几帧就正常收尾，正好也覆盖“正常收尾后重新订阅”这条路径。
      options.onStream?.();
      const round = streamRounds++;
      // 指标值保持不变，只让延迟随订阅轮次递增：
      // 用例既能断言稳定的读数，又能断言“确实在持续刷新”。
      // 延迟按订阅轮次成段递增：一轮发 3 帧，末帧延迟为 203 + round*3 + 2，
      // 因此断言末帧值就能确认该轮已经完整到达。
      const frames = [0, 1, 2].map(step => (
        `data: ${JSON.stringify({ ...STATUS_FIXTURE, latency_ms: 203 + round * 3 + step })}\n\n`
      ));
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
        body: frames.join(''),
      });
    }
    options.onPoll?.();
    return route.fulfill({ json: STATUS_FIXTURE });
  });
}

test.describe('桌面视口', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('连接已保存服务器后状态栏出现实时胶囊并自动展开状态抽屉', async ({ page }) => {
    await installTestWebSocket(page);
    await mockLiveStatus(page, { automationEnabled: true });

    await page.goto('/?lang=zh-CN');
    // 首帧到达前不显示胶囊（避免空占位与错误的自动展开）
    await expect(page.locator('#term-live-pills')).toBeHidden();
    await page.locator('#connect-7').click();
    await expect(page.locator('#term-status')).toContainText('已连接');

    // 无需任何点击：胶囊直接出现在状态栏里
    const pills = page.locator('#term-live-pills');
    await expect(pills).toBeVisible();
    await expect(pills).toContainText('53%');   // 内存
    await expect(pills).toContainText('73%');   // 磁盘
    await expect(pills).toContainText('45KB/s'); // 下行
    await expect(pills).toContainText('51KB/s'); // 上行
    await expect(pills).toContainText('32d16h'); // 运行时长（紧凑格式）

    // 抽屉自动展开，指标完整
    const panel = page.locator('#status-panel');
    await expect(panel).toBeVisible();
    await expect(page.locator('#status-panel-host')).toContainText('fixture-vps');
    await expect(page.locator('#status-panel-body')).toContainText('dm.us.933999.xyz');
    await expect(page.locator('#status-panel-body')).toContainText('32天16时36分');
    await expect(page.locator('#status-panel-body')).toContainText('AMD EPYC 9654 96-Core Processor');
    await expect(page.locator('#status-panel-badge')).toHaveText('实时');

    // 单次 SSE 响应只有有限帧，正常收尾后前端应重新订阅：
    // 第二轮末帧的延迟（208ms）只有在重新订阅发生后才会出现，
    // 证明是“持续刷新”而不是取到一帧就停。
    await expect(page.locator('#status-panel-body')).toContainText('208ms', { timeout: 15000 });

    // 主动收起后不再自动弹出，胶囊仍在（点击可重新展开）
    await page.locator('#status-panel-close-btn').click();
    await expect(panel).toBeHidden();
    await expect(pills).toBeVisible();
    await page.waitForTimeout(600);
    await expect(panel).toBeHidden();
    await pills.click();
    await expect(panel).toBeVisible();
  });

  test('URL 直连模式不出现实时胶囊也不订阅实时流', async ({ page }) => {
    const streams: string[] = [];
    await installTestWebSocket(page);
    await mockLiveStatus(page, { automationEnabled: true });
    page.on('request', request => {
      if (request.url().includes('/api/automation/status/live')) streams.push(request.url());
    });
    const wsUrl = encodeURIComponent('ws://127.0.0.1:4173/api/ssh?token=42:anonymous');

    await page.goto(`/?wsUrl=${wsUrl}&name=DirectTab&host=127.0.0.1&port=22&lang=zh-CN`);
    await expect(page.locator('.terminal-app-header')).toBeVisible();
    await expect(page.locator('#term-live-pills')).toBeHidden();
    await expect(page.locator('#status-panel')).toBeHidden();
    expect(streams, '匿名连接不应开启实时采样').toEqual([]);
  });

  test('Workers 部署下不出现实时胶囊', async ({ page }) => {
    await installTestWebSocket(page);
    await mockLiveStatus(page, { automationEnabled: false });

    await page.goto('/?lang=zh-CN');
    await page.locator('#connect-7').click();
    await expect(page.locator('#term-status')).toContainText('已连接');
    await expect(page.locator('#term-live-pills')).toBeHidden();
    await expect(page.locator('#status-panel')).toBeHidden();
  });

  test('SSE 不可用时降级为长轮询并持续刷新', async ({ page }) => {
    const polls: number[] = [];
    await installTestWebSocket(page);
    // 事件流被中间层掐断（返回 502 而不是 text/event-stream）
    await mockLiveStatus(page, { automationEnabled: true, sseBroken: true, onPoll: () => polls.push(Date.now()) });

    await page.goto('/?lang=zh-CN');
    await page.locator('#connect-7').click();
    await expect(page.locator('#term-live-pills')).toBeVisible();
    await expect(page.locator('#status-panel-body')).toContainText('dm.us.933999.xyz');
    // 长轮询自带下一次请求：等待期间应累积多次请求，而不是只取一帧就停
    await expect.poll(() => polls.length, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  });
});

test.describe('移动视口', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('窄屏同样自动展示实时胶囊与抽屉', async ({ page }) => {
    await installTestWebSocket(page);
    await mockLiveStatus(page, { automationEnabled: true });

    await page.goto('/?lang=zh-CN');
    await page.locator('#connect-7').click();
    await expect(page.locator('#term-status')).toContainText('已连接');

    const pills = page.locator('#term-live-pills');
    await expect(pills).toBeVisible();
    await expect(pills).toContainText('53%');
    const panel = page.locator('#status-panel');
    await expect(panel).toBeVisible();
    await expect(page.locator('#status-panel-body')).toContainText('32天16时36分');
    // 移动端抽屉占满可视宽度，不需要为顶栏让位
    const box = await panel.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(390);
  });
});
