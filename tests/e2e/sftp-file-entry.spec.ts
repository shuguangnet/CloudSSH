/**
 * SFTP 全链路守护（真实 sshd + 真实 standalone 面板 + 真实浏览器）：
 *
 * 1. attach 来源守护：standalone 的 requestFromNode 恒以 BASE_URL 解析请求 URL，
 *    服务端下发的 SFTP attach 地址因此携带 BASE_URL 主机；终端 WS 却走
 *    externalRequestOrigin（跟随浏览器实际访问地址）。经隧道/反代/内网地址访问
 *    面板时两者不一致，SFTP 数据通道会被 CSP connect-src 'self' 拦截（或被
 *    sameOriginOrHost 拒绝），表现为「终端正常但 SFTP WebSocket 连接错误」。
 *    terminal.ts 的 normalizeSFTPAttachUrl 把 attach 地址改写为页面来源 ——
 *    本测试用「BASE_URL 指向不可达地址 + 浏览器走 127.0.0.1」固化该行为。
 *
 * 2. 主页面「文件」入口守护：服务器卡片文件按钮直接建连并在 SSH 就绪后自动
 *    展开 SFTP 抽屉，无需先手动打开终端抽屉。
 *
 * 3. md/html 在线编辑守护：双击进入 CodeMirror 编辑器，修改保存后远端内容落地。
 */
import { expect, test } from '@playwright/test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const PASSWORD = 'fixture-password-123';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  await new Promise((done) => server.close(done));
  return port;
}

interface Env {
  base: string;
  port: number;
  sshPort: number;
  serverId: number;
  clientKey: string;
  cleanup: () => Promise<void>;
}

/** 杀掉遗留的 fixture 进程（按 /proc environ 的 DATA_DIR 匹配，绝不触碰 docker 容器同名进程） */
function killStaleFixtures(): void {
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (pid === String(process.pid)) continue;
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8');
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      // fixture 面板（DATA_DIR）或 fixture sshd（-f 配置路径）
      if (env.includes('cloudssh-sftp-e2e-') || cmdline.includes('cloudssh-sftp-e2e-')) {
        process.kill(Number(pid), 'SIGKILL');
      }
    } catch { /* 进程消失或无权读取 */ }
  }
}

/** 启动 sshd + standalone 面板（CAPTCHA_MODE=test），管理员登录并保存服务器 */
async function bootEnvironment(mismatchBaseUrl: boolean): Promise<Env> {
  killStaleFixtures();
  if (!existsSync('dist/worker.mjs')) {
    const build = spawnSync('node', ['scripts/build-standalone.mjs'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('build-standalone failed');
  }

  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-sftp-e2e-'));
  const sshPort = await freePort();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const hostKey = join(directory, 'host-key');
  const clientKey = join(directory, 'client-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(join(directory, 'authorized_keys'), readFileSync(`${clientKey}.pub`));
  writeFileSync(join(directory, 'sshd_config'), [
    `Port ${sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`,
    `PidFile ${directory}/sshd.pid`, `AuthorizedKeysFile ${directory}/authorized_keys`,
    'StrictModes no', 'PermitRootLogin yes', 'PubkeyAuthentication yes',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM yes',
    'LogLevel INFO', 'Subsystem sftp internal-sftp', '',
  ].join('\n'));
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(directory, 'sshd_config')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let sshdDead = false;
  const stopSshd = () => { sshdDead = true; try { sshd.kill('SIGTERM'); } catch { /* exited */ } };
  sshd.on('exit', () => { sshdDead = true; });

  const dataDir = join(directory, 'data');
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], {
    env: { ...process.env, DATA_DIR: dataDir }, input: PASSWORD, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const panel = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'),
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port),
      // 场景 1：BASE_URL 故意指向不可达地址，模拟隧道/反代/内网访问面板
      BASE_URL: mismatchBaseUrl ? 'http://10.255.255.1:65535' : base,
      ALLOW_INSECURE_HTTP: 'true', CAPTCHA_MODE: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let panelLogs = '';
  panel.stdout.on('data', (d) => (panelLogs += d));
  panel.stderr.on('data', (d) => (panelLogs += d));
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* booting */ }
    if (panel.exitCode !== null) throw new Error(`panel exited: ${panelLogs}`);
    await delay(50);
  }

  const cleanup = async () => {
    panel.kill('SIGTERM');
    stopSshd();
    for (let i = 0; i < 50 && (!sshdDead || panel.exitCode === null); i++) await delay(50);
    rmSync(directory, { recursive: true, force: true });
  };

  // 管理员登录 + 保存服务器
  const { pbkdf2Sync } = await import('node:crypto');
  const config = await (await fetch(`${base}/api/config`)).json();
  const key = pbkdf2Sync(
    PASSWORD,
    Buffer.from(config.passwordAuth.salt, 'base64url'),
    config.passwordAuth.iterations,
    32,
    'sha256'
  ).toString('base64url');
  const challenge = (await (await fetch(`${base}/api/captcha/challenge`)).json()).challenge;
  const login = await fetch(`${base}/api/auth/password/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, username: 'admin', captcha: { challenge, answer: 'TESTS' } }),
  });
  expect(login.status, panelLogs).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .find((v) => v.startsWith('session='))!!
    .split(';')[0];
  const added = await fetch(`${base}/api/servers`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'sftp-box', host: '127.0.0.1', port: sshPort, username: 'root',
      auth_method: 'publickey', credential: readFileSync(clientKey, 'utf8'),
    }),
  });
  expect(added.status, await added.text()).toBe(201);
  const servers = await (await fetch(`${base}/api/servers`, { headers: { Cookie: cookie } })).json();
  const serverId = servers.find((s: any) => s.name === 'sftp-box').id;
  return { base, port, sshPort, serverId, clientKey, cleanup };
}

/** 真实 ssh 客户端执行远端命令（fixture 私钥，仅用于测试夹具） */
function sshExec(env: Env, command: string): string {
  return execFileSync('ssh', [
    '-i', env.clientKey, '-p', String(env.sshPort),
    '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    'root@127.0.0.1', command,
  ]).toString();
}

/** 浏览器 UI 登录（管理员密码对话框，CAPTCHA_MODE=test 答案 TESTS） */
async function uiLogin(page: import('@playwright/test').Page, base: string): Promise<void> {
  await page.goto(`${base}/?lang=zh-CN`);
  await page.locator('#admin-login-btn').click();
  const dialog = page.locator('#admin-login-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="username"]').fill('admin');
  await dialog.locator('input[type="password"]').fill(PASSWORD);
  await dialog.locator('.image-captcha__input').fill('TESTS');
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/password/login')),
    dialog.locator('.auth-challenge-dialog__button--submit').click(),
  ]);
  await page.waitForSelector('.server-card', { timeout: 20_000 });
}

/** 等待 SFTP 列表渲染，返回行数（失败时为 0） */
async function waitForRows(page: import('@playwright/test').Page, ms = 15_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const rows = await page.locator('.sftp-entry').count();
    if (rows > 0) return rows;
    await delay(200);
  }
  return 0;
}

test.describe.configure({ mode: 'serial' });

test('SFTP attach 跟随浏览器来源（BASE_URL 不一致也能连接）', async ({ page }) => {
  test.setTimeout(180_000);
  const env = await bootEnvironment(true);
  try {
    const sftpWsUrls: string[] = [];
    page.on('websocket', (ws) => {
      if (ws.url().includes('/api/ssh/sftp')) sftpWsUrls.push(ws.url());
    });
    await uiLogin(page, env.base);
    await page.click(`#connect-${env.serverId}`);
    await expect(page.locator('#term-status')).toContainText('已连接', { timeout: 30_000 });
    await page.click('[data-drawer="sftp"]');
    await page.waitForSelector('#sftp-panel', { state: 'visible', timeout: 10_000 });
    const rows = await waitForRows(page);
    expect(rows, 'SFTP 列表应成功加载').toBeGreaterThan(0);
    // attach 地址必须改写为浏览器实际访问的来源（页面 origin），而非 BASE_URL
    expect(sftpWsUrls.length, '应发起 SFTP 数据通道连接').toBeGreaterThan(0);
    for (const url of sftpWsUrls) {
      expect(new URL(url).host, `attach URL 应为页面来源: ${url}`).toBe(`127.0.0.1:${env.port}`);
    }
  } finally {
    await env.cleanup();
  }
});

