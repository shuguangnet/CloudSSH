/**
 * 真实服务器图片验证码回归测试（standalone 服务器 + 真实浏览器，非 mock）。
 *
 * 用 CAPTCHA_MODE=test（固定答案 TESTS）驱动完整链路：挑战下发 SVG →
 * 输入框提交 → 服务端 HMAC/摘要/单次使用校验 → 会话建立。
 *
 * 历史注记：v2.6.3–v2.6.4 为滑块拼图形态，多轮真实用户拖拽画像返工后按用户
 * 决策改为图片字符验证码（输入框无坐标歧义、移动端零手势依赖）。
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
const TEST_ANSWER = 'TESTS'; // CAPTCHA_MODE=test 固定答案

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

test('真实图片验证码：答错 403 并自动换图，答对后密码登录成功', async ({ page }) => {
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

    const input = dialog.locator('.image-captcha__input');
    const figure = dialog.locator('.image-captcha__figure');

    // 挑战加载：SVG 图片渲染
    await expect(figure.locator('svg')).toBeVisible();
    await expect(input).toBeVisible();

    await dialog.locator('input[name="username"]').fill('admin');
    await dialog.locator('input[type="password"]').fill(PASSWORD);

    // —— 失败路径 1：错误答案 → 403，自动换新图 + 清空输入框
    const loginChallenges: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/auth/password/login')) {
        const body = request.postDataJSON() as { captcha?: { challenge?: string } };
        if (body.captcha?.challenge) loginChallenges.push(body.captcha.challenge);
      }
    });
    await input.fill('WRONG');
    const [rejected] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/auth/password/login')),
      dialog.locator('.auth-challenge-dialog__button--submit').click(),
    ]);
    expect(rejected.status()).toBe(403);
    await expect(dialog.locator('.auth-challenge-dialog__warning')).toContainText('Incorrect captcha');
    // 自动换图：输入框清空
    await expect(input).toHaveValue('');

    // —— 失败路径 2：验证码对但密码错 → 401（验证码通过，防线在密码）
    await input.fill(TEST_ANSWER.toLowerCase()); // 顺带覆盖大小写不敏感
    await dialog.locator('input[type="password"]').fill('definitely-wrong-password');
    const [badPassword] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/auth/password/login')),
      dialog.locator('.auth-challenge-dialog__button--submit').click(),
    ]);
    expect(badPassword.status()).toBe(401);
    // 401 同样换新图：输入框清空，且提交的是新挑战串（≠ 首次登录请求）
    await expect(input).toHaveValue('');
    expect(loginChallenges.length).toBeGreaterThanOrEqual(2);
    expect(loginChallenges[1]).not.toBe(loginChallenges[0]);

    // —— 成功路径：正确答案 + 正确密码 → 200 → reload 进入用户空间
    await dialog.locator('input[type="password"]').fill(PASSWORD);
    await input.fill(TEST_ANSWER);
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
