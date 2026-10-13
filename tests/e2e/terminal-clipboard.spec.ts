import { expect, test } from '@playwright/test';
import { mockAnonymousSession } from './helpers';

test('终端只在正常结束鼠标选区时自动复制', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-clipboard-test-root';
    root.style.width = '800px';
    root.style.height = '320px';
    document.body.appendChild(root);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const copiedTexts: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copiedTexts.push(text);
        },
      },
    });

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const xterm = (terminal as any).terminal;
    await new Promise<void>((resolve) => xterm.write('hello', resolve));
    xterm.select(0, 0, 5);

    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
      })
    );
    window.dispatchEvent(new PointerEvent('pointercancel', { button: 0 }));
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const copiedAfterCancel = copiedTexts.length;

    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 20,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        button: 0,
        clientX: 80,
        clientY: 20,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toast = document.querySelector<HTMLElement>('.app-toast');
    const output = {
      copiedAfterCancel,
      copiedTexts: [...copiedTexts],
      toastText: toast?.textContent || '',
      toastVariant: toast?.dataset.variant || '',
    };

    terminal.dispose();
    root.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as any).clipboard;
    }
    return output;
  });

  expect(result.copiedAfterCancel).toBe(0);
  expect(result.copiedTexts).toEqual(['hello']);
  expect(result.toastText).toContain('已复制');
  expect(result.toastVariant).toBe('success');
});

test('移动端通过选择模式拖动生成选区并显式复制', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const mobileModule = await (window as any).eval("import('/src/mobile-terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-touch-copy-test-root';
    root.style.cssText = 'width:390px;height:320px;';
    document.body.appendChild(root);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const copiedTexts: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => copiedTexts.push(text) },
    });

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const mobileController = new mobileModule.MobileTerminalController(() => terminal);
    mobileController.start();
    const xterm = (terminal as any).terminal;
    await new Promise<void>((resolve) => xterm.write('touch selection', resolve));

    const copyButton = document.getElementById('mobile-copy-btn')!;
    copyButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const selectionModeEnabled = terminal.isMobileSelectionMode();

    const screen = root.querySelector<HTMLElement>('.xterm-screen')!;
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / xterm.cols;
    const cellHeight = rect.height / xterm.rows;
    const pointerId = 7;
    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 0.5,
        clientY: rect.top + cellHeight * 0.5,
      })
    );
    root.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 4.5,
        clientY: rect.top + cellHeight * 0.5,
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 4.5,
        clientY: rect.top + cellHeight * 0.5,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const selectionBeforeCopy = xterm.getSelection();
    const copiedBeforeButton = [...copiedTexts];
    copyButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = {
      copiedTexts,
      copiedBeforeButton,
      selectionBeforeCopy,
      selectionAfterCopy: xterm.getSelection(),
      selectionModeEnabled,
      selectionModeAfterCopy: terminal.isMobileSelectionMode(),
      copyButtonPressed: copyButton.getAttribute('aria-pressed'),
    };
    terminal.dispose();
    root.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as any).clipboard;
    }
    return output;
  });

  expect(result.selectionModeEnabled).toBe(true);
  expect(result.selectionBeforeCopy).toBe('touch');
  expect(result.copiedBeforeButton).toEqual([]);
  expect(result.copiedTexts).toEqual(['touch']);
  expect(result.selectionAfterCopy).toBe('');
  expect(result.selectionModeAfterCopy).toBe(false);
  expect(result.copyButtonPressed).toBe('false');
});

test('旧版复制回退准确返回结果并恢复原焦点', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const clipboardModule = await (window as any).eval("import('/src/clipboard.ts')");
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => true,
    });
    const copied = clipboardModule.copyTextWithExecCommand('hello');
    const focusedAfterSuccess = document.activeElement === input;

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    });
    const rejected = clipboardModule.copyTextWithExecCommand('hello');
    const focusedAfterFailure = document.activeElement === input;

    const originalSelect = HTMLTextAreaElement.prototype.select;
    HTMLTextAreaElement.prototype.select = () => {
      throw new Error('selection unavailable');
    };
    const failedDuringSelection = clipboardModule.copyTextWithExecCommand('hello');
    const temporaryTextareas = document.querySelectorAll(
      'textarea[aria-hidden="true"][tabindex="-1"]'
    ).length;
    const focusedAfterSelectionError = document.activeElement === input;
    HTMLTextAreaElement.prototype.select = originalSelect;

    input.remove();
    if (execCommandDescriptor) {
      Object.defineProperty(document, 'execCommand', execCommandDescriptor);
    } else {
      delete (document as any).execCommand;
    }

    return {
      copied,
      rejected,
      failedDuringSelection,
      temporaryTextareas,
      focusedAfterSuccess,
      focusedAfterFailure,
      focusedAfterSelectionError,
    };
  });

  expect(result).toEqual({
    copied: true,
    rejected: false,
    failedDuringSelection: false,
    temporaryTextareas: 0,
    focusedAfterSuccess: true,
    focusedAfterFailure: true,
    focusedAfterSelectionError: true,
  });
});

