import {
  buildDefaultMobileShortcuts,
  PRESET_SHORTCUT_MAP,
} from '../../src/mobile-shortcuts-schema';
import { onLocaleChange, t } from './i18n';
import { isMobileTerminalKey, type MobileModifier } from './mobile-input';
import type { MobileShortcutsManager } from './mobile-shortcuts-manager';
import type { SSHTerminal } from './terminal';
import { notify } from './ui-feedback';

type TerminalGetter = () => SSHTerminal | null;

const VIEWPORT_FIT_STABLE_DELAY_MS = 120;
const SOFT_KEYBOARD_MIN_OCCLUSION_PX = 120;
const MOBILE_LAYOUT_QUERY = '(max-width: 767px), (max-width: 1180px) and (pointer: coarse)';

export class MobileTerminalController {
  private viewportFrame: number | null = null;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  private maximumViewportHeight = 0;
  private moreMenu: HTMLElement | null;
  private modifierButtons: HTMLButtonElement[];
  private activeTerminal: SSHTerminal | null = null;
  private readonly viewportListener = () => this.scheduleViewportUpdate();
  private readonly viewportResetListener = () => {
    this.maximumViewportHeight = 0;
    this.scheduleViewportUpdate();
  };
  private readonly terminalStateListener = () => this.syncTerminalState();
  private readonly outsideMenuListener = (event: PointerEvent) => {
    const target = event.target as Node | null;
    const button = document.getElementById('mobile-more-btn');
    if (target && (this.moreMenu?.contains(target) || button?.contains(target))) return;
    this.hideMoreMenu();
  };

