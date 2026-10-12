// 端到端覆盖 MCP 令牌管理接口：修改、临时禁用/启用、批量删除、审计清理。
// 面板真实启动（本机 TCP），走登录会话 Cookie + Origin 校验，与浏览器同路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pbkdf2Sync } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { solveCaptcha } from './captcha-helper.mjs';

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function stop(child) {
  if (!child || typeof child.kill !== 'function' || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); timer.unref();
  await exited; clearTimeout(timer);
}
async function startPanel(directory, port) {
  const child = spawn(process.execPath, ['standalone/server.mjs'], {
    cwd: resolve('.'), env: { ...process.env, DATA_DIR: directory, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, CAPTCHA_MODE: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', (data) => { logs += data; }); child.stderr.on('data', (data) => { logs += data; });
  for (let i = 0; i < 200; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return { child, logs }; } catch { /* Starting. */ }
    if (child.exitCode !== null) throw new Error(logs);
    await delay(50);
  }
  await stop(child); throw new Error(`Server startup timed out: ${logs}`);
}

test('MCP token management: edit, disable/enable, batch delete and audit purge', { timeout: 90000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloudssh-mcp-tokens-'));
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  execFileSync(process.execPath, ['scripts/setup-standalone.mjs', '--stdin'], {
    env: { ...process.env, DATA_DIR: directory }, input: 'fixture-password-123', stdio: ['pipe', 'pipe', 'pipe'],
  });

  let child;
  try {
    ({ child } = await startPanel(directory, port));
    const config = await (await fetch(`${base}/api/config`)).json();
    const key = pbkdf2Sync('fixture-password-123', Buffer.from(config.passwordAuth.salt, 'base64url'), config.passwordAuth.iterations, 32, 'sha256').toString('base64url');
    const login = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, username: 'admin', captcha: await solveCaptcha(base) }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find((value) => value.startsWith('session=')).split(';')[0];
    const api = async (path, method = 'GET', body, origin = base) => {
      const response = await fetch(`${base}${path}`, {
        method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    // MCP 端点：Bearer 认证，返回状态码即可判定令牌是否可用（无状态传输，可直接 tools/call）。
    const mcp = (token, name = 'list_servers', args = {}) => fetch(`${base}/mcp`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });

    const added = await api('/api/servers', 'POST', { name: 'token-box', host: '127.0.0.1', port: 2222, username: 'fixture', auth_method: 'password', credential: 'fixture-only' });
    assert.equal(added.status, 201);
    const serverId = (await api('/api/servers')).body[0].id;

    // ---------- 守卫：未登录 401、跨站 Origin 403、令牌 id 形状 ----------
    assert.equal((await fetch(`${base}/api/mcp/tokens/batch-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":["x"]}' })).status, 401);
    assert.equal((await api('/api/mcp/tokens/batch-delete', 'POST', { ids: ['a'.repeat(24)] }, 'https://evil.example')).status, 403);
    assert.equal((await api('/api/mcp/audit/purge', 'POST', { all: true }, 'https://evil.example')).status, 403);
    const created = await api('/api/mcp/tokens', 'POST', { name: 'editable', server_ids: [serverId], scopes: ['read'], expires_in_days: 5 });
    assert.equal(created.status, 201);
    const tokenId = created.body.id;
    assert.equal((await mcp(created.body.token)).status, 200, 'new token authenticates');

    // ---------- 修改：名称 / 授权主机 / 权限 ----------
    const renamed = await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { name: 'renamed', server_ids: [serverId], scopes: ['read', 'exec'] });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'renamed');
    assert.deepEqual(renamed.body.scopes, ['read', 'exec']);
    assert.equal(renamed.body.disabled, false);
    assert.equal((await mcp(created.body.token)).status, 200, 'editing keeps the token valid');

    // 非法输入：权限、空主机列表、非本账号服务器、未知令牌、空 PATCH
    assert.equal((await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { scopes: ['root'] })).status, 400);
    assert.equal((await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { server_ids: [] })).status, 400);
    assert.equal((await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { server_ids: [999999] })).status, 400);
    assert.equal((await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', {})).status, 400);
    assert.equal((await api(`/api/mcp/tokens/${'f'.repeat(24)}`, 'PATCH', { name: 'nope' })).status, 404);
    assert.equal((await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { disabled: 'yes' })).status, 400);

    // ---------- 临时禁用 / 恢复 ----------
    const disabled = await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { disabled: true });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.disabled, true);
    assert.equal((await mcp(created.body.token)).status, 401, 'disabled token is refused');
    const listed = (await api('/api/mcp/tokens')).body.find((token) => token.id === tokenId);
    assert.equal(listed.disabled, true, 'disabled flag is exposed to the UI');
    // 禁用期间仍可修改（改回后再启用）
    assert.equal((await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { name: 'renamed-while-disabled' })).status, 200);
    const enabled = await api(`/api/mcp/tokens/${tokenId}`, 'PATCH', { disabled: false });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.disabled, false);
    assert.equal(enabled.body.name, 'renamed-while-disabled');
    assert.equal((await mcp(created.body.token)).status, 200, 're-enabled token works again');

    // ---------- 批量删除：仍有效/不存在 → 跳过，已撤销 → 删除 ----------
    const second = await api('/api/mcp/tokens', 'POST', { name: 'second', server_ids: [serverId], scopes: ['read'], expires_in_days: 5 });
    const third = await api('/api/mcp/tokens', 'POST', { name: 'third', server_ids: [serverId], scopes: ['read'], expires_in_days: 5 });
    assert.equal((await api(`/api/mcp/tokens/${second.body.id}`, 'DELETE')).body.revoked, true);
    assert.equal((await api(`/api/mcp/tokens/${third.body.id}`, 'DELETE')).body.revoked, true);
    const missing = '0'.repeat(24);
    const purged = await api('/api/mcp/tokens/batch-delete', 'POST', { ids: [second.body.id, third.body.id, tokenId, missing] });
    assert.equal(purged.status, 200);
    assert.deepEqual(purged.body.deleted.sort(), [second.body.id, third.body.id].sort());
    assert.deepEqual(purged.body.skipped.sort(), [tokenId, missing].sort(), 'active and unknown ids are skipped');
    // 撤销/过期校验仍然生效：活跃令牌不可删除
    const afterDelete = (await api('/api/mcp/tokens')).body;
    assert.equal(afterDelete.some((token) => token.id === second.body.id), false);
    assert.equal(afterDelete.some((token) => token.id === tokenId), true);
    for (const bad of [{}, { ids: [] }, { ids: ['nope'] }, { ids: Array.from({ length: 101 }, () => 'a'.repeat(24)) }]) {
      assert.equal((await api('/api/mcp/tokens/batch-delete', 'POST', bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    // 已撤销的令牌不可再修改/禁用
    const revokedEdit = await api(`/api/mcp/tokens/${'1'.repeat(24)}`, 'PATCH', { name: 'x' });
    assert.equal(revokedEdit.status, 404);

    // ---------- 审计清理 ----------
    await mcp(created.body.token);
    await mcp(created.body.token);
    const audit = (await api('/api/mcp/audit')).body;
    assert.ok(audit.length >= 2, 'MCP calls are audited');
    // 无筛选条件必须显式 all=true
    assert.equal((await api('/api/mcp/audit/purge', 'POST', {})).status, 400);
    assert.equal((await api('/api/mcp/audit/purge', 'POST', { status: 'nope' })).status, 400);
    assert.equal((await api('/api/mcp/audit/purge', 'POST', { ids: [0] })).status, 400);
    // 按 id 精确删除
    const one = await api('/api/mcp/audit/purge', 'POST', { ids: [audit[0].id] });
    assert.equal(one.status, 200); assert.equal(one.body.deleted, 1);
    assert.equal((await api('/api/mcp/audit')).body.some((row) => row.id === audit[0].id), false);
    // 按筛选条件删除：该令牌名下的全部审计记录
    const remaining = (await api('/api/mcp/audit')).body;
    assert.ok(remaining.length >= 1);
    const filtered = await api('/api/mcp/audit/purge', 'POST', { token_id: tokenId });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.deleted, remaining.length);
    assert.equal((await api('/api/mcp/audit')).body.length, 0);
    // all=true 清空剩余（一次调用会记 started + succeeded 两条）
    await mcp(created.body.token);
    const beforeAll = (await api('/api/mcp/audit')).body.length;
    assert.equal(beforeAll, 2);
    const all = await api('/api/mcp/audit/purge', 'POST', { all: true });
    assert.equal(all.status, 200); assert.equal(all.body.deleted, beforeAll);
    assert.equal((await api('/api/mcp/audit')).body.length, 0);
  } finally {
    await stop(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