test('右键粘贴遵循终端的 bracketed paste 模式并统一换行', async ({ page, isMobile }) => {
  // 右键是鼠标专有交互。触屏设备上长按/右键必须交给自绘选区与浮动复制条，
  // 因此这条桌面语义的用例不在移动端项目下执行。
  test.skip(isMobile, '右键粘贴为桌面专有交互');
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-paste-test-root';
    root.style.width = '800px';
    root.style.height = '320px';
    document.body.appendChild(root);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => 'one\r\ntwo\n' },
    });

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const xterm = (terminal as any).terminal;
    (terminal as any).ws = {
      readyState: WebSocket.OPEN,
      close: () => undefined,
    };
    (terminal as any).sessionReady = true;
    const pasted: string[] = [];
    const inputDisposable = xterm.onData((data: string) => pasted.push(data));

    await new Promise<void>((resolve) => xterm.write('\x1b[?2004h', resolve));
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bracketed = pasted.join('');

    pasted.length = 0;
    await new Promise<void>((resolve) => xterm.write('\x1b[?2004l', resolve));
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const plain = pasted.join('');

    inputDisposable.dispose();
    terminal.dispose();
    root.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as any).clipboard;
    }
    return { bracketed, plain };
  });

  expect(result.bracketed).toBe('\x1b[200~one\rtwo\r\x1b[201~');
  expect(result.plain).toBe('one\rtwo\r');
});

test('触屏长按直接进入选区并浮出操作条，一次点击即复制', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  // 操作条仅在移动端显示，需让 matchMedia 命中 MOBILE_VIEWPORT_QUERY。
  await page.setViewportSize({ width: 390, height: 720 });

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-longpress-test-root';
    root.style.cssText = 'width:390px;height:320px;';
    document.body.appendChild(root);

    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const copiedTexts: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => copiedTexts.push(text) },
    });

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const xterm = (terminal as any).terminal;
    await new Promise<void>((resolve) => xterm.write('long press copy', resolve));

    const bar = document.getElementById('terminal-selection-actions')!;
    const screen = root.querySelector<HTMLElement>('.xterm-screen')!;
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / xterm.cols;
    const cellHeight = rect.height / xterm.rows;
    const pointerId = 11;
    const at = (cells: number) => ({
      clientX: rect.left + cellWidth * (cells + 0.5),
      clientY: rect.top + cellHeight * 0.5,
    });

    // 长按：按下后手指保持不动，等过判定时长。
    const start = at(0);
    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        ...start,
      })
    );
    const barHiddenWhileWaiting = bar.classList.contains('hidden');
    await new Promise((resolve) => setTimeout(resolve, 420));
    const modeAfterLongPress = terminal.isMobileSelectionMode();

    // 拖动扩大选区，操作条应浮出。
    root.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        ...at(9),
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const barVisibleAfterDrag = !bar.classList.contains('hidden');
    const selectedText = xterm.getSelection();

    // 点操作条上的复制。
    document.getElementById('terminal-selection-copy-btn')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = {
      barHiddenWhileWaiting,
      barVisibleAfterDrag,
      modeAfterLongPress,
      selectedText,
      copiedTexts: [...copiedTexts],
      modeAfterCopy: terminal.isMobileSelectionMode(),
      barHiddenAfterCopy: bar.classList.contains('hidden'),
    };
    terminal.dispose();
    root.remove();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as any).clipboard;
    }
    return output;
  });

  expect(result.barHiddenWhileWaiting).toBe(true);
  expect(result.modeAfterLongPress).toBe(true);
  expect(result.barVisibleAfterDrag).toBe(true);
  expect(result.selectedText).toBe('long press');
  expect(result.copiedTexts).toEqual(['long press']);
  expect(result.modeAfterCopy).toBe(false);
  expect(result.barHiddenAfterCopy).toBe(true);
});

test('长按判定期间的滑动仍走滚动，不会被抢成选区', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await page.setViewportSize({ width: 390, height: 720 });

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-longpress-scroll-test-root';
    root.style.cssText = 'width:390px;height:320px;';
    document.body.appendChild(root);

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const xterm = (terminal as any).terminal;
    await new Promise<void>((resolve) => xterm.write('scroll me', resolve));

    const screen = root.querySelector<HTMLElement>('.xterm-screen')!;
    const rect = screen.getBoundingClientRect();
    const cellWidth = rect.width / xterm.cols;
    const pointerId = 13;

    // 按下后立刻横向拖动超过容差，再等到超过长按时长：不应进入选区。
    root.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 0.5,
        clientY: rect.top + 40,
      })
    );
    root.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        button: 0,
        pointerType: 'touch',
        pointerId,
        clientX: rect.left + cellWidth * 20.5,
        clientY: rect.top + 40,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 420));

    const output = {
      selectionMode: terminal.isMobileSelectionMode(),
      selection: xterm.getSelection(),
      barHidden: document
        .getElementById('terminal-selection-actions')!
        .classList.contains('hidden'),
    };
    terminal.dispose();
    root.remove();
    return output;
  });

  expect(result.selectionMode).toBe(false);
  expect(result.selection).toBe('');
  expect(result.barHidden).toBe(true);
});

test('选择模式下抑制原生长按菜单', async ({ page }) => {
  await mockAnonymousSession(page);
  await page.goto('/?lang=zh-CN');
  await page.setViewportSize({ width: 390, height: 720 });

  const result = await page.evaluate(async () => {
    const terminalModule = await (window as any).eval("import('/src/terminal.ts')");
    const root = document.createElement('div');
    root.id = 'terminal-contextmenu-test-root';
    root.style.cssText = 'width:390px;height:320px;';
    document.body.appendChild(root);

    const terminal = new terminalModule.SSHTerminal(root.id);
    terminal.mount();
    const screen = root.querySelector<HTMLElement>('.xterm-screen')!;

    const dispatchContextMenu = () =>
      screen.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
      );

    const defaultPreventedWithoutMode = !dispatchContextMenu();
    terminal.setMobileSelectionMode(true);
    const defaultPreventedInMode = !dispatchContextMenu();

    terminal.dispose();
    root.remove();
    return { defaultPreventedWithoutMode, defaultPreventedInMode };
  });

  // 无论是否处于选择模式，触屏下的原生菜单都必须被拦下。
  expect(result.defaultPreventedWithoutMode).toBe(true);
  expect(result.defaultPreventedInMode).toBe(true);
});
