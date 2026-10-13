/**
 * 可复用凭据（Credentials）共享校验模式。
 *
 * Worker（/api/credentials → UserDBDO）与前端（表单预校验）共用同一套限额与校验，
 * 保证「拒绝的输入」在前后端一致，避免用户提交后才被服务端驳回。
 *
 * 安全边界：本模块**只做形状与长度校验**，不解析、不回显密钥内容。
 * 明文凭据仅存在于 UserDBDO 内部的解密瞬间，任何路由都不会把它发回客户端。
 */

/** 每个用户最多保存的凭据数量。 */
export const CREDENTIAL_MAX_COUNT = 100;
/** 凭据名称最大长度（Unicode 码点）。 */
export const CREDENTIAL_NAME_MAX_LENGTH = 50;
/** 备注最大长度（Unicode 码点）。 */
export const CREDENTIAL_COMMENT_MAX_LENGTH = 200;
/**
 * 密钥/密码正文最大长度。留足空间容纳 16384 位 RSA 私钥与 PEM 头尾，
 * 同时避免单行塞入超大载荷。
 */
export const CREDENTIAL_SECRET_MAX_LENGTH = 16384;

/** 凭据类型：密码或公钥认证用的私钥。 */
export const CREDENTIAL_KINDS = ['password', 'publickey'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === 'string' && (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

export type CredentialValidationError =
  | 'nameRequired'
  | 'nameTooLong'
  | 'kindRequired'
  | 'secretRequired'
  | 'secretTooLong'
  | 'commentTooLong';

export interface NormalizedCredentialInput {
  name: string;
  kind: CredentialKind;
  secret: string;
  comment: string;
}

export type CredentialInputResult =
  | { ok: true; value: NormalizedCredentialInput }
  | { ok: false; error: CredentialValidationError };

/**
 * 校验并规范化凭据输入：名称、类型、正文必填，备注可选。
 *
 * 密钥正文**不 trim 尾部以外的内容**：PEM 内部的换行与缩进必须原样保留，
 * 否则还原出的私钥会解析失败。这里只去掉整体首尾空白（粘贴时常见的多余换行）。
 * 长度按 Unicode 码点计数，避免多字节字符被字节长度误判。
 */
export function normalizeCredentialInput(
  name: unknown,
  kind: unknown,
  secret: unknown,
  comment?: unknown
): CredentialInputResult {
  if (typeof name !== 'string') return { ok: false, error: 'nameRequired' };
  const trimmedName = name.trim();
  if (!trimmedName) return { ok: false, error: 'nameRequired' };
  if ([...trimmedName].length > CREDENTIAL_NAME_MAX_LENGTH) {
    return { ok: false, error: 'nameTooLong' };
  }

  if (!isCredentialKind(kind)) return { ok: false, error: 'kindRequired' };

  if (typeof secret !== 'string') return { ok: false, error: 'secretRequired' };
  const trimmedSecret = secret.trim();
  if (!trimmedSecret) return { ok: false, error: 'secretRequired' };
  if ([...trimmedSecret].length > CREDENTIAL_SECRET_MAX_LENGTH) {
    return { ok: false, error: 'secretTooLong' };
  }

  let trimmedComment = '';
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== 'string') return { ok: false, error: 'commentTooLong' };
    trimmedComment = comment.trim();
    if ([...trimmedComment].length > CREDENTIAL_COMMENT_MAX_LENGTH) {
      return { ok: false, error: 'commentTooLong' };
    }
  }

  return {
    ok: true,
    value: { name: trimmedName, kind, secret: trimmedSecret, comment: trimmedComment },
  };
}

/**
 * 判断给定凭据类型是否与服务器的认证方式匹配。
 * 服务器认证方式是 `password` / `publickey`，与凭据类型一一对应；
 * 不匹配时拒绝保存，避免出现「密码凭据挂在密钥认证的服务器上」这种连接必失败的配置。
 */
export function credentialKindMatchesAuthMethod(
  kind: CredentialKind,
  authMethod: string
): boolean {
  return kind === authMethod;
}
