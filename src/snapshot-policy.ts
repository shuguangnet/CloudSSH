/**
 * 配置快照共享契约（Worker / 前端 / UserDBDO 三方一致）。
 *
 * 快照用于「改坏配置能回滚」：SFTP 覆盖写入与在线编辑保存之前，
 * 先把远端旧内容留档，用户可以按路径查看历史版本并恢复。
 *
 * 与 `sftp-upload-policy.ts` 同样是纯常量 + 纯函数，不含运行时依赖，
 * 因此可以被 Worker、浏览器与 Node（standalone）共同引用。
 */

/** 单份快照最大字节数：与在线编辑上限一致（EDITOR_MAX_FILE_SIZE = 2MiB）。 */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** 每条 (user, server, path) 保留的历史份数；超出后淘汰最旧。 */
export const SNAPSHOT_KEEP_PER_PATH = 10;

/** 每个用户全部路径合计的快照份数上限；超出后全局淘汰最旧。 */
export const SNAPSHOT_KEEP_PER_USER = 200;

/** 单次列表查询返回的最大条数（防御性上限，正常远小于此值）。 */
export const SNAPSHOT_LIST_MAX = 50;

/** 快照来源：区分是谁触发了留档，便于审计与 UI 展示。 */
export type SnapshotKind = 'upload' | 'edit' | 'restore' | 'delete';

export const SNAPSHOT_KINDS: readonly SnapshotKind[] = ['upload', 'edit', 'restore', 'delete'];

export function isSnapshotKind(value: unknown): value is SnapshotKind {
  return typeof value === 'string' && (SNAPSHOT_KINDS as readonly string[]).includes(value);
}

/**
 * 允许留档的路径校验：必须是绝对 POSIX 路径，且不含 NUL。
 * 快照按路径字符串做归属隔离，路径本身不做规范化（远端语义由 SSH 决定），
 * 只做「不能是相对路径 / 不能为空 / 不能过长」的基础约束。
 */
export const SNAPSHOT_MAX_PATH_LENGTH = 4096;

export function isValidSnapshotPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SNAPSHOT_MAX_PATH_LENGTH &&
    value.startsWith('/') &&
    !value.includes('\0')
  );
}

/**
 * 内容是否值得留档：二进制内容同样留档（回滚二进制配置并不罕见），
 * 但超过 SNAPSHOT_MAX_BYTES 的文件不留档——快照是「配置回滚」而非「备份系统」，
 * 大文件归档应由远端自身的备份机制承担。
 */
export function shouldSnapshot(size: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= SNAPSHOT_MAX_BYTES;
}

/**
 * 快照内容跨 Worker/DO 边界传输的 base64 编解码。
 *
 * 用 base64 而非 ArrayBuffer：DO stub 的 fetch 走 JSON 请求体，
 * 而快照可能是任意二进制（证书、keystore），JSON 无法直接携带字节。
 * 单份上限 SNAPSHOT_MAX_BYTES = 2MiB，编码后约 2.7MB，在请求体限制内。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // 分块拼接：一次性 apply 整个数组会在文件较大时溢出调用栈。
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 解码失败（非 base64 / 非字符串）返回 null，由调用方按 400 处理。 */
export function base64ToBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
