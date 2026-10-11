// Ed25519 keypair generation with OpenSSH-format serialization and idempotent deploy command.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const uint32 = (n) => { const buf = Buffer.alloc(4); buf.writeUInt32BE(n >>> 0); return buf; };
const sshString = (data) => Buffer.concat([uint32(data.length), data]);
const bytes = (text) => Buffer.from(text, 'utf8');

export function sanitizeComment(comment) {
  return String(comment ?? '').replace(/[^\w.@ -]/g, '').trim().slice(0, 64);
}

export function generateKeyPair(comment = '') {
  const cleanComment = sanitizeComment(comment);
  const { publicKey: rawPublicKey } = generateKeyPairSync('ed25519');
  const spki = rawPublicKey.export({ type: 'spki', format: 'der' });
  const keyBytes = spki.subarray(spki.length - 32);
  const pubBlob = Buffer.concat([sshString(bytes('ssh-ed25519')), sshString(keyBytes)]);

  // OpenSSH private key (v1, no encryption): checkint ×2, algorithm, pub, priv(seed+pub), comment, padding.
  const check = randomBytes(4);
  const privSection = Buffer.concat([
    check, check,
    sshString(bytes('ssh-ed25519')),
    sshString(keyBytes),
    sshString(Buffer.concat([keyBytes, keyBytes])),
    sshString(bytes(cleanComment)),
  ]);
  const padLen = 8 - (privSection.length % 8) || 8;
  const padding = Buffer.from(Array.from({ length: padLen }, (_, index) => index + 1));
  const inner = Buffer.concat([privSection, padding]);
  const privBlob = Buffer.concat([
    bytes('openssh-key-v1\0'),
    sshString(bytes('none')),
    sshString(bytes('none')),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(pubBlob),
    sshString(inner),
  ]);
  const base64 = privBlob.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n$/, '');
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const publicKeyLine = `ssh-ed25519 ${pubBlob.toString('base64')}${cleanComment ? ` ${cleanComment}` : ''}\n`;
  return { privateKey, publicKey: publicKeyLine };
}

const PUBLIC_KEY_LINE = /^(?:sk-)?(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|381|521)|ssh-dss) [A-Za-z0-9+/=]{40,}(?: [^\r\n]{0,64})?$/;

/** Validates one public key line, returning it trimmed without trailing newline. */
export function parsePublicKey(line) {
  const clean = String(line ?? '').split(/\r?\n/, 1)[0].trim();
  if (!PUBLIC_KEY_LINE.test(clean)) throw new Error('Invalid public key line');
  return clean;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** Idempotent ssh-copy-id style append to ~/.ssh/authorized_keys. */
export function deployCommand(publicKeyLine) {
  const line = parsePublicKey(publicKeyLine);
  const quoted = shellQuote(line);
  return [
    'umask 077',
    'mkdir -p ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 700 ~/.ssh',
    `grep -qxF ${quoted} ~/.ssh/authorized_keys || printf '%s\\n' ${quoted} >> ~/.ssh/authorized_keys`,
    'chmod 600 ~/.ssh/authorized_keys',
    'printf deployed',
  ].join('; ');
}
