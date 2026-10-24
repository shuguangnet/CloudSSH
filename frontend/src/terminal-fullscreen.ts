import { t } from './i18n';

/**
 * 终端影院全屏模式：
 * - 优先使用浏览器 Fullscreen API（#terminal-section 全屏）；
 * - API 不可用或被拒（iOS Safari 网页视图、无手势环境）时回退 CSS 覆盖模式
 *   （body.terminal-cinema-css 把 #terminal-section fixed 铺满视口）；
 * - 两种形态都为 #terminal-section 挂 .terminal-cinema：隐藏应用头部/状态条/
 *   移动快捷键栏，保留标签栏（切标签 + 全屏按钮本体可达）；
 * - 进入/退出后调用注入的 fit() 重算行列并下发 window-change；
 * - CSS 回退形态下 Esc 退出（Fullscreen API 形态由浏览器原生 Esc 处理）。
 *
 * 按钮由 TabManager.renderTabBar() 按既有「querySelector 保留 + 缺则重建」
 * 模式渲染在标签栏；点击通过 document 级委托绑定，重建不丢监听。
 */

const SECTION_ID = 'terminal-section';
const BUTTON_ID = 'terminal-fullscreen-btn';
const SECTION_CLASS = 'terminal-cinema';
const BODY_CLASS = 'terminal-cinema-css';

let fitTerminals: (() => void) | null = null;

function sectionEl(): HTMLElement | null {
  return document.getElementById(SECTION_ID);
}

export function isTerminalCinemaActive(): boolean {
  return document.fullscreenElement?.id === SECTION_ID || document.body.classList.contains(BODY_CLASS);
}

function syncButton(): void {
  const btn = document.getElementById(BUTTON_ID);
  if (!btn) return;
  const icon = btn.querySelector('.material-symbols-outlined');
  if (icon) icon.textContent = isTerminalCinemaActive() ? 'fullscreen_exit' : 'fullscreen';
  const title = isTerminalCinemaActive() ? t('terminal.exitFullscreen') : t('terminal.fullscreen');
  btn.setAttribute('title', title);
  btn.setAttribute('aria-label', title);
  btn.setAttribute('aria-pressed', String(isTerminalCinemaActive()));
}

function scheduleFit(): void {
  // 全屏状态类先落地，下一帧再量尺寸，避免拿到过渡中的中间值。
  requestAnimationFrame(() => {
    fitTerminals?.();
    syncButton();
  });
}

function clearCinema(): void {
  document.body.classList.remove(BODY_CLASS);
  sectionEl()?.classList.remove(SECTION_CLASS);
}

function enterCinema(): void {
  sectionEl()?.classList.add(SECTION_CLASS);
  scheduleFit();
}

export async function enterTerminalFullscreen(): Promise<void> {
  const section = sectionEl();
  if (!section) return;
  enterCinema();
  try {
    if (document.fullscreenEnabled && section.requestFullscreen) {
      await section.requestFullscreen({ navigationUI: 'hide' });
      return;
    }
  } catch {
    // 拒绝（无手势/嵌入式浏览器）时走 CSS 回退
  }
  document.body.classList.add(BODY_CLASS);
  scheduleFit();
}

export async function exitTerminalFullscreen(): Promise<void> {
  clearCinema();
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
  } catch {
    // 退出失败也已在本地清除状态
  }
  scheduleFit();
}

export async function toggleTerminalFullscreen(): Promise<void> {
  if (isTerminalCinemaActive()) {
    await exitTerminalFullscreen();
  } else {
    await enterTerminalFullscreen();
  }
}

function onFullscreenChange(): void {
  // 浏览器原生 Esc / 系统手势退出全屏后收敛本地状态
  if (document.fullscreenElement?.id !== SECTION_ID) {
    clearCinema();
    scheduleFit();
  } else {
    syncButton();
  }
}

function onKeydown(event: KeyboardEvent): void {
  // 仅 CSS 回退形态需要自管 Esc（API 形态由浏览器处理 Esc）；
  // 终端区隐藏（回服务器列表）时不动，避免干扰其他 Esc 语义（返回终端/关抽屉）。
  if (
    event.key !== 'Escape' ||
    !document.body.classList.contains(BODY_CLASS) ||
    sectionEl()?.classList.contains('hidden')
  ) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  void exitTerminalFullscreen();
}

export function initTerminalFullscreen(options: { fit: () => void }): void {
  fitTerminals = options.fit;
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(`#${BUTTON_ID}`)) {
      event.preventDefault();
      void toggleTerminalFullscreen();
    }
  });
}
