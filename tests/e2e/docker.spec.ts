import { test, expect, type Page, type Route } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

const CONTAINERS_FIXTURE = [
  {
    id: 'e16e50103cf4' + 'abcdef0123456789abcdef0123456789abcdef0123456789',
    short_id: 'e16e50103cf4',
    name: 'filebrowser',
    image: 'filebrowser/filebrowser:latest',
    state: 'running',
    status: 'Up 7 days',
    running_for: '7 days',
    ports: '0.0.0.0:8060->80/tcp, [::]:8060->80/tcp',
    created_at: '2026-10-04 12:00:00 +0000 UTC',
  },
  {
    id: '26c57eb76210' + 'abcdef0123456789abcdef0123456789abcdef0123456789',
    short_id: '26c57eb76210',
    name: 'caddy',
    image: 'caddy:latest',
    state: 'exited',
    status: 'Exited (0) 13 hours ago',
    running_for: '13 hours',
    ports: '0.0.0.0:80->80/tcp, [::]:443->443/udp, 2019/tcp',
    created_at: '2026-10-11 07:00:00 +0000 UTC',
  },
];

const SERVERS_FIXTURE = [
  { id: 7, name: 'fixture-vps', host: 'dm.us.933999.xyz', port: 22, username: 'root', auth_method: 'publickey', transport_type: 'direct', tags: [], jump_server_id: null },
];

const LOGS_FIXTURE = { logs: '2026-10-11T08:00:01.000000000Z line one\n2026-10-11T08:00:02.000000000Z line two\n' };

async function mockDocker(page: Page, options: { automationEnabled: boolean; actions?: { container: string; action: string }[]; logsRequests?: { container: string; tail: number }[] }): Promise<void> {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route => route.fulfill({
    json: { githubAuthEnabled: true, turnstileEnabled: false, automationEnabled: options.automationEnabled },
  }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: 7 } });
    return route.fulfill({ json: SERVERS_FIXTURE });
  });
  await page.route('**/api/docker/*/containers', (route: Route) => route.fulfill({ json: { containers: CONTAINERS_FIXTURE } }));
  await page.route('**/api/docker/*/action', (route: Route) => {
    const body = route.request().postDataJSON() as { container: string; action: string };
    options.actions?.push(body);
    return route.fulfill({ json: { ok: true, exit_code: 0, stdout: `ACTION:${body.action} ${body.container}`, stderr: '' } });
  });
  await page.route('**/api/docker/*/logs', (route: Route) => {
    const body = route.request().postDataJSON() as { container: string; tail: number };
    options.logsRequests?.push(body);
    return route.fulfill({ json: LOGS_FIXTURE });
  });
}

test('docker button opens the container manager with live actions', async ({ page }) => {
  const actions: { container: string; action: string }[] = [];
  await blockOptionalThirdPartyAssets(page);
  await mockDocker(page, { automationEnabled: true, actions });

  await page.goto('/?lang=zh-CN');
  const dockerButton = page.locator('#docker-7');
  await expect(dockerButton).toBeVisible();
  await dockerButton.click();

  const body = page.locator('#docker-modal-body');
  await expect(page.locator('#docker-modal')).toBeVisible();
  await expect(body).toContainText('共 2 个容器');

  // First card: running filebrowser with its ports.
  await expect(body).toContainText('filebrowser');
  await expect(body).toContainText('e16e50103cf4');
  await expect(body).toContainText('filebrowser/filebrowser:latest');
  await expect(body).toContainText('运行中');
  await expect(body).toContainText('0.0.0.0:8060->80/tcp');
  await expect(body).toContainText('[::]:8060->80/tcp');

  // Second card: exited caddy.
  await expect(body).toContainText('caddy');
  await expect(body).toContainText('已停止');
  await expect(body).toContainText('caddy:latest');
  await expect(body).toContainText('2019/tcp');

  // Stop is disabled while running; start is disabled for the exited one.
  const runningCard = body.locator('.rounded-lg', { hasText: 'filebrowser' });
  const exitedCard = body.locator('.rounded-lg', { hasText: 'caddy' });
  await expect(runningCard.locator('button[data-docker-action="stop"]')).toBeEnabled();
  await expect(runningCard.locator('button[data-docker-action="start"]')).toBeDisabled();
  await expect(exitedCard.locator('button[data-docker-action="start"]')).toBeEnabled();
  await expect(exitedCard.locator('button[data-docker-action="stop"]')).toBeDisabled();

  // Start the exited container; the action posts and the list refreshes.
  await exitedCard.locator('button[data-docker-action="start"]').click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toEqual({ container: 'caddy', action: 'start' });

  // Deleting requires confirmation; cancelling sends nothing.
  await runningCard.locator('button[data-docker-action="remove"]').click();
  const confirmDialog = page.locator('dialog.app-dialog');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText('filebrowser');
  await confirmDialog.locator('.app-dialog__button--cancel').click();
  await expect(confirmDialog).toBeHidden();
  expect(actions).toHaveLength(1);

  // Confirm path deletes.
  await runningCard.locator('button[data-docker-action="remove"]').click();
  await confirmDialog.locator('.app-dialog__button--confirm').click();
  await expect.poll(() => actions.length).toBe(2);
  expect(actions[1]).toEqual({ container: 'filebrowser', action: 'remove' });

  await page.keyboard.press('Escape');
  await expect(page.locator('#docker-modal')).toBeHidden();
});

