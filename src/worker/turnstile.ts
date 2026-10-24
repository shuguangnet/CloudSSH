/**
 * Cloudflare Turnstile 人机验证（可选，公网部署的登录防爆破增强）。
 *
 * 配置：TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY 同时非空才启用；启用后
 * 密码登录必验 Turnstile token，并取代图片字符验证码（更强的人机判定，
 * 免去用户读图输入）。未启用或只配了一半 → 维持原图片验证码防线。
 *
 * siteverify 校验：secret + response（+ remoteip 可选）。网络/上游异常按
 * 失败处理（fail closed，防验证通道不可用时被绕过）；超时 10 秒。
 * token 单次使用，验证失败或过期由前端 reset 后重新作答。
 */

export function turnstileActive(env: { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string }): boolean {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

export interface TurnstileResult {
  ok: boolean;
  reason: 'missing' | 'invalid' | 'timeout-or-error';
}

export async function verifyTurnstileToken(
  env: { TURNSTILE_SECRET_KEY?: string },
  token: unknown,
  remoteIp?: string | null
): Promise<TurnstileResult> {
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096) {
    return { ok: false, reason: 'missing' };
  }
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY ?? '', response: token });
  if (remoteIp && remoteIp !== 'unknown') form.set('remoteip', remoteIp);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, reason: 'timeout-or-error' };
    const outcome = (await response.json().catch(() => null)) as { success?: unknown } | null;
    return outcome?.success === true ? { ok: true, reason: 'invalid' } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'timeout-or-error' };
  }
}
