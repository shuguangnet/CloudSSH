/**
 * 可复用凭据库存储层（登录用户）。
 *
 * 设计要点：
 * - **仅登录用户可用**：凭据必须由服务端 AES-256-GCM 加密保存。这里刻意不提供
 *   localStorage 降级——把私钥明文写进浏览器存储会悄悄降低安全等级，而用户
 *   只会看到“能用”，不会意识到差别。匿名用户由 UI 引导使用服务器内嵌凭据。
 * - 列表只含元数据，**服务端从不回传 secret**；明文只能经 `reveal()` 显式
 *   按需取回，服务端会为每次调用留痕。
 * - `usageCount` 由服务端统计，用于删除保护提示与“复用 N 台”展示。
 */

import {
  normalizeCredentialInput,
  CREDENTIAL_COMMENT_MAX_LENGTH,
  CREDENTIAL_MAX_COUNT,
  CREDENTIAL_NAME_MAX_LENGTH,
  CREDENTIAL_SECRET_MAX_LENGTH,
  type CredentialKind,
  type CredentialValidationError,
} from '../../src/credential-schema';
import { t } from './i18n';

export interface StoredCredential {
  id: number;
  name: string;
  kind: CredentialKind;
  comment: string;
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export type CredentialErrorCode =
  | CredentialValidationError
  | 'limitReached'
  | 'notFound'
  | 'inUse'
  | 'kindConflict'
  | 'revealFailed'
  | 'network';

export class CredentialStoreError extends Error {
  constructor(
    public readonly code: CredentialErrorCode,
    /** 服务端给出的可读原因（引用冲突时会列出服务器名）。 */
    public readonly detail?: string
  ) {
    super(`Credential store error: ${code}`);
    this.name = 'CredentialStoreError';
  }
}

interface CredentialRow {
  id: number;
  name: string;
  kind: string;
  comment?: string | null;
  usage_count?: number | null;
  last_used_at?: number | null;
  created_at?: string;
  updated_at?: string;
}

function toCredential(row: CredentialRow): StoredCredential {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'password' ? 'password' : 'publickey',
    comment: row.comment ?? '',
    usageCount: Number(row.usage_count ?? 0),
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
  };
}

async function toStoreError(response: Response): Promise<CredentialStoreError> {
  let payload: { error?: string } = {};
  try {
    payload = (await response.json()) as { error?: string };
  } catch {
    /* 响应不是 JSON：退化为状态码判断 */
  }
  const raw = payload.error;
  if (response.status === 409) {
    // 服务端的引用冲突信息本身就是给用户看的（含服务器名），直接透传。
    return new CredentialStoreError('inUse', raw);
  }
  if (response.status === 404) return new CredentialStoreError('notFound');
  if (
    raw === 'nameRequired' ||
    raw === 'nameTooLong' ||
    raw === 'kindRequired' ||
    raw === 'secretRequired' ||
    raw === 'secretTooLong' ||
    raw === 'commentTooLong'
  ) {
    return new CredentialStoreError(raw);
  }
  if (raw === 'limitReached') return new CredentialStoreError('limitReached');
  // 密文解不开（例如加密密钥轮换后遗留的旧记录）不是网络问题，单独报。
  if (raw === 'decryptFailed') return new CredentialStoreError('revealFailed');
  // 服务端对「类型与在用服务器冲突」也走 409，但文案不同；
  // 此处按状态码已归入 inUse，detail 保留原始可读信息。
  return new CredentialStoreError('network');
}

/** 将存储层错误映射为面向用户的多语言提示。 */
export function credentialErrorMessage(error: unknown): string {
  if (error instanceof CredentialStoreError) {
    // 服务端提供了可读原因（例如“该凭据正被 web-1、web-2 使用”）时优先展示。
    if (error.detail) return error.detail;
    switch (error.code) {
      case 'nameRequired':
        return t('credential.error.nameRequired');
      case 'nameTooLong':
        return t('credential.error.nameTooLong', { max: CREDENTIAL_NAME_MAX_LENGTH });
      case 'kindRequired':
        return t('credential.error.kindRequired');
      case 'secretRequired':
        return t('credential.error.secretRequired');
      case 'secretTooLong':
        return t('credential.error.secretTooLong', { max: CREDENTIAL_SECRET_MAX_LENGTH });
      case 'commentTooLong':
        return t('credential.error.commentTooLong', { max: CREDENTIAL_COMMENT_MAX_LENGTH });
      case 'limitReached':
        return t('credential.error.limitReached', { max: CREDENTIAL_MAX_COUNT });
      case 'notFound':
        return t('credential.error.notFound');
      case 'revealFailed':
        return t('credential.revealFailed');
      case 'network':
        return t('credential.error.network');
      default:
        return t('credential.saveFailed');
    }
  }
  return t('credential.saveFailed');
}

