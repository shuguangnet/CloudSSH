export type MobileModifier = 'ctrl' | 'alt' | 'shift';
export type MobileTerminalKey =
  | 'escape'
  | 'tab'
  | 'backtab'
  | 'delete'
  | 'insert'
  | 'arrow_up'
  | 'arrow_down'
  | 'arrow_right'
  | 'arrow_left'
  | 'home'
  | 'end'
  | 'page_up'
  | 'page_down'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12'
  | 'ctrl_c'
  | 'ctrl_d'
  | 'ctrl_z'
  | 'ctrl_l';

const MOBILE_TERMINAL_KEYS = new Set<MobileTerminalKey>([
  'escape',
  'tab',
  'backtab',
  'delete',
  'insert',
  'arrow_up',
  'arrow_down',
  'arrow_right',
  'arrow_left',
  'home',
  'end',
  'page_up',
  'page_down',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
  'ctrl_c',
  'ctrl_d',
  'ctrl_z',
  'ctrl_l',
]);

export function isMobileTerminalKey(key: string): key is MobileTerminalKey {
  return MOBILE_TERMINAL_KEYS.has(key as MobileTerminalKey);
}

/**
 * 计算 xterm 隐藏 textarea 在一次延迟输入前后的差异。
 * iOS 中文输入法会在 keyup 前才把标点或空格写入 textarea。
 */
export function diffTextareaInput(oldValue: string, newValue: string): string {
  if (oldValue === newValue) return '';

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < oldValue.length &&
    commonPrefixLength < newValue.length &&
    oldValue.charCodeAt(commonPrefixLength) === newValue.charCodeAt(commonPrefixLength)
  ) {
    commonPrefixLength++;
  }

  const removedCount = oldValue.length - commonPrefixLength;
  return `${'\x7f'.repeat(removedCount)}${newValue.slice(commonPrefixLength)}`;
}

/** 精确识别 xterm 的焦点报告，不能将方向键、Alt 或粘贴等 ESC 序列一并视为报告。 */
export function isTerminalFocusReport(data: string): boolean {
  return data === '\x1b[I' || data === '\x1b[O';
}

const SHIFT_SYMBOL_MAP = new Map<string, string>([
  ['1', '!'],
  ['2', '@'],
  ['3', '#'],
  ['4', '$'],
  ['5', '%'],
  ['6', '^'],
  ['7', '&'],
  ['8', '*'],
  ['9', '('],
  ['0', ')'],
  ['-', '_'],
  ['=', '+'],
  ['[', '{'],
  [']', '}'],
  ['\\', '|'],
  [';', ':'],
  ["'", '"'],
  [',', '<'],
  ['.', '>'],
  ['/', '?'],
  ['`', '~'],
]);

const MODIFIER_CODE_MAP = {
  ctrl: 5,
  alt: 3,
  shift: 2,
} satisfies Record<MobileModifier, number>;

const SIMPLE_MACRO_SEQUENCES = new Map<MobileTerminalKey, string>([
  ['backtab', '\x1b[Z'],
  ['ctrl_c', '\x03'],
  ['ctrl_d', '\x04'],
  ['ctrl_z', '\x1a'],
  ['ctrl_l', '\x0c'],
]);

const TILDE_KEY_CODES = new Map<MobileTerminalKey, string>([
  ['insert', '2'],
  ['delete', '3'],
  ['page_up', '5'],
  ['page_down', '6'],
  ['f5', '15'],
  ['f6', '17'],
  ['f7', '18'],
  ['f8', '19'],
  ['f9', '20'],
  ['f10', '21'],
  ['f11', '23'],
  ['f12', '24'],
]);

const FN1_TO_4_FINALS = new Map<MobileTerminalKey, string>([
  ['f1', 'P'],
  ['f2', 'Q'],
  ['f3', 'R'],
  ['f4', 'S'],
]);

const CURSOR_KEY_FINALS = new Map<MobileTerminalKey, string>([
  ['arrow_up', 'A'],
  ['arrow_down', 'B'],
  ['arrow_right', 'C'],
  ['arrow_left', 'D'],
  ['home', 'H'],
  ['end', 'F'],
]);

function applyShiftToSingleChar(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= 97 && code <= 122) {
    return char.toUpperCase();
  }
  return SHIFT_SYMBOL_MAP.get(char) ?? char;
}

/** 将移动端一次性 Ctrl/Alt/Shift 状态应用到下一段终端输入。 */
export function applyMobileModifier(
  data: string,
  modifier: MobileModifier | null
): { data: string; consumed: boolean } {
  if (!modifier || !data) {
    return { data, consumed: false };
  }

  if (modifier === 'alt') {
    return { data: `\x1b${data}`, consumed: true };
  }

  if (modifier === 'shift') {
    if (data === '\t') {
      return { data: '\x1b[Z', consumed: true };
    }
    const shifted = data.length === 1 ? applyShiftToSingleChar(data) : data;
    return { data: shifted, consumed: true };
  }

  if (data.length !== 1) {
    return { data, consumed: true };
  }
  if (data === ' ') {
    return { data: '\x00', consumed: true };
  }
  const originalCode = data.charCodeAt(0);
  const code = originalCode >= 97 && originalCode <= 122 ? originalCode - 32 : originalCode;
  if (code >= 64 && code <= 95) {
    return { data: String.fromCharCode(code & 0x1f), consumed: true };
  }
  if (data === '?') {
    return { data: '\x7f', consumed: true };
  }
  return { data, consumed: true };
}

/** 按照 xterm 的 application cursor mode 和修饰键生成终端按键序列。 */
export function mobileTerminalKeySequence(
  key: MobileTerminalKey,
  applicationCursorMode: boolean,
  modifier: MobileModifier | null
): string {
  const modifierCode = modifier ? MODIFIER_CODE_MAP[modifier] : null;

  if (key === 'escape') {
    return modifier === 'alt' ? '\x1b\x1b' : '\x1b';
  }
  if (key === 'tab') {
    return modifier === 'shift' ? '\x1b[Z' : '\t';
  }

  const macro = SIMPLE_MACRO_SEQUENCES.get(key);
  if (macro) {
    return macro;
  }

  const number = TILDE_KEY_CODES.get(key);
  if (number) {
    return modifierCode ? `\x1b[${number};${modifierCode}~` : `\x1b[${number}~`;
  }

  const fnFinal = FN1_TO_4_FINALS.get(key);
  if (fnFinal) {
    return modifierCode ? `\x1b[1;${modifierCode}${fnFinal}` : `\x1bO${fnFinal}`;
  }

  const final = CURSOR_KEY_FINALS.get(key);
  if (!final) {
    return '';
  }
  if (modifierCode) {
    return `\x1b[1;${modifierCode}${final}`;
  }
  return applicationCursorMode ? `\x1bO${final}` : `\x1b[${final}`;
}

export interface IOSNavigatorLike {
  userAgent: string;
  maxTouchPoints: number;
  platform?: string;
  userAgentData?: { platform?: string };
}

export function isIOSLike(navigatorLike: IOSNavigatorLike): boolean {
  const platform = navigatorLike.userAgentData?.platform ?? navigatorLike.platform ?? '';
  if (
    /iPad|iPhone|iPod/.test(navigatorLike.userAgent) ||
    /^(iOS|iPadOS|iPhone|iPad|iPod)$/i.test(platform)
  ) {
    return true;
  }
  return (
    (platform === 'MacIntel' ||
      platform === 'macOS' ||
      /\bMacintosh\b/.test(navigatorLike.userAgent)) &&
    navigatorLike.maxTouchPoints > 1
  );
}
