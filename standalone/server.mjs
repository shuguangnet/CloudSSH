import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer, WebSocket as NetworkWebSocket } from 'ws';
import { installWorkerGlobals, LocalNamespace } from './runtime.mjs';
import { applyPendingRestore, createBackup, stageRestore, RESTORE_MAX_UPLOAD } from './backup.mjs';
import { AccessStore, tokenHash, clientIpFrom } from './access-store.mjs';
import { handleMcp } from './mcp.mjs';
import { AdminAccount, validUsername } from './admin-account.mjs';
import { savedServers, executeSaved, drainSshChainPool, sshChainPoolStats, connectionConfig } from './operations.mjs';
import { renderMetrics, metricsAuthorized } from './metrics.mjs';
import { AutomationStore } from './automation-store.mjs';
import { DatabaseStore } from './database-store.mjs';
import { createDatabaseRoutes } from './database-api.mjs';
import { generateVapidKeys } from './webpush.mjs';
import { setVapidProvider } from './notify.mjs';
import { AutomationEngine } from './scheduler.mjs';
import { DashboardEngine } from './dashboard.mjs';
import { createAutomationRoutes } from './automation-api.mjs';
import { createLiveStatusHub } from './live-status.mjs';
import { createCliRoutes } from './cli-api.mjs';
import { resolveBearerIdentity } from './cli-auth.mjs';

process.umask(0o077);
installWorkerGlobals();
const { worker, SSHSessionDO, UserDBDO, SSHShareDO, SSHSession,
  getAuthenticatedUser, parseAdminPasswordHash, isBlockedCommand } = await import('../dist/worker.mjs');
import { originAllowed as originAllowedFor } from './origin.mjs';
import { createBatchRoutes } from './batch.mjs';

const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
// 待应用的恢复包：必须在打开任何数据库 / 读取账号文件之前交换，
// 否则新库会被旧句柄重建覆盖。现役文件移入 pre-restore-<ts>/ 备查。
const appliedRestore = applyPendingRestore(dataDir);
if (appliedRestore) {
  console.log(`[backup] applied pending restore (${appliedRestore.files.length} files); previous state archived to ${appliedRestore.archived_to}`);
}
const baseUrl = new URL(process.env.BASE_URL || 'http://localhost:8787');
if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.pathname !== '/' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('BASE_URL must be an HTTP(S) origin without a path');
}
if (baseUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname) && process.env.ALLOW_INSECURE_HTTP !== 'true') {
  throw new Error('Use HTTPS in BASE_URL, or explicitly set ALLOW_INSECURE_HTTP=true for a trusted network');
}
const env = {
  ...process.env,
  BASE_URL: baseUrl.origin,
  SELF_HOSTED: 'true',
  SELF_HOSTED_ALLOW_PRIVATE: 'true',
  REQUIRE_GITHUB_AUTH: 'true',
  STRICT_HOST_KEY_VERIFY: 'true',
  ENABLE_SSH_SHARING: 'false',
  DEBUG_MODE: 'false',
};
// Compose uses blank defaults for optional OAuth settings.
if (env.GITHUB_ALLOWED_USER_IDS === '') delete env.GITHUB_ALLOWED_USER_IDS;
if (!env.ADMIN_PASSWORD_HASH && existsSync(join(dataDir, 'admin-password-hash'))) {
  env.ADMIN_PASSWORD_HASH = readFileSync(join(dataDir, 'admin-password-hash'), 'utf8').trim();
}
const adminAccount = new AdminAccount(dataDir, env);
if (env.ADMIN_PASSWORD_HASH && parseAdminPasswordHash(env.ADMIN_PASSWORD_HASH) === 'invalid') throw new Error('Invalid administrator password hash');
if (!env.ADMIN_PASSWORD_HASH && !(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)) {
  throw new Error('Authentication required: run scripts/setup-standalone.mjs or configure GitHub OAuth');
}
env.USER_DB = new LocalNamespace('users', UserDBDO, env, dataDir);
env.SSH_SESSION = new LocalNamespace('ssh', SSHSessionDO, env, dataDir);
env.SSH_SHARE = new LocalNamespace('shares', SSHShareDO, env, dataDir);
const store = new AccessStore(join(dataDir, 'mcp.sqlite'));
const automationStore = new AutomationStore(join(dataDir, 'automation.sqlite'));
// 数据库连接与代理的持久化。密钥文件与 sqlite 分开存放，避免只备份
// 一个文件就泄露全部数据库密码（见 database-store.mjs 顶部说明）。
const databaseStore = new DatabaseStore(join(dataDir, 'database.sqlite'));
// Web Push VAPID 身份：首次生成后落库，重启不变，否则浏览器订阅会全部失效。
setVapidProvider(async () => automationStore.getOrCreateVapid(generateVapidKeys));
const automationEngine = new AutomationEngine({
  store: automationStore, env, SSHSession, executeSaved, log: (message) => console.error(`[automation] ${message}`),
});
const dashboardEngine = new DashboardEngine({
  env, store: automationStore, executeSaved, SSHSession,
  intervalSeconds: Number(env.DASHBOARD_INTERVAL_SECONDS),
  log: (message) => console.error(`[dashboard] ${message}`),
});
dashboardEngine.start();
const liveStatusHub = createLiveStatusHub({ env, SSHSession, executeSaved });
const automationRoutes = createAutomationRoutes({
  env, SSHSession, store: automationStore, engine: automationEngine, dashboard: dashboardEngine, executeSaved, getAuthenticatedUser, liveStatus: liveStatusHub,
});
const batchRoutes = createBatchRoutes({ env, getAuthenticatedUser, SSHSession });
const databaseRoutes = createDatabaseRoutes({ env, databaseStore, getAuthenticatedUser });
// PWA assets are copied to dist/public by scripts/build-standalone.mjs; icons are
// immutable, the service worker must always revalidate.
const PUBLIC_FILES = {
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json', cache: 'public, max-age=3600' },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png', cache: 'public, max-age=604800' },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png', cache: 'public, max-age=604800' },
  '/icons/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: 'image/png', cache: 'public, max-age=604800' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml', cache: 'public, max-age=3600' },
};

