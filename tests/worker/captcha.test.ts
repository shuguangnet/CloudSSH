import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTCHA_WIDTH,
  captchaActiveFor,
  issueCaptchaChallenge,
  resolveCaptchaMode,
  verifyCaptcha,
  type CaptchaProof,
} from '../../src/worker/captcha';

const ENV = { ADMIN_PASSWORD_HASH: 'pbkdf2$sha256$1000$' + 'a'.repeat(22) + '$' + 'b'.repeat(43) } as const;
const TEST_ENV = { ...ENV, CAPTCHA_MODE: 'test' };

function proofFor(challenge: string, x = 120, span = 500): CaptchaProof {
  const now = Date.now();
  return {
    challenge,
    x,
    samples: [
      { x: 10, t: now },
      { x: 45, t: now + span * 0.33 },
      { x: 85, t: now + span * 0.66 },
      { x: x, t: now + span },
    ],
  };
}

/** 高刷新率屏幕画像：慢速精细拖拽产生大量密集样本（120Hz+ 下 3 秒即 400+） */
function rampProof(challenge: string, count: number, durationMs: number, x = 120, from = 10): CaptchaProof {
  const now = Date.now();
  const samples = Array.from({ length: count }, (_, i) => ({
    x: +(from + ((x - from) * i) / (count - 1)).toFixed(2),
    t: now + Math.round((durationMs * i) / (count - 1)),
  }));
  return { challenge, x, samples };
}

describe('滑块验证码 — 模式解析与启用门', () => {
  it('CAPTCHA_MODE 解析：off/test 显式，其余（含未配置/未知值）回退 on', () => {
    expect(resolveCaptchaMode({})).toBe('on');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'off' })).toBe('off');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'OFF' })).toBe('off');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'test' })).toBe('test');
    expect(resolveCaptchaMode({ CAPTCHA_MODE: 'bogus' })).toBe('on');
  });

  it('captchaActiveFor：off 或未配置密码哈希时不启用', () => {
    expect(captchaActiveFor({ ADMIN_PASSWORD_HASH: 'x' })).toBe(true);
    expect(captchaActiveFor({ ADMIN_PASSWORD_HASH: 'x', CAPTCHA_MODE: 'off' })).toBe(false);
    expect(captchaActiveFor({ CAPTCHA_MODE: 'test' })).toBe(false);
    expect(captchaActiveFor({})).toBe(false);
  });
});

describe('滑块验证码 — 挑战下发', () => {
  it('off / 无密码哈希 → null', async () => {
    expect(await issueCaptchaChallenge({ CAPTCHA_MODE: 'off' })).toBeNull();
    expect(await issueCaptchaChallenge({})).toBeNull();
  });

  it('test 模式：完整字段 + 服务端渲染 SVG + 噪声确定性', async () => {
    const first = await issueCaptchaChallenge(TEST_ENV);
    const second = await issueCaptchaChallenge(TEST_ENV);
    expect(first).not.toBeNull();
    expect(first?.challenge).toContain('.');
    expect(first?.background).toContain('<svg');
    expect(first?.piece).toContain('<svg');
    expect(first?.width).toBe(CAPTCHA_WIDTH);
    expect(first?.startX).toBe(10);
    expect(first?.y).toBe(48);
    // 同签名载荷 → 挑战串一致；nonce 不同则背景噪声不同
    expect(second?.challenge).not.toBe(first?.challenge);
    expect(second?.background).not.toBe(first?.background);
  });

  it('默认模式目标 X 分布在可拖区间内（不含明文目标字段）', async () => {
    for (let i = 0; i < 8; i++) {
      const challenge = await issueCaptchaChallenge({ ...ENV });
      expect(challenge).not.toBeNull();
      // y 与尺寸下发给前端渲染，目标 X 仅隐含在 SVG translate 与签名载荷内
      expect(challenge!.y).toBeGreaterThanOrEqual(28);
      expect(challenge!.y).toBeLessThanOrEqual(140 - 56 - 44 + 28);
    }
  });
});

