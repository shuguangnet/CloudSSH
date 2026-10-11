import { test, expect } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

test('saved server keys support extensionless local files and manual editing', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 1, github_id: 1, username: 'tester', avatar_url: '' } }));
  await page.route('**/api/config', route => route.fulfill({ json: { githubAuthEnabled: true } }));
  await page.route('**/api/user/theme', route => route.fulfill({ json: { theme: null } }));
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
  const textarea = page.locator('#server-private-key');
  const picker = page.locator('#server-private-key-file');
  await textarea.fill('manually entered private key');
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key-content\n-----END OPENSSH PRIVATE KEY-----\n';
  await picker.setInputFiles({ name: 'id_ed25519', mimeType: 'application/octet-stream', buffer: Buffer.from(key) });
  await expect(textarea).toHaveValue(key);
  await expect(page.locator('#server-key-file-name')).toHaveText('id_ed25519');
  expect(saves).toHaveLength(0);
  // Re-selecting the same filename is supported, and imported content remains editable.
  await picker.setInputFiles({ name: 'id_ed25519', mimeType: 'application/octet-stream', buffer: Buffer.from(key) });
  await textarea.fill(`${key}edited`);
  await expect(page.locator('#server-key-file-name')).toBeEmpty();
  await picker.setInputFiles({ name: 'empty', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
  await expect(page.getByText('读取私钥文件失败。', { exact: true })).toBeVisible();
  await expect(textarea).toHaveValue(`${key}edited`);
  await page.locator('#server-name').fill('fixture');
  await page.locator('#server-host').fill('server.example.com');
  await page.locator('#server-username').fill('root');
  await page.locator('#server-submit-btn').click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].auth_method).toBe('publickey');
  expect(saves[0].credential).toBe(`${key}edited`);
  await page.locator('#add-server-btn').click();
  await page.locator('#modal-auth-tab-key').click();
  await expect(textarea).toHaveValue('');
  await expect(page.locator('#server-key-file-name')).toBeEmpty();
});
