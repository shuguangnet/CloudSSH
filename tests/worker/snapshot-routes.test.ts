import { describe, expect, it, beforeEach } from 'vitest';
// @ts-expect-error standalone 运行时是 .mjs，无类型声明；复用其真实 SQLite 实现
import { SQLiteStorage } from '../../standalone/runtime.mjs';
import { UserDBDO } from '../../src/worker/user-db';
import type { Env } from '../../src/types';

/**
 * 快照 internal 路由测试（UserDBDO 层）。
 *
 * 为什么需要这一层：`snapshot-store.test.ts` 验证的是 Store 的 SQL 行为，
 * 但**归属校验、base64 编解码、参数校验发生在 DO 路由层**。
 * 越权的经典失误正是「路由忘了覆盖 body.user_id」，所以必须单独覆盖。
 *
 * 用真实 SQLite 而不是 FakeSql：快照 SQL 依赖子查询与 AUTOINCREMENT，
 * 手写 fake 会掩盖实现错误（第一版实现用 lastRowId/changes 就是这么被发现的）。
 */
function makeUserDb(): { userDb: UserDBDO; query: (sql: string, ...args: unknown[]) => any[]; close: () => void } {
  const storage = new SQLiteStorage(':memory:');
  const state = {
    storage: {
      sql: storage.sql,
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => undefined,
      transactionSync: (cb: () => unknown) => storage.transactionSync(cb),
    },
  };
  const userDb = new UserDBDO(state as never, { DEBUG_MODE: 'false' } as unknown as Env);
  return {
    userDb,
    query: (sql, ...args) => [...storage.sql.exec(sql, ...args)],
    close: () => storage.close(),
  };
}

