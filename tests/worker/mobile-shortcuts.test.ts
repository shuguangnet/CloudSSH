import { describe, expect, it, vi } from 'vitest';
import {
  buildDefaultMobileShortcuts,
  MAX_MOBILE_SHORTCUTS,
  normalizeMobileShortcutsPayload,
} from '../../src/mobile-shortcuts-schema';
import type { Env, UserInfo } from '../../src/types';

async function loadWorker() {
  const mod = await import('../../src/worker/index');
  return mod.default;
}

interface ShortcutsStubOptions {
  sessionToken?: string;
  user?: UserInfo;
  initialShortcuts?: string | null;
}

function makeShortcutsStub(options: ShortcutsStubOptions) {
  const user: UserInfo = options.user ?? {
    id: 1,
    github_id: 12345,
    username: 'octocat',
    avatar_url: null,
  };
  const sessions = new Set<string>(options.sessionToken ? [options.sessionToken] : []);
  let storedData: string | null = options.initialShortcuts ?? null;
  const calls: Array<{ path: string; method: string; userId: string | null; body?: unknown }> = [];

  const stub = {
    calls,
    getStoredData: () => storedData,
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === '/internal/session/verify') {
        const { token } = (await req.json()) as { token: string };
        if (!sessions.has(token)) {
          return Response.json({ error: 'Invalid or expired session' }, { status: 401 });
        }
        return Response.json(user);
      }

      if (path === '/internal/mobile-shortcuts') {
        let body: unknown;
        if (req.method === 'PUT') {
          const parsed = (await req.json()) as { user_id: number; shortcuts_data: string };
          body = parsed;
          storedData = parsed.shortcuts_data;
          calls.push({ path, method: req.method, userId: String(parsed.user_id), body });
          return Response.json({ success: true });
        }
        calls.push({ path, method: req.method, userId: url.searchParams.get('user_id') });
        if (req.method === 'GET') {
          if (!storedData) return Response.json({ shortcuts: null });
          return Response.json(JSON.parse(storedData));
        }
        if (req.method === 'DELETE') {
          storedData = null;
          return Response.json({ success: true });
        }
      }

      return Response.json({ error: 'not mocked' }, { status: 500 });
    }),
  };
  return stub;
}

