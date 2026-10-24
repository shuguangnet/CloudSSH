/**
 * 配置快照前端 API 客户端。
 *
 * 与 Worker 的 `/api/snapshots` 路由对应，仅做 HTTP 读写与形状校验；
 * 会话内的回滚动作走 WebSocket（`sftp_snapshot_restore`），因为需要复用
 * 已经就绪的 SFTP 通道——跨会话回滚需要新建 SSH 链，不在当前范围内。
 */

import { isSnapshotKind, type SnapshotKind } from '../../src/snapshot-policy';

export type SnapshotMeta = {
  id: number;
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  kind: SnapshotKind;
  created_at: number;
};

export type SnapshotPathSummary = SnapshotMeta;
export type SnapshotUsage = { count: number; bytes: number };

/** 列表接口返回形状不可信（后端版本可能不同），逐字段校验后再交给 UI。 */
function parseMeta(value: unknown): SnapshotMeta | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.id) || typeof row.path !== 'string') return null;
  return {
    id: row.id as number,
    path: row.path,
    size: Number.isFinite(row.size) ? Number(row.size) : 0,
    sha256: typeof row.sha256 === 'string' ? row.sha256 : '',
    mtime: Number.isFinite(row.mtime) ? Number(row.mtime) : -1,
    kind: isSnapshotKind(row.kind) ? row.kind : 'upload',
    created_at: Number.isFinite(row.created_at) ? Number(row.created_at) : 0,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 读取某路径的版本历史。失败时返回空数组（UI 按「无历史」降级展示）。 */
export async function fetchSnapshots(
  serverId: number,
  path: string
): Promise<SnapshotMeta[]> {
  try {
    const qs = new URLSearchParams({ server_id: String(serverId), path });
    const res = await fetch(`/api/snapshots?${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const body = await readJson(res);
    const list = Array.isArray(body?.snapshots) ? body.snapshots : [];
    return list.map(parseMeta).filter((item): item is SnapshotMeta => item !== null);
  } catch {
    return [];
  }
}

/** 读取该服务器上所有有快照的路径摘要 + 用量。 */
export async function fetchSnapshotPaths(
  serverId: number
): Promise<{ snapshots: SnapshotPathSummary[]; usage: SnapshotUsage }> {
  try {
    const qs = new URLSearchParams({ server_id: String(serverId), mode: 'paths' });
    const res = await fetch(`/api/snapshots?${qs}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { snapshots: [], usage: { count: 0, bytes: 0 } };
    const body = await readJson(res);
    const list = Array.isArray(body?.snapshots) ? body.snapshots : [];
    const usage = (body?.usage ?? {}) as Record<string, unknown>;
    return {
      snapshots: list.map(parseMeta).filter((item): item is SnapshotMeta => item !== null),
      usage: {
        count: Number.isFinite(usage.count) ? Number(usage.count) : 0,
        bytes: Number.isFinite(usage.bytes) ? Number(usage.bytes) : 0,
      },
    };
  } catch {
    return { snapshots: [], usage: { count: 0, bytes: 0 } };
  }
}

/** 读取单份快照内容（base64 解码为字节）。用于「预览差异」与本地确认。 */
export async function fetchSnapshotContent(
  serverId: number,
  id: number
): Promise<{ path: string; bytes: Uint8Array } | null> {
  try {
    const qs = new URLSearchParams({ server_id: String(serverId), id: String(id) });
    const res = await fetch(`/api/snapshots/content?${qs}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await readJson(res);
    if (typeof body?.path !== 'string' || typeof body?.content_base64 !== 'string') return null;
    const binary = atob(body.content_base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { path: body.path, bytes };
  } catch {
    return null;
  }
}

/** 删除单份快照。 */
export async function deleteSnapshot(serverId: number, id: number): Promise<boolean> {
  try {
    const res = await fetch('/api/snapshots', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: serverId, id }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 清空某服务器全部快照（服务器卸载 / 用户主动清理）。 */
export async function clearSnapshots(serverId: number): Promise<boolean> {
  try {
    const res = await fetch('/api/snapshots', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: serverId, all: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
