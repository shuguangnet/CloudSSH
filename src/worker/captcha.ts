/**
 * 自包含图片字符验证码（替代 Cloudflare Turnstile，零外部依赖零出网请求）。
 *
 * 设计：
 * - `GET /api/captcha/challenge` 下发渲染好的字符验证码 SVG 与 HMAC 签名的
 *   挑战串；**答案明文绝不进入载荷**（载荷可被 base64 解码，存的是
 *   `sha256(nonce:answer)` 摘要），响应 JSON 也不回显。
 * - 登录请求携带 `{ challenge, answer }`；服务端校验签名、有效期、单次使用
 *   与答案摘要恒时比对（大小写不敏感）。
 * - **答错同样消耗挑战**（防止同一张图反复暴力猜测），前端在失败后自动换图。
 * - 签名密钥从 ADMIN_PASSWORD_HASH 派生（管理员换密即全灭未决挑战），
 *   Workers 与 standalone（经 dist/worker.mjs）运行时行为一致。
 * - 单次使用为进程内 LRU（Workers 多 isolate 不共享，属尽力而为；真实防线
 *   仍是 PBKDF2 恒时比对 + 登录节流）。验证码定位为轻量机器人摩擦而非强证明。
 *
 * 历史注记：v2.6.3–v2.6.4 曾用滑块拼图形态，真实用户拖拽（高刷屏慢速对齐/
 * 快速甩动/视觉对齐策略）与脚本画像差异导致多轮"真人必拒"返工，最终按用户
 * 决策改为图片字符验证码——输入框无坐标歧义、移动端零手势依赖。v2.6.5
 * 首版字符集仍含 G/6、Z/2、S/5、B/8、U/V、T/7 等互混对 + 旋转 ±13° + 双
 * 干扰线，真实用户误读必 missed；本版按可读性优先收紧（见 CAPTCHA_ALPHABET）。
 *
 * 环境变量 `CAPTCHA_MODE`：
 * - `on`（默认）：随机答案；
 * - `off`：完全停用（挑战端点 501、登录不校验）；
 * - `test`：固定答案 `TESTS`，供自动化测试求解（部署方可控的显式测试缝）。
 */

/** 逻辑图片宽度（px，客户端按容器等比缩放） */
export const CAPTCHA_WIDTH = 180;
/** 逻辑图片高度 */
export const CAPTCHA_HEIGHT = 52;
/** 答案长度（4 位：输入负担最小；20^4=16 万组合，配合答错即消耗 +
 *  挑战限流 10/min + 登录 DO 节流，暴力不可行，摩擦定位不变） */
const CAPTCHA_ANSWER_LENGTH = 4;
/** 答案字符集：仅保留互不混淆的 20 个字符（全大写显示；比对大小写不敏感）。
 *  已剔除易混淆对：B/8、G/6、Z/2、S/5、T/7、X/K、Y/4、U/V（留 V）、
 *  P/D-R 近形（留 D R 去 P）、Q/O/0、I/1/l；数字仅 3（与 E 可辨：E 三横
 *  平直，3 圆弧开口）。v2.6.5 首版含上述互混对致真实用户误读必 missed。 */
const CAPTCHA_ALPHABET = 'ACDEFGHJKLMNRSTVW3';
/** 提交答案的合法形态（trim + 转大写后） */
const CAPTCHA_ANSWER_PATTERN = /^[A-Z0-9]{4,10}$/;
/** test 模式固定答案（自动化测试缝；docker-smoke / e2e / solveCaptcha 依赖） */
export const CAPTCHA_TEST_ANSWER = 'TESTS';
/** 挑战有效期（毫秒） */
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
/** 单次使用缓存容量（进程内） */
const CONSUMED_CACHE_MAX = 4096;

/** 解析后的运行模式 */
export type CaptchaMode = 'on' | 'off' | 'test';

export interface EnvLike {
  ADMIN_PASSWORD_HASH?: string;
  CAPTCHA_MODE?: string;
}

export interface CaptchaChallengeResponse {
  challenge: string;
  /** 渲染好的验证码 SVG（同源自渲染内容，前端 innerHTML 注入） */
  image: string;
  width: number;
  height: number;
}

export interface CaptchaProof {
  challenge?: unknown;
  answer?: unknown;
}

export interface CaptchaVerifyResult {
  ok: boolean;
  reason?: 'disabled' | 'malformed' | 'expired' | 'consumed' | 'missed';
}

