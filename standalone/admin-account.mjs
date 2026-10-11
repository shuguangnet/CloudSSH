import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const validUsername = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{1,63}$/.test(value);
export class AdminAccount {
  constructor(directory, env) {
    this.file = join(directory, 'admin-account.json');
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validUsername(saved.username) || typeof saved.passwordHash !== 'string') throw new Error('Invalid administrator account file');
      env.ADMIN_USERNAME = saved.username;
      env.ADMIN_PASSWORD_HASH = saved.passwordHash;
    } else if (env.ADMIN_PASSWORD_HASH) {
      env.ADMIN_USERNAME = env.ADMIN_USERNAME || 'admin';
      if (!validUsername(env.ADMIN_USERNAME)) throw new Error('Invalid ADMIN_USERNAME');
      this.save(env.ADMIN_USERNAME, env.ADMIN_PASSWORD_HASH);
    }
    this.env = env;
  }
  save(username, passwordHash) {
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ username, passwordHash }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  update(username, passwordHash) {
    this.save(username, passwordHash);
    this.env.ADMIN_USERNAME = username;
    this.env.ADMIN_PASSWORD_HASH = passwordHash;
  }
}
