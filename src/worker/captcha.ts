/**
 * 自包含滑块验证码（替代 Cloudflare Turnstile，零外部依赖零出网请求）。
 *
 * 设计：
 * - `GET /api/captcha/challenge` 下发拼图背景/滑块 SVG 与 HMAC 签名的挑战串；
 *   目标 X 坐标只存在于签名载荷内，响应 JSON 不回显（阻止直接回显绕过）。
 * - 登录请求携带 `{ challenge, x, samples:[{x,t}] }`；服务端校验签名、有效期、
 *   终点容差、拖拽轨迹（时长/样本数/离散度/终点一致）与单次使用。
 * - 签名密钥从 ADMIN_PASSWORD_HASH 派生（管理员换密即全灭未决挑战），
 *   Workers 与 standalone（经 dist/worker.mjs）运行时行为一致。
 * - 单次使用为进程内 LRU（Workers 多 isolate 不共享，属尽力而为；真实防线
 *   仍是 PBKDF2 恒时比对 + 登录节流）。滑块定位为轻量机器人摩擦而非强证明。
 *
 * 环境变量 `CAPTCHA_MODE`：
 * - `on`（默认）：随机目标；
 * - `off`：完全停用（挑战端点 501、登录不校验）；
 * - `test`：固定目标，供自动化测试求解（部署方可控的显式测试缝）。
 */

/** 逻辑画布宽度（px，客户端按容器等比缩放） */
export const CAPTCHA_WIDTH = 300;
/** 逻辑画布高度 */
export const CAPTCHA_HEIGHT = 140;
/** 拼图块边长 */
export const CAPTCHA_PIECE_SIZE = 44;
/** 圆角/凸起半径：拼图路径横向包围盒为 [0, size + PIECE_TAB_RADIUS] */
const PIECE_TAB_RADIUS = 9;
/** 滑块起始 X（左侧留白） */
export const CAPTCHA_START_X = 10;
/** 终点容差：拖动终点与目标 X 的最大偏差（人类在缩放画布上的对齐精度有限，
 *  形状同形修复后左缘对齐无歧义；8px ≈ 画布宽 2.7%，仍拒直接瞬移的脚本） */
const CAPTCHA_TOLERANCE = 8;
/** 挑战有效期（毫秒） */
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
/** 轨迹时长下/上限（毫秒）：过快为脚本瞬移、过慢为挂机重放。
 *  下限 60ms：人类快甩通常 ≥100ms，机器人瞬移 <10ms；原 120ms 会误伤快甩用户 */
const CAPTCHA_MIN_DRAG_MS = 60;
const CAPTCHA_MAX_DRAG_MS = 30 * 1000;
/** 轨迹样本数上下限。
 *  上限 512：高刷新率屏幕（120/144Hz）上 3 秒精细拖拽即可产生 400+ pointermove
 *  样本，原 256 会拒绝“越认真越失败”；前端另有 16ms 节流 + 160 抽稀双保险 */
const CAPTCHA_MIN_SAMPLES = 3;
const CAPTCHA_MAX_SAMPLES = 512;
/** test 模式固定目标（画布 40%） */
const CAPTCHA_TEST_TARGET_X = 120;
const CAPTCHA_TEST_TARGET_Y = 48;
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
  background: string;
  piece: string;
  width: number;
  height: number;
  pieceSize: number;
  startX: number;
  /** 拼图块的 Y 坐标（非机密；客户端据此纵向定位滑块图） */
  y: number;
}

export interface CaptchaProof {
  challenge?: unknown;
  x?: unknown;
  samples?: unknown;
}

export interface CaptchaVerifyResult {
  ok: boolean;
  reason?: 'disabled' | 'malformed' | 'bad-signature' | 'expired' | 'consumed' | 'missed' | 'bad-trajectory';
}

export function resolveCaptchaMode(env: EnvLike): CaptchaMode {
  const raw = env.CAPTCHA_MODE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'test') return raw;
  return 'on';
}

/** 滑块是否参与密码登录防线（off 或未配置密码哈希时不参与） */
export function captchaActiveFor(env: EnvLike): boolean {
  return resolveCaptchaMode(env) !== 'off' && !!env.ADMIN_PASSWORD_HASH?.trim();
}

/** 恒时字节比较（等长签名比对） */
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

/** 确定性 PRNG（mulberry32）：同一 nonce 生成同一噪声背景，便于测试断言 */
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

/** 拼图块路径：圆角方块 + 右侧外凸半圆凸起（缺口与滑块共用同一形状）。
 *  路径横向包围盒为 [0, size + r]（凸起超出方块），拼图 SVG 的 viewBox
 *  必须覆盖完整包围盒，否则凸起被裁剪 → 拼图（44px）与缺口（53px）不同形，
 *  视觉对齐产生系统性歧义（右缘对齐偏差 9px 必超容差） */
