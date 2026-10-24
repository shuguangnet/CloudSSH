import { expect, test } from '@playwright/test';

/**
 * 凭据管理 e2e：
 * - 侧边栏入口把凭据页作为**主内容区内的独立视图**打开（不是弹窗），
 *   左侧导航保持可见且高亮当前项；
 * - 默认只展示列表，表单折叠在「新建凭据」/「编辑」之后；
 * - 列表只显示元数据；明文必须经显式 `POST /reveal` 取回，取回后可复制；
 * - 新建/编辑/删除走通 → 请求体形状正确，未回显时编辑不发 secret；
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
  options: {
    rows?: MockCredential[];
    deleteStatus?: number;
    deleteError?: string;
    revealSecret?: string;
    revealStatus?: number;
    /** 打开自托管能力开关，用于验证与内嵌 iframe 页的视图互斥。 */
    capabilities?: boolean;
  } = {}
): Promise<{
  requests: { method: string; url: string; body: unknown }[];
  revealRequests: string[];
}> {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const revealRequests: string[] = [];
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
        mcpEnabled: Boolean(options.capabilities),
        adminAccountEnabled: false,
        automationEnabled: Boolean(options.capabilities),
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
    // 回显是独立端点，必须与 CRUD mock 分开处理——否则「按需回显」
    // 会被误当成一次创建请求，测试就失去意义了。
    if (url.endsWith('/reveal') && method === 'POST') {
      revealRequests.push(url);
      if (options.revealStatus && options.revealStatus !== 200) {
        return route.fulfill({
          status: options.revealStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'decryptFailed' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, kind: 'publickey', secret: options.revealSecret ?? SECRET_MARKER }),
      });
    }
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
  return { requests, revealRequests };
}

/** 从侧边栏进入凭据页，并断言它确实是一个独立页面视图。 */
async function openPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#credentials-btn').click();
  await expect(page.locator('#credentials-page-section')).toBeVisible();
}