export interface CredentialStore {
  list(): Promise<StoredCredential[]>;
  create(input: CredentialInput): Promise<StoredCredential>;
  update(id: number, input: CredentialInput): Promise<StoredCredential>;
  remove(id: number): Promise<void>;
  /** 按需取回明文。服务端会为每次调用留下审计记录。 */
  reveal(id: number): Promise<string>;
}

export interface CredentialInput {
  name: string;
  kind: CredentialKind;
  /** 留空表示保留原密钥（仅更新时有意义）。 */
  secret?: string;
  comment?: string;
}

export class RemoteCredentialStore implements CredentialStore {
  async list(): Promise<StoredCredential[]> {
    const response = await fetch('/api/credentials');
    if (!response.ok) throw await toStoreError(response);
    const rows = (await response.json()) as CredentialRow[];
    return Array.isArray(rows) ? rows.map(toCredential) : [];
  }

  async create(input: CredentialInput): Promise<StoredCredential> {
    const normalized = normalizeCredentialInput(
      input.name,
      input.kind,
      input.secret,
      input.comment
    );
    if (!normalized.ok) throw new CredentialStoreError(normalized.error);
    const response = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: normalized.value.name,
        kind: normalized.value.kind,
        secret: normalized.value.secret,
        comment: normalized.value.comment,
      }),
    });
    if (!response.ok) throw await toStoreError(response);
    return toCredential((await response.json()) as CredentialRow);
  }

  async update(id: number, input: CredentialInput): Promise<StoredCredential> {
    // 更新时 secret 可缺省（保留原密钥）；但一旦提供就必须通过完整校验。
    const hasSecret = typeof input.secret === 'string' && input.secret.trim().length > 0;
    const normalized = normalizeCredentialInput(
      input.name,
      input.kind,
      hasSecret ? input.secret : 'placeholder',
      input.comment
    );
    if (!normalized.ok) throw new CredentialStoreError(normalized.error);
    const body: Record<string, unknown> = {
      name: normalized.value.name,
      kind: normalized.value.kind,
      comment: normalized.value.comment,
    };
    if (hasSecret) body.secret = normalized.value.secret;
    const response = await fetch(`/api/credentials/${encodeURIComponent(String(id))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await toStoreError(response);
    return toCredential((await response.json()) as CredentialRow);
  }

  async remove(id: number): Promise<void> {
    const response = await fetch(`/api/credentials/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await toStoreError(response);
  }

  /**
   * 按需取回明文。
   *
   * 刻意不是列表的一部分：列表接口永远不带 secret，只有用户明确点「显示」时
   * 才走这个独立请求，服务端也会相应留痕。
   *
   * 明文只经返回值交给调用方，不写缓存、不落 localStorage。
   */
  async reveal(id: number): Promise<string> {
    const response = await fetch(`/api/credentials/${encodeURIComponent(String(id))}/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw await toStoreError(response);
    const payload = (await response.json()) as { secret?: unknown };
    return typeof payload.secret === 'string' ? payload.secret : '';
  }
}

/**
 * 纯函数：按认证方式过滤可用于某台服务器的凭据。
 * 服务器是密码认证时只应看到密码凭据，密钥认证时只应看到密钥凭据——
 * 选错类型连接必然失败，所以在选择阶段就挡掉。
 */
export function filterCredentialsByAuthMethod(
  credentials: StoredCredential[],
  authMethod: string
): StoredCredential[] {
  return credentials.filter((credential) => credential.kind === authMethod);
}
