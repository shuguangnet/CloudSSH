/**
 * 移动端快捷键（Mobile Terminal Shortcuts）共享定义与校验模式。
 *
 * Worker（/api/user/mobile-shortcuts → UserDBDO）与前端共用同一套模式与限额定义，
 * 确保云端持久化、数据校验与本地渲染语义保持一致。
 */

/** 最多允许配置的快捷键总数。 */
export const MAX_MOBILE_SHORTCUTS = 40;
/** 快捷键云端存储最大字节数（16 KB）。 */
export const SHORTCUTS_MAX_BYTES = 16384;
/** 自定义快捷键标签最大长度（Unicode 码点）。 */
export const SHORTCUT_LABEL_MAX_LENGTH = 8;
/** 自定义快捷键发送内容最大长度（Unicode 码点）。 */
export const SHORTCUT_VALUE_MAX_LENGTH = 64;

export type MobileShortcutType = 'key' | 'modifier' | 'action' | 'text';

export interface MobileShortcutItem {
  id: string;
  label?: string;
  type?: MobileShortcutType;
  value?: string;
}

export interface MobileShortcutsPayload {
  shortcuts: MobileShortcutItem[];
}

export interface PresetShortcutDefinition {
  id: string;
  category: 'modifier' | 'edit' | 'nav' | 'fn' | 'symbol' | 'action';
  label: string;
  type: MobileShortcutType;
  icon?: string;
  i18nTitle?: string;
  value?: string;
}

/** 所有支持的内置预设快捷键。 */
export const PRESET_SHORTCUTS: PresetShortcutDefinition[] = [
  // 1. 修饰键 (Modifiers)
  { id: 'ctrl', category: 'modifier', label: 'Ctrl', type: 'modifier' },
  { id: 'alt', category: 'modifier', label: 'Alt', type: 'modifier' },
  { id: 'shift', category: 'modifier', label: 'Shift', type: 'modifier' },

  // 2. 常用编辑与控制键 (Edit & Control)
  { id: 'escape', category: 'edit', label: 'Esc', type: 'key' },
  { id: 'tab', category: 'edit', label: 'Tab', type: 'key' },
  { id: 'backtab', category: 'edit', label: 'Backtab', type: 'key' }, // Shift+Tab
  { id: 'delete', category: 'edit', label: 'Del', type: 'key' },
  { id: 'insert', category: 'edit', label: 'Ins', type: 'key' },
  { id: 'ctrl_c', category: 'edit', label: '^C', type: 'key', value: '\x03' },
  { id: 'ctrl_d', category: 'edit', label: '^D', type: 'key', value: '\x04' },
  { id: 'ctrl_z', category: 'edit', label: '^Z', type: 'key', value: '\x1a' },
  { id: 'ctrl_l', category: 'edit', label: '^L', type: 'key', value: '\x0c' },

  // 3. 方向与导航键 (Navigation)
  {
    id: 'arrow_left',
    category: 'nav',
    label: '←',
    icon: 'arrow_back',
    type: 'key',
    i18nTitle: 'terminal.arrowLeft',
  },
  {
    id: 'arrow_up',
    category: 'nav',
    label: '↑',
    icon: 'arrow_upward',
    type: 'key',
    i18nTitle: 'terminal.arrowUp',
  },
  {
    id: 'arrow_down',
    category: 'nav',
    label: '↓',
    icon: 'arrow_downward',
    type: 'key',
    i18nTitle: 'terminal.arrowDown',
  },
  {
    id: 'arrow_right',
    category: 'nav',
    label: '→',
    icon: 'arrow_forward',
    type: 'key',
    i18nTitle: 'terminal.arrowRight',
  },
  { id: 'home', category: 'nav', label: 'Home', type: 'key' },
  { id: 'end', category: 'nav', label: 'End', type: 'key' },
  { id: 'page_up', category: 'nav', label: 'PgUp', type: 'key' },
  { id: 'page_down', category: 'nav', label: 'PgDn', type: 'key' },

  // 4. 功能键 (F1–F12)
  { id: 'f1', category: 'fn', label: 'F1', type: 'key' },
  { id: 'f2', category: 'fn', label: 'F2', type: 'key' },
  { id: 'f3', category: 'fn', label: 'F3', type: 'key' },
  { id: 'f4', category: 'fn', label: 'F4', type: 'key' },
  { id: 'f5', category: 'fn', label: 'F5', type: 'key' },
  { id: 'f6', category: 'fn', label: 'F6', type: 'key' },
  { id: 'f7', category: 'fn', label: 'F7', type: 'key' },
  { id: 'f8', category: 'fn', label: 'F8', type: 'key' },
  { id: 'f9', category: 'fn', label: 'F9', type: 'key' },
  { id: 'f10', category: 'fn', label: 'F10', type: 'key' },
  { id: 'f11', category: 'fn', label: 'F11', type: 'key' },
  { id: 'f12', category: 'fn', label: 'F12', type: 'key' },

  // 5. 常用符号 (Symbols)
  { id: '/', category: 'symbol', label: '/', type: 'key', value: '/' },
  { id: '-', category: 'symbol', label: '-', type: 'key', value: '-' },
  { id: '_', category: 'symbol', label: '_', type: 'key', value: '_' },
  { id: '|', category: 'symbol', label: '|', type: 'key', value: '|' },
  { id: '~', category: 'symbol', label: '~', type: 'key', value: '~' },
  { id: ':', category: 'symbol', label: ':', type: 'key', value: ':' },
  { id: '*', category: 'symbol', label: '*', type: 'key', value: '*' },
  { id: '&', category: 'symbol', label: '&', type: 'key', value: '&' },

  // 6. 系统操作 (Actions)
  {
    id: 'copy',
    category: 'action',
    label: 'Copy',
    icon: 'content_copy',
    type: 'action',
    i18nTitle: 'terminal.copySelection',
  },
  {
    id: 'paste',
    category: 'action',
    label: 'Paste',
    icon: 'content_paste',
    type: 'action',
    i18nTitle: 'terminal.paste',
  },
  {
    id: 'keyboard_hide',
    category: 'action',
    label: 'Hide',
    icon: 'keyboard_hide',
    type: 'action',
    i18nTitle: 'terminal.hideKeyboard',
  },
];

