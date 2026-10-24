import { describe, expect, it } from 'vitest';
import {
  credentialKindMatchesAuthMethod,
  isCredentialKind,
  normalizeCredentialInput,
  CREDENTIAL_COMMENT_MAX_LENGTH,
  CREDENTIAL_KINDS,
  CREDENTIAL_MAX_COUNT,
  CREDENTIAL_NAME_MAX_LENGTH,
  CREDENTIAL_SECRET_MAX_LENGTH,
} from '../src/credential-schema';

describe('credential-schema 校验', () => {
  it('常量符合产品约定', () => {
    expect(CREDENTIAL_MAX_COUNT).toBe(100);
    expect(CREDENTIAL_NAME_MAX_LENGTH).toBe(50);
    expect(CREDENTIAL_COMMENT_MAX_LENGTH).toBe(200);
    expect(CREDENTIAL_SECRET_MAX_LENGTH).toBe(16384);
    expect(CREDENTIAL_KINDS).toEqual(['password', 'publickey']);
  });

  it('通过合法输入并去除首尾空白', () => {
    expect(normalizeCredentialInput('  生产密钥  ', 'publickey', '  KEY  ')).toEqual({
      ok: true,
      value: { name: '生产密钥', kind: 'publickey', secret: 'KEY', comment: '' },
    });
    expect(
      normalizeCredentialInput('生产密钥', 'publickey', 'KEY', '  备注  ')
    ).toEqual({
      ok: true,
      value: { name: '生产密钥', kind: 'publickey', secret: 'KEY', comment: '备注' },
    });
  });

  it('保留 PEM 内部换行，只裁剪整体首尾空白', () => {
    const pem = '\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
    const result = normalizeCredentialInput('k', 'publickey', pem);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 内部换行必须原样保留，否则还原出的私钥无法解析。
    expect(result.value.secret).toContain('\nb3BlbnNzaC1rZXktdjEAAAAA\n');
    expect(result.value.secret.startsWith('-----BEGIN')).toBe(true);
    expect(result.value.secret.endsWith('-----')).toBe(true);
  });

  it('名称必填且非空白', () => {
    expect(normalizeCredentialInput('', 'password', 'x')).toEqual({
      ok: false,
      error: 'nameRequired',
    });
    expect(normalizeCredentialInput('   ', 'password', 'x')).toEqual({
      ok: false,
      error: 'nameRequired',
    });
    expect(normalizeCredentialInput(null as unknown as string, 'password', 'x')).toEqual({
      ok: false,
      error: 'nameRequired',
    });
  });

  it('类型必须是 password 或 publickey，其他值一律拒绝', () => {
    for (const bad of ['', 'totp', 'key', 'PASSWORD', null, 42]) {
      expect(normalizeCredentialInput('n', bad, 'x')).toEqual({
        ok: false,
        error: 'kindRequired',
      });
      expect(isCredentialKind(bad)).toBe(false);
    }
    expect(isCredentialKind('password')).toBe(true);
    expect(isCredentialKind('publickey')).toBe(true);
  });

  it('凭据正文必填且非空白', () => {
    expect(normalizeCredentialInput('n', 'password', '')).toEqual({
      ok: false,
      error: 'secretRequired',
    });
    expect(normalizeCredentialInput('n', 'password', '   ')).toEqual({
      ok: false,
      error: 'secretRequired',
    });
    expect(normalizeCredentialInput('n', 'password', undefined)).toEqual({
      ok: false,
      error: 'secretRequired',
    });
  });

  it('长度上限按 Unicode 码点计数', () => {
    expect(normalizeCredentialInput('a'.repeat(51), 'password', 'x')).toEqual({
      ok: false,
      error: 'nameTooLong',
    });
    expect(normalizeCredentialInput('a'.repeat(50), 'password', 'x').ok).toBe(true);
    // 多字节字符不应被按字节长度误判。
    expect(normalizeCredentialInput('密'.repeat(50), 'password', 'x').ok).toBe(true);
    expect(normalizeCredentialInput('密'.repeat(51), 'password', 'x')).toEqual({
      ok: false,
      error: 'nameTooLong',
    });

    expect(normalizeCredentialInput('n', 'password', 'k'.repeat(16385))).toEqual({
      ok: false,
      error: 'secretTooLong',
    });
    expect(normalizeCredentialInput('n', 'password', 'k'.repeat(16384)).ok).toBe(true);
  });

  it('备注可选，超长拒绝', () => {
    expect(normalizeCredentialInput('n', 'password', 'x', undefined).ok).toBe(true);
    expect(normalizeCredentialInput('n', 'password', 'x', null).ok).toBe(true);
    expect(normalizeCredentialInput('n', 'password', 'x', 'a'.repeat(201))).toEqual({
      ok: false,
      error: 'commentTooLong',
    });
    expect(normalizeCredentialInput('n', 'password', 'x', 123)).toEqual({
      ok: false,
      error: 'commentTooLong',
    });
  });

  it('凭据类型与服务器认证方式必须一一对应', () => {
    expect(credentialKindMatchesAuthMethod('password', 'password')).toBe(true);
    expect(credentialKindMatchesAuthMethod('publickey', 'publickey')).toBe(true);
    expect(credentialKindMatchesAuthMethod('password', 'publickey')).toBe(false);
    expect(credentialKindMatchesAuthMethod('publickey', 'password')).toBe(false);
  });
});