// Split shell 模式的 CSP：脚本来自同源 /assets/*（哈希文件名，不可变缓存），
// 无需脚本哈希；其余策略与 build-html.js 生成的内联 PANEL_CSP 保持同口径
// （脚本哈希每次构建都变，而资产文件名本身就是内容哈希，'self' 即足够严格）。
const SPLIT_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self' https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Split app shell (dist/public/index.html plus hashed /assets/* files, copied by
// scripts/build-standalone.mjs). Served only when every referenced asset exists;
// otherwise the inlined worker shell remains the fallback. Hashed filenames make
// the assets immutable across deploys, so only index.html revalidates.
const SPLIT_SHELL = (() => {
  try {
    const publicDir = new URL('../dist/public/', import.meta.url);
    const html = readFileSync(new URL('index.html', publicDir), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)=["']\/assets\/([\w.-]+)["']/g)].map((match) => match[1]);
    if (assets.length === 0 || !assets.every((name) => existsSync(new URL(`assets/${name}`, publicDir)))) return null;
    return html;
  } catch { return null; }
})();
const ASSET_TYPES = {
  js: 'text/javascript; charset=utf-8', css: 'text/css', svg: 'image/svg+xml', png: 'image/png',
  map: 'application/json', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
};
function serveAsset(name) {
  if (!/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 });
  const type = ASSET_TYPES[name.split('.').pop()];
  if (!type) return new Response('Not found', { status: 404 });
  try {
    return new Response(readFileSync(new URL(`../dist/public/assets/${name}`, import.meta.url)), {
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  } catch { return new Response('Not found', { status: 404 }); }
}
let authGeneration = env.ADMIN_PASSWORD_HASH ? tokenHash(env.ADMIN_PASSWORD_HASH) : 'github';

// Support Cloudflare's outbound WebSocket fetch for existing Tunnel connections.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  if (new Headers(options.headers).get('upgrade')?.toLowerCase() !== 'websocket') return nativeFetch(input, options);
  const url = new URL(String(input));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return await new Promise((resolveFetch, reject) => {
    const headers = Object.fromEntries(new Headers(options.headers));
    delete headers.upgrade; delete headers.connection; delete headers['sec-websocket-version'];
    const socket = new NetworkWebSocket(url, { headers, followRedirects: false, handshakeTimeout: 15000 });
    socket.once('open', () => {
      socket.accept = () => {};
      resolveFetch(new Response(null, { status: 101, webSocket: socket }));
    });
    socket.once('unexpected-response', (_request, response) => {
      response.resume(); socket.terminate();
      resolveFetch(new Response(null, { status: response.statusCode, headers: response.headers }));
    });
    socket.once('error', reject);
  });
};

const limits = new Map();
function rateLimited(key) {
  const now = Date.now();
  let state = limits.get(key);
  if (!state || state.expires <= now) {
    if (limits.size >= 10000) limits.delete(limits.keys().next().value);
    state = { count: 0, expires: now + 60000 }; limits.set(key, state);
  }
  return ++state.count > 120;
}
export async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request body exceeds 1 MiB'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function requestFromNode(req, body, res) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  // Client-supplied proxy/IP headers must not impersonate the trusted Cloudflare header.
  headers.set('CF-Connecting-IP', req.socket.remoteAddress || 'unknown');
  // Propagate client disconnects: routes pass request.signal into executeSaved
  // so aborted status/docker polls tear down their SSH chains early instead of
  // holding throttle slots (which made follow-up polls fail with 429/409).
  const abort = new AbortController();
  if (res) res.once('close', () => { if (!res.writableEnded) abort.abort(); });
  return new Request(new URL(req.url, env.BASE_URL), {
    method: req.method, headers, signal: abort.signal,
    ...(body?.length && !['GET', 'HEAD'].includes(req.method) ? { body } : {}),
  });
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
/**
 * Origin 允许判定（CSRF 防护，支持反代/自定义域名/CDN 中转部署）：
 * BASE_URL 严格匹配；或 Origin 的 host[:port] 与请求实际 Host 头一致；
 * 或与 X-Forwarded-Host（链首，中转反代改写 Host 时的标准转发头）一致。
 * 浏览器 CSRF 请求的 Origin 是攻击者站点而 Host/转发头是面板地址，仍被拒。
 */
const originAllowed = (originHeader, hostHeader, forwardedHostHeader) =>
  originAllowedFor(originHeader, hostHeader, forwardedHostHeader, env.BASE_URL);
async function sendResponse(res, response) {
  const headers = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies.map((cookie) =>
    baseUrl.protocol === 'http:' ? cookie.replace(/; Secure\b/g, '') : cookie);
  if (!headers['cache-control']) headers['cache-control'] = 'no-store';
  headers['x-content-type-options'] = 'nosniff';
  res.writeHead(response.status, headers);
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (!res.write(value)) await new Promise((doneWrite) => res.once('drain', doneWrite));
      }
    } finally { reader.releaseLock(); }
  }
  res.end();
}
async function management(request, pathname, remoteAddress) {
  const user = await getAuthenticatedUser(request, env);
  if (!user) return Response.json({ error: 'Authentication required' }, { status: 401 });
  if (request.method !== 'GET' && !originAllowed(request.headers.get('Origin'), request.headers.get('Host'), request.headers.get('X-Forwarded-Host'))) {
    console.warn(`[MCP-mgmt] rejected write: origin=${request.headers.get('Origin')} host=${request.headers.get('Host')} xfh=${request.headers.get('X-Forwarded-Host')}`);
    return Response.json({ error: 'Invalid origin' }, { status: 403 });
  }
  if (pathname === '/api/mcp/tokens' && request.method === 'GET') return Response.json(store.list(user));
  if (pathname === '/api/mcp/tokens' && request.method === 'POST') {
    const body = await request.json();
    const servers = await savedServers(env, { github_id: String(user.github_id), user_id: user.id });
    if (!Array.isArray(body.server_ids) || body.server_ids.some((id) => !servers.some((server) => server.id === id))) {
      return Response.json({ error: 'Only your saved servers may be authorized' }, { status: 400 });
    }
    try { return Response.json(store.create(user, body, authGeneration), { status: 201 }); }
    catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
  const match = pathname.match(/^\/api\/mcp\/tokens\/([a-f0-9]{24})$/);
  // 二次查看令牌：独立于通用 :id 路由（同凭据库 reveal 的教训——路由顺序
  // 不可被顺带匹配），仅 POST；非 POST 一律落到底部的 404。成功与失败都写
  // 一条 token_reveal 审计（含来源 IP），让「谁看过密钥」可追溯。
  const revealMatch = pathname.match(/^\/api\/mcp\/tokens\/([a-f0-9]{24})\/reveal$/);
  if (revealMatch && request.method === 'POST') {
    const ip = clientIpFrom(request.headers.get('x-forwarded-for'), request.headers.get('x-real-ip'), remoteAddress);
    const row = store.owned(user, revealMatch[1]);
    if (!row) return Response.json({ error: 'Token not found' }, { status: 404 });
    try {
      const revealed = store.reveal(user, revealMatch[1]);
      store.audit(row, 'token_reveal', null, 'succeeded', { name: row.name }, ip);
      // 老令牌（升级前创建）没有加密副本：如实返回 null，前端提示不可查看。
      return Response.json({ token: revealed.token ?? null });
    } catch (error) {
      store.audit(row, 'token_reveal', null, 'failed', { name: row.name, error: 'decryptFailed' }, ip);
      // 解密失败绝不能把密文当明文回传（同凭据库约束）。
      return Response.json({ error: 'decryptFailed' }, { status: 500 });
    }
  }
  if (revealMatch) return Response.json({ error: 'Not found' }, { status: 404 });
  if (match && request.method === 'DELETE') {
    const purge = new URL(request.url).searchParams.get('purge') === '1';
    if (!purge) return Response.json({ revoked: store.revoke(user, match[1]) });
    try { return Response.json({ deleted: store.remove(user, match[1]) }); }
    catch (error) { return Response.json({ error: error.message }, { status: 409 }); }
  }
  // 先于 /tokens/:id 匹配：批量删除与审计清理都是固定路径。
  if (pathname === '/api/mcp/tokens/batch-delete' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const ids = body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))) {
      return Response.json({ error: 'ids must be a non-empty array of at most 100 token ids' }, { status: 400 });
    }
    return Response.json(store.removeMany(user, ids));
  }
  if (pathname === '/api/mcp/audit/purge' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid purge request' }, { status: 400 });
    try { return Response.json({ deleted: store.purgeAudits(user, body) }); }
    catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
  // 修改名称/授权主机/权限，以及临时禁用与恢复。
  if (match && request.method === 'PATCH') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid token settings' }, { status: 400 });
    if (body.server_ids !== undefined) {
      const servers = await savedServers(env, { github_id: String(user.github_id), user_id: user.id });
      if (!Array.isArray(body.server_ids) || body.server_ids.some((id) => !servers.some((server) => server.id === id))) {
        return Response.json({ error: 'Only your saved servers may be authorized' }, { status: 400 });
      }
    }
    if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
      return Response.json({ error: 'disabled must be a boolean' }, { status: 400 });
    }
    const changesStyle = body.name !== undefined || body.server_ids !== undefined || body.scopes !== undefined;
    if (!changesStyle && body.disabled === undefined) return Response.json({ error: 'Nothing to update' }, { status: 400 });
    try {
      let token = null;
      if (changesStyle) {
        token = store.update(user, match[1], { name: body.name, server_ids: body.server_ids, scopes: body.scopes });
        if (!token) return Response.json({ error: 'Token not found' }, { status: 404 });
      }
      if (body.disabled !== undefined) {
        token = store.setDisabled(user, match[1], body.disabled);
        if (!token) return Response.json({ error: 'Token not found' }, { status: 404 });
      }
      return Response.json(token);
    } catch (error) {
      // invalid = 输入非法（400）；其余为状态冲突（409，已撤销/已过期）。
      return Response.json({ error: error.message }, { status: error.code === 'invalid' ? 400 : 409 });
    }
  }
  if (pathname === '/api/mcp/audit' && request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const before = Number(params.get('before') || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) return Response.json({ error: 'Invalid cursor' }, { status: 400 });
    const token_id = params.get('token_id');
    if (token_id && !/^[a-f0-9]{24}$/.test(token_id)) return Response.json({ error: 'Invalid token id' }, { status: 400 });
    const server_id = params.has('server_id') && params.get('server_id') !== '' ? Number(params.get('server_id')) : null;
    if (server_id !== null && (!Number.isSafeInteger(server_id) || server_id < 1)) return Response.json({ error: 'Invalid server id' }, { status: 400 });
    const tool = params.get('tool');
    // 工具名只做形状校验（同清理接口的口径）：固定白名单会随新工具过时，
    // 之前连 execute_command/write_file/run_snippet/db_* 都滤不了。
    if (tool && !/^[a-z0-9_]{1,60}$/.test(tool)) {
      return Response.json({ error: 'Invalid tool' }, { status: 400 });
    }
    const status = params.get('status');
    if (status && !['succeeded', 'failed', 'started', 'unknown', 'denied'].includes(status)) {
      return Response.json({ error: 'Invalid status' }, { status: 400 });
    }
    return Response.json(store.audits(user, { before, token_id, server_id, tool, status }));
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}