export const PRESET_SHORTCUT_MAP = new Map<string, PresetShortcutDefinition>(
  PRESET_SHORTCUTS.map((item) => [item.id, item])
);

/** 默认移动端快捷键配置 ID 列表（保持与原始写死布局完全对齐）。 */
export const DEFAULT_MOBILE_SHORTCUT_IDS: readonly string[] = Object.freeze([
  'escape',
  'tab',
  'ctrl',
  'alt',
  'copy',
  'paste',
  'keyboard_hide',
  'arrow_left',
  'arrow_up',
  'arrow_down',
  'arrow_right',
  'home',
  'end',
  'page_up',
  'page_down',
  '/',
  '-',
  '_',
  '|',
  '~',
]);

/** 构造默认配置数据对象。 */
export function buildDefaultMobileShortcuts(): MobileShortcutsPayload {
  return {
    shortcuts: DEFAULT_MOBILE_SHORTCUT_IDS.map((id) => {
      const preset = PRESET_SHORTCUT_MAP.get(id);
      const item: MobileShortcutItem = {
        id,
        label: preset?.label ?? id,
        type: preset?.type ?? 'key',
      };
      if (preset?.value) {
        item.value = preset.value;
      }
      return item;
    }),
  };
}

function extractRawShortcuts(input: unknown): unknown[] | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  if (Array.isArray(input)) {
    return input;
  }
  if ('shortcuts' in input && Array.isArray((input as Record<string, unknown>).shortcuts)) {
    return (input as Record<string, unknown>).shortcuts as unknown[];
  }
  return null;
}

function normalizePresetShortcutItem(
  id: string,
  rawItem: Record<string, unknown>,
  preset: PresetShortcutDefinition
): MobileShortcutItem {
  let label = preset.label;
  const rawLabel = rawItem.label;
  if (typeof rawLabel === 'string') {
    const trimmedLabel = rawLabel.trim();
    if (trimmedLabel && [...trimmedLabel].length <= SHORTCUT_LABEL_MAX_LENGTH) {
      label = trimmedLabel;
    }
  }

  const result: MobileShortcutItem = {
    id,
    label,
    type: preset.type,
  };
  if (preset.value) {
    result.value = preset.value;
  }
  return result;
}

function normalizeCustomShortcutItem(
  id: string,
  rawItem: Record<string, unknown>
): MobileShortcutItem | null {
  const isCustomId = id.startsWith('custom_') || id.startsWith('c_');
  const itemType = rawItem.type;
  if (!isCustomId && itemType !== 'text') {
    return null;
  }

  const rawLabel = rawItem.label;
  const rawValue = rawItem.value;
  if (typeof rawLabel !== 'string' || typeof rawValue !== 'string') {
    return null;
  }

  const label = rawLabel.trim();
  const value = rawValue;
  if (!label || [...label].length > SHORTCUT_LABEL_MAX_LENGTH) {
    return null;
  }
  if (!value || [...value].length > SHORTCUT_VALUE_MAX_LENGTH) {
    return null;
  }

  return {
    id,
    label,
    type: 'text',
    value,
  };
}

function normalizeSingleShortcutItem(item: unknown): MobileShortcutItem | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const rawItem = item as Record<string, unknown>;
  const rawId = rawItem.id;
  if (typeof rawId !== 'string') {
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }

  const preset = PRESET_SHORTCUT_MAP.get(id);
  if (preset) {
    return normalizePresetShortcutItem(id, rawItem, preset);
  }
  return normalizeCustomShortcutItem(id, rawItem);
}

/**
 * 校验并规范化用户提交的移动端快捷键数据。
 *
 * 规范：
 * 1. 根对象必须是 `{ shortcuts: [...] }` 或直接是快捷键数组；
 * 2. 快捷键总数在 1 ~ MAX_MOBILE_SHORTCUTS 之间；
 * 3. 每个元素如果是内置预设 ID，自动填充或继承预设属性，允许覆盖合规的自定义 label；
 * 4. 如果是自定义按键（type === 'text' 或 id 以 'custom_' 开头），必须具备合法 label (1-8 字符) 和 value (1-64 字符)；
 * 5. 任何不合规项都会导致整批拒绝并返回 null（fail closed）。
 */
export function normalizeMobileShortcutsPayload(input: unknown): MobileShortcutsPayload | null {
  const rawShortcuts = extractRawShortcuts(input);
  if (!rawShortcuts || rawShortcuts.length === 0 || rawShortcuts.length > MAX_MOBILE_SHORTCUTS) {
    return null;
  }

  const normalized: MobileShortcutItem[] = [];
  for (const item of rawShortcuts) {
    const itemResult = normalizeSingleShortcutItem(item);
    if (!itemResult) {
      return null;
    }
    normalized.push(itemResult);
  }

  return { shortcuts: normalized };
}
