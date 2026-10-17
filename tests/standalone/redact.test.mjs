import assert from 'node:assert/strict';
import test from 'node:test';

import { createRedaction, redactValue } from '../../standalone/redact.mjs';

// ==================== 单值脱敏 ====================

test('PEM 私钥块被整体脱敏', () => {
  const pem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  const result = redactValue(`key=${pem}`);
  assert.equal(result.redacted, 1);
  assert.ok(!result.value.includes('b3BlbnNzaC1rZXktdjE'), '私钥内容不能残留');
  assert.ok(result.value.includes('私钥已脱敏'));
});

test('RSA / EC / PGP 各变体私钥都识别', () => {
  for (const label of ['RSA', 'EC', 'DSA', 'PGP']) {
    const pem = `-----BEGIN ${label} PRIVATE KEY-----\nSECRETDATA\n-----END ${label} PRIVATE KEY-----`;
    const result = redactValue(pem);
    assert.equal(result.redacted, 1, `${label} 私钥未脱敏`);
    assert.ok(!result.value.includes('SECRETDATA'));
  }
});

test('Bearer token 脱敏', () => {
  const result = redactValue('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.ok(result.redacted >= 1);
  assert.ok(!result.value.includes('eyJhbGciOiJIUzI1NiJ9.payload.sig'));
});

test('KEY=VALUE 形态的口令脱敏', () => {
  for (const text of [
    'API_KEY=sk-live-abcdef123456',
    'password=hunter2',
    'PASSWORD: hunter2',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI',
    'DB_PASSWORD=p@ssw0rd!',
  ]) {
    const result = redactValue(text);
    assert.ok(result.redacted >= 1, `未脱敏：${text}`);
    assert.ok(result.value.includes('***'), `未替换：${result.value}`);
  }
});

test('连接串口令脱敏但保留用户名与主机', () => {
  const result = redactValue('postgres://admin:s3cret@db.internal:5432/app');
  assert.equal(result.redacted, 1);
  assert.ok(result.value.includes('admin'), '用户名应保留，便于排查');
  assert.ok(result.value.includes('db.internal:5432'), '主机应保留');
  assert.ok(!result.value.includes('s3cret'), '口令不能残留');
});

test('各协议连接串都覆盖', () => {
  for (const [text, secret] of [
    ['mysql://u:pass1@h:3306/d', 'pass1'],
    ['redis://u:pass2@h:6379/0', 'pass2'],
    ['mongodb+srv://u:pass3@h/d', 'pass3'],
    ['rediss://u:pass4@h:6380', 'pass4'],
    ['amqp://u:pass5@h:5672', 'pass5'],
  ]) {
    const result = redactValue(text);
    assert.ok(!result.value.includes(secret), `${text} 的口令未脱敏`);
  }
});

test('sk- 风格密钥脱敏', () => {
  const result = redactValue('token: sk-proj-abcdefghijklmnop123456');
  assert.ok(!result.value.includes('sk-proj-abcdefghijklmnop123456'));
});

test('GitHub token 脱敏', () => {
  const result = redactValue('GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz');
  assert.ok(!result.value.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz'));
});

test('JWT 脱敏', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const result = redactValue(`cookie=${jwt}`);
  assert.ok(!result.value.includes('dozjgNryP4J3jVmNHl0w5N'), 'JWT 未脱敏');
});

// ==================== 不该误伤的内容 ====================

test('普通文本不被改动', () => {
  for (const text of [
    'hello world',
    'user@example.com',
    'SELECT * FROM users',
    '2026-10-17T15:30:00Z',
    'https://example.com/path?q=1',
    '这是一段中文说明',
  ]) {
    const result = redactValue(text);
    assert.equal(result.redacted, 0, `误伤：${text} → ${result.value}`);
    assert.equal(result.value, text);
  }
});

test('非字符串值原样返回', () => {
  for (const value of [null, undefined, 42, 3.14, true, false, new Date('2026-01-01T00:00:00Z')]) {
    const result = redactValue(value);
    assert.equal(result.redacted, 0);
    assert.equal(result.value, value);
  }
});

test('空字符串不产生脱敏', () => {
  const result = redactValue('');
  assert.equal(result.redacted, 0);
  assert.equal(result.value, '');
});

// ==================== 累计计数器 ====================

test('createRedaction 累计多行命中次数', () => {
  const redaction = createRedaction();
  assert.equal(redaction.count, 0);

  redaction.redact('API_KEY=aaa');
  assert.equal(redaction.count, 1);

  redaction.redact('password=bbb');
  assert.equal(redaction.count, 2);

  // 同一行多处命中应各自计数
  redaction.redact('API_KEY=ccc password=ddd');
  assert.equal(redaction.count, 4);

  // 未命中的值不增加计数
  redaction.redact('plain text');
  assert.equal(redaction.count, 4);
});

test('createRedaction 返回值已脱敏', () => {
  const redaction = createRedaction();
  const out = redaction.redact('password=hunter2');
  assert.ok(!String(out).includes('hunter2'));
  assert.equal(redaction.count, 1);
});

test('重复调用不会因为正则状态而漏检', () => {
  // 全局正则有 lastIndex 状态，复用模式串时必须每轮重置。
  const redaction = createRedaction();
  for (let index = 0; index < 5; index += 1) {
    const out = redaction.redact('API_KEY=secret-value');
    assert.ok(!String(out).includes('secret-value'), `第 ${index + 1} 次漏检`);
  }
  assert.equal(redaction.count, 5);
});
