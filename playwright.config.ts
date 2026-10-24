import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Service Worker 会接管页面请求：WebKit 下被 SW 控制的页面里、
    // 未调用 respondWith 的 pass-through 请求会绕过 page.route 拦截并返回空响应，
    // 破坏所有 API mock。e2e 不验证 SW 本身（PWA 资产路由由 standalone 测试覆盖），
    // 因此统一屏蔽 SW 注册保持测试封闭。
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit-mobile',
      testMatch: [
        /(?:auth-challenge|connection-recovery|ios-ime|sftp-panel-actions)\.spec\.ts/,
        /terminal-(?:touch-scroll|focus-report|clipboard)\.spec\.ts/,
      ],
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: {
    command: 'pnpm --dir frontend exec vite --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  outputDir: 'test-results',
});
