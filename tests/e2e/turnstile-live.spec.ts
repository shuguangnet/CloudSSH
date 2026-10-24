/**
 * 真实 Turnstile 登录回归测试（standalone 服务器 + 真实浏览器 + Cloudflare 官方测试密钥）。
 *
 * 用 Cloudflare Turnstile 官方测试密钥驱动完整链路：`/api/config` 下发 site key →
 * 登录对话框渲染 widget（1x 测试密钥自动通过）→ 提交携带 turnstileToken →
 * 服务端真实调用 siteverify（1x 测试 secret 恒过）→ 会话建立进入用户空间。
 * 同时守护「取代语义」：Turnstile 启用时图片验证码不出现在对话框中。
 *
 * 依赖出站可达 challenges.cloudflare.com（浏览器脚本 + 服务端 siteverify）；
 * 网络不可达时整条跳过（单测 tests/worker/turnstile.test.ts 已覆盖全部服务端逻辑）。
 */
import { expect, test } from '@playwright/test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const PASSWORD = 'live-turnstile-password-123';
// Cloudflare 官方测试密钥（文档公开）：site key 恒过可见模式 / secret siteverify 恒过
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

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

async function cloudflareReachable(): Promise<boolean> {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/api.js', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    return response.ok || response.status === 302 || response.status === 301;
  } catch {
    return false;
  }
}

test('真实 Turnstile：widget 取代图片验证码，token 经 siteverify 后登录成功', async ({ page }) => {
  test.setTimeout(150_000);
  if (!(await cloudflareReachable())) {
    test.skip(true, 'challenges.cloudflare.com unreachable; covered by unit tests');
  }
  if (!existsSync('dist/worker.mjs')) {
    const build = spawnSync('node', ['scripts/build-standalone.mjs'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('build-standalone failed');
  }

  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-turnstile-live-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], {
    env: { ...process.env, DATA_DIR: directory }, input: PASSWORD, stdio: ['pipe', 'pipe', 'pipe'],
  });

  const child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'),
    env: {
      ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: base,
      TURNSTILE_SITE_KEY: TEST_SITE_KEY, TURNSTILE_SECRET_KEY: TEST_SECRET,
    },
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

    // /api/config 下发 site key（secret 绝不出现在任何响应中）
    const config = (await (await fetch(`${base}/api/config`)).json()) as {
      turnstileSiteKey?: string; captchaEnabled?: boolean;
    };
    expect(config.turnstileSiteKey).toBe(TEST_SITE_KEY);
    expect(config.captchaEnabled).toBe(true); // 仍为 true：取代逻辑在前端/登录流程，flag 本身不变
    expect(JSON.stringify(config)).not.toContain(TEST_SECRET);

    await page.goto(base);
    await page.locator('#admin-login-btn').click();
    const dialog = page.locator('#admin-login-dialog');
    await expect(dialog).toBeVisible();

    // 取代语义：图片验证码不渲染，Turnstile widget 就位（headless 下无 iframe，
    // 以 cf-turnstile-response 隐藏输入作为完成判据；1x 测试密钥自动通过）
    await expect(dialog.locator('.image-captcha__input, .image-captcha__figure')).toHaveCount(0);
    const tokenInput = dialog.locator('input[name="cf-turnstile-response"]');
    await expect(tokenInput).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(async () => (await tokenInput.inputValue()) ?? '').not.toBe('');

    // 提交：请求体携带 turnstileToken，服务端真实 siteverify 通过 → 登录成功
    await dialog.locator('input[name="username"]').fill('admin');
    await dialog.locator('input[type="password"]').fill(PASSWORD);
    const [accepted] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/auth/password/login')),
      dialog.locator('.auth-challenge-dialog__button--submit').click(),
    ]);
    expect(accepted.status()).toBe(200);
    const sentBody = accepted.request().postDataJSON() as { turnstileToken?: string };
    expect(sentBody.turnstileToken).toBeTruthy();

    await expect(page.locator('#user-space-section')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#admin-login-btn')).toHaveCount(0);
  } finally {
    child.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
  }
});