test.describe('凭据管理页', () => {
  test('侧边栏入口打开独立页面并列出凭据元数据，不回显密钥', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);

    // 不是弹窗：主内容区里渲染，左侧导航仍然可见。
    await expect(page.locator('#credentials-page-section')).toBeVisible();
    await expect(page.locator('#app-sidebar')).toBeVisible();
    await expect(page.locator('#credentials-btn')).toHaveAttribute('aria-current', 'page');
    // 服务器列表要让位，避免两个视图叠在一起。
    await expect(page.locator('.user-space-main')).toBeHidden();

    const list = page.locator('#credential-list');
    await expect(list).toContainText('生产密钥');
    await expect(list).toContainText('主密钥');
    // 「复用 2 台」徽标
    await expect(list).toContainText('复用 2 台');
    // 密钥正文绝不能出现在 DOM 中
    await expect(page.locator('#credentials-page-section')).not.toContainText(SECRET_MARKER);
    // 默认不展开表单：一进页面只有列表。
    await expect(page.locator('#credential-form')).toBeHidden();
  });

  test('「返回面板」回到服务器列表并复位导航高亮', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);

    await page.click('#credentials-page-close');
    await expect(page.locator('#credentials-page-section')).toBeHidden();
    await expect(page.locator('#credentials-btn')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#sidebar-servers')).toHaveAttribute('aria-current', 'page');
  });

  test('新建凭据提交规范化后的请求体', async ({ page }) => {
    const { requests } = await setupLoggedIn(page);
    await openPanel(page);

    // 表单默认收起，必须点「新建凭据」才展开。
    await expect(page.locator('#credential-form')).toBeHidden();
    await page.click('#credential-new-btn');
    await expect(page.locator('#credential-form')).toBeVisible();

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
    const { requests, revealRequests } = await setupLoggedIn(page);
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="编辑"]').first().click();
    // 编辑不自动回显：输入框为空，必须用户显式点「显示」。
    await expect(page.locator('#credential-secret')).toHaveValue('');
    await expect(page.locator('#credential-secret-hint')).toContainText('点「显示」按需取回');
    expect(revealRequests).toHaveLength(0);

    await page.fill('#credential-name', '改名后');
    await page.click('#credential-save-btn');

    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].body).not.toHaveProperty('secret');
    expect((requests[0].body as { name: string }).name).toBe('改名后');
  });

  test('点「显示」才按需取回明文，可复制；再次点击收起', async ({ page }) => {
    const { revealRequests } = await setupLoggedIn(page, { revealSecret: SECRET_MARKER });
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="编辑"]').first().click();
    // 编辑态下才有回显入口。
    await expect(page.locator('#credential-reveal-btn')).toBeVisible();
    await expect(page.locator('#credential-copy-btn')).toBeHidden();

    await page.click('#credential-reveal-btn');
    await expect(page.locator('#credential-secret')).toHaveValue(SECRET_MARKER);
    // 必须走 POST /reveal 端点，而不是从列表里读。
    expect(revealRequests).toHaveLength(1);
    expect(revealRequests[0]).toContain('/reveal');
    await expect(page.locator('#credential-copy-btn')).toBeVisible();
    await expect(page.locator('#credential-reveal-btn')).toHaveText('隐藏');

    // 复制按钮把明文写进剪贴板。
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#credential-copy-btn');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(SECRET_MARKER);

    await page.click('#credential-reveal-btn');
    await expect(page.locator('#credential-secret')).toHaveValue('');
  });

  test('回显后收起表单会清掉明文，不留痕在 DOM 里', async ({ page }) => {
    await setupLoggedIn(page, { revealSecret: SECRET_MARKER });
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="编辑"]').first().click();
    await page.click('#credential-reveal-btn');
    await expect(page.locator('#credential-secret')).toHaveValue(SECRET_MARKER);

    await page.click('#credential-cancel-btn');
    await expect(page.locator('#credential-form')).toBeHidden();
    await expect(page.locator('#credentials-page-section')).not.toContainText(SECRET_MARKER);
  });

  test('取回明文失败时给出提示，不把错误当成空值', async ({ page }) => {
    await setupLoggedIn(page, { revealStatus: 500 });
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="编辑"]').first().click();
    await page.click('#credential-reveal-btn');
    await expect(page.locator('#credential-form-error')).toContainText('取回凭据内容失败');
    await expect(page.locator('#credential-secret')).toHaveValue('');
  });

  test('新建表单不提供回显入口（内容本来就是用户输入的）', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);
    await page.click('#credential-new-btn');
    await expect(page.locator('#credential-reveal-btn')).toBeHidden();
  });

  test('回显后用户自己改过内容，自动清除不会抹掉他的编辑', async ({ page }) => {
    await setupLoggedIn(page, { revealSecret: SECRET_MARKER });
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="编辑"]').first().click();
    await page.click('#credential-reveal-btn');
    await expect(page.locator('#credential-secret')).toHaveValue(SECRET_MARKER);

    // 用户在回显内容上接着编辑：此时它已不再是「服务端那份明文」。
    await page.fill('#credential-secret', 'EDITED-BY-USER');
    // 一旦改动，按钮就不再自称「隐藏」（等价于不再处于回显态）。
    await expect(page.locator('#credential-reveal-btn')).toHaveText('显示');

    // 提交时发的是用户改后的内容。
    await page.click('#credential-save-btn');
    await expect(page.locator('#credential-form')).toBeHidden();
  });

  test('新建时输入密钥后出现复制按钮（仅依据内容，不依赖回显）', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);
    await page.click('#credential-new-btn');

    // 新建态没有回显入口，但自己输入内容后应能一键复制。
    await expect(page.locator('#credential-reveal-btn')).toBeHidden();
    await expect(page.locator('#credential-copy-btn')).toBeHidden();
    await page.fill('#credential-secret', 'TYPED-BY-USER');
    await expect(page.locator('#credential-copy-btn')).toBeVisible();
    await expect(page.locator('#credential-reveal-btn')).toBeHidden();
  });

  test('类型切换会同步密钥字段标签', async ({ page }) => {
    await setupLoggedIn(page);
    await openPanel(page);
    await page.click('#credential-new-btn');

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

test.describe('凭据页与其它视图的互斥', () => {
  test('在凭据页与内嵌 iframe 页之间往返，任何时刻只有一个视图可见', async ({ page }) => {
    await setupLoggedIn(page, { capabilities: true });
    await openPanel(page);

    // 切到内嵌 iframe 页：凭据页必须整体收起，否则两个视图会叠在一起。
    await page.click('#menu-automation');
    await expect(page.locator('#embedded-page-section')).toBeVisible();
    await expect(page.locator('#credentials-page-section')).toBeHidden();
    await expect(page.locator('#menu-automation')).toHaveAttribute('aria-current', 'page');

    // 切回凭据页：内嵌页必须收起。
    await page.click('#credentials-btn');
    await expect(page.locator('#credentials-page-section')).toBeVisible();
    await expect(page.locator('#embedded-page-section')).toBeHidden();
    await expect(page.locator('#credentials-btn')).toHaveAttribute('aria-current', 'page');

    // 再点「服务器列表」：两个页面视图都应收起，服务器列表回归。
    await page.click('#sidebar-servers');
    await expect(page.locator('#credentials-page-section')).toBeHidden();
    await expect(page.locator('#embedded-page-section')).toBeHidden();
    // mock 下没有服务器，列表区展示空态；关键是主内容区本身回来了。
    await expect(page.locator('.user-space-main')).toBeVisible();
    await expect(page.locator('#sidebar-servers')).toHaveAttribute('aria-current', 'page');
  });

  test('窄屏下凭据页仍可进入，且表单不会横向溢出', async ({ page }) => {
    // 移动端侧边栏是 header 下方的横向滚动条带，凭据页必须能在这种布局下
    // 正常进入并完整渲染（新增页面视图最容易在这里被漏掉）。
    await page.setViewportSize({ width: 390, height: 780 });
    await setupLoggedIn(page);
    await openPanel(page);

    await expect(page.locator('#credentials-page-section')).toBeVisible();
    await expect(page.locator('#credential-list')).toContainText('生产密钥');

    await page.click('#credential-new-btn');
    await expect(page.locator('#credential-form')).toBeVisible();

    // 表单与页面都不应产生横向滚动。
    const overflowX = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      form: (() => {
        const el = document.getElementById('credential-form');
        return el ? el.scrollWidth - el.clientWidth : 0;
      })(),
    }));
    expect(overflowX.page).toBeLessThanOrEqual(1);
    expect(overflowX.form).toBeLessThanOrEqual(1);

    // 窄屏下「返回面板」仍可回到服务器列表。
    await page.click('#credentials-page-close');
    await expect(page.locator('#credentials-page-section')).toBeHidden();
    await expect(page.locator('.user-space-main')).toBeVisible();
  });

  test('从凭据页切走后明文不再留在 DOM 中', async ({ page }) => {
    await setupLoggedIn(page, { capabilities: true, revealSecret: SECRET_MARKER });
    await openPanel(page);

    await page.locator('#credential-list button[aria-label="编辑"]').first().click();
    await page.click('#credential-reveal-btn');
    await expect(page.locator('#credential-secret')).toHaveValue(SECRET_MARKER);

    await page.click('#menu-automation');
    await expect(page.locator('#credentials-page-section')).not.toContainText(SECRET_MARKER);
    await expect(page.locator('#credential-secret')).toHaveValue('');
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