export function resolveCaptchaMode(env: EnvLike): CaptchaMode {
  const raw = env.CAPTCHA_MODE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'test') return raw;
  return 'on';
}

/** 验证码是否参与密码登录防线（off 或未配置密码哈希时不参与） */
export function captchaActiveFor(env: EnvLike): boolean {
  return resolveCaptchaMode(env) !== 'off' && !!env.ADMIN_PASSWORD_HASH?.trim();
}

/** 恒时字节比较（等长比对，不短路） */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array | null {
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 从管理员密码哈希派生签名密钥（换密码即轮换密钥） */
async function captchaSigningKey(env: EnvLike): Promise<CryptoKey | null> {
  const hash = env.ADMIN_PASSWORD_HASH?.trim();
  if (!hash) return null;
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`captcha:${hash}`));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(key: CryptoKey, payload: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** 确定性 PRNG（mulberry32）：同一 nonce 生成同一干扰背景，便于测试断言 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function randomAnswer(): string {
  let answer = '';
  for (let i = 0; i < CAPTCHA_ANSWER_LENGTH; i++) {
    answer += CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)];
  }
  return answer;
}

/**
 * 答案摘要：`sha256("captcha-answer:<nonce>:<ANSWER>")` 前 32 hex。
 * nonce 参与散列使相同答案在不同挑战下摘要不同；明文答案不进入载荷
 * （挑战串可被 base64 解码，回显/内嵌明文等于零摩擦绕过）。
 */
async function answerDigest(nonce: string, answer: string): Promise<string> {
  return (await sha256Hex(`captcha-answer:${nonce}:${answer}`)).slice(0, 32);
}

/** 渲染验证码 SVG：渐变底 + 折线/噪点干扰 + 逐字符随机旋转/偏移/颜色 */
function renderCaptchaSvg(answer: string, seed: number): string {
  const rand = mulberry32(seed);
  const palette = ['#7dd3fc', '#c4b5fd', '#6ee7b7', '#fcd34d', '#f9a8d4', '#fdba74'];

  let noise = '';
  // 一条淡折线横穿（干扰读图但不破坏字形：opacity 0.10，远低于字符对比度）
  {
    const y1 = 6 + rand() * 40;
    const points = [`M-4 ${y1.toFixed(1)}`];
    let x = 12 + rand() * 20;
    while (x < CAPTCHA_WIDTH + 8) {
      points.push(`L${x.toFixed(1)} ${(4 + rand() * 44).toFixed(1)}`);
      x += 16 + rand() * 22;
    }
    noise += `<path d="${points.join(' ')}" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="1.1"/>`;
  }
  // 少量噪点
  for (let i = 0; i < 14; i++) {
    noise += `<circle cx="${(rand() * CAPTCHA_WIDTH).toFixed(1)}" cy="${(rand() * CAPTCHA_HEIGHT).toFixed(1)}" r="${(0.6 + rand() * 1.2).toFixed(1)}" fill="#ffffff" opacity="${(0.06 + rand() * 0.06).toFixed(2)}"/>`;
  }

  // 逐字符渲染：等距分布 + 轻微纵向偏移 / 旋转 / 字号 / 颜色（可读性优先：
  // 旋转 ±8° 与纵向 ±3px 足以打散 OCR 直读，又不让人眼误判字形）
  const step = CAPTCHA_WIDTH / CAPTCHA_ANSWER_LENGTH;
  let chars = '';
  for (let i = 0; i < answer.length; i++) {
    const cx = step * i + step / 2;
    const cy = CAPTCHA_HEIGHT / 2 + 6 + (rand() - 0.5) * 6;
    const rotate = ((rand() - 0.5) * 16).toFixed(1);
    const fontSize = 28 + Math.round(rand() * 5);
    const fill = palette[Math.floor(rand() * palette.length)];
    chars +=
      `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" transform="rotate(${rotate} ${cx.toFixed(1)} ${cy.toFixed(1)})" ` +
      `font-family="'Courier New', ui-monospace, monospace" font-size="${fontSize}" font-weight="700" text-anchor="middle" fill="${fill}">${answer[i]}</text>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" viewBox="0 0 ${CAPTCHA_WIDTH} ${CAPTCHA_HEIGHT}">` +
    '<defs>' +
    '<linearGradient id="cap" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#141b26"/><stop offset="1" stop-color="#1d2a3a"/>' +
    '</linearGradient>' +
    '</defs>' +
    `<rect width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" fill="url(#cap)"/>` +
    noise +
    chars +
    '</svg>'
  );
}

