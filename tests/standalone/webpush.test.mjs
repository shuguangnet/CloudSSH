// Web Push (RFC 8291/8292) unit tests:
// - encryption locked against the official RFC 8291 Appendix A vector
// - an independent WebCrypto-based decrypt cross-check
// - VAPID JWT signature verification with node's verify()
// - channel validation + end-to-end sendToChannels with a mocked push service
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildVapidHeader,
  encryptPushPayload,
  generateVapidKeys,
  parseVapidPrivate,
  webpushSend,
} from '../../standalone/webpush.mjs';
import { validateChannel, sendToChannels, setVapidProvider } from '../../standalone/notify.mjs';
import { AutomationStore } from '../../standalone/automation-store.mjs';

const b64u = (value) => Buffer.from(value.replace(/\s+/g, ''), 'base64url');
const b64uEncode = (buffer) => Buffer.from(buffer).toString('base64url');

// ---------- RFC 8291 Appendix A vector ----------
const RFC_PLAINTEXT = Buffer.from('When I grow up, I want to be a watermelon');
const RFC_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const RFC_SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const RFC_UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const RFC_AS_PUBLIC = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const RFC_AS_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const RFC_BODY = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

function keyPairFromVector() {
  const point = b64u(RFC_AS_PUBLIC);
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64uEncode(point.subarray(1, 33)),
    y: b64uEncode(point.subarray(33)),
    d: RFC_AS_PRIVATE,
  };
  return {
    privateKey: createPrivateKey({ key: jwk, format: 'jwk' }),
    publicKey: createPublicKey({ key: jwk, format: 'jwk' }),
  };
}

test('RFC 8291 Appendix A: encryption output matches the RFC byte for byte', () => {
  const body = encryptPushPayload(RFC_PLAINTEXT, {
    p256dh: RFC_UA_PUBLIC,
    auth: RFC_AUTH,
    salt: b64u(RFC_SALT),
    ephemeralKeys: keyPairFromVector(),
  });
  assert.equal(b64uEncode(body), RFC_BODY);
});

test('encryption roundtrip decrypts with an independent WebCrypto implementation', async () => {
  const plaintext = Buffer.from(JSON.stringify({ title: '⚠️ server down', body: 'probe failed', tag: 'cloudssh-alert' }));
  const authBytes = webcrypto.getRandomValues(new Uint8Array(16));
  const uaPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', uaPair.publicKey));
  const body = encryptPushPayload(plaintext, {
    p256dh: b64uEncode(uaPublicRaw),
    auth: b64uEncode(authBytes),
  });

  // Receiver side: parse header, ECDH(ua_priv, as_pub), RFC 8291 key schedule, AES-GCM decrypt.
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPoint = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen, -16);
  const tag = body.subarray(-16);

  const asPublic = await webcrypto.subtle.importKey('raw', asPoint, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'ECDH', public: asPublic }, uaPair.privateKey, 256));
  const prkKey = new Uint8Array(await webcrypto.subtle.sign('HMAC', await webcrypto.subtle.importKey('raw', authBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), ecdhSecret));
  // "WebPush: info" 长度 13 字节，后接 0x00 与两个 65 字节未压缩公钥点 = 144 字节
  const keyInfo = new Uint8Array(13 + 1 + 65 + 65);
  keyInfo.set(Buffer.from('WebPush: info'), 0); keyInfo[13] = 0;
  keyInfo.set(uaPublicRaw, 14); keyInfo.set(asPoint, 79);
  const ikm = new Uint8Array(await webcrypto.subtle.sign('HMAC', await webcrypto.subtle.importKey('raw', prkKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new Uint8Array([...keyInfo, 1])));
  const prk = new Uint8Array(await webcrypto.subtle.sign('HMAC', await webcrypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), ikm));
  const deriveWithInfo = async (label, length) => {
    // HKDF-Expand：HMAC(PRK, info || 0x01) 截取前 length 字节
    const info = new Uint8Array([...Buffer.from(label), 0, 1]);
    const mac = await webcrypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const out = new Uint8Array(await webcrypto.subtle.sign('HMAC', mac, info));
    return out.slice(0, length);
  };
  const cek = await deriveWithInfo('Content-Encoding: aes128gcm', 16);
  const nonce = await deriveWithInfo('Content-Encoding: nonce', 12);
  const aesKey = await webcrypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, Buffer.concat([ciphertext, tag])));
  const recovered = Buffer.from(padded.slice(0, -1)); // strip 0x02 delimiter
  assert.equal(recovered.toString('utf8'), plaintext.toString('utf8'));
});

// ---------- VAPID ----------

test('generated VAPID keys have the right shape and roundtrip', () => {
  const keys = generateVapidKeys();
  const raw = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
  const privateKey = parseVapidPrivate(keys.privateKey);
  assert.equal(privateKey.asymmetricKeyType, 'ec');
  const again = generateVapidKeys();
  assert.notEqual(again.publicKey, keys.publicKey);
});

