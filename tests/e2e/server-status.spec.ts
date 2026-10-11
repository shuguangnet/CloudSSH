import { test, expect, type Page, type Route } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

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

const SERVERS_FIXTURE = [
  { id: 7, name: 'fixture-vps', host: 'dm.us.933999.xyz', port: 22, username: 'root', auth_method: 'publickey', transport_type: 'direct', tags: [], jump_server_id: null },
];

async function mockStatusPanel(page: Page, options: { automationEnabled: boolean; statusCalls?: number[] }): Promise<void> {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route => route.fulfill({
    json: { githubAuthEnabled: true, automationEnabled: options.automationEnabled },
  }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: 7 } });
    return route.fulfill({ json: SERVERS_FIXTURE });
  });
  await page.route('**/api/automation/status/*', (route: Route) => {
    options.statusCalls?.push(Date.now());
    return route.fulfill({ json: STATUS_FIXTURE });
  });
}

test('server status button opens a live metrics panel (self-hosted only)', async ({ page }) => {
  const statusCalls: number[] = [];
  await blockOptionalThirdPartyAssets(page);
  await mockStatusPanel(page, { automationEnabled: true, statusCalls });

  await page.goto('/?lang=zh-CN');
  const statusButton = page.locator('#status-7');
  await expect(statusButton).toBeVisible();
  await expect(page.locator('#connect-7')).toBeVisible();
  await statusButton.click();

  const body = page.locator('#status-modal-body');
  await expect(page.locator('#status-modal')).toBeVisible();
  await expect(body).toContainText('dm.us.933999.xyz');
  await expect(body).toContainText('32天16时36分'); // uptime 2824574s = 32d 16h 36m
  await expect(body).toContainText('10.2%');
  await expect(body).toContainText('0.04, 0.03, 0.04');
  await expect(body).toContainText('53.4%');
  await expect(body).toContainText('515 MB/965 MB');
  await expect(body).toContainText('73.0%');
  await expect(body).toContainText('12.8 GB/19.6 GB');
  await expect(body).toContainText('45.1 KB/s');
  await expect(body).toContainText('51.2 KB/s');
  await expect(body).toContainText('AMD EPYC 9654 96-Core Processor');
  await expect(body).toContainText('Debian GNU/Linux 11 (bullseye) x86_64');
  await expect(body).toContainText('203ms');

  // Manual refresh triggers another collection; closing stops the dialog.
  await page.locator('#status-refresh-btn').click();
  await expect.poll(() => statusCalls.length).toBeGreaterThanOrEqual(2);
  await page.locator('#status-modal-close-btn').click();
  await expect(page.locator('#status-modal')).toBeHidden();

  // Escape re-opens and closes again through the keyboard path.
  await statusButton.click();
  await expect(page.locator('#status-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#status-modal')).toBeHidden();
});

test('server status button stays hidden on Workers deployments', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await mockStatusPanel(page, { automationEnabled: false });

  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#connect-7')).toBeVisible();
  await expect(page.locator('#status-7')).toHaveCount(0);
});

test('status panel surfaces collection failures with a retry path', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await mockStatusPanel(page, { automationEnabled: true });
  let failures = 0;
  await page.route('**/api/automation/status/*', (route: Route) => {
    failures += 1;
    if (failures <= 2) return route.fulfill({ status: 502, json: { error: 'SSH authentication failed' } });
    return route.fulfill({ json: STATUS_FIXTURE });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#status-7').click();
  const body = page.locator('#status-modal-body');
  await expect(body).toContainText('获取状态失败');
  await expect(body).toContainText('SSH authentication failed');
  // A second consecutive failure disables auto refresh; retry still works manually.
  await page.locator('#status-refresh-btn').click();
  await expect(page.locator('#status-auto-refresh')).not.toBeChecked();
  await page.locator('#status-retry-btn').click();
  await expect(body).toContainText('dm.us.933999.xyz');
});
