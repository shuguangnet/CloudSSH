import { test, expect, type Page, type Route } from '@playwright/test';
import { blockOptionalThirdPartyAssets, mockAnonymousSession } from './helpers';

interface HostFileEntryFixture { name: string; type: 'dir' | 'file'; size: number | null }
interface HostFileFixture { path: string; size: number; content: string }

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nserver-side-key\n-----END OPENSSH PRIVATE KEY-----\n';

async function mockHostFileApi(page: Page, fixture?: Record<string, HostFileEntryFixture[]>): Promise<void> {
  const listings: Record<string, HostFileEntryFixture[]> = fixture ?? {
    '/': [{ name: 'etc', type: 'dir', size: null }, { name: 'root', type: 'dir', size: null }],
    '/root': [{ name: '.ssh', type: 'dir', size: null }],
    '/root/.ssh': [{ name: 'authorized_keys', type: 'file', size: 120 }, { name: 'id_ed25519', type: 'file', size: 411 }],
  };
  const files: Record<string, HostFileFixture> = {
    '/root/.ssh/id_ed25519': { path: '/root/.ssh/id_ed25519', size: 411, content: KEY },
  };
  await page.route('**/api/host-file*', (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/api/host-files')) {
      const entries = listings[url.searchParams.get('path') ?? '/'];
      if (!entries) return route.fulfill({ status: 404, json: { error: 'Directory not found' } });
      return route.fulfill({ json: { path: url.searchParams.get('path') ?? '/', entries, truncated: false } });
    }
    const file = files[url.searchParams.get('path') ?? ''];
    if (!file) return route.fulfill({ status: 404, json: { error: 'File not found' } });
    return route.fulfill({ json: file });
  });
}

test('saved server keys can be picked from deployment server files', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route => route.fulfill({ json: { githubAuthEnabled: true } }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await mockHostFileApi(page);
  const saves: Record<string, unknown>[] = [];
  await page.route('**/api/servers', route => {
    if (route.request().method() === 'POST') {
      saves.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: 1 } });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto('/?lang=zh-CN');
  await page.locator('#add-server-btn').click();
  await page.locator('#modal-auth-tab-key').click();
  const hostKeyButton = page.locator('#server-choose-host-key');
  // Feature-detected: only shown when the self-hosted file API answers.
  await expect(hostKeyButton).toBeVisible();
  await hostKeyButton.click();

  const browser = page.locator('#host-file-browser');
  await expect(browser).toBeVisible();
  await expect(browser).toContainText('浏览服务器文件');
  await expect(browser.locator('[data-host-file-list]')).toContainText('etc');

  // Navigate into /root/.ssh and pick the key file.
  await browser.locator('[data-host-file-list] .text-on-surface', { hasText: 'root' }).click();
  await expect(browser.locator('[data-host-file-list]')).toContainText('.ssh');
  await browser.locator('[data-host-file-list] .text-on-surface', { hasText: '.ssh' }).click();
  await expect(browser.locator('[data-host-file-list]')).toContainText('id_ed25519');
  const selectButton = browser.locator('[data-host-file-select]');
  await expect(selectButton).toBeDisabled();
  await browser.locator('[data-host-file-list] .text-on-surface', { hasText: 'id_ed25519' }).click();
  await expect(selectButton).toBeEnabled();
  await selectButton.click();

  await expect(browser).not.toBeVisible();
  await expect(page.locator('#server-private-key')).toHaveValue(KEY);
  await expect(page.locator('#server-key-file-name')).toHaveText('/root/.ssh/id_ed25519');

  await page.locator('#server-name').fill('fixture');
  await page.locator('#server-host').fill('server.example.com');
  await page.locator('#server-username').fill('root');
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].auth_method).toBe('publickey');
  expect(saves[0].credential).toBe(KEY);

  // Reopening the modal resets the imported content and path label.
  await page.locator('#add-server-btn').click();
  await page.locator('#modal-auth-tab-key').click();
  await expect(page.locator('#server-private-key')).toHaveValue('');
  await expect(page.locator('#server-key-file-name')).toBeEmpty();
});

test('host key button stays hidden when the deployment has no file API', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route => route.fulfill({ json: { githubAuthEnabled: true } }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
  await page.route('**/api/servers', route => route.fulfill({ json: [] }));
  // Cloudflare Workers deployments do not expose host file browsing.
  await page.route('**/api/host-files*', route => route.fulfill({ status: 404, json: { error: 'Not found' } }));

  await page.goto('/?lang=zh-CN');
  await page.locator('#add-server-btn').click();
  await page.locator('#modal-auth-tab-key').click();
  await expect(page.locator('#server-choose-host-key')).toBeHidden();
  await expect(page.locator('#host-file-browser')).toHaveCount(0);
});

test('anonymous connection form can pick a deployment server key', async ({ page }) => {
  await mockAnonymousSession(page);
  await mockHostFileApi(page);

  await page.goto('/?lang=zh-CN');
  await page.locator('#auth-tab-key').click();
  const hostKeyButton = page.locator('#choose-host-key');
  await expect(hostKeyButton).toBeVisible();
  await hostKeyButton.click();

  const browser = page.locator('#host-file-browser');
  await expect(browser).toBeVisible();
  await browser.locator('[data-host-file-list] .text-on-surface', { hasText: 'root' }).click();
  await browser.locator('[data-host-file-list] .text-on-surface', { hasText: '.ssh' }).click();
  await browser.locator('[data-host-file-list] .text-on-surface', { hasText: 'id_ed25519' }).click();
  await browser.locator('[data-host-file-select]').click();

  await expect(browser).not.toBeVisible();
  await expect(page.locator('#private-key')).toHaveValue(KEY);
  await expect(page.locator('#file-name')).toHaveText('/root/.ssh/id_ed25519');
});
