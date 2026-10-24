/**
 * Cloudflare Turnstile widget 装载与生命周期管理。
 *
 * 在已挂载的 host 元素内显式渲染（turnstile.render）：host 必须已进入 DOM
 * （渲染到游离节点时 iframe 不会加载），因此调用点在 dialog.showModal() 之后。
 * 脚本按需异步加载且全局唯一；token 单次使用，失败后由调用方 reset()
 * 重新作答；remove() 销毁 widget 并清空 host。脚本加载失败（网络受限/超时）
 * 时抛错，调用方保持登录可用但提交会被服务端拒绝（fail closed）。
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_TIMEOUT_MS = 10_000;

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    const timer = window.setTimeout(() => {
      script.remove();
      scriptPromise = null;
      reject(new Error('timeout'));
    }, SCRIPT_TIMEOUT_MS);
    script.addEventListener('load', () => {
      window.clearTimeout(timer);
      resolve();
    });
    script.addEventListener('error', () => {
      window.clearTimeout(timer);
      script.remove();
      scriptPromise = null;
      reject(new Error('load-error'));
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileWidget {
  /** 当前 token；未完成或已消费（reset 后）为 null。 */
  getToken(): string | null;
  /** 作废旧 token 并要求用户重新作答（每次登录失败后调用）。 */
  reset(): void;
  /** 销毁 widget 并清空 host。 */
  remove(): void;
  /** 聚焦（错误提示后的回焦）。 */
  focus(): void;
}

export async function createTurnstileWidget(
  siteKey: string,
  host: HTMLElement,
  options: { onReady?: () => void; onExpired?: () => void; onError?: () => void } = {}
): Promise<TurnstileWidget> {
  await loadTurnstileScript();
  if (!window.turnstile) throw new Error('Turnstile script unavailable');

  const container = document.createElement('div');
  host.appendChild(container);
  let token: string | null = null;
  const widgetId = window.turnstile.render(container, {
    sitekey: siteKey,
    // flexible 尺寸自适应面板宽度；交互式挑战需要时自动展开
    size: 'flexible',
    callback: (value: string) => {
      token = value;
      options.onReady?.();
    },
    'expired-callback': () => {
      token = null;
      options.onExpired?.();
    },
    'error-callback': () => {
      token = null;
      options.onError?.();
    },
  });
  return {
    getToken: () => token,
    reset: () => {
      token = null;
      try {
        window.turnstile?.reset(widgetId);
      } catch {
        /* widget 已被移除时静默 */
      }
    },
    remove: () => {
      try {
        window.turnstile?.remove(widgetId);
      } catch {
        /* 静默 */
      }
      container.remove();
    },
    focus: () => {
      container.querySelector('iframe')?.focus();
    },
  };
}
