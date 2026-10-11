import { createServer } from 'node:http';
import { readFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer, WebSocket as NetworkWebSocket } from 'ws';
import { installWorkerGlobals, LocalNamespace } from './runtime.mjs';
import { AccessStore, tokenHash } from './access-store.mjs';
import { handleMcp } from './mcp.mjs';
import { AdminAccount, validUsername } from './admin-account.mjs';
import { savedServers, executeSaved, drainSshChainPool } from './operations.mjs';
import { AutomationStore } from './automation-store.mjs';
import { generateVapidKeys } from './webpush.mjs';
import { setVapidProvider } from './notify.mjs';
import { AutomationEngine } from './scheduler.mjs';
import { DashboardEngine } from './dashboard.mjs';
import { createAutomationRoutes } from './automation-api.mjs';

process.umask(0o077);
installWorkerGlobals();
const { worker, SSHSessionDO, UserDBDO, SSHShareDO, SSHSession,
  getAuthenticatedUser, parseAdminPasswordHash, isBlockedCommand } = await import('../dist/worker.mjs');
import { originAllowed as originAllowedFor } from './origin.mjs';
import { createBatchRoutes } from './batch.mjs';

const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
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
const automationRoutes = createAutomationRoutes({
  env, SSHSession, store: automationStore, engine: automationEngine, dashboard: dashboardEngine, executeSaved, getAuthenticatedUser,
});
const batchRoutes = createBatchRoutes({ env, getAuthenticatedUser, SSHSession });
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
async function management(request, pathname) {
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
  if (match && request.method === 'DELETE') {
    const purge = new URL(request.url).searchParams.get('purge') === '1';
    if (!purge) return Response.json({ revoked: store.revoke(user, match[1]) });
    try { return Response.json({ deleted: store.remove(user, match[1]) }); }
    catch (error) { return Response.json({ error: error.message }, { status: 409 }); }
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
    if (tool && !['list_servers', 'list_snippets', 'get_server_info', 'list_files', 'read_file', 'download_file'].includes(tool)) {
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
  }), { ...env, CAPTCHA_MODE: 'off' });
  // Already authenticated and origin-checked; retain throttling without a second CAPTCHA.
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
const server = createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return sendJson(res, 400, { error: 'Invalid request target' });
    const requestUrl = new URL(req.url, env.BASE_URL);
    if (requestUrl.origin !== env.BASE_URL) return sendJson(res, 400, { error: 'Invalid request target' });
    const pathname = requestUrl.pathname;
    if (pathname !== '/api/health' && rateLimited(req.socket.remoteAddress)) return sendJson(res, 429, { error: 'Rate limit exceeded' });
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
        return sendJson(res, 401, { error: 'Invalid, expired or revoked access token' });
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
      await handleMcp(req, res, { env, store, identity, SSHSession, isBlockedCommand }, body);
      return;
    }
    const body = !['GET', 'HEAD'].includes(req.method) ? await readBody(req) : undefined;
    const request = requestFromNode(req, body, res);
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
    if (pathname.startsWith('/api/mcp/')) return sendResponse(res, await management(request, pathname));
    if (pathname === '/api/host-files' && req.method === 'GET') return sendResponse(res, await listHostFiles(request, requestUrl));
    if (pathname === '/api/host-file' && req.method === 'GET') return sendResponse(res, await readHostFile(request, requestUrl));
    const response = await worker.fetch(request, env);
    if (pathname === '/api/config' && response.ok) {
      return sendResponse(res, Response.json({ ...await response.json(), mcpEnabled: true, automationEnabled: true, adminAccountEnabled: !!env.ADMIN_PASSWORD_HASH, adminUsernameRequired: !!env.ADMIN_PASSWORD_HASH }));
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
server.on('upgrade', async (req, socket, head) => {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('Invalid target');
    const url = new URL(req.url, env.BASE_URL);
    if (url.origin !== env.BASE_URL || !['/api/ssh', '/api/ssh/sftp'].includes(url.pathname) || rateLimited(req.socket.remoteAddress)) {
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