test('VAPID header carries a verifiable ES256 JWT bound to the endpoint origin', async () => {
  const crypto = await import('node:crypto');
  const { verify } = crypto;
  const keys = generateVapidKeys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/some-token';
  const { header } = buildVapidHeader(endpoint, keys, 'mailto:ops@example.com');
  assert.match(header, /^vapid t=[\w.-]+, k=[\w-]+$/);
  const token = header.slice('vapid t='.length).split(', k=')[0];
  const [headerPart, claimsPart, signaturePart] = token.split('.');
  const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000);
  assert.equal(claims.sub, 'mailto:ops@example.com');
  assert.equal(JSON.parse(Buffer.from(headerPart, 'base64url').toString()).alg, 'ES256');

  // Verify the signature against the advertised public key (independent path).
  const point = Buffer.from(keys.publicKey, 'base64url');
  const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([prefix, point]), format: 'der', type: 'spki' });
  const data = Buffer.from(`${headerPart}.${claimsPart}`);
  const signature = Buffer.from(signaturePart, 'base64url');
  assert.equal(signature.length, 64); // ieee-p1363 raw r||s
  assert.ok(verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature));
});

// ---------- validation & dispatch ----------

test('validateChannel accepts well-formed webpush subscriptions and rejects malformed ones', () => {
  const good = validateChannel('webpush', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: b64uEncode(Buffer.alloc(65, 1)),
    auth: b64uEncode(Buffer.alloc(16, 2)),
  });
  assert.equal(good.type, 'webpush');
  assert.equal(good.config.endpoint, 'https://fcm.googleapis.com/fcm/send/abc');

  assert.throws(() => validateChannel('webpush', { endpoint: 'http://insecure.example/push', p256dh: b64uEncode(Buffer.alloc(65, 1)), auth: b64uEncode(Buffer.alloc(16, 2)) }), /https/);
  assert.throws(() => validateChannel('webpush', { endpoint: 'https://push.example/a', p256dh: 'short', auth: b64uEncode(Buffer.alloc(16, 2)) }), /p256dh/);
  assert.throws(() => validateChannel('webpush', { endpoint: 'https://push.example/a', p256dh: b64uEncode(Buffer.alloc(65, 1)), auth: 'x' }), /auth/);
});

test('webpushSend posts an encrypted body with VAPID auth and reports expiry', async () => {
  const keys = generateVapidKeys();
  const uaPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const subscription = {
    endpoint: 'https://push.example/sync/sub123',
    keys: {
      p256dh: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', uaPair.publicKey))),
      auth: b64uEncode(webcrypto.getRandomValues(new Uint8Array(16))),
    },
  };

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 201 };
  };
  try {
    const result = await webpushSend(subscription, { title: 'UP', body: 'host is down' }, keys);
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, subscription.endpoint);
    assert.match(requests[0].init.headers.Authorization, /^vapid t=/);
    assert.equal(requests[0].init.headers['Content-Encoding'], 'aes128gcm');
    assert.ok(Number(requests[0].init.headers.TTL) > 0);
    assert.ok(Buffer.isBuffer(requests[0].init.body));
    assert.equal(requests[0].init.body[20], 65); // idlen

    // 410 Gone：浏览器已退订，错误必须可被识别以便清理渠道。
    globalThis.fetch = async () => ({ ok: false, status: 410 });
    await assert.rejects(
      webpushSend(subscription, { title: 'x', body: 'y' }, keys),
      (error) => /expired/i.test(error.message) && error.expired === true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendToChannels dispatches webpush through the injected VAPID provider', async () => {
  const keys = generateVapidKeys();
  setVapidProvider(async () => keys);
  const uaPair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const subscription = {
    endpoint: 'https://push.example/sync/ch1',
    keys: {
      p256dh: b64uEncode(new Uint8Array(await webcrypto.subtle.exportKey('raw', uaPair.publicKey))),
      auth: b64uEncode(webcrypto.getRandomValues(new Uint8Array(16))),
    },
  };
  const channel = { id: 1, type: 'webpush', config: { endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 201 });
  try {
    const [result] = await sendToChannels([channel], { title: 't', body: 'b' });
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    setVapidProvider(null);
  }
});

test('webpush dispatch fails cleanly when no VAPID provider is configured', async () => {
  setVapidProvider(null);
  const channel = { id: 2, type: 'webpush', config: { endpoint: 'https://push.example/x', p256dh: b64uEncode(Buffer.alloc(65, 1)), auth: b64uEncode(Buffer.alloc(16, 3)) } };
  const [result] = await sendToChannels([channel], { title: 't', body: 'b' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
});

// ---------- persistence ----------

test('AutomationStore persists the VAPID identity across instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloudssh-webpush-'));
  try {
    const path = join(dir, 'automation.sqlite');
    const storeA = new AutomationStore(path);
    const keysA = storeA.getOrCreateVapid(generateVapidKeys);
    const keysA2 = storeA.getOrCreateVapid(generateVapidKeys);
    assert.equal(keysA2.publicKey, keysA.publicKey);

    const storeB = new AutomationStore(path);
    const keysB = storeB.getOrCreateVapid(generateVapidKeys);
    assert.equal(keysB.publicKey, keysA.publicKey);
    assert.equal(keysB.privateKey, keysA.privateKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
