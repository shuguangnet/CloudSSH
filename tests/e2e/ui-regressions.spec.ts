import { expect, test } from '@playwright/test';
import { blockOptionalThirdPartyAssets } from './helpers';

test('强制 GitHub 登录模式隐藏匿名连接表单', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sitekey: '',
        githubAuthEnabled: true,
        githubAuthRequired: true,
      }),
    })
  );

  await page.goto('/');

  await expect(page.locator('#github-auth-required-panel')).toBeVisible();
  await expect(page.locator('#github-login-btn')).toBeVisible();
  await expect(page.locator('#connection-form')).toHaveCount(0);
});

test('AI 配置首次点击立即显示，配置数据异步加载', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );

  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  await page.route('**/api/ai/config', async (route) => {
    await configGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        base_url: 'https://api.example.com/v1',
        model: 'example-model',
        api_key_last4: '1234',
      }),
    });
  });

  await page.goto('/');
  await page.locator('#ai-config-btn').click();

  await expect(page.locator('#ai-config-modal')).toBeVisible();
  await expect(page.locator('#ai-base-url')).toHaveValue('');

  releaseConfig();
  await expect(page.locator('#ai-base-url')).toHaveValue('https://api.example.com/v1');
  await expect(page.locator('#ai-model')).toHaveValue('example-model');
});

test('AI 模型选择下拉框：免重复输入 token 获取模型列表，且展示完整模型并支持切换与清空', async ({
  page,
}) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 42, username: 'testuser', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        base_url: 'https://api.example.com/v1',
        model: 'model-a',
        api_key_last4: '9999',
      }),
    })
  );

  let capturedRequestBody: any = null;
  await page.route('**/api/ai/models', async (route) => {
    capturedRequestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'model-a' },
          { id: 'model-b' },
          { id: 'model-c' },
        ],
        fallback: false,
      }),
    });
  });

  await page.goto('/');
  await page.locator('#ai-config-btn').click();
  await expect(page.locator('#ai-config-modal')).toBeVisible();

  // 验证 API 密钥输入框为空，但显示了掩码提示
  await expect(page.locator('#ai-api-key')).toHaveValue('');
  await expect(page.locator('#ai-key-hint')).toContainText('9999');

  // 用户第二次修改模型时：无需输入 token，直接点击“获取模型列表”
  await page.locator('#ai-fetch-models-btn').click();

  // 验证请求体：无需传 api_key，后端将自动使用已存储的密钥
  expect(capturedRequestBody).toEqual({ base_url: 'https://api.example.com/v1' });

  // 获取成功后，自定义下拉菜单自动展开并展示所有 3 个模型
  const menu = page.locator('#ai-model-menu');
  await expect(menu).toBeVisible();
  const options = menu.locator('#ai-model-options > div');
  await expect(options).toHaveCount(3);

  // 检查 model-b 和 model-c 都在列表中，而不是只显示当前选中的 1 个模型
  await expect(options.nth(0)).toContainText('model-a');
  await expect(options.nth(1)).toContainText('model-b');
  await expect(options.nth(2)).toContainText('model-c');

  // 点击选择 model-b
  await options.nth(1).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#ai-model')).toHaveValue('model-b');

  // 点击清空按钮
  await page.locator('#ai-model-clear-btn').click();
  await expect(page.locator('#ai-model')).toHaveValue('');
  // 清空后下拉菜单重新展开完整模型列表
  await expect(menu).toBeVisible();
  await expect(options).toHaveCount(3);

  // 点击下拉箭头按钮切换折叠
  await page.locator('#ai-model-dropdown-btn').click();
  await expect(menu).toBeHidden();
});

