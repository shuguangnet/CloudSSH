import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Env } from '../../src/types';
import { turnstileActive, verifyTurnstileToken } from '../../src/worker/turnstile';

function makeEnv(overrides: Partial<Env> & { userDbStub?: { fetch: unknown } } = {}): Env {
  const { userDbStub, ...rest } = overrides;
  const stub =
    (userDbStub as unknown as { fetch: (req: Request) => Promise<Response> } | undefined) ??
    { fetch: async () => new Response('{}', { status: 500 }) };
  return {
    SSH_SESSION: { idFromName: () => 'do-ssh', get: () => stub } as unknown as Env['SSH_SESSION'],
    USER_DB: { idFromName: () => 'do-userdb', get: () => stub } as unknown as Env['USER_DB'],
    SSH_SHARE: { idFromName: () => 'do-share', get: () => stub } as unknown as Env['SSH_SHARE'],
    CAPTCHA_MODE: 'off',
    ...rest,
  } as Env;
}

describe('turnstileActive', () => {
  it('两个 key 都配置才启用', () => {
    expect(turnstileActive(makeEnv({ TURNSTILE_SITE_KEY: 's', TURNSTILE_SECRET_KEY: 'x' }))).toBe(true);
    expect(turnstileActive(makeEnv({ TURNSTILE_SITE_KEY: 's' }))).toBe(false);
    expect(turnstileActive(makeEnv({ TURNSTILE_SECRET_KEY: 'x' }))).toBe(false);
    expect(turnstileActive(makeEnv())).toBe(false);
    // 空字符串视同未配置（standalone 内部复用登录时的显式关闭口径）
    expect(turnstileActive(makeEnv({ TURNSTILE_SITE_KEY: 's', TURNSTILE_SECRET_KEY: '' }))).toBe(false);
  });
});

describe('verifyTurnstileToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('缺少/畸形 token 直接拒绝（不发起网络请求）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = makeEnv({ TURNSTILE_SITE_KEY: 's', TURNSTILE_SECRET_KEY: 'sec' });
    expect((await verifyTurnstileToken(env, undefined)).reason).toBe('missing');
    expect((await verifyTurnstileToken(env, 'short')).reason).toBe('missing');
    expect((await verifyTurnstileToken(env, 'x'.repeat(5000))).reason).toBe('missing');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('siteverify success:true → ok；success:false → invalid（并携带 secret 与 remoteip）', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) =>
      new Response(JSON.stringify({ success: init?.body === 'secret=sec&response=good-token&remoteip=1.2.3.4' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const env = makeEnv({ TURNSTILE_SITE_KEY: 's', TURNSTILE_SECRET_KEY: 'sec' });
    const ok = await verifyTurnstileToken(env, 'good-token', '1.2.3.4');
    expect(ok.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' })
    );
    const bad = await verifyTurnstileToken(env, 'bad-token', '1.2.3.4');
    expect(bad).toEqual({ ok: false, reason: 'invalid' });
  });

  it('上游非 200 / 网络异常 → fail closed（timeout-or-error）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const env = makeEnv({ TURNSTILE_SECRET_KEY: 'sec' });
    expect(await verifyTurnstileToken(env, 'good-token')).toEqual({ ok: false, reason: 'timeout-or-error' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await verifyTurnstileToken(env, 'good-token')).toEqual({ ok: false, reason: 'timeout-or-error' });
  });
});

describe('Turnstile — 登录端点集成', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadWorker() {
    const mod = await import('../../src/worker/index');
    return mod.default;
  }

  async function adminHash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const stretched = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, baseKey, 256));
    const verifier = new Uint8Array(await crypto.subtle.digest('SHA-256', stretched));
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    return `pbkdf2$sha256$1000$${b64(salt)}$${b64(verifier)}`;
  }

  function stubDb() {
    const sessions = new Map<string, unknown>();
    return {
      sessions,
      fetch: vi.fn(async (req: Request) => {
        const path = new URL(req.url).pathname;
        if (path === '/internal/login-throttle') {
          const { action } = (await req.json()) as { action: string };
          return Response.json({ locked: false, retryAfterSec: 0 });
        }
        if (path === '/internal/local-admin-user') {
          return Response.json({ id: 1, github_id: -1, username: 'admin', avatar_url: null });
        }
        if (path === '/internal/session/create') {
          const token = `local:${Math.random().toString(36).slice(2)}`;
          sessions.set(token, {});
          return Response.json({ token, expires_at: new Date().toISOString() });
        }
        return Response.json({ error: 'not mocked' }, { status: 500 });
      }),
    };
  }

  function loginRequest(body: Record<string, unknown>): Request {
    return new Request('https://cloudssh.test/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://cloudssh.test' },
      body: JSON.stringify(body),
    });
  }

  it('启用 Turnstile：缺 token → 403（在图片验证码与节流之前）', async () => {
    const worker = await loadWorker();
    const env = makeEnv({
      ADMIN_PASSWORD_HASH: await adminHash('correct-password'),
      TURNSTILE_SITE_KEY: 'site',
      TURNSTILE_SECRET_KEY: 'sec',
      userDbStub: stubDb(),
    });
    const res = await worker.fetch(loginRequest({ key: 'x'.repeat(43) }), env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('Turnstile verification failed');
  });

  it('启用 Turnstile：token 有效 → 登录成功；图片验证码字段被忽略（取代语义）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    const worker = await loadWorker();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('correct-password'), 'PBKDF2', false, ['deriveBits']);
    const stretched = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, baseKey, 256));
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    const verifier = new Uint8Array(await crypto.subtle.digest('SHA-256', stretched));
    const hash = `pbkdf2$sha256$1000$${b64(salt)}$${b64(verifier)}`;
    const env = makeEnv({
      ADMIN_PASSWORD_HASH: hash,
      CAPTCHA_MODE: 'on', // 即便图片验证码也开着，Turnstile 优先且取代之
      TURNSTILE_SITE_KEY: 'site',
      TURNSTILE_SECRET_KEY: 'sec',
      userDbStub: stubDb(),
    });
    const res = await worker.fetch(
      loginRequest({ key: b64(stretched), turnstileToken: 'valid-token-from-widget', captcha: { challenge: 'c', answer: 'ignored' } }),
      env
    );
    expect(res.status).toBe(200);
  });

  it('启用 Turnstile：siteverify 判失败 → 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 })));
    const worker = await loadWorker();
    const env = makeEnv({
      ADMIN_PASSWORD_HASH: await adminHash('correct-password'),
      TURNSTILE_SITE_KEY: 'site',
      TURNSTILE_SECRET_KEY: 'sec',
      userDbStub: stubDb(),
    });
    const res = await worker.fetch(loginRequest({ key: 'x'.repeat(43), turnstileToken: 'expired-token' }), env);
    expect(res.status).toBe(403);
  });

  it('/api/config：完整配置才下发 turnstileSiteKey', async () => {
    const worker = await loadWorker();
    const full = makeEnv({ TURNSTILE_SITE_KEY: 'site-key-x', TURNSTILE_SECRET_KEY: 'sec' });
    const configFull = (await (await worker.fetch(new Request('https://cloudssh.test/api/config'), full)).json()) as { turnstileSiteKey?: string };
    expect(configFull.turnstileSiteKey).toBe('site-key-x');
    const half = makeEnv({ TURNSTILE_SITE_KEY: 'site-key-x' });
    const configHalf = (await (await worker.fetch(new Request('https://cloudssh.test/api/config'), half)).json()) as { turnstileSiteKey?: string };
    expect(configHalf.turnstileSiteKey).toBeUndefined();
  });
});
