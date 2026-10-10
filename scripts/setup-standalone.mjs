#!/usr/bin/env node
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pbkdf2Sync, createHash, randomBytes } from 'node:crypto';

process.umask(0o077);
const directory = resolve(process.env.DATA_DIR || './data');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = join(directory, 'admin-password-hash');
if (existsSync(file) || process.env.ADMIN_PASSWORD_HASH ||
    (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)) {
  console.log('Authentication already configured; no password changed.');
  process.exit(0);
}
let password;
if (process.argv.includes('--stdin')) {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > 1024) throw new Error('Password input too long');
  }
  password = data.split(/\r?\n/)[0];
  if (password.length < 12 || password.length > 256) throw new Error('Use a password of 12–256 characters');
} else {
  password = randomBytes(18).toString('base64url');
}
const salt = randomBytes(16);
const stretched = pbkdf2Sync(password, salt, 600000, 32, 'sha256');
const verifier = createHash('sha256').update(stretched).digest('base64url');
writeFileSync(file, `pbkdf2$sha256$600000$${salt.toString('base64url')}$${verifier}\n`, { mode: 0o600, flag: 'wx' });
console.log('CloudSSH administrator authentication initialized.');
if (!process.argv.includes('--stdin')) console.log(`Administrator password (shown once): ${password}`);
console.log('Save the password securely. The data directory stores only its verifier.');