test('管理员登录对话框图片验证码：渲染、输入与提交载荷', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.addInitScript(() => {
    localStorage.setItem('cloudssh_theme_selection', 'standard-light');
  });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        captchaEnabled: true,
        githubAuthEnabled: false,
        githubAuthRequired: false,
        authMode: 'password',
        adminUsernameRequired: true,
        passwordAuth: { kdf: 'pbkdf2-sha256', iterations: 1000, salt: 'c2FsdHNhbHRzYWx0c2FsdA' },
      }),
    })
  );

  const image =
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48"><rect width="160" height="48" fill="#141b26"/><text x="16" y="30" font-size="28" fill="#7dd3fc">T</text><text x="48" y="28" font-size="28" fill="#c4b5fd">E</text><text x="80" y="31" font-size="28" fill="#6ee7b7">S</text><text x="112" y="27" font-size="28" fill="#fcd34d">T</text><text x="144" y="29" font-size="28" fill="#f9a8d4">S</text></svg>';
  let challengeFetches = 0;
  await page.route('**/api/captcha/challenge', (route) => {
    challengeFetches += 1;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        challenge: `dmVydHktbG9uZy1jaGFsbGVuZ2Utc3RyaW5nLSR7aXRlcmF0aW9ufQ==.${'A'.repeat(43)}`,
        image,
        width: 160,
        height: 48,
      }),
    });
  });

  const loginRequests: Array<{ captcha?: { challenge: string; answer: string } }> = [];
  await page.route('**/api/auth/password/login', async (route) => {
    const body = route.request().postDataJSON();
    loginRequests.push(body);
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
  });

  await page.goto('/');

  // 密码模式渲染管理员登录入口
  const loginBtn = page.locator('#admin-login-btn');
  await expect(loginBtn).toBeVisible();
  await loginBtn.click();

  const dialog = page.locator('#admin-login-dialog');
  await expect(dialog).toBeVisible();

  // 验证码组件：SVG 图片注入 + 答案输入框 + 换一张按钮
  const figure = dialog.locator('.image-captcha__figure');
  const input = dialog.locator('.image-captcha__input');
  await expect(figure.locator('> svg')).toHaveCount(1);
  await expect(input).toBeVisible();
  await expect(dialog.locator('.image-captcha__refresh')).toBeVisible();

  // 未填答案直接提交 → captchaRequired 错误提示，且不发登录请求
  await dialog.locator('input[name="username"]').fill('admin');
  await dialog.locator('input[type="password"]').fill('secret-password');
  await dialog.locator('.auth-challenge-dialog__button--submit').click();
  await expect(dialog.locator('.auth-challenge-dialog__warning')).toContainText('captcha');
  expect(loginRequests).toHaveLength(0);

  // 填入答案提交 → 登录请求体携带 { challenge, answer } 载荷
  await input.fill('TESTS');
  await dialog.locator('.auth-challenge-dialog__button--submit').click();
  await expect
    .poll(() => loginRequests.length)
    .toBe(1);
  const captcha = loginRequests[0]?.captcha;
  expect(captcha).toBeTruthy();
  expect(captcha?.answer).toBe('TESTS');
  expect(captcha?.challenge).toContain('.');
  // 不再携带旧滑块坐标/轨迹字段
  expect((captcha as Record<string, unknown>)?.x).toBeUndefined();
  expect((captcha as Record<string, unknown>)?.samples).toBeUndefined();

  // 登录失败后自动换新图（新挑战请求）并清空输入框
  await expect
    .poll(() => challengeFetches)
    .toBe(2);
  await expect(input).toHaveValue('');

  // 点击“换一张”手动刷新（不额外发登录请求）
  await dialog.locator('.image-captcha__refresh').click();
  await expect
    .poll(() => challengeFetches)
    .toBe(3);
  expect(loginRequests).toHaveLength(1);
  // SVG 移除 width/height 后按容器等比缩放
  const svgSize = await figure.locator('> svg').evaluate((svg) => ({
    w: svg.getAttribute('width'),
    cw: svg.getBoundingClientRect().width,
  }));
  expect(svgSize.w).toBeNull();
  expect(svgSize.cw).toBeGreaterThan(100);
});

/**
 * Liquid Glass 下 .cyber-box 的 overflow 简写回归（v2.3.0 缺陷）：
 *
 * 主题规则 `html[data-ui-style="liquid"] :is(.server-card, .cyber-box)` 曾使用
 * `overflow: hidden` 简写。它会同时把 overflow-x / overflow-y 置为 hidden，
 * 且特异性高于 Tailwind 的 `.overflow-y-auto`。而 #ai-model-menu（AI 模型下拉）
 * 与 .responsive-modal-panel（AI 设置面板本身）都带 .cyber-box 并依赖滚动，
 * 于是模型列表与面板全部失去滚动能力 —— 445 个模型只能看到前 6 个且无法选择。
 *
 * 本用例以「用户级」方式断言：滚轮悬停在列表上必须真的产生滚动，且滚动后
 * 靠后的模型必须能被点选并写回输入框（仅在断言 overflow-y 计算值之外多一层保障）。
 */
