import {
  SNAPSHOT_KEEP_PER_PATH,
  SNAPSHOT_KEEP_PER_USER,
  SNAPSHOT_LIST_MAX,
  SNAPSHOT_MAX_BYTES,
  isValidSnapshotPath,
  isSnapshotKind,
  shouldSnapshot,
  type SnapshotKind,
} from '../snapshot-policy';

/**
 * 配置快照存储（UserDBDO 所有）。
 *
 * 设计要点：
 * - 内容以 BLOB 存储：快照可能是二进制配置（证书、keystore），不假设 UTF-8。
 * - 归属隔离按 (user_id, server_id) 行级：所有查询都带 user_id，
 *   与 command_snippets / server memory 的既有隔离模型一致。
 * - 淘汰是同步的、在写入的同一事务里完成：保留每路径最近 N 份 + 每用户总量上限，
 *   保证表不会无界增长（快照是回滚窗口，不是备份系统）。
 * - `content` 只在显式请求单条详情时返回，列表不携带内容（避免列表接口放大流量）。
 */

const SNAPSHOT_KINDS_SQL = "('upload','edit','restore','delete')";

export type SnapshotMeta = {
  id: number;
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  kind: SnapshotKind;
  created_at: number;
};

export type SnapshotDetail = SnapshotMeta & { content: Uint8Array };

type SnapshotRow = {
  id: number;
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  kind: string;
  created_at: number;
};

type SnapshotContentRow = SnapshotRow & { content: Uint8Array | ArrayBuffer | null };

