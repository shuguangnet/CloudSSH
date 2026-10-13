import { expect, test } from '@playwright/test';

/**
 * 凭据管理 e2e：
 * - 侧边栏入口打开面板，列表只显示元数据（绝不回显密钥）；
 * - 新建/编辑/删除走通 → 请求体形状正确，编辑时留空密钥不发 secret；
 * - 被引用的凭据删除时 409 文案透传到界面。
 *
 * 全程 mock /api/credentials，不依赖真实 DO。
 */

interface MockCredential {
  id: number;
  name: string;
  kind: 'password' | 'publickey';
  comment: string;
  usage_count: number;
  last_used_at: number | null;
  created_at: string;
  updated_at: string;
}

const SECRET_MARKER = 'SUPER-SECRET-PRIVATE-KEY-MATERIAL';

function row(overrides: Partial<MockCredential> = {}): MockCredential {
  return {
    id: 1,
    name: '生产密钥',
    kind: 'publickey',
    comment: '主密钥',
    usage_count: 2,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

/** 装好登录态 + 凭据接口 mock，并记录所有写请求。 */
async function setupLoggedIn(
  page: import('@playwright/test').Page,
  options: { rows?: MockCredential[]; deleteStatus?: number; deleteError?: string } = {}
): Promise<{ requests: { method: string; url: string; body: unknown }[] }> {
  const requests: { method: string; url: string; body: unknown }[] = [];
  let rows = [...(options.rows ?? [row()])];

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sshSharingEnabled: false,
        mcpEnabled: false,
        adminAccountEnabled: false,
        automationEnabled: false,
      }),
    })
  );
  await page.route('**/api/servers', async (route) => {
    if (route.request().method() !== 'GET') {
      let body: unknown = null;
      try {
        body = route.request().postDataJSON();
      } catch {
        body = null;
      }
      requests.push({ method: route.request().method(), url: route.request().url(), body });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 50, ...(body as object) }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/credentials**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    if (method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rows),
      });
    }
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    requests.push({ method, url, body });
    if (method === 'DELETE') {
      if (options.deleteStatus && options.deleteStatus !== 200) {
        return route.fulfill({
          status: options.deleteStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error: options.deleteError ?? 'in use' }),
        });
      }
      const id = Number(url.split('/').pop());
      rows = rows.filter((item) => item.id !== id);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(row({ id: 99, name: '新凭据', kind: 'publickey', comment: '' })),
    });
  });

  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#user-space-section')).toBeVisible();
  return { requests };
}

async function openPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#credentials-btn').click();
  await expect(page.locator('#credentials-modal')).toBeVisible();
}

