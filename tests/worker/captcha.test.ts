import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_TEST_ANSWER,
  captchaActiveFor,
  issueCaptchaChallenge,
  resolveCaptchaMode,
  verifyCaptcha,
  type CaptchaProof,
} from '../../src/worker/captcha';

/** 测试密码哈希(任意非空即可,签名密钥只做派生源) */
const PASSWORD_HASH = 'pbkdf2:100000:salt=abcdefgh:hash=0123456789abcdef0123456789abcdef';
/** base64url 解码挑战载荷 */
function decodePayload(challenge: string): string {
  const payload = challenge.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(payload + '='.repeat((4 - (payload.length % 4)) % 4), 'base64').toString('utf8');
}

function otherEnv(): { ADMIN_PASSWORD_HASH: string } {
  // 不同哈希 → 不同签名密钥
  return { ADMIN_PASSWORD_HASH: 'pbkdf2:100000:salt=zzzzzzzz:hash=ffffffffffffffffffffffffffffffff' };
}

describe('captcha mode resolution', () => {
  it('defaults to on', () => {
    expect(resolveCaptchaMode({})).toBe('on');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'on' })).toBe('on');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'ON' })).toBe('on');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'unknown' })).toBe('on');
  });

  it('honors off and test', () => {
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'off' })).toBe('off');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'OFF' })).toBe('off');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: ' test ' })).toBe('test');
  });

  it('active unless off or unconfigured password', () => {
    expect(captchaActiveFor({ ADMIN_PASSWORD_HASH: PASSWORD_HASH })).toBe(true);
    expect(captchaActiveFor({ ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'test' })).toBe(true);
    expect(captchaActiveFor({ ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'off' })).toBe(false);
    expect(captchaActiveFor({})).toBe(false);
    expect(captchaActiveFor({ ADMIN_PASSWORD_HASH: '  ' })).toBe(false);
  });
});

describe('issueCaptchaChallenge', () => {
  it('returns image challenge fields', async () => {
    const challenge = await issueCaptchaChallenge({ ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'test' });
    expect(challenge).not.toBeNull();
    expect(challenge!.challenge).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(challenge!.image).toContain('<svg');
    expect(challenge!.width).toBe(160);
    expect(challenge!.height).toBe(48);
  });

  it('renders exactly the test answer in test mode', async () => {
    const challenge = await issueCaptchaChallenge({ ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'test' });
    // 逐字符存在(text-anchor 逐字符渲染)
    for (const ch of CAPTCHA_TEST_ANSWER) {
      expect(challenge!.image).toContain(`>${ch}</text>`);
    }
  });

  it('never embeds the plaintext answer in the challenge payload', async () => {
    // 关键安全属性:载荷可被 base64 解码,答案只能以 sha256 摘要形式存在
    const challenge = await issueCaptchaChallenge({ ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'test' });
    const payload = decodePayload(challenge!.challenge);
    expect(payload).toMatch(/^v1\|[a-f0-9]{32}\|\d+\|[a-f0-9]{16}$/);
    expect(payload).not.toContain(CAPTCHA_TEST_ANSWER);
  });

  it('issues unique nonces (distinct images) per challenge', async () => {
    const env = { ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'test' };
    const a = await issueCaptchaChallenge(env);
    const b = await issueCaptchaChallenge(env);
    expect(a!.challenge).not.toBe(b!.challenge);
    const nonceA = decodePayload(a!.challenge).split('|')[3];
    const nonceB = decodePayload(b!.challenge).split('|')[3];
    expect(nonceA).not.toBe(nonceB);
  });

  it('returns null when disabled or unconfigured', async () => {
    expect(await issueCaptchaChallenge({ ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'off' })).toBeNull();
    expect(await issueCaptchaChallenge({})).toBeNull();
  });
});

describe('verifyCaptcha', () => {
  const env = { ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'test' };

  async function freshChallenge(): Promise<string> {
    return (await issueCaptchaChallenge(env))!.challenge;
  }

  it('accepts the correct answer', async () => {
    const proof: CaptchaProof = { challenge: await freshChallenge(), answer: CAPTCHA_TEST_ANSWER };
    expect(await verifyCaptcha(env, proof)).toEqual({ ok: true });
  });

  it('is case-insensitive and trims surrounding whitespace', async () => {
    const proof: CaptchaProof = { challenge: await freshChallenge(), answer: ` ${CAPTCHA_TEST_ANSWER.toLowerCase()} ` };
    expect(await verifyCaptcha(env, proof)).toEqual({ ok: true });
  });

  it('rejects a wrong answer with reason missed', async () => {
    const proof: CaptchaProof = { challenge: await freshChallenge(), answer: 'WRONG' };
    const result = await verifyCaptcha(env, proof);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missed');
  });

  it('rejects missing or malformed answer', async () => {
    const challenge = await freshChallenge();
    for (const answer of ['', '   ', 'ab', 'x'.repeat(20)]) {
      const result = await verifyCaptcha(env, { challenge, answer });
      // malformed(不符形态)与 missed(格式合法但摘要不符)都属拒绝
      expect(result.ok).toBe(false);
    }
  });

  it('consumes the challenge after a wrong answer (anti-brute-force)', async () => {
    const challenge = await freshChallenge();
    const first = await verifyCaptcha(env, { challenge, answer: 'WRONG' });
    expect(first.reason).toBe('missed');
    // 同一张图第二次提交 —— 即使答对也拒绝
    const second = await verifyCaptcha(env, { challenge, answer: CAPTCHA_TEST_ANSWER });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('consumed');
  });

  it('consumes the challenge after success (single use)', async () => {
    const challenge = await freshChallenge();
    expect(await verifyCaptcha(env, { challenge, answer: CAPTCHA_TEST_ANSWER })).toEqual({ ok: true });
    const second = await verifyCaptcha(env, { challenge, answer: CAPTCHA_TEST_ANSWER });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('consumed');
  });

  it('rejects a tampered payload', async () => {
    const challenge = await freshChallenge();
    const [payload, signature] = challenge.split('.');
    // 篡改摘要段(改为摘要全 0)后签名必然失配
    const forged = `${payload.slice(0, 3)}${'0'.repeat(32)}${payload.slice(35)}.${signature}`;
    const result = await verifyCaptcha(env, { challenge: forged, answer: CAPTCHA_TEST_ANSWER });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('rejects a challenge signed with a different key', async () => {
    const foreign = (await issueCaptchaChallenge({ ...otherEnv(), CAPTCHA_MODE: 'test' }))!;
    const result = await verifyCaptcha(env, { challenge: foreign.challenge, answer: CAPTCHA_TEST_ANSWER });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it('rejects an expired challenge', async () => {
    const challenge = await issueCaptchaChallenge(env);
    advanceClock(5 * 60 * 1000 + 1000);
    const result = await verifyCaptcha(env, { challenge: challenge!.challenge, answer: CAPTCHA_TEST_ANSWER });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('returns disabled-ok when off', async () => {
    const result = await verifyCaptcha({ ADMIN_PASSWORD_HASH: PASSWORD_HASH, CAPTCHA_MODE: 'off' }, {});
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('disabled');
  });
});

// ---------- 时间控制辅助(轻量 Date.now 覆盖,避免 fakeTimers 与 WebCrypto 异步交织) ----------
let clockOffset = 0;
const realNow = Date.now.bind(Date);

function advanceClock(ms: number): void {
  clockOffset += ms;
  Date.now = () => realNow() + clockOffset;
}

afterEach(() => {
  clockOffset = 0;
  Date.now = realNow;
});
