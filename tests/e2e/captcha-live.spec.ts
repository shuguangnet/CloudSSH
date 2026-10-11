/**
 * 真实服务器滑块验证码回归测试（standalone 服务器 + 真实浏览器，非 mock）。
 *
 * 背景：v2.6.3 之前的实现中，前端提交的 x 是「拖拽距离」而服务端 targetX 是
 * 「拼图块绝对左缘」，系统性偏差 startX=10px 超出 ±5px 容差，导致真实浏览器
 * 每次登录必 403（mock e2e 与 solveCaptcha 均绕过前端数学而未覆盖）。
 * 本测试用 CAPTCHA_MODE=test（固定目标 120,48）驱动完整链路：
 * 前端采样换算 → 登录载荷 → 服务端 HMAC/轨迹/对齐校验 → 会话建立。
 *
 * 依赖 dist/worker.mjs（standalone 服务器入口）；缺失时自动构建。
 */
import { expect, test } from '@playwright/test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const PASSWORD = 'live-captcha-password-123';
const TARGET_X = 120; // CAPTCHA_MODE=test 固定目标
const START_X = 10; // 服务端下发的拼图起始偏移

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no port'));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
    server.on('error', reject);
  });
}

/** 按服务端契约拖拽：目标绝对 X → 拖拽距离 = (targetX - startX) * scale（CSS 像素） */
async function dragTo(page: import('@playwright/test').Page, dialog: import('@playwright/test').Locator, targetX: number) {
  const scale = await dialog.locator('.slider-captcha__canvas').evaluate((el) => el.clientWidth / 300);
  const thumb = dialog.locator('.slider-captcha__thumb');
  const box = await thumb.boundingBox();
  if (!box) throw new Error('thumb not measurable');
  const dx = (targetX - START_X) * scale;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width / 2 + (dx * i) / 8, box.y + box.height / 2, { steps: 2 });
    await page.waitForTimeout(35);
  }
  await page.mouse.up();
}

test('真实滑块验证码：未对齐 403 并重置，对齐后密码登录成功', async ({ page }) => {
  test.setTimeout(120_000);
  if (!existsSync('dist/worker.mjs')) {
    const build = spawnSync('node', ['scripts/build-standalone.mjs'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('build-standalone failed');
  }

  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-captcha-live-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], {
    env: { ...process.env, DATA_DIR: directory }, input: PASSWORD, stdio: ['pipe', 'pipe', 'pipe'],
  });

  const child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: base, CAPTCHA_MODE: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });

  try {
    for (let i = 0; i < 200; i++) {
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok) break;
      } catch { /* boot */ }
      if (child.exitCode !== null) throw new Error(`server exited: ${logs}`);
      await delay(50);
    }

    await page.goto(base);
    await page.locator('#admin-login-btn').click();
    const dialog = page.locator('#admin-login-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.slider-captcha__piece')).toBeVisible();

    await dialog.locator('input[type="text"]').fill('admin');
    await dialog.locator('input[type="password"]').fill(PASSWORD);

    // —— 失败路径：拖到错误位置（70，远离目标 120）→ 403，滑块自动重置换新挑战
    await dragTo(page, dialog, 70);
    await expect(dialog.locator('.slider-captcha__track--done')).toHaveCount(1);
    const [rejected] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/auth/password/login')),
      dialog.locator('.auth-challenge-dialog__button--submit').click(),
    ]);
    expect(rejected.status()).toBe(403);
    await expect(dialog.locator('.auth-challenge-dialog__warning')).toContainText('Slider verification failed');
    // 重置：完成态消失、回到可拖拽提示
    await expect(dialog.locator('.slider-captcha__track--done')).toHaveCount(0);
    await expect(dialog.locator('.slider-captcha__hint')).toContainText('Hold and drag');

    // —— 成功路径：对齐固定目标 120 → 200 → reload 进入用户空间
    await dragTo(page, dialog, TARGET_X);
    await expect(dialog.locator('.slider-captcha__track--done')).toHaveCount(1);
    const [accepted] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/auth/password/login')),
      dialog.locator('.auth-challenge-dialog__button--submit').click(),
    ]);
    expect(accepted.status()).toBe(200);

    await expect(page.locator('#user-space-section')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#admin-login-btn')).toHaveCount(0);
  } finally {
    child.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  }
});