/** sha256 hex（快照内容指纹，用于「回滚到这一版」的去重与校验）。 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toBytes(value: SnapshotContentRow['content']): Uint8Array {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

function toMeta(row: SnapshotRow): SnapshotMeta {
  // kind 由枚举约束；库中若有历史脏值，回退为 'upload' 而不是让整列表失败。
  const kind = isSnapshotKind(row.kind) ? row.kind : 'upload';
  return {
    id: row.id,
    path: row.path,
    size: row.size,
    sha256: row.sha256,
    mtime: row.mtime,
    kind,
    created_at: row.created_at,
  };
}

export class SnapshotStore {
  constructor(
    private db: SqlStorage,
    private transaction: <T>(callback: () => T) => T
  ) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_snapshots (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id     INTEGER NOT NULL,
          server_id   INTEGER NOT NULL,
          path        TEXT NOT NULL,
          content     BLOB NOT NULL,
          size        INTEGER NOT NULL,
          sha256      TEXT NOT NULL,
          mtime       INTEGER NOT NULL DEFAULT -1,
          kind        TEXT NOT NULL CHECK (kind IN ${SNAPSHOT_KINDS_SQL}),
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_snapshots_path
          ON file_snapshots(user_id, server_id, path, id DESC);
        CREATE INDEX IF NOT EXISTS idx_file_snapshots_owner
          ON file_snapshots(user_id, id DESC);
      `);
    } catch {
      /* mock 环境下忽略建表失败，与 ServerMemoryStore 的既有约定一致 */
    }
  }

  private query<T>(sql: string, ...values: (string | number | null)[]): T[] {
    // SAFETY: each caller supplies a row shape matching its explicit SELECT columns.
    return this.db.exec(sql, ...values).toArray() as unknown as T[];
  }

  /**
   * 写入一份快照并执行淘汰。返回新快照的元数据。
   *
   * 内容超过 SNAPSHOT_MAX_BYTES 时返回 null（调用方据此跳过留档），
   * 而不是抛错——留档是增强能力，不该让正常的文件写入失败。
   */
  async create(
    userId: number,
    serverId: number,
    path: string,
    content: Uint8Array,
    kind: SnapshotKind,
    mtime: number
  ): Promise<SnapshotMeta | null> {
    if (!isValidSnapshotPath(path) || !shouldSnapshot(content.length)) return null;
    if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(serverId)) return null;
    if (!isSnapshotKind(kind)) kind = 'upload';

    // 哈希是异步的（WebCrypto）；先算完再进入同步事务提交，避免事务跨越 await。
    const sha256 = await sha256Hex(content);
    const createdAt = Date.now();
    const bytes = content.length;

    let insertedId = 0;
    try {
      this.transaction(() => {
        // 不依赖 lastRowId（DO SqlStorage 与 standalone SQLite shim 的返回形状不同），
        // 而是在同一事务内取该归属下最新的 id —— 刚插入的那行必然是它。
        this.db.exec(
          `INSERT INTO file_snapshots
             (user_id, server_id, path, content, size, sha256, mtime, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          userId, serverId, path, content, bytes, sha256,
          Number.isSafeInteger(mtime) ? mtime : -1, kind, createdAt
        );
        insertedId = Number(
          this.query<{ id: number }>(
            `SELECT id FROM file_snapshots WHERE user_id = ? AND server_id = ?
              ORDER BY id DESC LIMIT 1`,
            userId, serverId
          )[0]?.id ?? 0
        );

        // 路径级淘汰：只保留最近 SNAPSHOT_KEEP_PER_PATH 份。
        this.db.exec(
          `DELETE FROM file_snapshots
            WHERE user_id = ? AND server_id = ? AND path = ?
              AND id NOT IN (
                SELECT id FROM file_snapshots
                 WHERE user_id = ? AND server_id = ? AND path = ?
                 ORDER BY id DESC LIMIT ?
              )`,
          userId, serverId, path, userId, serverId, path, SNAPSHOT_KEEP_PER_PATH
        );

        // 用户级总量淘汰：跨路径合计上限，防止大量不同路径各留 10 份撑爆存储。
        this.db.exec(
          `DELETE FROM file_snapshots
            WHERE user_id = ?
              AND id NOT IN (
                SELECT id FROM file_snapshots
                 WHERE user_id = ? ORDER BY id DESC LIMIT ?
              )`,
          userId, userId, SNAPSHOT_KEEP_PER_USER
        );
      });
    } catch {
      return null;
    }

    if (!insertedId) {
      // 少数运行时在事务里拿不到 id：按 (路径, 哈希, 时间) 回查一次。
      const row = this.query<SnapshotRow>(
        `SELECT id, path, size, sha256, mtime, kind, created_at FROM file_snapshots
          WHERE user_id = ? AND server_id = ? AND path = ? AND sha256 = ? AND created_at = ?
          ORDER BY id DESC LIMIT 1`,
        userId, serverId, path, sha256, createdAt
      )[0];
      return row ? toMeta(row) : null;
    }
    return { id: insertedId, path, size: bytes, sha256, mtime, kind, created_at: createdAt };
  }

  /** 列出某路径的版本历史（不含内容），最新在前。 */
  list(userId: number, serverId: number, path: string): SnapshotMeta[] {
    if (!isValidSnapshotPath(path)) return [];
    return this.query<SnapshotRow>(
      `SELECT id, path, size, sha256, mtime, kind, created_at FROM file_snapshots
        WHERE user_id = ? AND server_id = ? AND path = ?
        ORDER BY id DESC LIMIT ?`,
      userId, serverId, path, SNAPSHOT_LIST_MAX
    ).map(toMeta);
  }

  /** 列出该服务器上所有有快照的路径摘要（每路径仅最近一条），供 UI 入口展示。 */
  listPaths(userId: number, serverId: number): SnapshotMeta[] {
    return this.query<SnapshotRow>(
      `SELECT s.id, s.path, s.size, s.sha256, s.mtime, s.kind, s.created_at
         FROM file_snapshots s
         JOIN (
           SELECT path, MAX(id) AS max_id FROM file_snapshots
            WHERE user_id = ? AND server_id = ?
            GROUP BY path
         ) latest ON latest.max_id = s.id
        WHERE s.user_id = ? AND s.server_id = ?
        ORDER BY s.id DESC LIMIT ?`,
      userId, serverId, userId, serverId, SNAPSHOT_LIST_MAX
    ).map(toMeta);
  }

  /** 读取单份快照（含内容）。归属不匹配返回 null，绝不跨用户读取。 */
  get(userId: number, serverId: number, id: number): SnapshotDetail | null {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const row = this.query<SnapshotContentRow>(
      `SELECT id, path, content, size, sha256, mtime, kind, created_at FROM file_snapshots
        WHERE id = ? AND user_id = ? AND server_id = ?`,
      id, userId, serverId
    )[0];
    if (!row) return null;
    return { ...toMeta(row), content: toBytes(row.content) };
  }

  /** 删除单份快照。先查归属再删 —— 与代码库既有模式一致（无 changes 依赖）。 */
  remove(userId: number, serverId: number, id: number): boolean {
    if (!Number.isSafeInteger(id) || id < 1) return false;
    const exists = this.query<{ id: number }>(
      'SELECT id FROM file_snapshots WHERE id = ? AND user_id = ? AND server_id = ?',
      id, userId, serverId
    );
    if (exists.length === 0) return false;
    this.db.exec(
      'DELETE FROM file_snapshots WHERE id = ? AND user_id = ? AND server_id = ?',
      id, userId, serverId
    );
    return true;
  }

  /** 清空某路径（或该服务器全部路径）的快照，返回删除条数。 */
  clearPath(userId: number, serverId: number, path: string | null): number {
    if (path !== null && !isValidSnapshotPath(path)) return 0;
    const countRow = this.query<{ count: number }>(
      path === null
        ? 'SELECT COUNT(*) AS count FROM file_snapshots WHERE user_id = ? AND server_id = ?'
        : 'SELECT COUNT(*) AS count FROM file_snapshots WHERE user_id = ? AND server_id = ? AND path = ?',
      ...(path === null ? [userId, serverId] : [userId, serverId, path])
    );
    const removed = Number(countRow[0]?.count ?? 0);
    if (removed === 0) return 0;
    if (path === null) {
      this.db.exec(
        'DELETE FROM file_snapshots WHERE user_id = ? AND server_id = ?',
        userId, serverId
      );
    } else {
      this.db.exec(
        'DELETE FROM file_snapshots WHERE user_id = ? AND server_id = ? AND path = ?',
        userId, serverId, path
      );
    }
    return removed;
  }

  /** 服务器被删除时清理其快照，避免悬空数据。 */
  removeServer(userId: number, serverId: number): void {
    try {
      this.db.exec(
        'DELETE FROM file_snapshots WHERE user_id = ? AND server_id = ?',
        userId, serverId
      );
    } catch {
      /* 清理失败不影响服务器删除本身 */
    }
  }

  /** 该用户当前快照总占用（UI 展示存储用量）。 */
  usage(userId: number): { count: number; bytes: number } {
    const row = this.query<{ count: number; bytes: number | null }>(
      'SELECT COUNT(*) AS count, SUM(size) AS bytes FROM file_snapshots WHERE user_id = ?',
      userId
    )[0];
    return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
  }
}

export { SNAPSHOT_MAX_BYTES };