describe('滑块验证码 — 证明校验', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('合法轨迹 → ok', async () => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    const result = await verifyCaptcha(TEST_ENV, proofFor(challenge!.challenge));
    expect(result.ok).toBe(true);
  });

  it('单次使用：重放同一证明 → consumed', async () => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    const proof = proofFor(challenge!.challenge);
    expect((await verifyCaptcha(TEST_ENV, proof)).ok).toBe(true);
    const replay = await verifyCaptcha(TEST_ENV, proof);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('consumed');
  });

  it('终点超出容差 → missed', async () => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    const result = await verifyCaptcha(TEST_ENV, proofFor(challenge!.challenge, 90));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missed');
  });

  it('容差边界：|x-targetX| ≤ 8 通过，≥ 10 拒绝', async () => {
    const within = await issueCaptchaChallenge(TEST_ENV);
    expect((await verifyCaptcha(TEST_ENV, proofFor(within!.challenge, 128))).ok).toBe(true);
    const beyond = await issueCaptchaChallenge(TEST_ENV);
    expect((await verifyCaptcha(TEST_ENV, proofFor(beyond!.challenge, 130))).reason).toBe('missed');
  });

  it('高刷屏慢速精细拖拽（300+ 密集样本/3s）→ ok（旧 256 上限会误拒认真用户）', async () => {
    const challengeA = await issueCaptchaChallenge(TEST_ENV);
    expect((await verifyCaptcha(TEST_ENV, rampProof(challengeA!.challenge, 300, 3000))).ok).toBe(true);
    const challengeB = await issueCaptchaChallenge(TEST_ENV);
    expect((await verifyCaptcha(TEST_ENV, rampProof(challengeB!.challenge, 500, 4000))).ok).toBe(true);
  });

  it('快速人类甩动（6 样本/100ms）→ ok（旧 120ms 下限会误拒快甩用户）', async () => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    expect((await verifyCaptcha(TEST_ENV, rampProof(challenge!.challenge, 6, 100))).ok).toBe(true);
  });

  it('伪造/篡改挑战 → malformed', async () => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    const parts = challenge!.challenge.split('.');
    const forged = `${parts[0].slice(0, -2)}xx.${parts[1]}`;
    const result = await verifyCaptcha(TEST_ENV, proofFor(forged));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
    expect((await verifyCaptcha(TEST_ENV, {})).reason).toBe('malformed');
    expect((await verifyCaptcha(TEST_ENV, { challenge: 'garbage', x: 1, samples: [] })).reason).toBe('malformed');
  });

  it('过期挑战 → expired', async () => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const result = await verifyCaptcha(TEST_ENV, proofFor(challenge!.challenge));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('换 ADMIN_PASSWORD_HASH → 旧挑战签名失效', async () => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    const rotated = { ...TEST_ENV, ADMIN_PASSWORD_HASH: 'pbkdf2$sha256$1000$' + 'c'.repeat(22) + '$' + 'd'.repeat(43) };
    const result = await verifyCaptcha(rotated, proofFor(challenge!.challenge));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed');
  });

  it.each([
    ['样本过少', (p: CaptchaProof) => ({ ...p, samples: (p.samples as Array<{ x: number; t: number }>).slice(0, 2) })],
    ['时长过短（脚本瞬移，< 60ms）', (p: CaptchaProof) => proofFor(p.challenge as string, 120, 40)],
    ['时长超限（挂机）', (p: CaptchaProof) => proofFor(p.challenge as string, 120, 60_000)],
    ['样本数超限（> 512）', (p: CaptchaProof) => rampProof(p.challenge as string, 513, 3000)],
    ['时间戳回退', (p: CaptchaProof) => ({ ...p, samples: [...((p.samples as Array<{ x: number; t: number }>).slice(0, 2)), { x: 120, t: 0 }] })],
    ['全程同一 X（无拖拽位移）', (p: CaptchaProof) => ({ ...p, samples: (p.samples as Array<{ x: number; t: number }>).map((s, i) => ({ x: 10, t: 1000 + i * 150 })) })],
    ['末帧与终点不一致', (p: CaptchaProof) => ({ ...p, samples: [...((p.samples as Array<{ x: number; t: number }>).slice(0, 3)), { x: 95, t: 4000 }] })],
  ])('轨迹行为异常（%s）→ bad-trajectory', async (_name, mutate) => {
    const challenge = await issueCaptchaChallenge(TEST_ENV);
    const proof = mutate(proofFor(challenge!.challenge));
    const result = await verifyCaptcha(TEST_ENV, proof);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-trajectory');
  });

  it('CAPTCHA_MODE=off → 直接放行（部署方显式停用）', async () => {
    const result = await verifyCaptcha({ ...TEST_ENV, CAPTCHA_MODE: 'off' }, {});
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('disabled');
  });
});
