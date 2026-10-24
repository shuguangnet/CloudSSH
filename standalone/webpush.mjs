// Web Push (RFC 8030/8291/8292) in pure node:crypto — no external dependencies.
//
// - generateVapidKeys(): P-256 keypair, publicKey is the raw 65-byte uncompressed
//   point as base64url (what the browser expects as applicationServerKey).
// - encryptPushPayload(): aes128gcm content coding against the subscription's
//   p256dh/auth secrets (RFC 8291), single 4096-byte record.
// - buildVapidHeader(): ES256 JWT with the ieee-p1363 signature encoding (RFC 8292).
// - webpushSend(): POST the encrypted body to the push service endpoint.

import {
  createCipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const B64URL = /^[\w-]+$/;

export function b64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function assertB64Url(value, what) {
  if (typeof value !== 'string' || !B64URL.test(value) || value.length < 16 || value.length > 512) {
    throw new Error(`Invalid ${what}`);
  }
  return Buffer.from(value, 'base64url');
}

/** Generate a VAPID identity: { publicKey, privateKey } (base64url + jwk-encoded private key). */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rawPoint = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const jwk = privateKey.export({ type: 'jwk', format: 'jwk' });
  return { publicKey: b64urlEncode(rawPoint), privateKey: b64urlEncode(JSON.stringify(jwk)) };
}

export function parseVapidPrivate(privateKey) {
  const raw = assertB64Url(privateKey, 'VAPID private key');
  const jwk = JSON.parse(raw.toString('utf8'));
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('VAPID private key is not P-256');
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

function importSubscriptionKey(p256dh) {
  const raw = assertB64Url(p256dh, 'p256dh subscription key');
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('p256dh key must be an uncompressed P-256 point');
  return createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

const hkdfExpand = (prk, info, length) =>
  createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);

/** RFC 8291 §3.4 aes128gcm payload encryption（单记录，rs=4096）。 */
export function encryptPushPayload(payload, { p256dh, auth, salt = randomBytes(16), ephemeralKeys = null }) {
  if (payload.length > 3993) throw new Error('Push payload too large');
  const authSecret = assertB64Url(auth, 'auth secret');
  const uaKey = importSubscriptionKey(p256dh);
  const uaPublicPoint = rawPointOf(uaKey);
  // 同一个临时密钥既参与 ECDH，也以明文点形式嵌入头部 idlen 字段（RFC 8291 §4）。
  const asKeys = ephemeralKeys || generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const asPublicPoint = rawPointOf(asKeys.publicKey);
  const ecdhSecret = diffieHellman({ privateKey: asKeys.privateKey, publicKey: uaKey });

  // 阶段 1：组合共享秘密与认证秘密（HKDF-Extract + Expand）
  const prkKey = createHmac('sha256', authSecret).update(ecdhSecret).digest();
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info'), Buffer.from([0]), uaPublicPoint, asPublicPoint,
  ]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  // 阶段 2：RFC 8188 密钥/nonce 派生（salt 为头部里随密文传输的 16 字节随机值）
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const cek = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0])]), 16);
  const nonce = hkdfExpand(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0])]), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 单记录：明文后追加 0x02 填充分隔符（RFC 8291 §4）
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final()]);
  // salt(16) + rs(4, 4096) + idlen(1, 65) + 临时公钥点(65) = 86 字节头部
  const header = Buffer.alloc(86);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = 65;
  asPublicPoint.copy(header, 21);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

function rawPointOf(publicKey) {
  const point = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('Expected an uncompressed P-256 point');
  return point;
}

/** Build the Authorization: vapid header value for an endpoint. */
export function buildVapidHeader(endpoint, vapid, subject = 'mailto:admin@cloudssh.local') {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject };
  const data = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(claims))}`;
  const key = parseVapidPrivate(vapid.privateKey);
  const signature = cryptoSign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return { header: `vapid t=${data}.${b64urlEncode(signature)}, k=${vapid.publicKey}`, aud };
}

/**
 * Deliver a Web Push notification. Returns { ok: true, status }.
 * Throws with status 404/410 → the browser unsubscribed; the channel should be removed.
 */
export async function webpushSend(subscription, { title, body, tag }, vapid) {
  const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint : '';
  if (!/^https:\/\/[^\s]{10,2000}$/.test(endpoint)) throw new Error('Invalid push endpoint');
  assertB64Url(subscription.keys?.p256dh, 'p256dh subscription key');
  assertB64Url(subscription.keys?.auth, 'auth secret');

  const payload = Buffer.from(JSON.stringify({ title: String(title).slice(0, 200), body: String(body).slice(0, 800), tag: String(tag || 'cloudssh').slice(0, 64) }));
  const encrypted = encryptPushPayload(payload, { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });
  const { header } = buildVapidHeader(endpoint, vapid);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: header,
      TTL: '3600',
      Urgency: 'normal',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
    body: encrypted,
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404 || response.status === 410) {
    throw Object.assign(new Error(`Push subscription expired (HTTP ${response.status})`), { expired: true });
  }
  if (!response.ok) throw new Error(`Push service returned HTTP ${response.status}`);
  return { ok: true, status: response.status };
}