test('docker button stays hidden on Workers deployments', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await mockDocker(page, { automationEnabled: false });

  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#connect-7')).toBeVisible();
  await expect(page.locator('#docker-7')).toHaveCount(0);
});

test('docker logs dialog fetches and re-fetches with the selected tail', async ({ page }) => {
  const logsRequests: { container: string; tail: number }[] = [];
  await blockOptionalThirdPartyAssets(page);
  await mockDocker(page, { automationEnabled: true, logsRequests });

  await page.goto('/?lang=zh-CN');
  await page.locator('#docker-7').click();
  const body = page.locator('#docker-modal-body');
  const runningCard = body.locator('.rounded-lg', { hasText: 'filebrowser' });

  await runningCard.locator('button[data-docker-action="logs"]').click();
  await expect(page.locator('#docker-logs-modal')).toBeVisible();
  await expect(page.locator('#docker-logs-container-name')).toHaveText('filebrowser');
  await expect(page.locator('#docker-logs-body')).toContainText('line one');
  await expect(page.locator('#docker-logs-body')).toContainText('line two');
  await expect.poll(() => logsRequests.length).toBe(1);
  expect(logsRequests[0].container).toBe('filebrowser');
  expect(logsRequests[0].tail).toBe(500); // default

  await page.locator('#docker-logs-tail').selectOption('100');
  await page.locator('#docker-logs-refresh-btn').click();
  await expect.poll(() => logsRequests.length).toBeGreaterThanOrEqual(2);
  expect(logsRequests[logsRequests.length - 1]).toEqual({ container: 'filebrowser', tail: 100 });

  // Escape closes only the logs overlay; the container list stays open.
  await page.keyboard.press('Escape');
  await expect(page.locator('#docker-logs-modal')).toBeHidden();
  await expect(page.locator('#docker-modal')).toBeVisible();
});

test('docker list failures show a docker-missing hint and a retry path', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await mockDocker(page, { automationEnabled: true });
  let failures = 0;
  await page.route('**/api/docker/*/containers', (route: Route) => {
    failures += 1;
    if (failures <= 1) {
      return route.fulfill({ status: 502, json: { error: 'bash: line 1: docker: command not found' } });
    }
    return route.fulfill({ json: { containers: CONTAINERS_FIXTURE } });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#docker-7').click();
  const body = page.locator('#docker-modal-body');
  await expect(body).toContainText('获取容器列表失败');
  await expect(body).toContainText('服务器未安装 Docker 或命令不可用。');
  // A failed fetch disables auto refresh; retry recovers.
  await expect(page.locator('#docker-auto-refresh')).not.toBeChecked();
  await page.locator('#docker-retry-btn').click();
  await expect(body).toContainText('filebrowser');
});
