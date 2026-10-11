/**
 * 图片字符验证码组件（替代 Cloudflare Turnstile；v2.6.5 前为滑块拼图形态）。
 *
 * 后端契约（src/worker/captcha.ts）：
 * - GET /api/captcha/challenge → { challenge, image, width, height }；
 *   答案明文不在挑战串内（载荷存 sha256 摘要），前端无法本地判定对错，
 *   校验发生在登录请求内（见 auth-form.ts）。
 * - 登录提交 { challenge, answer }；答错同样消耗挑战，因此任何登录失败后
 *   都必须换新图（本组件由 auth-form 调用 reset()）。
 *
 * 组件无外部依赖：服务端下发的 SVG 经 innerHTML 注入（同源自渲染内容，
 * 与项目内既有 pi-lens-ignore 用法一致），图片区可点击刷新，主题经 CSS 变量适配。
 */

import { t } from './i18n';

export interface CaptchaSolvedPayload {
  challenge: string;
  answer: string;
}

export interface ImageCaptchaWidget {
  /** 容器元素（渲染完成/失败状态均保持占位） */
  element: HTMLElement;
  /** 是否已输入答案（对错由服务端裁决） */
  isComplete: () => boolean;
  /** 取证明载荷；无答案时返回 null */
  getProof: () => CaptchaSolvedPayload | null;
  /** 重置：拉取新挑战并清空输入框 */
  reset: () => Promise<void>;
  /** 聚焦答案输入框（验证码错误后引导重输） */
  focus: () => void;
  /** 销毁：移除事件监听 */
  destroy: () => void;
}

interface ChallengeResponse {
  challenge: string;
  image: string;
  width: number;
  height: number;
}

export async function createImageCaptcha(): Promise<ImageCaptchaWidget> {
  const root = document.createElement('div');
  root.className = 'image-captcha';

  const figure = document.createElement('div');
  figure.className = 'image-captcha__figure';
  figure.setAttribute('role', 'button');
  figure.setAttribute('tabIndex', '0');
  figure.setAttribute('aria-label', t('auth.captchaRefresh'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'image-captcha__input';
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  input.maxLength = 10;
  input.setAttribute('data-i18n-placeholder', 'auth.captchaHint');
  input.placeholder = t('auth.captchaHint');
  input.setAttribute('aria-label', t('auth.captchaAria'));

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'image-captcha__refresh';
  refresh.setAttribute('aria-label', t('auth.captchaRefresh'));
  refresh.title = t('auth.captchaRefresh');
  const refreshIcon = document.createElement('span');
  refreshIcon.className = 'material-symbols-outlined';
  refreshIcon.setAttribute('aria-hidden', 'true');
  refreshIcon.textContent = 'refresh';
  refresh.appendChild(refreshIcon);

  const row = document.createElement('div');
  row.className = 'image-captcha__row';
  row.append(input, refresh);
  root.append(figure, row);

  let challenge: ChallengeResponse | null = null;
  let destroyed = false;
  let loadGeneration = 0;

  const loadChallenge = async (): Promise<void> => {
    const generation = ++loadGeneration;
    root.classList.remove('image-captcha--error');
    input.value = '';
    try {
      const response = await fetch('/api/captcha/challenge');
      if (!response.ok) throw new Error(`challenge ${response.status}`);
      const data = (await response.json()) as ChallengeResponse;
      if (destroyed || generation !== loadGeneration) return;
      challenge = data;
      // pi-lens-ignore: no-inner-html
      figure.innerHTML = data.image;
      const svg = figure.querySelector('svg');
      if (svg) {
        svg.removeAttribute('width');
        svg.removeAttribute('height');
      }
      root.classList.remove('image-captcha--loading');
    } catch {
      if (destroyed || generation !== loadGeneration) return;
      root.classList.add('image-captcha--error');
      root.classList.remove('image-captcha--loading');
    }
  };

  // 点击图片 / 刷新按钮 / Enter(figure) 均换一张（答错即消耗，必须换新图）
  const refreshNow = (): void => {
    root.classList.add('image-captcha--loading');
    void loadChallenge();
  };
  figure.addEventListener('click', refreshNow);
  figure.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      refreshNow();
    }
  });
  refresh.addEventListener('click', refreshNow);

  root.classList.add('image-captcha--loading');
  void loadChallenge();

  return {
    element: root,
    isComplete: () => challenge !== null && input.value.trim().length > 0,
    getProof: () => {
      if (!challenge) return null;
      const answer = input.value.trim();
      if (!answer) return null;
      return { challenge: challenge.challenge, answer };
    },
    reset: loadChallenge,
    focus: () => input.focus(),
    destroy: () => {
      destroyed = true;
      root.remove();
    },
  };
}
