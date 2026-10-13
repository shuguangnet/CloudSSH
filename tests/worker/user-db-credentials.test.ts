import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';

const { inferLocationHintMock } = vi.hoisted(() => ({
  inferLocationHintMock: vi.fn(),
}));

vi.mock('../../src/worker/ip-geo', () => ({
  inferLocationHint: inferLocationHintMock,
}));

import { UserDBDO } from '../../src/worker/user-db';

/**
 * 可复用凭据库测试。
 *
 * 这里刻意覆盖三条最容易出错的路径：
 * 1. secret 绝不出现在任何响应里（只在 DO 内部解密瞬间存在）；
 * 2. 连接时按 credential_id 解析，而不是读服务器自带的 credential 列；
 * 3. 删除/改类型时的引用保护（否则会出现静默连接失败）。
 */
class FakeSql {
  statements: Array<{ query: string; values: unknown[] }> = [];
  encryptionSecret = 'test-encryption-secret-1234567890';
  credentials: Array<Record<string, unknown>> = [];
  serverRows: Array<Record<string, unknown>> = [];
  private nextCredentialId = 1;

  exec(query: string, ...values: unknown[]): { toArray: () => unknown[] } {
    this.statements.push({ query, values });

    if (query.includes('PRAGMA table_info')) {
      // 全部列都已存在：迁移分支不应触发 ALTER TABLE。
      return {
        toArray: () => [
          { name: 'region' },
          { name: 'inferred_hint' },
          { name: 'tags' },
          { name: 'os' },
          { name: 'jump_server_id' },
          { name: 'transport_type' },
          { name: 'cf_tunnel_host' },
          { name: 'cf_access_client_id' },
          { name: 'cf_access_client_secret' },
          { name: 'last_connected_at' },
          { name: 'credential_id' },
        ],
      };
    }
    if (query.includes("SELECT value FROM system_config WHERE key = 'encryption_secret'")) {
      return { toArray: () => [{ value: this.encryptionSecret }] };
    }
    if (query.includes('SELECT github_id FROM users WHERE id = ?')) {
      return { toArray: () => [{ github_id: 12345 }] };
    }

    // --- 凭据 CRUD ---
    if (query.includes('SELECT COUNT(*) AS count FROM credentials')) {
      return { toArray: () => [{ count: this.credentials.length }] };
    }
    if (query.startsWith('INSERT INTO credentials')) {
      const row = {
        id: this.nextCredentialId++,
        user_id: values[0],
        name: values[1],
        kind: values[2],
        secret: values[3],
        comment: values[4],
      };
      this.credentials.push(row);
      return { toArray: () => [] };
    }
    if (query.startsWith('UPDATE credentials SET last_used_at')) {
      const row = this.credentials.find((c) => c.id === values[1]);
      if (row) row.last_used_at = values[0];
      return { toArray: () => [] };
    }
    if (query.includes('SELECT id FROM credentials WHERE user_id = ? AND id = ?')) {
      const row = this.credentials.find((c) => c.id === values[1] && c.user_id === values[0]);
      return { toArray: () => (row ? [{ id: row.id }] : []) };
    }
    if (query.includes('SELECT kind FROM credentials WHERE user_id = ? AND id = ?')) {
      const row = this.credentials.find((c) => c.id === values[1] && c.user_id === values[0]);
      return { toArray: () => (row ? [{ kind: row.kind }] : []) };
    }
    if (query.includes('SELECT kind, secret FROM credentials WHERE user_id = ? AND id = ?')) {
      const row = this.credentials.find((c) => c.id === values[1] && c.user_id === values[0]);
      return { toArray: () => (row ? [{ kind: row.kind, secret: row.secret }] : []) };
    }
    if (query.includes('FROM credentials c WHERE c.user_id = ? AND c.id = ?')) {
      const row = this.credentials.find((c) => c.id === values[1] && c.user_id === values[0]);
      return { toArray: () => (row ? [this.decorate(row)] : []) };
    }
    if (query.includes('FROM credentials c WHERE c.user_id = ?')) {
      return {
        toArray: () =>
          this.credentials.filter((c) => c.user_id === values[0]).map((c) => this.decorate(c)),
      };
    }
    if (query.startsWith('UPDATE credentials SET name')) {
      // updates: name, kind, comment, [secret], user_id, id
      const hasSecret = query.includes('secret = ?');
      const id = values[values.length - 1];
      const row = this.credentials.find((c) => c.id === id);
      if (row) {
        row.name = values[0];
        row.kind = values[1];
        row.comment = values[2];
        if (hasSecret) row.secret = values[3];
      }
      return { toArray: () => [] };
    }
    if (query.startsWith('DELETE FROM credentials')) {
      this.credentials = this.credentials.filter(
        (c) => !(c.id === values[1] && c.user_id === values[0])
      );
      return { toArray: () => [] };
    }

    // --- 服务器侧引用查询 ---
    if (query.includes('SELECT name FROM servers WHERE user_id = ? AND credential_id = ?')) {
      return {
        toArray: () =>
          this.serverRows
            .filter((s) => s.credential_id === values[1] && s.user_id === values[0])
            .map((s) => ({ name: s.name })),
      };
    }
    if (query.includes('SELECT name FROM servers WHERE user_id = ? AND credential_id = ? AND auth_method != ?')) {
      return {
        toArray: () =>
          this.serverRows
            .filter(
              (s) =>
                s.credential_id === values[1] &&
                s.user_id === values[0] &&
                s.auth_method !== values[2]
            )
            .map((s) => ({ name: s.name })),
      };
    }
    if (query.includes('FROM servers WHERE id = ?')) {
      return { toArray: () => this.serverRows.filter((s) => s.id === values[0]) };
    }
    if (query.includes('FROM known_hosts WHERE user_id = ?')) {
      return { toArray: () => [] };
    }
    if (query.startsWith('UPDATE servers SET last_connected_at')) {
      return { toArray: () => [] };
    }
    return { toArray: () => [] };
  }

