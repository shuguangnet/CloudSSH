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
  await page.locator('#user-menu-btn').click();
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
  await page.locator('#user-menu-btn').click();
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

test('管理员登录对话框滑块验证码：渲染、拖拽采样与提交载荷', async ({ page }) => {
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

  const background =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="140" viewBox="0 0 300 140"><rect width="300" height="140" fill="#141b26"/><circle cx="120" cy="70" r="20" fill="rgba(0,0,0,0.48)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/></svg>';
  const pieceSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><path d="M9 0 H35 A9 9 0 0 1 44 9 V13 A9 9 0 0 1 44 31 V35 A9 9 0 0 1 35 44 H9 A9 9 0 0 1 0 35 V9 A9 9 0 0 1 9 0 Z" fill="rgba(255,255,255,0.82)" stroke="#e2e8f0" stroke-width="1.5"/></svg>';
  let challengeFetches = 0;
  await page.route('**/api/captcha/challenge', (route) => {
    challengeFetches += 1;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        challenge: 'dmExfDEyMHw0OHwxNzAwMDAwMDAwfDAwMTEyMjMzNDQ1NTY2Nzc.A'.repeat(1) + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        background,
        piece: pieceSvg,
        width: 300,
        height: 140,
        pieceSize: 44,
        startX: 10,
        y: 48,
      }),
    });
  });

  const loginRequests: Array<{ captcha?: { x: number; samples: Array<{ x: number }> } }> = [];
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

  // 滑块组件：背景 SVG 注入 + 拼图块定位 + 轨道出现
  const canvas = dialog.locator('.slider-captcha__canvas');
  await expect(canvas.locator('> svg')).toHaveCount(1);
  const piece = dialog.locator('.slider-captcha__piece');
  await expect(piece).toBeVisible();
  await expect(dialog.locator('.slider-captcha__track')).toBeVisible();
  await expect(dialog.locator('.slider-captcha__hint')).toContainText('drag the piece');

  // 未拖拽直接提交 → captchaRequired 错误提示，且不发登录请求
  await dialog.locator('input[type="text"]').fill('admin');
  await dialog.locator('input[type="password"]').fill('secret-password');
  await dialog.locator('.auth-challenge-dialog__button--submit').click();
  await expect(dialog.locator('.auth-challenge-dialog__warning')).toContainText('slider verification');
  expect(loginRequests).toHaveLength(0);

  // 真实拖拽：拖拽距离 = (targetX - startX) * scale（画布 CSS 宽 / 300），
  // 模拟对齐固定目标 120；多步 + 间隔确保轨迹时长
  const scale = await dialog.locator('.slider-captcha__canvas').evaluate((el) => el.clientWidth / 300);
  const thumb = dialog.locator('.slider-captcha__thumb');
  const box = await thumb.boundingBox();
  if (!box) throw new Error('thumb not measurable');
  const dx = (120 - 10) * scale;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width / 2 + (dx * i) / 8, box.y + box.height / 2, { steps: 2 });
    await page.waitForTimeout(35);
  }
  await page.mouse.up();

  // 轨道进入完成态
  await expect(dialog.locator('.slider-captcha__track--done')).toHaveCount(1);

  // 提交 → 登录请求体携带 captcha 载荷（challenge + x + samples）
  await dialog.locator('.auth-challenge-dialog__button--submit').click();
  await expect
    .poll(() => loginRequests.length)
    .toBe(1);
  const captcha = loginRequests[0]?.captcha;
  expect(captcha).toBeTruthy();
  // 坐标契约：x 为拼图块绝对左缘（对齐目标 120，容差内），首样本 ≈ startX(10)
  expect(captcha?.x).toBeGreaterThanOrEqual(115);
  expect(captcha?.x).toBeLessThanOrEqual(125);
  expect(captcha?.samples.length).toBeGreaterThanOrEqual(3);
  expect(captcha?.samples[0]?.x).toBeLessThanOrEqual(15);

  // 登录失败后滑块自动重置（新挑战）
  await expect
    .poll(() => challengeFetches)
    .toBe(2);
  await expect(dialog.locator('.slider-captcha__track--done')).toHaveCount(0);
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

  await page.locator('#user-menu-btn').click();
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
  await page.locator('#user-menu-btn').click();
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

test('用户菜单按功能/设置分组展示独立页面入口', async ({ page }) => {
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

  // 初始收起
  await expect(page.locator('#user-menu')).toBeHidden();

  await page.locator('#user-menu-btn').click();
  await expect(page.locator('#user-menu')).toBeVisible();
  await expect(page.locator('#user-menu [data-menu-group="functions"]')).toBeVisible();
  await expect(page.locator('#user-menu [data-menu-group="settings"]')).toBeVisible();
  await expect(page.locator('#menu-automation')).toHaveAttribute('href', '/automation');
  await expect(page.locator('#menu-mcp')).toHaveAttribute('href', '/mcp/settings');
  await expect(page.locator('#menu-account')).toHaveAttribute('href', '/account/settings');
  await expect(page.locator('#user-menu .user-menu-group-label').first()).toHaveText('功能');
  await expect(page.locator('#user-menu .user-menu-group-label').nth(1)).toHaveText('设置');
  await expect(page.locator('#ai-config-btn')).toBeVisible();
  await expect(page.locator('#logout-btn')).toBeVisible();

  // 点击菜单外区域收起
  await page.mouse.click(8, 200);
  await expect(page.locator('#user-menu')).toBeHidden();

  // Escape 收起
  await page.locator('#user-menu-btn').click();
  await expect(page.locator('#user-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#user-menu')).toBeHidden();
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

  await page.locator('#user-menu-btn').click();
  await expect(page.locator('#user-menu')).toBeVisible();
  // 功能组整组隐藏；设置组仅剩 AI Agent 设置
  await expect(page.locator('#user-menu [data-menu-group="functions"]')).toBeHidden();
  await expect(page.locator('#menu-account')).toBeHidden();
  await expect(page.locator('#user-menu [data-menu-group="settings"]')).toBeVisible();
  await expect(page.locator('#user-menu [data-menu-group="settings"] .user-menu-item:not(.hidden)')).toHaveCount(1);
});