test.describe('凭据管理面板', () => {
  test('侧边栏入口打开面板并列出凭据元数据，不回显密钥', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);

    const list = page.locator('#credential-list');
    await expect(list).toContainText('生产密钥');
    await expect(list).toContainText('主密钥');
    // 「复用 2 台」徽标
    await expect(list).toContainText('复用 2 台');
    // 密钥正文绝不能出现在 DOM 中
    await expect(page.locator('#credentials-modal')).not.toContainText(SECRET_MARKER);
    // 编辑态之前密钥输入框为空
    await expect(page.locator('#credential-secret')).toHaveValue('');
  });

  test('新建凭据提交规范化后的请求体', async ({ page }) => {
    const { requests } = await setupLoggedIn(page);
    await openPanel(page);

    await page.fill('#credential-name', '  新凭据  ');
    await page.selectOption('#credential-kind', 'publickey');
    await page.fill('#credential-secret', '  KEY-MATERIAL  ');
    await page.fill('#credential-comment', '  备注  ');
    await page.click('#credential-save-btn');

    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({
      name: '新凭据',
      kind: 'publickey',
      secret: 'KEY-MATERIAL',
      comment: '备注',
    });
  });

  test('编辑时密钥框留空 → 请求体不含 secret，避免覆盖原密钥', async ({ page }) => {
    const { requests } = await setupLoggedIn(page);
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="编辑"]').first().click();
    // 密钥不回显，输入框为空且不再必填
    await expect(page.locator('#credential-secret')).toHaveValue('');
    await expect(page.locator('#credential-secret')).not.toHaveAttribute('required', '');
    await expect(page.locator('#credential-secret-hint')).toContainText('留空表示不修改');

    await page.fill('#credential-name', '改名后');
    await page.click('#credential-save-btn');

    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].body).not.toHaveProperty('secret');
    expect((requests[0].body as { name: string }).name).toBe('改名后');
  });

  test('类型切换会同步密钥字段标签', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);

    await page.selectOption('#credential-kind', 'password');
    await expect(page.locator('#credential-secret-label')).toHaveText('密码');
    await page.selectOption('#credential-kind', 'publickey');
    await expect(page.locator('#credential-secret-label')).toHaveText('私钥');
  });

  test('删除被引用的凭据：409 冲突文案透传到界面且列表不变', async ({ page }) => {
    await setupLoggedIn(page, {
      deleteStatus: 409,
      deleteError: '该凭据正被 web-1、web-2 使用，请先解除引用',
    });
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="删除"]').first().click();
    // 二次确认弹窗里应写出影响面
    await expect(page.locator('body')).toContainText('正被 2 台服务器使用');
    await page.locator('button:has-text("删除")').last().click();

    // 服务端 409 的可读原因必须原样展示，而不是「保存失败」
    await expect(page.locator('body')).toContainText('该凭据正被 web-1、web-2 使用');
    await expect(page.locator('#credential-list')).toContainText('生产密钥');
  });

  test('删除成功后面板刷新且条目消失', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="删除"]').first().click();
    await page.locator('button:has-text("删除")').last().click();

    await expect(page.locator('#credential-list')).not.toContainText('生产密钥');
    await expect(page.locator('#credential-list')).toContainText('暂无凭据');
  });

  test('空凭据库显示引导文案', async ({ page }) => {
    await setupLoggedIn(page, { rows: [] });
    await openPanel(page);
    await expect(page.locator('#credential-list')).toContainText('暂无凭据');
  });
});

test.describe('服务器表单：从凭据库选择', () => {
  test('引用模式下按认证方式过滤凭据，并把 credential_id 提交给服务端', async ({ page }) => {
    const { requests } = await setupLoggedIn(page, {
      rows: [
        row({ id: 1, name: '密码凭据', kind: 'password', usage_count: 0 }),
        row({ id: 2, name: '密钥凭据', kind: 'publickey', usage_count: 0 }),
      ],
    });

    await page.locator('#add-server-btn').click();
    await expect(page.locator('#server-modal')).toBeVisible();
    // 默认内嵌模式
    await expect(page.locator('#server-credential-picker')).toBeHidden();

    await page.click('#server-cred-source-library');
    await expect(page.locator('#server-credential-picker')).toBeVisible();

    // 密码认证只列出密码凭据
    const options = page.locator('#server-credential-id option');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveText('密码凭据');

    // 切到密钥认证后列表应替换为密钥凭据
    await page.click('#modal-auth-tab-key');
    await expect(page.locator('#server-credential-id option')).toHaveCount(1);
    await expect(page.locator('#server-credential-id option').first()).toHaveText('密钥凭据');

    await page.fill('#server-name', 'ref-host');
    await page.fill('#server-host', '10.0.0.9');
    await page.fill('#server-username', 'root');
    await page.click('#server-submit-btn');

    const save = requests.find((item) => item.method === 'POST');
    await expect.poll(() => !!save).toBe(true);
    expect((save!.body as { credential_id: number }).credential_id).toBe(2);
    // 引用模式下不应内嵌凭据正文
    expect(save!.body).not.toHaveProperty('credential');
  });

  test('凭据库为空时给出引导文案且阻止提交', async ({ page }) => {
    const { requests } = await setupLoggedIn(page, { rows: [] });

    await page.locator('#add-server-btn').click();
    await page.click('#server-cred-source-library');
    await expect(page.locator('#server-credential-hint')).toContainText('没有与当前认证方式匹配的凭据');

    await page.fill('#server-name', 'x');
    await page.fill('#server-host', '10.0.0.9');
    await page.fill('#server-username', 'root');
    await page.click('#server-submit-btn');

    // 未选择凭据时不得发出保存请求
    await expect(page.locator('#server-modal')).toBeVisible();
    expect(requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  });
});