  private decorate(row: Record<string, unknown>): Record<string, unknown> {
    const usage = this.serverRows.filter((s) => s.credential_id === row.id).length;
    // 与真实 SELECT 列保持一致：刻意不返回 secret，这样“响应不泄露凭据”
    // 这条断言才真正校验被测代码，而不是被假件的宽容所掩盖。
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      comment: row.comment,
      last_used_at: row.last_used_at ?? null,
      created_at: row.created_at ?? '',
      updated_at: row.updated_at ?? '',
      usage_count: usage,
    };
  }
}

function createUserDB(sql: FakeSql): UserDBDO {
  return new UserDBDO(
    { storage: { sql } } as unknown as DurableObjectState,
    { DEBUG_MODE: 'false' } as unknown as Env
  );
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function put(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 取出 DO 内部按 token 暂存的连接配置，用于断言实际下发的凭据。 */
function connectConfigFor(userDB: UserDBDO, token: string): Record<string, unknown> {
  const tokens = (userDB as unknown as { connectTokens: Map<string, { config: unknown }> })
    .connectTokens;
  const entry = tokens.get(token);
  if (!entry) throw new Error(`未找到 token 对应的连接配置: ${token}`);
  return entry.config as Record<string, unknown>;
}

describe('UserDB 可复用凭据库', () => {
  it('凭据列表与详情绝不返回 secret，只回传元数据与 has_secret', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '生产部署密钥',
        kind: 'publickey',
        secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
        comment: '仅限生产环境',
      })
    );

    const listResponse = await userDB.fetch(
      new Request('http://internal/internal/credentials?user_id=7')
    );
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: '生产部署密钥',
      kind: 'publickey',
      comment: '仅限生产环境',
      has_secret: true,
      usage_count: 0,
    });
    // 关键安全断言：响应里不能出现明文凭据，也不能有以 secret 为名的字段。
    // （has_secret 是布尔标记，不属泄露。）
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    for (const item of list) {
      expect(Object.keys(item)).not.toContain('secret');
    }
  });

  it('凭据入库时加密存储，不落明文', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);
    const plaintext = 'super-secret-password';

    await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '数据库密码',
        kind: 'password',
        secret: plaintext,
      })
    );

    expect(sql.credentials).toHaveLength(1);
    const stored = String(sql.credentials[0].secret);
    expect(stored).not.toBe(plaintext);
    expect(stored.length).toBeGreaterThan(0);
  });

  it('按 credential_id 连接时使用凭据库中的密文解密结果', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    // 先建凭据，拿到真实密文。
    await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '复用密钥',
        kind: 'publickey',
        secret: 'REUSED-KEY-MATERIAL',
      })
    );
    const credentialId = sql.credentials[0].id as number;

    // 服务器自带 credential 故意留空，证明凭据只能来自引用。
    sql.serverRows = [
      {
        id: 10,
        user_id: 7,
        name: 'prod',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        credential: '',
        auth_method: 'publickey',
        jump_server_id: null,
        transport_type: 'direct',
        credential_id: credentialId,
      },
    ];

    const response = await userDB.fetch(
      post('http://internal/internal/servers/10/connect', { user_id: 7 })
    );
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const config = connectConfigFor(userDB, token);
    expect(config.privateKey).toBe('REUSED-KEY-MATERIAL');
    expect(config.password).toBe('');
  });

  it('引用凭据类型与服务器认证方式不符时拒绝连接，而不是静默回落到空凭据', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '密码凭据',
        kind: 'password',
        secret: 'p@ssw0rd',
      })
    );
    const credentialId = sql.credentials[0].id as number;

    // 密码凭据被挂在密钥认证的服务器上：配置错误，必须显式报错。
    sql.serverRows = [
      {
        id: 11,
        user_id: 7,
        name: 'misconfigured',
        host: 'm.example.com',
        port: 22,
        username: 'root',
        credential: '',
        auth_method: 'publickey',
        jump_server_id: null,
        transport_type: 'direct',
        credential_id: credentialId,
      },
    ];

    const response = await userDB.fetch(
      post('http://internal/internal/servers/11/connect', { user_id: 7 })
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain('misconfigured');
    expect(payload.error).toContain('类型');
  });

  it('引用的凭据已被删除时拒绝连接并提示重新选择', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);
    sql.serverRows = [
      {
        id: 12,
        user_id: 7,
        name: 'dangling',
        host: 'd.example.com',
        port: 22,
        username: 'root',
        credential: '',
        auth_method: 'publickey',
        jump_server_id: null,
        transport_type: 'direct',
        credential_id: 999,
      },
    ];

    const response = await userDB.fetch(
      post('http://internal/internal/servers/12/connect', { user_id: 7 })
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain('dangling');
    expect(payload.error).toContain('已不存在');
  });

  it('删除被服务器引用的凭据时返回 409 并列出引用它的服务器', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);
    await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '共享密钥',
        kind: 'publickey',
        secret: 'KEY',
      })
    );
    const credentialId = sql.credentials[0].id as number;
    sql.serverRows = [
      {
        id: 21,
        user_id: 7,
        name: 'web-1',
        credential_id: credentialId,
        auth_method: 'publickey',
      },
      {
        id: 22,
        user_id: 7,
        name: 'web-2',
        credential_id: credentialId,
        auth_method: 'publickey',
      },
    ];

    const response = await userDB.fetch(
      del(`http://internal/internal/credentials/${credentialId}`, { user_id: 7 })
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain('web-1');
    expect(payload.error).toContain('web-2');
    // 被拒绝后凭据必须仍在库中。
    expect(sql.credentials).toHaveLength(1);
  });

  it('删除未被引用的凭据成功', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);
    await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '孤儿凭据',
        kind: 'password',
        secret: 'x',
      })
    );
    const credentialId = sql.credentials[0].id as number;

    const response = await userDB.fetch(
      del(`http://internal/internal/credentials/${credentialId}`, { user_id: 7 })
    );
    expect(response.status).toBe(200);
    expect(sql.credentials).toHaveLength(0);
  });

  it('更新凭据时缺省 secret 会保留原密文，改类型遇到引用冲突则拒绝', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);
    await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '旧名',
        kind: 'publickey',
        secret: 'ORIGINAL-KEY',
      })
    );
    const credentialId = sql.credentials[0].id as number;
    const originalCipher = sql.credentials[0].secret;

    // 只改名字与备注：密文必须原样保留。
    const renameResponse = await userDB.fetch(
      put(`http://internal/internal/credentials/${credentialId}`, {
        user_id: 7,
        name: '新名',
        kind: 'publickey',
        comment: '更新备注',
      })
    );
    expect(renameResponse.status).toBe(200);
    expect(sql.credentials[0].secret).toBe(originalCipher);
    expect(sql.credentials[0].name).toBe('新名');

    // 该凭据正被一台密钥认证服务器引用，改成密码类型应被拒绝。
    sql.serverRows = [
      { id: 31, user_id: 7, name: 'k8s-node', credential_id: credentialId, auth_method: 'publickey' },
    ];
    const conflictResponse = await userDB.fetch(
      put(`http://internal/internal/credentials/${credentialId}`, {
        user_id: 7,
        name: '新名',
        kind: 'password',
      })
    );
    expect(conflictResponse.status).toBe(409);
    const payload = (await conflictResponse.json()) as { error: string };
    expect(payload.error).toContain('k8s-node');
    // 类型未被改动。
    expect(sql.credentials[0].kind).toBe('publickey');
  });

  it('凭据输入校验：名称/正文必填，超长拒绝，类型必须是 password 或 publickey', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    const missingName = await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '   ',
        kind: 'password',
        secret: 'x',
      })
    );
    expect(missingName.status).toBe(400);
    await expect(missingName.json()).resolves.toEqual({ error: 'nameRequired' });

    const badKind = await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: 'x',
        kind: 'totp',
        secret: 'x',
      })
    );
    expect(badKind.status).toBe(400);
    await expect(badKind.json()).resolves.toEqual({ error: 'kindRequired' });

    const emptySecret = await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: 'x',
        kind: 'password',
        secret: '  ',
      })
    );
    expect(emptySecret.status).toBe(400);
    await expect(emptySecret.json()).resolves.toEqual({ error: 'secretRequired' });

    const tooLongName = await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: 'a'.repeat(51),
        kind: 'password',
        secret: 'x',
      })
    );
    expect(tooLongName.status).toBe(400);
    await expect(tooLongName.json()).resolves.toEqual({ error: 'nameTooLong' });

    // 校验失败不应写入任何记录。
    expect(sql.credentials).toHaveLength(0);
  });

  it('迁移：新增 credential_id 列与凭据表，且对既有列幂等', async () => {
    const sql = new FakeSql();
    createUserDB(sql);

    expect(
      sql.statements.some(({ query }) => query.includes('CREATE TABLE IF NOT EXISTS credentials'))
    ).toBe(true);
    // 列已存在（PRAGMA 返回 credential_id），因此不应再发 ALTER TABLE。
    expect(
      sql.statements.some(({ query }) =>
        query.includes('ALTER TABLE servers ADD COLUMN credential_id')
      )
    ).toBe(false);
  });

  it('未引用凭据的服务器仍走内嵌 credential 列（存量数据兼容）', async () => {
    const sql = new FakeSql();
    const userDB = createUserDB(sql);

    // 先按老路径建一台服务器，拿到密文。
    const legacySecret = 'legacy-inline-password';
    const created = await userDB.fetch(
      post('http://internal/internal/credentials', {
        user_id: 7,
        name: '借用加密管线',
        kind: 'password',
        secret: legacySecret,
      })
    );
    expect(created.status).toBe(201);
    const cipher = String(sql.credentials[0].secret);

    sql.serverRows = [
      {
        id: 41,
        user_id: 7,
        name: 'legacy',
        host: 'legacy.example.com',
        port: 22,
        username: 'root',
        credential: cipher,
        auth_method: 'password',
        jump_server_id: null,
        transport_type: 'direct',
        credential_id: null,
      },
    ];

    const response = await userDB.fetch(
      post('http://internal/internal/servers/41/connect', { user_id: 7 })
    );
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(connectConfigFor(userDB, token).password).toBe(legacySecret);
  });
});