/** 直接建一台属于 userId 的服务器（绕过 servers 路由的加密细节）。 */
function seedServer(
  userDb: UserDBDO,
  query: (sql: string, ...args: unknown[]) => any[],
  id: number,
  userId: number
): void {
  void userDb;
  // servers.user_id 有外键指向 users(id)，且运行库开了 foreign_keys=ON，
  // 所以必须先建用户行（真实部署里由 OAuth/密码登录创建）。
  query(
    `INSERT OR IGNORE INTO users (id, github_id, username, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    userId, 1000 + userId, `user-${userId}`
  );
  query(
    `INSERT INTO servers (id, user_id, name, host, port, username, auth_method, credential, created_at, updated_at)
     VALUES (?, ?, ?, '127.0.0.1', 22, 'root', 'password', 'enc', datetime('now'), datetime('now'))`,
    id, userId, `srv-${id}`
  );
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const json = async (res: Response): Promise<any> => res.json();


function postSnapshot(serverId: number, userId: number, body: Record<string, unknown>): Request {
  return new Request('http://internal/internal/snapshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, server_id: serverId, ...body }),
  });
}

describe('快照 internal 路由', () => {
  let ctx: ReturnType<typeof makeUserDb>;

  beforeEach(() => {
    ctx = makeUserDb();
  });

  it('写入后可通过列表与内容接口读回', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);

    const created = await ctx.userDb.fetch(
      postSnapshot(1, 10, {
        path: '/etc/nginx/nginx.conf',
        kind: 'upload',
        mtime: 1234,
        content_base64: b64('worker_processes auto;'),
      })
    );
    expect(created.status).toBe(200);
    const createdBody = await json(created);
    expect(createdBody.success).toBe(true);
    const snapshotId = createdBody.snapshot.id;

    const list = await ctx.userDb.fetch(
      new Request('http://internal/internal/snapshots?user_id=10&server_id=1&path=%2Fetc%2Fnginx%2Fnginx.conf')
    );
    const listBody = await json(list);
    expect(listBody.snapshots).toHaveLength(1);
    // 列表不得携带内容字段
    expect(listBody.snapshots[0]).not.toHaveProperty('content');
    expect(listBody.snapshots[0].mtime).toBe(1234);

    const content = await ctx.userDb.fetch(
      new Request(`http://internal/internal/snapshots/content?user_id=10&server_id=1&id=${snapshotId}`)
    );
    const contentBody = await json(content);
    expect(Buffer.from(contentBody.content_base64, 'base64').toString('utf8')).toBe(
      'worker_processes auto;'
    );

    ctx.close();
  });

  it('不属于该用户的服务器一律 404，不泄漏存在性', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);

    // 服务器 1 属于 user 10；user 20 尝试写入 → 404（而非 403，避免探测）
    const res = await ctx.userDb.fetch(
      postSnapshot(1, 20, { path: '/etc/a.conf', kind: 'upload', content_base64: b64('x') })
    );
    expect(res.status).toBe(404);

    // 读路径同样受保护
    const list = await ctx.userDb.fetch(
      new Request('http://internal/internal/snapshots?user_id=20&server_id=1&path=%2Fetc%2Fa.conf')
    );
    expect((await json(list)).snapshots).toHaveLength(0);

    ctx.close();
  });

  it('读取他人快照内容返回 404（跨用户隔离）', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);
    seedServer(ctx.userDb, ctx.query, 2, 20);

    const mine = await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/a.conf', kind: 'upload', content_base64: b64('secret') })
    );
    const id = (await json(mine)).snapshot.id;

    // user 20 用自己的服务器 id 读 user 10 的快照 id → 必须 404
    const stolen = await ctx.userDb.fetch(
      new Request(`http://internal/internal/snapshots/content?user_id=20&server_id=2&id=${id}`)
    );
    expect(stolen.status).toBe(404);

    ctx.close();
  });

  it('拒绝非法路径、非法 kind 与非法 base64', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);

    const badPath = await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: 'relative.conf', kind: 'upload', content_base64: b64('x') })
    );
    expect(badPath.status).toBe(400);

    const badKind = await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/a.conf', kind: 'evil', content_base64: b64('x') })
    );
    expect(badKind.status).toBe(400);

    const badB64 = await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/a.conf', kind: 'upload', content_base64: '!!!not-base64!!!' })
    );
    expect(badB64.status).toBe(400);

    // 缺失标识符
    const noIds = await ctx.userDb.fetch(
      new Request('http://internal/internal/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/etc/a.conf', kind: 'upload', content_base64: b64('x') }),
      })
    );
    expect(noIds.status).toBe(400);

    ctx.close();
  });

  it('超过大小上限时返回 success:false 而不是错误（留档可降级）', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);

    const huge = Buffer.alloc(3 * 1024 * 1024, 0x41).toString('base64');
    const res = await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/big.bin', kind: 'upload', content_base64: huge })
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.snapshot).toBeNull();

    ctx.close();
  });

  it('二进制内容可完整往返（不假设 UTF-8）', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);

    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00]);
    const created = await ctx.userDb.fetch(
      postSnapshot(1, 10, {
        path: '/etc/ssl/private.key',
        kind: 'upload',
        content_base64: binary.toString('base64'),
      })
    );
    const id = (await json(created)).snapshot.id;

    const content = await ctx.userDb.fetch(
      new Request(`http://internal/internal/snapshots/content?user_id=10&server_id=1&id=${id}`)
    );
    const roundTripped = Buffer.from((await json(content)).content_base64, 'base64');
    expect(roundTripped.equals(binary)).toBe(true);

    ctx.close();
  });

  it('路径摘要模式返回每个路径最近一条 + 用量', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);

    await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/a.conf', kind: 'upload', content_base64: b64('a1') })
    );
    await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/a.conf', kind: 'edit', content_base64: b64('a2') })
    );
    await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/b.conf', kind: 'upload', content_base64: b64('b1') })
    );

    const res = await ctx.userDb.fetch(
      new Request('http://internal/internal/snapshots?user_id=10&server_id=1&mode=paths')
    );
    const body = await json(res);
    expect(body.snapshots).toHaveLength(2);
    expect(body.snapshots.find((s: any) => s.path === '/etc/a.conf').kind).toBe('edit');
    expect(body.usage.count).toBe(3);
    expect(body.usage.bytes).toBeGreaterThan(0);

    ctx.close();
  });

  it('删除单份快照与清空全部', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);

    const first = await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/a.conf', kind: 'upload', content_base64: b64('a') })
    );
    const id = (await json(first)).snapshot.id;
    await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/b.conf', kind: 'upload', content_base64: b64('b') })
    );

    const removeOne = await ctx.userDb.fetch(
      new Request('http://internal/internal/snapshots', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10, server_id: 1, id }),
      })
    );
    expect((await json(removeOne)).success).toBe(true);

    const clearAll = await ctx.userDb.fetch(
      new Request('http://internal/internal/snapshots', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10, server_id: 1, all: true }),
      })
    );
    expect((await json(clearAll)).removed).toBe(1);

    const list = await ctx.userDb.fetch(
      new Request('http://internal/internal/snapshots?user_id=10&server_id=1&mode=paths')
    );
    expect((await json(list)).snapshots).toHaveLength(0);

    ctx.close();
  });

  it('服务器删除时其快照一并清理', async () => {
    seedServer(ctx.userDb, ctx.query, 1, 10);
    await ctx.userDb.fetch(
      postSnapshot(1, 10, { path: '/etc/a.conf', kind: 'upload', content_base64: b64('a') })
    );

    const deleted = await ctx.userDb.fetch(
      new Request('http://internal/internal/servers/1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 10 }),
      })
    );
    expect(deleted.status).toBe(200);

    // 服务器已删，快照不应留下悬空数据。
    const rows = ctx.query('SELECT id FROM file_snapshots WHERE server_id = 1');
    expect(rows).toHaveLength(0);

    ctx.close();
  });
});
