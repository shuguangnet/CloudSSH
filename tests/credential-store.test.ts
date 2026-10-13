import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  credentialErrorMessage,
  filterCredentialsByAuthMethod,
  RemoteCredentialStore,
  CredentialStoreError,
  type StoredCredential,
} from '../frontend/src/credential-store';

function credential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: 1,
    name: 'x',
    kind: 'password',
    comment: '',
    usageCount: 0,
    lastUsedAt: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

/** 用固定的 fetch 响应驱动 RemoteCredentialStore，避免真实网络。 */
function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('filterCredentialsByAuthMethod', () => {
  it('只保留与认证方式一致的凭据', () => {
    const items = [
      credential({ id: 1, kind: 'password' }),
      credential({ id: 2, kind: 'publickey' }),
      credential({ id: 3, kind: 'password' }),
    ];
    expect(filterCredentialsByAuthMethod(items, 'password').map((c) => c.id)).toEqual([1, 3]);
    expect(filterCredentialsByAuthMethod(items, 'publickey').map((c) => c.id)).toEqual([2]);
    expect(filterCredentialsByAuthMethod(items, 'gssapi')).toEqual([]);
  });
});

describe('RemoteCredentialStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('列表把服务端行字段映射为 camelCase，并保留 usageCount', async () => {
    stubFetch(() =>
      json([
        {
          id: 7,
          name: '生产密钥',
          kind: 'publickey',
          comment: '主密钥',
          usage_count: 3,
          last_used_at: 1700000000000,
          created_at: '2026-01-01',
          updated_at: '2026-01-02',
        },
      ])
    );
    const list = await new RemoteCredentialStore().list();
    expect(list).toEqual([
      {
        id: 7,
        name: '生产密钥',
        kind: 'publickey',
        comment: '主密钥',
        usageCount: 3,
        lastUsedAt: 1700000000000,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
      },
    ]);
  });

  it('未知 kind 归一到 publickey 之外的取值时不越界', async () => {
    stubFetch(() => json([{ id: 1, name: 'x', kind: 'weird' }]));
    const list = await new RemoteCredentialStore().list();
    // 服务端只会给出两种类型；出现异常值时退化为 publickey 而不是抛错。
    expect(list[0].kind).toBe('publickey');
  });

  it('创建前先本地校验，非法输入不发起请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      new RemoteCredentialStore().create({ name: '  ', kind: 'password', secret: 'x' })
    ).rejects.toMatchObject({ code: 'nameRequired' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('创建 request body 只含规范化后的字段', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    stubFetch((input, init) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return json({ id: 1, name: 'n', kind: 'password' });
    });
    await new RemoteCredentialStore().create({
      name: '  n  ',
      kind: 'password',
      secret: '  s  ',
      comment: '  c  ',
    });
    expect(captured!.url).toBe('/api/credentials');
    expect(captured!.body).toEqual({
      name: 'n',
      kind: 'password',
      secret: 's',
      comment: 'c',
    });
  });

  it('更新时密钥留空则不发送 secret 字段（保留原密钥）', async () => {
    let body: Record<string, unknown> | null = null;
    stubFetch((_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ id: 5, name: 'n', kind: 'publickey' });
    });
    await new RemoteCredentialStore().update(5, {
      name: '新名',
      kind: 'publickey',
      secret: '',
      comment: '',
    });
    expect(body).not.toBeNull();
    expect('secret' in body!).toBe(false);
  });

  it('更新时提供了密钥则发送 secret', async () => {
    let body: Record<string, unknown> | null = null;
    stubFetch((_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ id: 5, name: 'n', kind: 'publickey' });
    });
    await new RemoteCredentialStore().update(5, {
      name: 'n',
      kind: 'publickey',
      secret: 'NEW-KEY',
    });
    expect(body!.secret).toBe('NEW-KEY');
  });

  it('409 冲突透传服务端的可读原因（含服务器名）', async () => {
    stubFetch(() => json({ error: '该凭据正被 web-1、web-2 使用，请先解除引用' }, 409));
    const error = await new RemoteCredentialStore()
      .remove(1)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).detail).toBe(
      '该凭据正被 web-1、web-2 使用，请先解除引用'
    );
    // 有 detail 时错误提示直接使用服务端文案。
    expect(credentialErrorMessage(error)).toBe('该凭据正被 web-1、web-2 使用，请先解除引用');
  });

  it('400 的校验错误码映射为本地错误码', async () => {
    stubFetch(() => json({ error: 'secretRequired' }, 400));
    await expect(
      new RemoteCredentialStore().create({ name: 'n', kind: 'password', secret: 'x' })
    ).rejects.toMatchObject({ code: 'secretRequired' });
  });

  it('非 JSON 响应退化为网络错误而不是抛解析异常', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    await expect(new RemoteCredentialStore().list()).rejects.toMatchObject({ code: 'network' });
  });

  it('列表响应不是数组时返回空数组', async () => {
    stubFetch(() => json({ error: 'oops' }));
    await expect(new RemoteCredentialStore().list()).resolves.toEqual([]);
  });
});