function piecePath(size: number): string {
  const r = PIECE_TAB_RADIUS; // 圆角/凸起半径
  const tabTop = size / 2 - r;
  const tabBottom = size / 2 + r;
  return [
    `M${r} 0`,
    `H${size - r}`,
    `A${r} ${r} 0 0 1 ${size} ${r}`,
    `V${tabTop}`,
    `A${r} ${r} 0 0 1 ${size} ${tabBottom}`,
    `V${size - r}`,
    `A${r} ${r} 0 0 1 ${size - r} ${size}`,
    `H${r}`,
    `A${r} ${r} 0 0 1 0 ${size - r}`,
    `V${r}`,
    `A${r} ${r} 0 0 1 ${r} 0`,
    'Z',
  ].join(' ');
}

/** 服务端渲染背景 SVG：渐变底 + 噪声几何形状 + 目标缺口（目标 X 仅在此隐式存在） */
function renderBackgroundSvg(targetX: number, targetY: number, seed: number): string {
  const rand = mulberry32(seed);
  const palette = ['#3b82f6', '#8b5cf6', '#06b6d4', '#f59e0b', '#10b981'];
  let shapes = '';
  for (let i = 0; i < 9; i++) {
    const kind = rand();
    const x = Math.round(rand() * CAPTCHA_WIDTH);
    const y = Math.round(rand() * CAPTCHA_HEIGHT);
    const color = palette[Math.floor(rand() * palette.length)];
    const opacity = (0.10 + rand() * 0.22).toFixed(2);
    if (kind < 0.45) {
      const r = Math.round(8 + rand() * 26);
      shapes += `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
    } else if (kind < 0.8) {
      const w = Math.round(14 + rand() * 46);
      const h = Math.round(10 + rand() * 30);
      const rotate = Math.round(rand() * 180);
      shapes += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="1.5" opacity="${opacity}" transform="rotate(${rotate} ${x} ${y})"/>`;
    } else {
      const x2 = Math.round(rand() * CAPTCHA_WIDTH);
      const y2 = Math.round(rand() * CAPTCHA_HEIGHT);
      shapes += `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1" opacity="${opacity}"/>`;
    }
  }
  // 点阵网格（细纹理，增强拼图对齐的视觉参照）
  let dots = '';
  for (let gx = 15; gx < CAPTCHA_WIDTH; gx += 30) {
    for (let gy = 15; gy < CAPTCHA_HEIGHT; gy += 28) {
      dots += `<circle cx="${gx}" cy="${gy}" r="1" fill="#ffffff" opacity="0.10"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" viewBox="0 0 ${CAPTCHA_WIDTH} ${CAPTCHA_HEIGHT}">` +
    '<defs>' +
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#141b26"/><stop offset="1" stop-color="#1d2a3a"/>' +
    '</linearGradient>' +
    '</defs>' +
    `<rect width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" fill="url(#bg)"/>` +
    dots +
    shapes +
    // 目标缺口（同 piece 形状）
    `<g transform="translate(${targetX} ${targetY})">` +
    `<path d="${piecePath(CAPTCHA_PIECE_SIZE)}" fill="rgba(0,0,0,0.48)" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>` +
    `<path d="${piecePath(CAPTCHA_PIECE_SIZE)}" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="3" transform="translate(0 1.5)"/>` +
    '</g>' +
    '</svg>'
  );
}

/** 服务端渲染滑块 SVG（半透明白块 + 描边 + 投影，浅/深主题均可读）。
 *  viewBox 覆盖完整路径包围盒（含右侧凸起），与缺口形状严格一致 */
export function renderPieceSvg(): string {
  const bboxWidth = CAPTCHA_PIECE_SIZE + PIECE_TAB_RADIUS;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bboxWidth}" height="${CAPTCHA_PIECE_SIZE}" viewBox="0 0 ${bboxWidth} ${CAPTCHA_PIECE_SIZE}">` +
    `<path d="${piecePath(CAPTCHA_PIECE_SIZE)}" fill="rgba(255,255,255,0.82)" stroke="#e2e8f0" stroke-width="1.5"/>` +
    `<path d="${piecePath(CAPTCHA_PIECE_SIZE)}" fill="none" stroke="rgba(15,23,42,0.35)" stroke-width="1" transform="translate(0 1)"/>` +
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
  targetX: number;
  y: number;
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
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const targetX = Number(parts[1]);
  const y = Number(parts[2]);
  const exp = Number(parts[3]);
  const nonce = parts[4];
  if (
    !Number.isFinite(targetX) || !Number.isFinite(y) || !Number.isFinite(exp) ||
    !/^[a-f0-9]{16}$/.test(nonce)
  ) {
    return null;
  }

  const expected = await hmac(key, new TextDecoder().decode(payloadBytes));
  if (!timingSafeEqual(signature, expected)) return null;
  return { targetX, y, exp, nonce, signatureHex: toHex(signature) };
}

