/**
 * 单管理员密码登录 —— 浏览器端 PBKDF2 预拉伸（server relief）。
 *
 * Workers Free 套餐每次调用仅有 10ms CPU 预算，服务端跑高强度 KDF 必然超限；
 * 因此 PBKDF2 在浏览器本地执行（用户自己的 CPU，迭代强度不受限），仅提交
 * 拉伸后的 32 字节密钥，Worker 侧只做一次 SHA-256 + 恒时比对。
 * 原始密码永不离开浏览器；参数（盐/迭代数）来自 /api/config 公开下发，
 * 与 `scripts/hash-password.mjs` 的生成口径保持一致。
 */

import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';

function b64urlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** 拉伸后密钥长度（字节），与服务端 verifier（SHA-256 输入）一致 */
export const STRETCHED_KEY_BYTES = 32;

/** 合理迭代数边界（防异常参数把浏览器卡死）；下界与服务端 parseAdminPasswordHash 一致 */
export const MIN_ITERATIONS = 1000;
export const MAX_ITERATIONS = 10_000_000;

/** 生成器默认迭代数（OWASP 对 PBKDF2-HMAC-SHA256 的推荐下限）；与 scripts/hash-password.mjs 默认值一致 */
export const DEFAULT_HASH_ITERATIONS = 600000;

/** 生成器最小密码长度；与 scripts/hash-password.mjs 默认值一致 */
export const MIN_PASSWORD_LENGTH = 10;

/** 生成器盐长度（字节）；与 scripts/hash-password.mjs 一致 */
const SALT_BYTES = 16;

/**
 * 用 /api/config 下发的参数拉伸管理员密码。
 * 返回 base64url 编码的 32 字节拉伸密钥（作为登录请求体 key 字段提交）。
 */
export async function stretchAdminPassword(
  password: string,
  saltB64url: string,
  iterations: number
): Promise<string> {
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('Invalid KDF iterations');
  }
  const salt = b64urlToBytes(saltB64url);
  if (salt.length < 8) throw new Error('Invalid KDF salt');

  // Some embedded/older browsers expose subtle but reject PBKDF2 operations.
  // Keep the same local derivation when native Web Crypto is unavailable.
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const baseKey = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
        baseKey, STRETCHED_KEY_BYTES * 8
      );
      return bytesToB64url(new Uint8Array(bits));
    } catch {
      // No credentials leave the browser until local derivation succeeds.
    }
  }
  const stretched = await pbkdf2Async(sha256, new TextEncoder().encode(password), salt, {
    c: iterations, dkLen: STRETCHED_KEY_BYTES, asyncTick: 10,
  });
  return bytesToB64url(stretched);
}

/**
 * 管理员密码哈希生成器（浏览器内本地执行，Dashboard-only 部署无需本地 Node 工具）。
 *
 * 产出 `pbkdf2$sha256$<iterations>$<salt-b64url>$<verifier-b64url>`，与服务端
 * `parseAdminPasswordHash`、登录预拉伸 `stretchAdminPassword`、
 * `scripts/hash-password.mjs` 四方口径对齐：
 * verifier = SHA-256(PBKDF2-HMAC-SHA256(password, salt, iterations, 32B))。
 * 随机盐每次生成；原始密码不离开浏览器。
 */
export async function buildAdminPasswordHash(
  password: string,
  iterations: number = DEFAULT_HASH_ITERATIONS
): Promise<string> {
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('Invalid KDF iterations');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const stretchedB64url = await stretchAdminPassword(password, bytesToB64url(salt), iterations);
  const stretched = b64urlToBytes(stretchedB64url);
  const verifier = typeof crypto !== 'undefined' && crypto.subtle
    ? new Uint8Array(await crypto.subtle.digest('SHA-256', stretched))
    : sha256(stretched);
  return `pbkdf2$sha256$${iterations}$${bytesToB64url(salt)}$${bytesToB64url(verifier)}`;
}