test('主页面文件入口直达 SFTP + md/html 在线编辑', async ({ page }) => {
  test.setTimeout(180_000);
  const env = await bootEnvironment(false);
  const stamp = Date.now();
  const mdName = `__sftp_e2e_${stamp}.md`;
  const htmlName = `__sftp_e2e_${stamp}.html`;
  const home = sshExec(env, 'echo $HOME').trim();
  try {
    sshExec(env, `printf '# Hello SFTP' > '${home}/${mdName}'`);
    sshExec(env, `printf '<h1>Hi</h1>' > '${home}/${htmlName}'`);

    await uiLogin(page, env.base);
    // 卡片「文件」按钮：建连 + 就绪后自动展开 SFTP 抽屉（不点终端抽屉按钮）
    await page.click(`#files-${env.serverId}`);
    await expect(page.locator('#term-status')).toContainText('已连接', { timeout: 30_000 });
    await page.waitForSelector('#sftp-panel', { state: 'visible', timeout: 15_000 });
    const rows = await waitForRows(page);
    expect(rows).toBeGreaterThan(0);
    await expect(page.locator('.sftp-entry', { hasText: mdName })).toBeVisible();

    // 双击 md 文件 → CodeMirror 编辑器打开
    const editor = page.locator('dialog.remote-editor');
    await page.locator('.sftp-entry', { hasText: mdName }).dblclick();
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(editor.locator('.cm-content')).toContainText('Hello SFTP');
    // 修改并保存（单行文件，End 即文档末尾）
    await editor.locator('.cm-content').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' UPDATED');
    await editor.locator('.remote-editor__button--save').click();
    for (let i = 0; i < 40; i++) {
      const remote = sshExec(env, `cat '${home}/${mdName}' 2>/dev/null || true`);
      if (remote.includes('Hello SFTP UPDATED')) break;
      await delay(250);
      if (i === 39) throw new Error(`保存未落地，远端内容: ${remote}`);
    }
    await editor.locator('.remote-editor__close').click();
    await expect(editor).toBeHidden({ timeout: 5_000 });

    // 双击 html 文件 → 编辑器同样支持
    await page.locator('.sftp-entry', { hasText: htmlName }).dblclick();
    await expect(editor).toBeVisible({ timeout: 10_000 });
    await expect(editor.locator('.cm-content')).toContainText('<h1>Hi</h1>');
    await editor.locator('.remote-editor__close').click();
  } finally {
    sshExec(env, `rm -f '${home}/${mdName}' '${home}/${htmlName}'`);
    await env.cleanup();
  }
});