/**
 * 下发新挑战。返回 null 表示验证码不可用（off / 未配置密码哈希）。
 */
export async function issueCaptchaChallenge(env: EnvLike): Promise<CaptchaChallengeResponse | null> {
  const mode = resolveCaptchaMode(env);
  if (mode === 'off') return null;
  const key = await captchaSigningKey(env);
  if (!key) return null;

  const testMode = mode === 'test';
  const targetX = testMode ? CAPTCHA_TEST_TARGET_X : CAPTCHA_START_X + 50 + randomInt(CAPTCHA_WIDTH - CAPTCHA_START_X - 50 - CAPTCHA_PIECE_SIZE - 30);
  const targetY = testMode ? CAPTCHA_TEST_TARGET_Y : 28 + randomInt(CAPTCHA_HEIGHT - 56 - CAPTCHA_PIECE_SIZE);
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const exp = Date.now() + CAPTCHA_TTL_MS;

  const payload = `v1|${targetX}|${targetY}|${exp}|${nonce}`;
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const signatureB64 = base64UrlEncode(await hmac(key, payload));

  return {
    challenge: `${payloadB64}.${signatureB64}`,
    background: renderBackgroundSvg(targetX, targetY, parseInt(nonce.slice(0, 8), 16)),
    piece: renderPieceSvg(),
    width: CAPTCHA_WIDTH,
    height: CAPTCHA_HEIGHT,
    pieceSize: CAPTCHA_PIECE_SIZE,
    startX: CAPTCHA_START_X,
    y: targetY,
  };
}

/**
 * 校验登录提交的滑块证明。任何失败均返回 ok:false（不区分原因给调用方以外信息）。
 */
export async function verifyCaptcha(env: EnvLike, proof: CaptchaProof): Promise<CaptchaVerifyResult> {
  if (resolveCaptchaMode(env) === 'off') return { ok: true, reason: 'disabled' };
  const parsed = await parseChallenge(env, typeof proof.challenge === 'string' ? proof.challenge : '');
  if (!parsed) return { ok: false, reason: 'malformed' };

  const now = Date.now();
  if (parsed.exp <= now) return { ok: false, reason: 'expired' };
  if (consumedChallenges.has(parsed.signatureHex)) return { ok: false, reason: 'consumed' };

  const x = typeof proof.x === 'number' ? proof.x : Number(proof.x);
  if (!Number.isFinite(x) || x < 0 || x > CAPTCHA_WIDTH - CAPTCHA_PIECE_SIZE) {
    return { ok: false, reason: 'missed' };
  }
  if (Math.abs(x - parsed.targetX) > CAPTCHA_TOLERANCE) return { ok: false, reason: 'missed' };

  // 轨迹行为校验：样本数、时长、非递减时间戳、离散度、终点一致
  const samples = proof.samples;
  if (!Array.isArray(samples) || samples.length < CAPTCHA_MIN_SAMPLES || samples.length > CAPTCHA_MAX_SAMPLES) {
    return { ok: false, reason: 'bad-trajectory' };
  }
  let firstT = Infinity;
  let lastT = -Infinity;
  let lastX = NaN;
  let previousT = -Infinity;
  const distinctX = new Set<number>();
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') return { ok: false, reason: 'bad-trajectory' };
    const sx = (sample as { x?: unknown }).x;
    const st = (sample as { t?: unknown }).t;
    if (typeof sx !== 'number' || typeof st !== 'number' || !Number.isFinite(sx) || !Number.isFinite(st)) {
      return { ok: false, reason: 'bad-trajectory' };
    }
    if (st < previousT) return { ok: false, reason: 'bad-trajectory' };
    previousT = st;
    if (st < firstT) firstT = st;
    if (st > lastT) lastT = st;
    distinctX.add(Math.round(sx));
    lastX = sx;
  }
  const span = lastT - firstT;
  if (span < CAPTCHA_MIN_DRAG_MS || span > CAPTCHA_MAX_DRAG_MS) {
    return { ok: false, reason: 'bad-trajectory' };
  }
  if (distinctX.size < 2) return { ok: false, reason: 'bad-trajectory' };
  if (!Number.isFinite(lastX) || Math.abs(lastX - x) > CAPTCHA_TOLERANCE) {
    return { ok: false, reason: 'bad-trajectory' };
  }

  markConsumed(parsed.signatureHex, parsed.exp);
  return { ok: true };
}