function makeEnv(userDbStub: ReturnType<typeof makeShortcutsStub>): Env {
  const fallback = {
    fetch: vi.fn(async () => new Response('{"error":"not mocked"}', { status: 500 })),
  };
  return {
    SSH_SESSION: {
      idFromName: () => 'do-ssh',
      get: () => fallback,
    } as unknown as Env['SSH_SESSION'],
    USER_DB: {
      idFromName: () => 'do-userdb',
      get: () => userDbStub,
    } as unknown as Env['USER_DB'],
    SSH_SHARE: {
      idFromName: () => 'do-share',
      get: () => fallback,
    } as unknown as Env['SSH_SHARE'],
  } as Env;
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    cookies?: Record<string, string>;
    body?: unknown;
    origin?: string;
  } = {}
): Request {
  const url = new URL(`https://cloudssh.test${path}`);
  const headers: Record<string, string> = {};
  if (opts.cookies) {
    headers['Cookie'] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  if (opts.origin !== undefined) {
    headers['Origin'] = opts.origin;
  }
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return new Request(url.toString(), init);
}

const SESSION_TOKEN = '12345:abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678';

describe('mobile-shortcuts-schema 校验与规范化', () => {
  it('buildDefaultMobileShortcuts 生成完整默认快捷键列表', () => {
    const defaults = buildDefaultMobileShortcuts();
    expect(defaults.shortcuts.length).toBe(20);
    expect(defaults.shortcuts[0]).toEqual({ id: 'escape', label: 'Esc', type: 'key' });
    expect(defaults.shortcuts.some((s) => s.id === 'ctrl')).toBe(true);
    expect(defaults.shortcuts.some((s) => s.id === 'copy')).toBe(true);
  });

  it('支持预设按键（含 shift、f1-f12、delete、insert）与自定义按键', () => {
    const result = normalizeMobileShortcutsPayload({
      shortcuts: [
        { id: 'escape' },
        { id: 'shift' },
        { id: 'f3' },
        { id: 'delete' },
        { id: 'custom_1', label: 'sudo', type: 'text', value: 'sudo ' },
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.shortcuts).toEqual([
      { id: 'escape', label: 'Esc', type: 'key' },
      { id: 'shift', label: 'Shift', type: 'modifier' },
      { id: 'f3', label: 'F3', type: 'key' },
      { id: 'delete', label: 'Del', type: 'key' },
      { id: 'custom_1', label: 'sudo', type: 'text', value: 'sudo ' },
    ]);
  });

  it('拒绝空数组、超过上限数量、未知非自定义 ID 或超长自定义标签', () => {
    expect(normalizeMobileShortcutsPayload({ shortcuts: [] })).toBeNull();
    expect(
      normalizeMobileShortcutsPayload({
        shortcuts: Array.from({ length: MAX_MOBILE_SHORTCUTS + 1 }, () => ({ id: 'escape' })),
      })
    ).toBeNull();
    expect(
      normalizeMobileShortcutsPayload({
        shortcuts: [{ id: 'unknown_hack_key' }],
      })
    ).toBeNull();
    expect(
      normalizeMobileShortcutsPayload({
        shortcuts: [{ id: 'custom_1', label: '123456789', type: 'text', value: 'ls' }],
      })
    ).toBeNull();
  });
});

describe('/api/user/mobile-shortcuts 路由鉴权与同步', () => {
  it('未登录访问 GET/PUT/DELETE 返回 401', async () => {
    const worker = await loadWorker();
    const stub = makeShortcutsStub({});
    const env = makeEnv(stub);

    const getRes = await worker.fetch(makeRequest('/api/user/mobile-shortcuts'), env);
    expect(getRes.status).toBe(401);

    const putRes = await worker.fetch(
      makeRequest('/api/user/mobile-shortcuts', {
        method: 'PUT',
        body: { shortcuts: [{ id: 'escape' }] },
      }),
      env
    );
    expect(putRes.status).toBe(401);
  });

  it('登录用户可保存、读取并重置移动端快捷键配置', async () => {
    const worker = await loadWorker();
    const stub = makeShortcutsStub({ sessionToken: SESSION_TOKEN });
    const env = makeEnv(stub);
    const cookies = { session: SESSION_TOKEN };

    // 1. 初始读取为空
    const res1 = await worker.fetch(
      makeRequest('/api/user/mobile-shortcuts', { cookies }),
      env
    );
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ shortcuts: null });

    // 2. 保存自定义配置（含 shift、f3、delete）
    const putRes = await worker.fetch(
      makeRequest('/api/user/mobile-shortcuts', {
        method: 'PUT',
        cookies,
        origin: 'https://cloudssh.test',
        body: {
          shortcuts: [{ id: 'escape' }, { id: 'shift' }, { id: 'f3' }, { id: 'delete' }],
        },
      }),
      env
    );
    expect(putRes.status).toBe(200);

    // 3. 再次读取应返回规范化后的快捷键列表
    const res2 = await worker.fetch(
      makeRequest('/api/user/mobile-shortcuts', { cookies }),
      env
    );
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as { shortcuts: Array<{ id: string }> };
    expect(data2.shortcuts.map((s) => s.id)).toEqual(['escape', 'shift', 'f3', 'delete']);

    // 4. DELETE 重置
    const delRes = await worker.fetch(
      makeRequest('/api/user/mobile-shortcuts', {
        method: 'DELETE',
        cookies,
        origin: 'https://cloudssh.test',
      }),
      env
    );
    expect(delRes.status).toBe(200);
    expect(stub.getStoredData()).toBeNull();
  });

  it('跨源 Origin 的 PUT/DELETE 请求返回 403 Forbidden', async () => {
    const worker = await loadWorker();
    const stub = makeShortcutsStub({ sessionToken: SESSION_TOKEN });
    const env = makeEnv(stub);
    const cookies = { session: SESSION_TOKEN };

    const putRes = await worker.fetch(
      makeRequest('/api/user/mobile-shortcuts', {
        method: 'PUT',
        cookies,
        origin: 'https://evil.example.com',
        body: { shortcuts: [{ id: 'escape' }] },
      }),
      env
    );
    expect(putRes.status).toBe(403);
  });
});