  constructor(
    private readonly getTerminal: TerminalGetter,
    private readonly shortcutsManager?: MobileShortcutsManager
  ) {
    this.moreMenu = document.getElementById('mobile-more-menu');
    this.modifierButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-mobile-modifier]')
    );
  }

  start(): void {
    window.addEventListener('resize', this.viewportListener, { passive: true });
    window.addEventListener('orientationchange', this.viewportResetListener, { passive: true });
    window.visualViewport?.addEventListener('resize', this.viewportListener, { passive: true });
    window.visualViewport?.addEventListener('scroll', this.viewportListener, { passive: true });
    document.addEventListener('fullscreenchange', this.viewportResetListener);
    document.addEventListener('cloudssh:mobile-modifier-change', this.terminalStateListener);
    document.addEventListener('cloudssh:active-terminal-change', this.terminalStateListener);
    document.addEventListener('pointerdown', this.outsideMenuListener, true);

    document
      .getElementById('mobile-more-btn')
      ?.addEventListener('click', () => this.toggleMoreMenu());
    document.getElementById('mobile-search-btn')?.addEventListener('click', () => {
      this.getTerminal()?.toggleSearch();
      this.hideMoreMenu();
    });
    document.getElementById('mobile-export-btn')?.addEventListener('click', () => {
      this.getTerminal()?.exportToFile();
      this.hideMoreMenu();
    });
    document.getElementById('mobile-landscape-btn')?.addEventListener('click', () => {
      void this.requestLandscape();
      this.hideMoreMenu();
    });
    document.getElementById('mobile-shortcuts-terminal-btn')?.addEventListener('click', () => {
      this.shortcutsManager?.showModal();
      this.hideMoreMenu();
    });

    const scrollContainer = document.querySelector<HTMLElement>(
      '#mobile-terminal-toolbar .mobile-terminal-toolbar-scroll'
    );
    if (scrollContainer) {
      scrollContainer.addEventListener('click', (event) => {
        const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
        if (!target || !scrollContainer.contains(target)) return;

        if (target.id === 'mobile-copy-btn') {
          void this.handleCopyAction();
          return;
        }
        if (target.id === 'mobile-paste-btn') {
          void this.getTerminal()?.pasteFromClipboard();
          return;
        }
        if (target.id === 'mobile-keyboard-hide-btn') {
          this.getTerminal()?.blur();
          return;
        }

        if (target.dataset.mobileModifier) {
          const terminal = this.getTerminal();
          if (!terminal) return;
          const modifier = target.dataset.mobileModifier as MobileModifier;
          terminal.setMobileModifier(terminal.getMobileModifier() === modifier ? null : modifier);
          this.syncModifierButtons();
          terminal.focus();
          return;
        }

        if (target.dataset.terminalKey) {
          const key = target.dataset.terminalKey;
          const terminal = this.getTerminal();
          if (terminal && isMobileTerminalKey(key)) {
            terminal.sendMobileKey(key);
          } else if (terminal && key) {
            terminal.sendInput(key);
          }
          this.syncModifierButtons();
          return;
        }

        if (target.dataset.terminalText) {
          const text = decodeURIComponent(target.dataset.terminalText);
          const terminal = this.getTerminal();
          if (terminal && text) {
            terminal.sendInput(text);
          }
          this.syncModifierButtons();
          return;
        }
      });
    }

    if (this.shortcutsManager) {
      this.shortcutsManager.onChange(() => this.renderToolbar());
    }
    this.renderToolbar();

    onLocaleChange(() => {
      this.updateOrientationLabel();
      this.renderToolbar();
    });
    this.updateOrientationLabel();
    this.syncTerminalState();
    this.scheduleViewportUpdate();
  }

  private renderToolbar(): void {
    const scrollContainer = document.querySelector<HTMLElement>(
      '#mobile-terminal-toolbar .mobile-terminal-toolbar-scroll'
    );
    if (!scrollContainer) return;

    const shortcuts = this.shortcutsManager
      ? this.shortcutsManager.getShortcuts()
      : buildDefaultMobileShortcuts().shortcuts;

    scrollContainer.replaceChildren();

    for (const item of shortcuts) {
      const btn = document.createElement('button');
      btn.type = 'button';

      if (item.type === 'modifier') {
        btn.dataset.mobileModifier = item.id;
        btn.setAttribute('aria-pressed', 'false');
        btn.textContent = item.label || item.id;
      } else if (item.type === 'action') {
        if (item.id === 'copy') {
          btn.id = 'mobile-copy-btn';
          btn.dataset.i18nTitle = 'terminal.copySelection';
          btn.title = t('terminal.copySelection');
          btn.setAttribute('aria-pressed', 'false');
          const icon = document.createElement('span');
          icon.className = 'material-symbols-outlined';
          icon.setAttribute('aria-hidden', 'true');
          icon.textContent = 'content_copy';
          btn.appendChild(icon);
        } else if (item.id === 'paste') {
          btn.id = 'mobile-paste-btn';
          btn.dataset.i18nTitle = 'terminal.paste';
          btn.title = t('terminal.paste');
          const icon = document.createElement('span');
          icon.className = 'material-symbols-outlined';
          icon.setAttribute('aria-hidden', 'true');
          icon.textContent = 'content_paste';
          btn.appendChild(icon);
        } else if (item.id === 'keyboard_hide') {
          btn.id = 'mobile-keyboard-hide-btn';
          btn.dataset.i18nTitle = 'terminal.hideKeyboard';
          btn.title = t('terminal.hideKeyboard');
          const icon = document.createElement('span');
          icon.className = 'material-symbols-outlined';
          icon.setAttribute('aria-hidden', 'true');
          icon.textContent = 'keyboard_hide';
          btn.appendChild(icon);
        }
      } else if (item.type === 'text') {
        btn.dataset.terminalText = encodeURIComponent(item.value || '');
        btn.textContent = item.label || 'Cmd';
      } else {
        // key
        btn.dataset.terminalKey = item.id;
        const preset = PRESET_SHORTCUT_MAP.get(item.id);
        if (preset?.icon) {
          if (preset.i18nTitle) {
            btn.dataset.i18nTitle = preset.i18nTitle;
            btn.title = t(preset.i18nTitle as any);
          }
          const icon = document.createElement('span');
          icon.className = 'material-symbols-outlined';
          icon.setAttribute('aria-hidden', 'true');
          icon.textContent = preset.icon;
          btn.appendChild(icon);
        } else {
          btn.textContent = item.label || preset?.label || item.id;
        }
      }

      scrollContainer.appendChild(btn);
    }

    this.modifierButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-mobile-modifier]')
    );
    this.syncModifierButtons();
    this.syncCopyButton();
  }

  private scheduleViewportUpdate(): void {
    if (this.viewportFrame !== null) cancelAnimationFrame(this.viewportFrame);
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = null;
      const visualViewport = window.visualViewport;
      const viewportHeight = Math.max(1, Math.round(visualViewport?.height ?? window.innerHeight));
      const viewportOffsetTop = Math.max(0, Math.round(visualViewport?.offsetTop ?? 0));
      const isMobileLayout = window.matchMedia?.(MOBILE_LAYOUT_QUERY).matches ?? false;

      if (this.maximumViewportHeight === 0 || viewportHeight > this.maximumViewportHeight) {
        this.maximumViewportHeight = viewportHeight;
      }
      const keyboardOpen =
        isMobileLayout &&
        this.maximumViewportHeight - viewportHeight >= SOFT_KEYBOARD_MIN_OCCLUSION_PX;

      const root = document.documentElement;
      root.style.setProperty('--visual-viewport-height', `${viewportHeight}px`);
      root.style.setProperty('--visual-viewport-offset-top', `${viewportOffsetTop}px`);
      root.classList.toggle('mobile-keyboard-open', keyboardOpen);
      this.scheduleStableFit();
      this.updateOrientationLabel();
    });
  }

  private scheduleStableFit(): void {
    if (!document.body.classList.contains('terminal-active')) return;
    if (this.fitTimer !== null) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      this.getTerminal()?.fit();
    }, VIEWPORT_FIT_STABLE_DELAY_MS);
  }

  private toggleMoreMenu(): void {
    const hidden = this.moreMenu?.classList.contains('hidden') ?? true;
    this.moreMenu?.classList.toggle('hidden', !hidden);
    document.getElementById('mobile-more-btn')?.setAttribute('aria-expanded', String(hidden));
  }

  /** 需要由外部（如 main.ts 的抽屉入口）关闭菜单时调用 */
  hideMoreMenu(): void {
    this.moreMenu?.classList.add('hidden');
    document.getElementById('mobile-more-btn')?.setAttribute('aria-expanded', 'false');
  }

  private syncModifierButtons(): void {
    const active = this.getTerminal()?.getMobileModifier() ?? null;
    for (const button of this.modifierButtons) {
      const pressed = button.dataset.mobileModifier === active;
      button.classList.toggle('is-active', pressed);
      button.setAttribute('aria-pressed', String(pressed));
    }
  }

  private syncTerminalState(): void {
    const terminal = this.getTerminal();
    if (this.activeTerminal && this.activeTerminal !== terminal) {
      this.activeTerminal.setMobileSelectionMode(false);
    }
    this.activeTerminal = terminal;
    this.syncModifierButtons();
    this.syncCopyButton();
    this.scheduleStableFit();
  }

  private syncCopyButton(): void {
    const button = document.getElementById('mobile-copy-btn');
    if (!button) return;
    const active = this.getTerminal()?.isMobileSelectionMode() ?? false;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }

  private async handleCopyAction(): Promise<void> {
    const terminal = this.getTerminal();
    if (!terminal) return;

    if (terminal.hasSelection()) {
      const copied = await terminal.copyCurrentSelection();
      if (copied) {
        terminal.setMobileSelectionMode(false);
        terminal.clearSelection();
      }
      this.syncCopyButton();
      return;
    }

    const enabled = !terminal.isMobileSelectionMode();
    terminal.setMobileSelectionMode(enabled);
    if (enabled) {
      terminal.blur();
      notify(t('terminal.mobileSelectionHint'), { variant: 'info' });
    }
    this.syncCopyButton();
  }

  private updateOrientationLabel(): void {
    const button = document.getElementById('mobile-landscape-btn');
    if (!button) return;
    const label = this.isTerminalFullscreen()
      ? t('terminal.exitFullscreen')
      : t('terminal.landscapeMode');
    const text = button.querySelector<HTMLElement>('[data-mobile-landscape-label]');
    if (text) text.textContent = label;
    button.title = label;
  }

  private async requestLandscape(): Promise<void> {
    if (this.isTerminalFullscreen()) {
      try {
        screen.orientation?.unlock?.();
      } catch {
        /* ignore */
      }
      await document.exitFullscreen?.();
      return;
    }

    const fullscreenTarget = document.documentElement;
    if (!fullscreenTarget.requestFullscreen) {
      notify(t('terminal.landscapeUnsupported'), { variant: 'warning' });
      return;
    }

    try {
      await fullscreenTarget.requestFullscreen();
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (orientation: 'landscape') => Promise<void>;
      };
      if (orientation.lock) {
        await orientation.lock('landscape');
      } else {
        notify(t('terminal.rotateManually'), { variant: 'info' });
      }
    } catch {
      if (this.isTerminalFullscreen()) {
        notify(t('terminal.rotateManually'), { variant: 'info' });
      } else {
        notify(t('terminal.landscapeUnsupported'), { variant: 'warning' });
      }
    } finally {
      this.scheduleViewportUpdate();
    }
  }

  leaveTerminal(): void {
    this.activeTerminal?.setMobileSelectionMode(false);
    this.syncCopyButton();
    if (this.isTerminalFullscreen()) {
      try {
        screen.orientation?.unlock?.();
      } catch {
        /* ignore */
      }
      void document.exitFullscreen?.();
    }
    document.documentElement.classList.remove('mobile-keyboard-open');
    this.hideMoreMenu();
  }

  private isTerminalFullscreen(): boolean {
    return document.fullscreenElement === document.documentElement;
  }
}
