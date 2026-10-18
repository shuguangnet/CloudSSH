/**
 * CLI 的 Bearer 令牌鉴权（与 /mcp 完全同一把令牌、同一套代际校验）。
 *
 * 为什么 CLI 不走密码登录：
 * - 密码登录要求图片验证码（生产默认 CAPTCHA_MODE=on），终端解不了 SVG；
 * - session cookie 内嵌管理员密码代际指纹，改一次密码所有 CLI 全部失效；
 * - cookie 是浏览器语义（HttpOnly/Secure/SameSite），命令行没有它的收益。
 *
 * 所以 CLI 与 MCP 共用 `cssh_` 令牌：面板里创建、可随时撤销、带
 * server_ids / scopes / db_connection_ids 三重授权。本文档负责把
 * 「HTTP 请求 → 令牌身份」这一层抽出来，供 /api/cli/* 与 WS 升级复用。
 */

/** 从 Authorization 头取出 `cssh_…` 令牌；形态不符返回 null。 */
export function bearerToken(headers) {
  const raw = typeof headers?.authorization === 'string' ? headers.authorization : '';
  return raw.match(/^Bearer (\S+)$/i)?.[1] ?? null;
}

/**
 * 解析 Bearer 身份。返回 `{ identity }` 或 `{ response }`（已构造好的 401）。
 *
 * 与 server.mjs 的 /mcp 分支保持同一套门禁，任何一处放宽都会让 CLI 成为
 * 绕过撤销/过期/代际失效的后门，所以这里刻意重复而不是抽出共用函数——
 * 重复的 4 行比一个「顺手也能过」的共享宽松分支安全。
 */
export function resolveBearerIdentity({ headers, store, env, authGeneration }) {
  const token = bearerToken(headers);
  const identity = store.verify(token);
  // 切换认证模式或改 GitHub 白名单后，旧令牌立即失效（与浏览器会话一致）。
  const ownerAllowed = env.ADMIN_PASSWORD_HASH
    ? identity?.github_id === '-1'
    : identity?.github_id !== '-1'
      && (!env.GITHUB_ALLOWED_USER_IDS
        || env.GITHUB_ALLOWED_USER_IDS.split(',').map((id) => id.trim()).includes(identity?.github_id));
  if (!identity || !ownerAllowed || identity.auth_generation !== authGeneration) {
    return {
      response: Response.json(
        { error: 'Invalid, expired, revoked or disabled access token' },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="CloudSSH CLI"' } }
      ),
    };
  }
  return { identity };
}

/** 令牌是否被授权操作这台服务器；未授权与不存在返回同一错误（不泄漏存在性）。 */
export function requireServerScope(identity, serverId, scope) {
  if (serverId !== undefined && !identity.server_ids.includes(serverId)) {
    throw Object.assign(new Error('Server is not authorized for this token'), { status: 403 });
  }
  if (scope && !identity.scopes.includes(scope)) {
    throw Object.assign(new Error(`Operation requires the "${scope}" scope`), { status: 403 });
  }
}