async function accountManagement(request) {
  if (!env.ADMIN_PASSWORD_HASH) return Response.json({ error: 'Password login required' }, { status: 404 });
  const generation = authGeneration;
  const usernameBefore = env.ADMIN_USERNAME;
  const user = await getAuthenticatedUser(request, env);
  if (!user || String(user.github_id) !== '-1') return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (request.method === 'GET') return Response.json({ username: env.ADMIN_USERNAME });
  if (request.method !== 'PUT') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  if (!originAllowed(request.headers.get('Origin'), request.headers.get('Host'), request.headers.get('X-Forwarded-Host'))) return Response.json({ error: 'Invalid origin' }, { status: 403 });
  const body = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid account settings' }, { status: 400 });
  if (!validUsername(body.username)) return Response.json({ error: 'Invalid account name' }, { status: 400 });
  const newHash = body.passwordHash;
  if (newHash !== undefined) {
    const parsed = typeof newHash === 'string' ? parseAdminPasswordHash(newHash) : 'invalid';
    if (!parsed || parsed === 'invalid' || newHash !== newHash.trim() || parsed.iterations !== 600000 || parsed.salt.length !== 16) {
      return Response.json({ error: 'Invalid new password verifier' }, { status: 400 });
    }
  }
  // Reuse the persistent login throttle and constant-time password verifier.
  const verified = await worker.fetch(new Request(`${env.BASE_URL}/api/auth/password/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.BASE_URL,
      'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || 'unknown' },
    body: JSON.stringify({ username: usernameBefore, key: body.currentKey }),
  }), { ...env, CAPTCHA_MODE: 'off', TURNSTILE_SECRET_KEY: '' });
  // Already authenticated and origin-checked; retain throttling without a second CAPTCHA/Turnstile.
  if (!verified.ok) return verified;
  if (generation !== authGeneration || usernameBefore !== env.ADMIN_USERNAME) {
    return Response.json({ error: 'Account changed; sign in again' }, { status: 409 });
  }
  const changedPassword = newHash !== undefined && newHash !== env.ADMIN_PASSWORD_HASH;
  adminAccount.update(body.username, newHash ?? env.ADMIN_PASSWORD_HASH);
  authGeneration = tokenHash(env.ADMIN_PASSWORD_HASH);
  if (changedPassword) {
    store.revokeOwner(user);
    for (const client of wss.clients) client.close(1008, 'Administrator password changed');
  }
  return Response.json({ username: env.ADMIN_USERNAME, loginRequired: changedPassword });
}

const inflight = new Map();
let activeMcp = 0;

// Admin-only file browsing on the self-hosted deployment, so keys already on this
// machine (for example ~/.ssh/id_ed25519) can be picked for saved servers.
const HOST_FILE_MAX_BYTES = 1024 * 1024;
const HOST_LISTING_MAX_ENTRIES = 500;
function hostFilePath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 4096 || raw.includes('\0')) return null;
  return resolve(raw);
}
async function listHostFiles(request, url) {
  if (!await getAuthenticatedUser(request, env)) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const raw = url.searchParams.get('path');
  if (raw !== null && hostFilePath(raw) === null) return Response.json({ error: 'Absolute path required' }, { status: 400 });
  const dirPath = raw === null ? resolve(homedir()) : hostFilePath(raw);
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return Response.json({ error: 'Directory not found' }, { status: 404 });
    if (error.code === 'EACCES' || error.code === 'EPERM') return Response.json({ error: 'Access denied' }, { status: 403 });
    return Response.json({ error: 'Unable to list directory' }, { status: 500 });
  }
  let truncated = false;
  const listed = [];
  for (const entry of entries) {
    if (listed.length >= HOST_LISTING_MAX_ENTRIES) { truncated = true; break; }
    let type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : null;
    let size = null;
    try {
      // Follow symlinks so a symlinked .ssh directory still navigates.
      const stats = await stat(join(dirPath, entry.name));
      type = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : null;
      if (type === 'file') size = stats.size;
    } catch { /* Keep the dirent type when stat is not permitted. */ }
    if (!type) continue;
    listed.push({ name: entry.name, type, size });
  }
  listed.sort((a, b) => (a.type === b.type
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : a.type === 'dir' ? -1 : 1));
  return Response.json({ path: dirPath, entries: listed, truncated });
}
async function readHostFile(request, url) {
  if (!await getAuthenticatedUser(request, env)) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const filePath = hostFilePath(url.searchParams.get('path'));
  if (!filePath) return Response.json({ error: 'Absolute path required' }, { status: 400 });
  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }
  if (!stats.isFile()) return Response.json({ error: 'Not a regular file' }, { status: 400 });
  if (stats.size > HOST_FILE_MAX_BYTES) return Response.json({ error: 'File exceeds 1 MiB limit' }, { status: 413 });
  try {
    return Response.json({ path: filePath, size: stats.size, content: await readFile(filePath, 'utf8') });
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') return Response.json({ error: 'Access denied' }, { status: 403 });
    return Response.json({ error: 'Unable to read file' }, { status: 500 });
  }
}
// /metrics cloudssh_start_time_seconds 用：模块初始化时刻近似进程启动时刻。
const processStartAt = Date.now();
const server = createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return sendJson(res, 400, { error: 'Invalid request target' });
    const requestUrl = new URL(req.url, env.BASE_URL);
    if (requestUrl.origin !== env.BASE_URL) return sendJson(res, 400, { error: 'Invalid request target' });
    const pathname = requestUrl.pathname;
    if (pathname !== '/api/health' && pathname !== '/metrics' && rateLimited(req.socket.remoteAddress)) return sendJson(res, 429, { error: 'Rate limit exceeded' });
    if (pathname === '/metrics') {
      // 监控专用令牌（METRICS_BEARER_TOKEN）；未配置则 404，不暴露端点存在性。
      // 监控拉取频率高，故豁免 IP 限流（恒定小响应，无放大面）。
      if (!metricsAuthorized(env.METRICS_BEARER_TOKEN, req.headers.authorization)) return sendJson(res, 404, { error: 'Not found' });
      const body = renderMetrics({
        wssClients: wss.clients.size,
        sshChainPoolIdle: sshChainPoolStats().idle,
        liveStatus: liveStatusHub.stats(),
        cronTasks: automationStore.countAllTasks(),
        monitors: automationStore.countAllMonitors(),
        mcpTokens: store.countActiveTokens(),
        startedAt: processStartAt,
      });
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (pathname === '/mcp') {
      if (req.headers.origin && !originAllowed(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])) {
        console.warn(`[MCP] rejected: origin=${req.headers.origin} host=${req.headers.host} xfh=${req.headers['x-forwarded-host']}`);
        return sendJson(res, 403, { error: 'Invalid origin' });
      }
      const bearer = typeof req.headers.authorization === 'string' ? req.headers.authorization.match(/^Bearer (\S+)$/i)?.[1] : undefined;
      const identity = store.verify(bearer);
      // Mode changes and GitHub allowlist changes invalidate access, just like browser sessions.
      const ownerAllowed = env.ADMIN_PASSWORD_HASH ? identity?.github_id === '-1' :
        identity?.github_id !== '-1' && (!env.GITHUB_ALLOWED_USER_IDS ||
          env.GITHUB_ALLOWED_USER_IDS.split(',').map((id) => id.trim()).includes(identity?.github_id));
      if (!identity || !ownerAllowed || identity.auth_generation !== authGeneration) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="CloudSSH MCP"');
        return sendJson(res, 401, { error: 'Invalid, expired, revoked or disabled access token' });
      }
      if (activeMcp >= 64 || (inflight.get(identity.id) || 0) >= 4) return sendJson(res, 429, { error: 'Too many concurrent MCP requests' });
      if (!['POST', 'GET', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' });
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString()) : undefined;
      activeMcp++; inflight.set(identity.id, (inflight.get(identity.id) || 0) + 1);
      let released = false;
      const release = () => {
        if (released) return; released = true; activeMcp--;
        const count = inflight.get(identity.id) - 1;
        if (count) inflight.set(identity.id, count); else inflight.delete(identity.id);
      };
      res.once('finish', release); res.once('close', release);
      await handleMcp(req, res, {
        env, store, identity, SSHSession, isBlockedCommand, databaseStore,
        clientIp: clientIpFrom(req.headers['x-forwarded-for'], req.headers['x-real-ip'], req.socket.remoteAddress),
      }, body);
      return;
    }
    // 备份导出 / 恢复（管理员会话 + 同源；恢复包体积可达数百 MB，
    // 必须在通用 1MiB readBody 之前自行读流）
    if (pathname === '/api/backup/export' && req.method === 'POST') {
      const request = requestFromNode(req, undefined, res);
      if (!await getAuthenticatedUser(request, env)) return sendJson(res, 401, { error: 'Authentication required' });
      if (!originAllowed(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])) return sendJson(res, 403, { error: 'Invalid origin' });
      try {
        const { buffer, filename } = createBackup(dataDir);
        return sendResponse(res, new Response(buffer, {
          headers: {
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
          },
        }));
      } catch (error) {
        console.error('[backup] export failed:', error);
        return sendJson(res, 500, { error: 'Backup export failed' });
      }
    }
    if (pathname === '/api/backup/restore' && req.method === 'POST') {
      const request = requestFromNode(req, undefined, res);
      if (!await getAuthenticatedUser(request, env)) return sendJson(res, 401, { error: 'Authentication required' });
      if (!originAllowed(req.headers.origin, req.headers.host, req.headers['x-forwarded-host'])) return sendJson(res, 403, { error: 'Invalid origin' });
      const chunks = []; let uploadSize = 0; let tooLarge = false;
      for await (const chunk of req) {
        uploadSize += chunk.length;
        if (uploadSize > RESTORE_MAX_UPLOAD) { tooLarge = true; break; }
        chunks.push(chunk);
      }
      if (tooLarge) return sendJson(res, 413, { error: 'Backup exceeds size limit' });
      try {
        const result = stageRestore(dataDir, Buffer.concat(chunks));
        return sendJson(res, 200, { ok: true, requires_restart: true, files: result.manifest.files.map((file) => file.name) });
      } catch (error) {
        const status = error.status || 500;
        if (status >= 500) console.error('[backup] restore staging failed:', error);
        return sendJson(res, status, { error: error instanceof Error ? error.message : 'Restore failed' });
      }
    }
    const body = !['GET', 'HEAD'].includes(req.method) ? await readBody(req) : undefined;
    const request = requestFromNode(req, body, res);
    // CLI（终端客户端）：Bearer 令牌鉴权，与 /mcp 共用同一把令牌与门禁。
    // 必须放在 worker.fetch 之前——自托管下 worker 硬编码只认 session cookie。
    if (pathname.startsWith('/api/cli/')) {
      const { identity, response: rejected } = resolveBearerIdentity({
        headers: req.headers, store, env, authGeneration,
      });
      if (rejected) return sendResponse(res, rejected);
      const handled = await cliRoutes(identity)(request, pathname);
      if (handled) return sendResponse(res, handled);
    }
    // 数据库连接管理（面板用）：/api/db/*
    if (pathname.startsWith('/api/db/')) return sendResponse(res, await databaseRoutes(request, pathname));
    if (pathname === '/api/admin/account') return sendResponse(res, await accountManagement(request));
    if (pathname === '/account/settings') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!env.ADMIN_PASSWORD_HASH || !await getAuthenticatedUser(request, env)) return sendResponse(res, new Response(null, { status: 302, headers: { Location: '/' } }));
      return sendResponse(res, new Response(readFileSync(new URL('./account.html', import.meta.url)), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" },
      }));
    }
    if (pathname === '/account/settings.js' && req.method === 'GET') return sendResponse(res, new Response(readFileSync(new URL('../dist/account.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }));
    if (pathname === '/mcp/settings') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!await getAuthenticatedUser(request, env)) return sendResponse(res, new Response(null, { status: 302, headers: { Location: '/' } }));
      return sendResponse(res, new Response(readFileSync(new URL('./settings.html', import.meta.url)), {
        headers: { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" },
      }));
    }
    if (['/mcp/settings.js', '/mcp/settings.css'].includes(pathname) && req.method === 'GET') {
      const extension = pathname.endsWith('.js') ? 'js' : 'css';
      return sendResponse(res, new Response(readFileSync(new URL(`./settings.${extension}`, import.meta.url)), {
        headers: { 'Content-Type': extension === 'js' ? 'text/javascript; charset=utf-8' : 'text/css' },
      }));
    }
    if (pathname === '/automation') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!await getAuthenticatedUser(request, env)) return sendResponse(res, new Response(null, { status: 302, headers: { Location: '/' } }));
      return sendResponse(res, new Response(readFileSync(new URL('./automation.html', import.meta.url)), {
        headers: { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" },
      }));
    }
    if (pathname === '/database') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!await getAuthenticatedUser(request, env)) return sendResponse(res, new Response(null, { status: 302, headers: { Location: '/' } }));
      return sendResponse(res, new Response(readFileSync(new URL('./database.html', import.meta.url)), {
        headers: { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" },
      }));
    }
    if (['/database.js', '/database.css'].includes(pathname) && req.method === 'GET') {
      const extension = pathname.endsWith('.js') ? 'js' : 'css';
      return sendResponse(res, new Response(readFileSync(new URL(`./database.${extension}`, import.meta.url)), {
        headers: { 'Content-Type': extension === 'js' ? 'text/javascript; charset=utf-8' : 'text/css' },
      }));
    }
    if (['/automation.js', '/automation.css'].includes(pathname) && req.method === 'GET') {
      const extension = pathname.endsWith('.js') ? 'js' : 'css';
      return sendResponse(res, new Response(readFileSync(new URL(`./automation.${extension}`, import.meta.url)), {
        headers: { 'Content-Type': extension === 'js' ? 'text/javascript; charset=utf-8' : 'text/css' },
      }));
    }
    // Shared design system + panel-theme sync for the standalone utility pages.
    if (['/page.css', '/page.js'].includes(pathname) && req.method === 'GET') {
      const extension = pathname.endsWith('.js') ? 'js' : 'css';
      return sendResponse(res, new Response(readFileSync(new URL(`./page.${extension}`, import.meta.url)), {
        headers: { 'Content-Type': extension === 'js' ? 'text/javascript; charset=utf-8' : 'text/css', 'Cache-Control': 'no-cache' },
      }));
    }
    if (req.method === 'GET' && pathname.startsWith('/assets/') && pathname.length > '/assets/'.length) {
      return sendResponse(res, serveAsset(pathname.slice('/assets/'.length)));
    }
    if (req.method === 'GET' && SPLIT_SHELL && pathname === '/') {
      return sendResponse(res, new Response(SPLIT_SHELL, {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': SPLIT_CSP,
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      }));
    }
    if (req.method === 'GET' && PUBLIC_FILES[pathname]) {
      const { file, type, cache } = PUBLIC_FILES[pathname];
      return sendResponse(res, new Response(readFileSync(new URL(`../dist/public/${file}`, import.meta.url)), {
        headers: { 'Content-Type': type, 'Cache-Control': cache },
      }));
    }
    // Dashboard SSE: streamed directly on the socket — Response objects cannot
    // model an open-ended server push, and the worker deployment has no
    // dashboard engine at all (no scheduler), so this route is standalone-only.
    if (pathname === '/api/dashboard/stream' && req.method === 'GET') {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return sendJson(res, 401, { error: 'Authentication required' });
      const owner = String(user.github_id);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ } };
      send({ type: 'snapshot', snapshots: dashboardEngine.snapshots(owner), interval_seconds: dashboardEngine.intervalSeconds });
      const unsubscribe = dashboardEngine.subscribe(owner, (snapshot) => send({ type: 'update', snapshot }));
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* client gone */ } }, 15000);
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
      return;
    }
    if (pathname.startsWith('/api/batch/')) return sendResponse(res, await batchRoutes(request, pathname));
    if (pathname.startsWith('/api/automation/') || pathname.startsWith('/api/ssh/keys/') || pathname.startsWith('/api/docker/') || pathname.startsWith('/api/dashboard/')) {
      const response = await automationRoutes(request, pathname, requestUrl);
      if (response) return sendResponse(res, response);
    }
    if (pathname.startsWith('/api/mcp/')) return sendResponse(res, await management(request, pathname, req.socket.remoteAddress));
    if (pathname === '/api/host-files' && req.method === 'GET') return sendResponse(res, await listHostFiles(request, requestUrl));
    if (pathname === '/api/host-file' && req.method === 'GET') return sendResponse(res, await readHostFile(request, requestUrl));
    const response = await worker.fetch(request, env);
    if (pathname === '/api/config' && response.ok) {
      return sendResponse(res, Response.json({ ...await response.json(), mcpEnabled: true, automationEnabled: true, databaseEnabled: true, adminAccountEnabled: !!env.ADMIN_PASSWORD_HASH, adminUsernameRequired: !!env.ADMIN_PASSWORD_HASH }));
    }
    return sendResponse(res, response);
  } catch (error) {
    console.error(`[http] ${req.method} ${req.url} failed:`, error);
    if (res.headersSent) { res.destroy(); return; }
    sendJson(res, error instanceof SyntaxError ? 400 : (error.status || 500), {
      error: error instanceof SyntaxError ? 'Invalid JSON' : error.status === 413 ? error.message : 'Request failed',
    });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const cliRoutes = (identity) => createCliRoutes({
  env, identity, SSHSession, isBlockedCommand, databaseStore,
});

// CLI 专用的 WS 升级：/api/cli/ssh?server_id=N
//
// 与面板 /api/ssh 的关键差别：不走 worker 的 cookie 门（自托管下它硬编码
// REQUIRE_GITHUB_AUTH=true），而是用 Bearer 令牌鉴权后，把服务端已解密的
// 连接配置以 x-ssh-config 头喂给同一个 SSHSessionDO——跳板链、主机指纹、
// 空闲超时、审计全部复用，凭据永不出服务端进程。
async function upgradeCliSsh(req, socket, head, url) {
  const { identity, response } = resolveBearerIdentity({
    headers: req.headers, store, env, authGeneration,
  });
  if (response) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const serverId = Number(url.searchParams.get('server_id'));
  if (!Number.isSafeInteger(serverId) || serverId <= 0 || !identity.server_ids.includes(serverId)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  // 连接配置（含解密后的凭据）只在服务端内存里流转。
  const config = await connectionConfig(env, identity, serverId);
  const sessionName = `session:${Date.now()}:${randomUUID()}`;
  const doId = env.SSH_SESSION.idFromName(sessionName);
  const doUrl = new URL(req.url, env.BASE_URL);
  doUrl.pathname = '/api/ssh';
  doUrl.search = '';
  doUrl.searchParams.set('session', sessionName);
  const cols = Number(url.searchParams.get('cols'));
  const rows = Number(url.searchParams.get('rows'));
  if (Number.isInteger(cols) && cols > 0) doUrl.searchParams.set('cols', String(cols));
  if (Number.isInteger(rows) && rows > 0) doUrl.searchParams.set('rows', String(rows));

  const headers = new Headers(req.headers);
  headers.delete('authorization');
  headers.set('x-cloudflare-colo', 'SELF_HOSTED');
  headers.set('x-ssh-config', encodeURIComponent(JSON.stringify(config)));
  const doResponse = await env.SSH_SESSION.get(doId).fetch(
    new Request(doUrl.toString(), { headers })
  );
  if (doResponse.status !== 101 || !doResponse.webSocket) {
    socket.end(`HTTP/1.1 ${doResponse.status} Rejected\r\nConnection: close\r\n\r\n`);
    return;
  }
  if (socket.destroyed) { doResponse.webSocket.close(1001); return; }
  wss.handleUpgrade(req, socket, head, (network) => doResponse.webSocket.attach(network));
}

server.on('upgrade', async (req, socket, head) => {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid target');
    const url = new URL(req.url, env.BASE_URL);
    if (url.origin !== env.BASE_URL || rateLimited(req.socket.remoteAddress)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    // CLI 终端：Bearer 鉴权，绕开浏览器 cookie 门。
    if (url.pathname === '/api/cli/ssh') {
      await upgradeCliSsh(req, socket, head, url);
      return;
    }
    if (!['/api/ssh', '/api/ssh/sftp'].includes(url.pathname)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const response = await worker.fetch(requestFromNode(req), env);
    if (response.status !== 101 || !response.webSocket) {
      socket.end(`HTTP/1.1 ${response.status} Rejected\r\nConnection: close\r\n\r\n`); return;
    }
    if (socket.destroyed) { response.webSocket.close(1001); return; }
    wss.handleUpgrade(req, socket, head, (network) => response.webSocket.attach(network));
  } catch {
    socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
  }
});
// Data includes encryption material and remote credentials; no other users should read it.
for (const file of readdirSync(dataDir)) {
  if (file.endsWith('.sqlite') || file.startsWith('admin-')) chmodSync(join(dataDir, file), 0o600);
}
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
server.listen(port, process.env.HOST || '0.0.0.0', () => {
  automationEngine.start();
  console.log(`CloudSSH listening on port ${port}; panel ${env.BASE_URL}; MCP ${env.BASE_URL}/mcp`);
});
let closing = false;
function shutdown() {
  if (closing) return; closing = true;
  automationEngine.stop();
  liveStatusHub.stopAll();
  server.close(); wss.close();
  for (const client of wss.clients) client.close(1001, 'Service shutting down');
  // Give bounded operations time to finish; never replay calls on restart.
  const timer = setInterval(() => {
    if (activeMcp) return;
    clearInterval(timer);
    drainSshChainPool();
    env.SSH_SESSION.close(); env.USER_DB.close(); env.SSH_SHARE.close(); store.close(); automationStore.close();
    process.exit(0);
  }, 100);
  setTimeout(() => process.exit(1), 200000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