test('Liquid Glass 主题下 AI 模型下拉与设置面板保持可滚动、可选（overflow 简写回归）', async ({
  page,
}) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 42, username: 'testuser', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        base_url: 'https://api.example.com/v1',
        model: 'model-0',
        api_key_last4: '9999',
      }),
    })
  );
  // 模型数量必须足以超出 max-h-52（208px）才会暴露不可滚动的问题
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: Array.from({ length: 60 }, (_, i) => ({ id: `model-${i}` })),
        fallback: false,
      }),
    })
  );

  await page.addInitScript(() => localStorage.setItem('cloudssh_theme_selection', 'liquid-glass'));
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'liquid');

  await page.locator('#ai-config-btn').click();
  await expect(page.locator('#ai-config-modal')).toBeVisible();
  await page.locator('#ai-fetch-models-btn').click();

  const menu = page.locator('#ai-model-menu');
  await expect(menu).toBeVisible();
  const options = menu.locator('#ai-model-options > div');
  await expect(options).toHaveCount(60);

  // 意图锁定：必须保留 Tailwind 的 overflow-y-auto（曾被简写改成 hidden）
  expect(await menu.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  // 面板本身同样依赖 overflow-y-auto 在矮视口下滚动
  expect(
    await page
      .locator('#ai-config-modal .responsive-modal-panel')
      .evaluate((el) => getComputedStyle(el).overflowY)
  ).toBe('auto');

  // 用户级验证：滚轮悬停在列表上必须真的滚动
  const menuBox = (await menu.boundingBox())!;
  await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // 滚动到靠后位置后，必须能真正点选并写回输入框
  const target = options.nth(40);
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#ai-model')).toHaveValue('model-40');
});

/**
 * 窄视口弹窗不得出现横向滚动条（v2.3.0 后续缺陷）：
 *
 * 模型行里的「获取模型列表」按钮是 shrink-0 + whitespace-nowrap，而
 * #ai-model-combobox 未声明 min-width: 0，因此 flex 行无法收缩，整行比面板宽出
 * 约 80px；而 overflow-y: auto 会使 overflow-x 计算为 auto，于是弹窗底部冒出
 * 原生横向滚动条，并把左侧标签挤出可视区（用户上报的「不美观」）。
 *
 * 修复：面板 overflow-x: hidden + 面板内 .terminal-input { min-width: 0 }
 *   + 模型组合框 min-w-0；滚动条另经全局主题化，不再使用系统原生外观。
 * 同时守护 .no-scrollbar 确实有定义（此前该 class 被引用但从未实现，
 * 导致面包屑/胶囊条等本应隐藏的横向滚动条一直以原生样式出现）。
 */
test('窄视口 AI 设置弹窗不出现横向滚动条，且 .no-scrollbar 已实现', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 42, username: 'testuser', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/ai/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        base_url: 'https://openrouter.ai/api/v1',
        model: 'gpt-4o-mini',
        api_key_last4: '26b8',
      }),
    })
  );
  await page.route('**/api/ai/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        // 长模型名曾把面板撑出横向滚动条
        models: Array.from({ length: 12 }, (_, i) => ({
          id: `deepseek/deepseek-r1-distill-llama-70b-${i}`,
        })),
        fallback: false,
      }),
    })
  );

  await page.addInitScript(() => localStorage.setItem('cloudssh_theme_selection', 'liquid-glass'));
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'liquid');

  const moreBtn = page.locator('#user-space-more-btn');
  if (await moreBtn.isVisible()) await moreBtn.click();
  await page.locator('#ai-config-btn').click();
  await expect(page.locator('#ai-config-modal')).toBeVisible();
  await page.locator('#ai-fetch-models-btn').click();
  await expect(page.locator('#ai-model-menu')).toBeVisible();

  const layout = await page.evaluate(() => {
    const panel = document.querySelector(
      '#ai-config-modal .responsive-modal-panel'
    ) as HTMLElement;
    const menu = document.getElementById('ai-model-menu') as HTMLElement;
    const btn = document.getElementById('ai-fetch-models-btn') as HTMLElement;
    const panelRect = panel.getBoundingClientRect();
    const probe = document.createElement('div');
    probe.className = 'no-scrollbar';
    document.body.appendChild(probe);
    const noScrollbarWidth = getComputedStyle(probe).scrollbarWidth;
    probe.remove();
    return {
      panelHasHScroll: panel.scrollWidth > panel.clientWidth,
      menuHasHScroll: menu.scrollWidth > menu.clientWidth,
      btnInsidePaddingBox: btn.getBoundingClientRect().right <= panelRect.right,
      noScrollbarWidth,
    };
  });

  expect(layout.panelHasHScroll).toBe(false);
  expect(layout.menuHasHScroll).toBe(false);
  expect(layout.btnInsidePaddingBox).toBe(true);
  expect(layout.noScrollbarWidth).toBe('none');
});

