/**
 * 滑块拼图验证码组件（替代 Cloudflare Turnstile）。
 *
 * 后端契约（src/worker/captcha.ts）：
 * - GET /api/captcha/challenge → { challenge, background, piece, width, height,
 *   pieceSize, startX, y }；目标 X 只存在于 HMAC 签名载荷内，响应不回显，
 *   因此前端无法本地判定对齐，校验发生在登录请求内（见 auth-form.ts）。
 * - 拖拽全程采样 {x,t}，随登录提交供服务端行为校验。
 *
 * 组件无外部依赖：服务端下发的 SVG 经 innerHTML 注入（同源自渲染内容，
 * 与项目内既有 pi-lens-ignore 用法一致），指针事件驱动，主题经 CSS 变量适配。
 */

import { t } from './i18n';

export interface CaptchaSolvedPayload {
  challenge: string;
  x: number;
  samples: Array<{ x: number; t: number }>;
}

export interface SliderCaptchaWidget {
  /** 容器元素（渲染完成/失败状态均保持占位） */
  element: HTMLElement;
  /** 是否已拖拽完成（不保证对齐，对齐由服务端裁决） */
  isComplete: () => boolean;
  /** 取证明载荷；未完成时返回 null */
  getProof: () => CaptchaSolvedPayload | null;
  /** 重置：拉取新挑战并清空轨迹 */
  reset: () => Promise<void>;
  /** 销毁：移除事件监听 */
  destroy: () => void;
}

interface ChallengeResponse {
  challenge: string;
  background: string;
  piece: string;
  width: number;
  height: number;
  pieceSize: number;
  startX: number;
  y: number;
}

