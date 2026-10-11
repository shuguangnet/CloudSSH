import { afterEach, describe, expect, it, vi } from 'vitest';
import { pbkdf2Sync, createHash } from 'node:crypto';
import { stretchAdminPassword, buildAdminPasswordHash } from '../frontend/src/password-stretch';
import { randomUUID } from '../frontend/src/random-id';

const browserCrypto = globalThis.crypto;
afterEach(() => vi.unstubAllGlobals());

function insecureContext() {
  vi.stubGlobal('crypto', { getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) });
}

describe('public HTTP browser crypto compatibility', () => {
  it('derives the same password key and verifier without Web Crypto', async () => {
    insecureContext();
    const password = 'HTTP 密码 🔑';
    const salt = Buffer.from('0123456789abcdef');
    const expected = pbkdf2Sync(password, salt, 1000, 32, 'sha256');
    expect(await stretchAdminPassword(password, salt.toString('base64url'), 1000))
      .toBe(expected.toString('base64url'));
    const hash = await buildAdminPasswordHash(password, 1000);
    const [, , iterations, encodedSalt, verifier] = hash.split('$');
    const derived = pbkdf2Sync(password, Buffer.from(encodedSalt, 'base64url'), Number(iterations), 32, 'sha256');
    expect(verifier).toBe(createHash('sha256').update(derived).digest('base64url'));
  });

  it('generates valid distinct UUIDs without the HTTPS-only randomUUID API', () => {
    insecureContext();
    const ids = Array.from({ length: 50 }, () => randomUUID());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