/** 进程内单次使用缓存：签名指纹 → 过期时间 */
const consumedChallenges = new Map<string, number>();

function markConsumed(signatureHex: string, exp: number): void {
  if (consumedChallenges.size >= CONSUMED_CACHE_MAX) {
    const now = Date.now();
    for (const [key, expiry] of consumedChallenges) {
      if (expiry <= now) consumedChallenges.delete(key);
    }
    if (consumedChallenges.size >= CONSUMED_CACHE_MAX) {
      consumedChallenges.delete(consumedChallenges.keys().next().value as string);
    }
  }
  consumedChallenges.set(signatureHex, exp);
}

interface ParsedChallenge {
  digest: string;
  exp: number;
  nonce: string;
  signatureHex: string;
}

async function parseChallenge(env: EnvLike, challenge: string): Promise<ParsedChallenge | null> {
  if (typeof challenge !== 'string' || challenge.length > 512 || !challenge.includes('.')) return null;
  const [payloadB64, signatureB64] = challenge.split('.');
  if (!payloadB64 || !signatureB64) return null;
  const payloadBytes = base64UrlDecode(payloadB64);
  const signature = base64UrlDecode(signatureB64);
  if (!payloadBytes || !signature || signature.length !== 32) return null;

  const key = await captchaSigningKey(env);
  if (!key) return null;

  const parts = new TextDecoder().decode(payloadBytes).split('|');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const digest = parts[1];
  const exp = Number(parts[2]);
  const nonce = parts[3];
  if (!/^[a-f0-9]{32}$/.test(digest) || !Number.isFinite(exp) || !/^[a-f0-9]{16}$/.test(nonce)) {
    return null;
  }

  const expected = await hmac(key, new TextDecoder().decode(payloadBytes));
  if (!timingSafeEqual(signature, expected)) return null;
  return { digest, exp, nonce, signatureHex: toHex(signature) };
}

/**
 * 下发新挑战。返回 null 表示验证码不可用（off / 未配置密码哈希）。
 */
export async function issueCaptchaChallenge(env: EnvLike): Promise<CaptchaChallengeResponse | null> {
  const mode = resolveCaptchaMode(env);
  if (mode === 'off') return null;
  const key = await captchaSigningKey(env);
  if (!key) return null;

  const answer = mode === 'test' ? CAPTCHA_TEST_ANSWER : randomAnswer();
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const exp = Date.now() + CAPTCHA_TTL_MS;
  const digest = await answerDigest(nonce, answer);

  const payload = `v1|${digest}|${exp}|${nonce}`;
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const signatureB64 = base64UrlEncode(await hmac(key, payload));

  return {
    challenge: `${payloadB64}.${signatureB64}`,
    image: renderCaptchaSvg(answer, parseInt(nonce.slice(0, 8), 16)),
    width: CAPTCHA_WIDTH,
    height: CAPTCHA_HEIGHT,
  };
}

/**
 * 校验登录提交的验证码证明。任何失败均返回 ok:false（不区分原因给调用方以外信息）。
 * 答案错误同样消耗挑战（markConsumed），防止同一张图反复暴力猜测。
 */
export async function verifyCaptcha(env: EnvLike, proof: CaptchaProof): Promise<CaptchaVerifyResult> {
  if (resolveCaptchaMode(env) === 'off') return { ok: true, reason: 'disabled' };
  const parsed = await parseChallenge(env, typeof proof.challenge === 'string' ? proof.challenge : '');
  if (!parsed) return { ok: false, reason: 'malformed' };

  const now = Date.now();
  if (parsed.exp <= now) return { ok: false, reason: 'expired' };
  if (consumedChallenges.has(parsed.signatureHex)) return { ok: false, reason: 'consumed' };

  const answer = typeof proof.answer === 'string' ? proof.answer.trim().toUpperCase() : '';
  const ok = CAPTCHA_ANSWER_PATTERN.test(answer) &&
    timingSafeEqual(new TextEncoder().encode(await answerDigest(parsed.nonce, answer)), new TextEncoder().encode(parsed.digest));

  // 对错都消耗：每张图只允许一次猜测（前端失败后自动换新图）
  markConsumed(parsed.signatureHex, parsed.exp);
  return ok ? { ok: true } : { ok: false, reason: 'missed' };
}