export async function createSliderCaptcha(): Promise<SliderCaptchaWidget> {
  const root = document.createElement('div');
  root.className = 'slider-captcha';

  const canvas = document.createElement('div');
  canvas.className = 'slider-captcha__canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', t('auth.captchaAria'));

  const track = document.createElement('div');
  track.className = 'slider-captcha__track';

  const thumb = document.createElement('div');
  thumb.className = 'slider-captcha__thumb';
  thumb.setAttribute('role', 'slider');
  thumb.setAttribute('aria-valuemin', '0');
  thumb.setAttribute('aria-valuemax', '100');
  thumb.setAttribute('aria-label', t('auth.captchaAria'));
  thumb.tabIndex = 0;

  const hint = document.createElement('span');
  hint.className = 'slider-captcha__hint';
  const hintIcon = document.createElement('span');
  hintIcon.className = 'material-symbols-outlined';
  hintIcon.setAttribute('aria-hidden', 'true');
  hintIcon.textContent = 'double_arrow';
  const hintText = document.createElement('span');
  hintText.textContent = t('auth.captchaHint');
  hint.append(hintIcon, hintText);

  track.append(hint, thumb);
  root.append(canvas, track);

  let challenge: ChallengeResponse | null = null;
  let samples: Array<{ x: number; t: number }> = [];
  let completed = false;
  let dragging = false;
  let destroyed = false;
  let currentX = 0;
  let dragOffset = 0;
  let pointerMoveHandler: ((event: PointerEvent) => void) | null = null;
  let pointerUpHandler: ((event: PointerEvent) => void) | null = null;
  let loadGeneration = 0;

  const canvasScale = (): number => {
    if (!challenge) return 1;
    const width = canvas.clientWidth || challenge.width;
    return width / challenge.width;
  };

  const clampX = (x: number): number => {
    if (!challenge) return 0;
    return Math.min(challenge.width - challenge.pieceSize, Math.max(0, x));
  };

  // x 统一采用「拼图块绝对左缘」（SVG 逻辑坐标，含 startX 起始偏移）：
  // 服务端 targetX 与校验均在同一空间（见 src/worker/captcha.ts 的 |x-targetX|≤5），
  // 拖拽距离换算不得遇漏 startX，否则系统性偏差 10px 必然超出容差。
  const applyX = (x: number): void => {
    if (!challenge) return;
    const clamped = clampX(x);
    const piece = canvas.querySelector<HTMLElement>('.slider-captcha__piece');
    if (piece) piece.style.transform = `translate(${clamped * canvasScale()}px, 0)`;
    const draggable = challenge.width - challenge.pieceSize - challenge.startX;
    const percent = Math.min(100, Math.max(0, ((clamped - challenge.startX) / draggable) * 100));
    thumb.style.left = `${percent}%`;
    thumb.setAttribute('aria-valuenow', String(Math.round(percent)));
    track.classList.toggle('slider-captcha__track--filled', clamped > challenge.startX + 2);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || !challenge) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left - dragOffset;
    const x = clampX(px / canvasScale());
    currentX = x;
    samples.push({ x, t: event.timeStamp });
    applyX(x);
  };

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    if (pointerMoveHandler) window.removeEventListener('pointermove', pointerMoveHandler);
    if (pointerUpHandler) window.removeEventListener('pointerup', pointerUpHandler);
    // 服务端要求样本 ≥3（pointerdown + ≥2 次 move）；不足时不进入完成态，
    // 避免提交注定被拒的证明（单击/微拖不算有效拖拽，保持可重试）
    if (samples.length >= 3) {
      completed = true;
      track.classList.add('slider-captcha__track--done');
      thumb.innerHTML = '';
      const done = document.createElement('span');
      done.className = 'material-symbols-outlined';
      done.setAttribute('aria-hidden', 'true');
      done.textContent = 'check';
      thumb.appendChild(done);
      hintText.textContent = t('auth.captchaDone');
      hint.classList.add('slider-captcha__hint--done');
    }
  };

  const onPointerUp = (): void => endDrag();

  thumb.addEventListener('pointerdown', (event) => {
    if (completed || !challenge) return;
    event.preventDefault();
    dragging = true;
    // 捕获保证指针滑出组件仍可跟踪（手势期间 capture，结束即释放）
    thumb.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    dragOffset = event.clientX - rect.left - currentX * canvasScale();
    samples = [{ x: currentX, t: event.timeStamp }];
    window.addEventListener('pointermove', pointerMoveHandler = onPointerMove, { passive: false });
    window.addEventListener('pointerup', pointerUpHandler = onPointerUp);
  });
  thumb.addEventListener('pointercancel', endDrag);

  const loadChallenge = async (): Promise<void> => {
    const generation = ++loadGeneration;
    root.classList.remove('slider-captcha--error');
    track.classList.remove('slider-captcha__track--filled', 'slider-captcha__track--done');
    hint.classList.remove('slider-captcha__hint--done');
    completed = false;
    samples = [];
    currentX = 0;
    thumb.replaceChildren();
    hintText.textContent = t('auth.captchaHint');
    applyX(0);

    try {
      const response = await fetch('/api/captcha/challenge');
      if (!response.ok) throw new Error(`challenge ${response.status}`);
      const data = (await response.json()) as ChallengeResponse;
      if (destroyed || generation !== loadGeneration) return;
      challenge = data;

      // pi-lens-ignore: no-inner-html
      canvas.innerHTML = data.background;
      const svg = canvas.querySelector('svg');
      if (svg) {
        svg.removeAttribute('width');
        svg.removeAttribute('height');
      }

      // 滑块图：纵向锚定缺口行，横向由拖拽驱动
      const piece = document.createElement('div');
      piece.className = 'slider-captcha__piece';
      const logicalScale = canvas.clientWidth || data.width;
      const scale = logicalScale / data.width;
      // pi-lens-ignore: no-inner-html
      piece.innerHTML = data.piece;
      const pieceSvg = piece.querySelector('svg');
      if (pieceSvg) {
        pieceSvg.style.width = `${Math.round(data.pieceSize * scale)}px`;
        pieceSvg.style.height = `${Math.round(data.pieceSize * scale)}px`;
      }
      piece.style.top = `${Math.round(data.y * scale)}px`;
      piece.style.left = '0px';
      piece.style.setProperty('--piece-size', `${Math.round(data.pieceSize * scale)}px`);
      piece.style.transform = 'translate(0px, 0px)';
      canvas.appendChild(piece);

      // 进入绝对坐标空间：初始位 = startX（applyX 的 translate 承担全部横向定位）
      currentX = data.startX;
      applyX(data.startX);
      root.classList.remove('slider-captcha--loading');
    } catch {
      if (destroyed || generation !== loadGeneration) return;
      root.classList.add('slider-captcha--error');
      hintText.textContent = t('auth.captchaLoadFailed');
      root.classList.remove('slider-captcha--loading');
    }
  };

  root.classList.add('slider-captcha--loading');
  hintText.textContent = t('auth.captchaLoading');
  void loadChallenge();

  return {
    element: root,
    isComplete: () => completed,
    getProof: () => {
      if (!challenge || !completed || samples.length === 0) return null;
      return { challenge: challenge.challenge, x: clampX(samples[samples.length - 1].x), samples };
    },
    reset: loadChallenge,
    destroy: () => {
      destroyed = true;
      dragging = false;
      if (pointerMoveHandler) window.removeEventListener('pointermove', pointerMoveHandler);
      if (pointerUpHandler) window.removeEventListener('pointerup', pointerUpHandler);
      root.remove();
    },
  };
}
