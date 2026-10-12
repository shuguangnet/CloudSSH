import { describe, expect, it } from 'vitest';
// @ts-expect-error standalone 运行时是 .mjs，无类型声明；测试里直接复用其真实 SQLite 实现
import { SQLiteStorage } from '../../standalone/runtime.mjs';
import { SnapshotStore, sha256Hex } from '../../src/worker/snapshot-store';
import {
  SNAPSHOT_KEEP_PER_PATH,
  SNAPSHOT_KEEP_PER_USER,
  SNAPSHOT_MAX_BYTES,
} from '../../src/snapshot-policy';

/**
 * 配置快照存储的行为测试。
 *
 * 走真实 SQLite（standalone 的 SQLiteStorage）而不是手写 fake：
 * 淘汰逻辑依赖子查询与 AUTOINCREMENT 语义，fake 很容易把实现 bug 掩盖掉。
 */
function makeStore(): { store: SnapshotStore; storage: any; close: () => void } {
  const storage = new SQLiteStorage(':memory:');
  const store = new SnapshotStore(storage.sql, (cb: () => unknown) => storage.transactionSync(cb));
  return { store, storage, close: () => storage.close() };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('配置快照存储', () => {
  it('写入后可按路径读回内容与元数据', async () => {
    const { store, close } = makeStore();
    try {
      const meta = await store.create(1, 10, '/etc/nginx/nginx.conf', bytes('worker {}'), 'upload', 1234);
      expect(meta).not.toBeNull();
      expect(meta!.size).toBe(9);
      expect(meta!.kind).toBe('upload');
      expect(meta!.mtime).toBe(1234);
      expect(meta!.sha256).toBe(await sha256Hex(bytes('worker {}')));

      const detail = store.get(1, 10, meta!.id);
      expect(detail).not.toBeNull();
      expect(new TextDecoder().decode(detail!.content)).toBe('worker {}');
    } finally {
      close();
    }
  });

  it('列表按最新在前返回，且不携带内容字段', async () => {
    const { store, close } = makeStore();
    try {
      await store.create(1, 10, '/etc/a.conf', bytes('v1'), 'upload', -1);
      await store.create(1, 10, '/etc/a.conf', bytes('v2'), 'edit', -1);

      const list = store.list(1, 10, '/etc/a.conf');
      expect(list).toHaveLength(2);
      expect(list[0].size).toBe(2); // 最新一份
      expect(list[1].size).toBe(2);
      // 列表项不应出现 content 字段（避免列表接口放大流量）。
      expect(Object.keys(list[0])).not.toContain('content');
    } finally {
      close();
    }
  });

  it('归属隔离：不同用户/服务器读不到彼此的快照', async () => {
    const { store, close } = makeStore();
    try {
      const meta = await store.create(1, 10, '/etc/a.conf', bytes('secret'), 'upload', -1);
      expect(meta).not.toBeNull();

      // 换 user_id / server_id 任一不匹配都必须读不到。
      expect(store.get(2, 10, meta!.id)).toBeNull();
      expect(store.get(1, 11, meta!.id)).toBeNull();
      expect(store.list(2, 10, '/etc/a.conf')).toHaveLength(0);
      // 删除同样受归属约束，跨用户删除无效。
      expect(store.remove(2, 10, meta!.id)).toBe(false);
      expect(store.get(1, 10, meta!.id)).not.toBeNull();
    } finally {
      close();
    }
  });

  it('单路径超过保留上限时淘汰最旧版本', async () => {
    const { store, close } = makeStore();
    try {
      for (let i = 0; i < SNAPSHOT_KEEP_PER_PATH + 5; i++) {
        await store.create(1, 10, '/etc/grow.conf', bytes(`v${i}`), 'upload', -1);
      }
      const list = store.list(1, 10, '/etc/grow.conf');
      expect(list).toHaveLength(SNAPSHOT_KEEP_PER_PATH);
      // 保留的是最近的 N 份：最新一份内容是最后一次写入。
      const newest = store.get(1, 10, list[0].id);
      expect(new TextDecoder().decode(newest!.content)).toBe(`v${SNAPSHOT_KEEP_PER_PATH + 4}`);
    } finally {
      close();
    }
  });

  it('单用户总量超过上限时跨路径淘汰最旧', async () => {
    const { store, close } = makeStore();
    try {
      // 每条路径只留 1 份，用不同路径把总量顶过用户上限。
      for (let i = 0; i < SNAPSHOT_KEEP_PER_USER + 10; i++) {
        await store.create(1, 10, `/etc/file-${i}.conf`, bytes('x'), 'upload', -1);
      }
      expect(store.usage(1).count).toBe(SNAPSHOT_KEEP_PER_USER);
      // 最早写入的路径应已被淘汰。
      expect(store.list(1, 10, '/etc/file-0.conf')).toHaveLength(0);
    } finally {
      close();
    }
  });

  it('超过大小上限或非法路径的内容不留档且不抛错', async () => {
    const { store, close } = makeStore();
    try {
      expect(await store.create(1, 10, '/etc/big.bin', new Uint8Array(SNAPSHOT_MAX_BYTES + 1), 'upload', -1)).toBeNull();
      expect(await store.create(1, 10, 'relative/path', bytes('x'), 'upload', -1)).toBeNull();
      expect(await store.create(1, 10, '/etc/ok.conf', new Uint8Array(0), 'upload', -1)).not.toBeNull();
      expect(store.list(1, 10, '/etc/big.bin')).toHaveLength(0);
      expect(store.list(1, 10, 'relative/path')).toHaveLength(0);
    } finally {
      close();
    }
  });

  it('路径摘要每个路径只返回最近一条', async () => {
    const { store, close } = makeStore();
    try {
      await store.create(1, 10, '/etc/a.conf', bytes('a1'), 'upload', -1);
      await store.create(1, 10, '/etc/a.conf', bytes('a2'), 'edit', -1);
      await store.create(1, 10, '/etc/b.conf', bytes('b1'), 'upload', -1);

      const paths = store.listPaths(1, 10);
      expect(paths).toHaveLength(2);
      const a = paths.find((p) => p.path === '/etc/a.conf');
      expect(a?.kind).toBe('edit'); // 最近一份的来源
      expect(store.list(1, 10, '/etc/a.conf')).toHaveLength(2); // 明细仍有两条
    } finally {
      close();
    }
  });

  it('清空与服务器移除会删除对应快照', async () => {
    const { store, close } = makeStore();
    try {
      await store.create(1, 10, '/etc/a.conf', bytes('a'), 'upload', -1);
      await store.create(1, 10, '/etc/b.conf', bytes('b'), 'upload', -1);
      await store.create(1, 20, '/etc/c.conf', bytes('c'), 'upload', -1);

      expect(store.clearPath(1, 10, '/etc/a.conf')).toBe(1);
      expect(store.list(1, 10, '/etc/a.conf')).toHaveLength(0);

      store.removeServer(1, 10);
      expect(store.list(1, 10, '/etc/b.conf')).toHaveLength(0);
      // 其它服务器不受影响。
      expect(store.list(1, 20, '/etc/c.conf')).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('回滚产生的快照本身也可作为下一轮回滚目标（可逆）', async () => {
    const { store, close } = makeStore();
    try {
      const first = await store.create(1, 10, '/etc/a.conf', bytes('original'), 'upload', -1);
      // 模拟 restoreSnapshot 在写回前对当前内容留档
      await store.create(1, 10, '/etc/a.conf', bytes('broken'), 'restore', -1);

      const list = store.list(1, 10, '/etc/a.conf');
      expect(list[0].kind).toBe('restore');
      expect(new TextDecoder().decode(store.get(1, 10, first!.id)!.content)).toBe('original');
    } finally {
      close();
    }
  });
});