test('标签栏不绘制无效纵向滚动条（单行横向容器必须禁止纵向溢出）', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 42, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#user-space-section')).toBeVisible();

  // 需要一个真实标签项才能复现溢出（「+」按钮本身不满高）
  await page.evaluate(async () => {
    const main = await (window as any).eval("import('/src/main.ts')");
    const { terminal } = main.showTerminalWithNewTab('Server-1', {
      host: '127.0.0.1',
      port: 22,
      serverId: 101,
    });
    terminal.mount();
  });
  await expect(page.locator('#tab-bar .tab-item')).toHaveCount(1);

  const metrics = await page.locator('#tab-bar').evaluate((el) => ({
    overflowX: getComputedStyle(el).overflowX,
    overflowY: getComputedStyle(el).overflowY,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));

  // 修复前：overflow-x-auto 把 overflow-y 隐式提升为 auto，而标签项上下各 3px margin
  // 的 margin-box（36px）比 36px 高度减 1px 下边框后的可用高度多 1px，于是右侧被绘制一条
  // 无效纵向滚动条；显式 overflow-y-hidden 后纵向不再产生可滚动溢出。
  expect(metrics.overflowY).toBe('hidden');
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
  // 多标签时仍需横向滚动，不得因禁止纵向滚动而一并关闭
  expect(metrics.overflowX).toBe('auto');
});

test('左侧导航栏按功能/设置分组常驻展示独立页面入口', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  // 自托管能力全开：功能组（自动化/MCP）与设置组（账号设置/AI）都应出现
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sshSharingEnabled: true,
        mcpEnabled: true,
        adminAccountEnabled: true,
        automationEnabled: true,
      }),
    })
  );

  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#user-space-section')).toBeVisible();

  // 左侧边栏常驻展示：功能/设置分组 + 各入口
  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('[data-menu-group="functions"]')).toBeVisible();
  await expect(sidebar.locator('[data-menu-group="settings"]')).toBeVisible();
  await expect(page.locator('#sidebar-servers')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#menu-automation')).toHaveAttribute('href', '/automation');
  await expect(page.locator('#menu-mcp')).toHaveAttribute('href', '/mcp/settings');
  await expect(page.locator('#menu-account')).toHaveAttribute('href', '/account/settings');
  await expect(sidebar.locator('.sidebar-group-label').first()).toHaveText('功能');
  await expect(sidebar.locator('.sidebar-group-label').nth(1)).toHaveText('设置');
  await expect(page.locator('#ai-config-btn')).toBeVisible();
  await expect(page.locator('#logout-btn')).toBeVisible();
  await expect(page.locator('#user-info')).toBeVisible();
  // 旧的用户下拉菜单已被侧边栏取代
  await expect(page.locator('#user-menu-btn')).toHaveCount(0);
  await expect(page.locator('#user-menu')).toHaveCount(0);

  // 侧边栏位于内容左侧：内容区起点 = 侧边栏右缘
  const sidebarBox = await sidebar.boundingBox();
  const mainBox = await page.locator('.user-space-main').boundingBox();
  expect(mainBox?.x).toBeCloseTo(sidebarBox!.x + sidebarBox!.width, 0);
});

test('Workers 部署（无自动化/MCP/账号页能力）隐藏功能组与受限入口', async ({ page }) => {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/user/theme', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"theme":null}' })
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 1, github_id: 1, username: 'tester', avatar_url: '' }),
    })
  );
  await page.route('**/api/servers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sshSharingEnabled: true,
        mcpEnabled: false,
        adminAccountEnabled: false,
        automationEnabled: false,
      }),
    })
  );

  await page.goto('/?lang=zh-CN');
  await expect(page.locator('#user-space-section')).toBeVisible();

  // 左侧边栏：功能组整组隐藏；设置组仅剩 AI Agent 设置
  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('[data-menu-group="functions"]')).toBeHidden();
  await expect(page.locator('#menu-account')).toBeHidden();
  await expect(sidebar.locator('[data-menu-group="settings"]')).toBeVisible();
  await expect(sidebar.locator('[data-menu-group="settings"] .sidebar-item:not(.hidden)')).toHaveCount(1);
});
