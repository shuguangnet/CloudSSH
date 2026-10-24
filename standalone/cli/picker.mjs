/**
 * 手写 ANSI 选择器。
 *
 * 为什么不用 Ink / Blessed：本项目已经有一套极简 ANSI 风格（standalone/*.html
 * 的终端页面），而 TUI 框架会重新翻译 ANSI 序列——`cssh ssh` 之后的 SSH
 * 流是「原样透传的字节」，一旦被框架拦截重排，宽度、颜色、光标位置全乱。
 * 而且零依赖是这个项目一贯的取向（只复用已有的 `ws`）。
 *
 * 交互约定（尽量贴近 fzf / gh 的手感，减少学习成本）：
 *   ↑/↓ 或 k/j   移动
 *   Enter        选中
 *   Esc / Ctrl+C 取消（退出码 130）
 *   输入字符      模糊过滤
 *   Backspace     删除过滤字符
 *   Ctrl+U       清空过滤
 *   Home/End     跳首/跳尾
 *
 * 非 TTY 一律拒绝而不是降级成「打印列表」——静默降级会让人以为
 * 交互选择成功了，实际上什么都没连。
 */

import { normalize } from './match.mjs';

const CSI = '\x1b[';
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;

export class PickerError extends Error {}

/** 可选条目在显示层的字段。 */
function columns(item) {
  const tags = Array.isArray(item.tags) && item.tags.length ? item.tags.join(',') : '';
  return {
    id: String(item.id).padStart(3),
    name: item.name || '',
    target: `${item.username}@${item.host}:${item.port}`,
    tags,
  };
}

/** 把过滤词按空白切分，全部命中才算——多词交集比「整串子串」好用得多。 */
function filterItems(items, filter) {
  const terms = normalize(filter).split('-').filter(Boolean);
  if (!terms.length) return items;
  return items.filter((item) => {
    const text = normalize(
      [item.id, item.name, item.host, item.username, item.os, ...(item.tags || [])].join('-')
    );
    return terms.every((term) => text.includes(term));
  });
}

/**
 * 渲染选择器。返回被选中的条目，取消时返回 null。
 *
 * @param {object} options
 * @param {object[]} options.items      必选：服务器列表
 * @param {string}   options.title      标题行
 * @param {string}   options.filter     初始过滤词（多命中时预筛）
 * @param {NodeJS.ReadStream}  options.input
 * @param {NodeJS.WriteStream} options.output
 */
export function pick(options) {
  const {
    items, title = '选择服务器', filter: initialFilter = '',
    input = process.stdin, output = process.stdout,
  } = options;

  if (!input.isTTY || !output.isTTY) {
    throw new PickerError('交互选择需要真正的终端；请改用 cssh <名称> 或 cssh ls');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new PickerError('没有可选的服务器');
  }

  return new Promise((resolve, reject) => {
    let filter = initialFilter;
    let cursor = 0;
    let visible = [];
    let rows = 0;
    const width = () => Math.max(40, output.columns || 80);

    const write = (text) => output.write(text);
    const clearScreen = () => write(`${CSI}2J${CSI}H`);
    const moveTo = (row, column = 1) => write(`${CSI}${row};${column}H`);

    function computeVisible() {
      visible = filterItems(items, filter);
      if (cursor >= visible.length) cursor = Math.max(0, visible.length - 1);
    }

    function render() {
      computeVisible();
      const maxRows = Math.max(4, Math.min(visible.length + 6, (output.rows || 24) - 2));
      const w = width();
      const lines = [];

      lines.push(`\x1b[1m${title}\x1b[0m ${`\x1b[2m(${visible.length}/${items.length})\x1b[0m`}`);
      lines.push(`\x1b[2m${'─'.repeat(Math.min(w - 1, 70))}\x1b[0m`);
      lines.push(`\x1b[36m>\x1b[0m ${filter}\x1b[7m \x1b[0m`);
      lines.push('');

      if (visible.length === 0) {
        lines.push('\x1b[33m没有匹配的服务器\x1b[0m');
      } else {
        // 滚动窗口：始终让选中项落在可见区内，且尽量居中。
        const windowSize = Math.max(4, maxRows - 6);
        let start = 0;
        if (visible.length > windowSize) {
          start = Math.min(Math.max(0, cursor - Math.floor(windowSize / 2)),
            visible.length - windowSize);
        }
        const end = Math.min(visible.length, start + windowSize);
        for (let index = start; index < end; index++) {
          const item = visible[index];
          const cell = columns(item);
          const marker = index === cursor ? '\x1b[36m❯\x1b[0m' : ' ';
          const nameStyle = index === cursor ? '\x1b[1;36m' : '';
          const reset = index === cursor ? '\x1b[0m' : '';
          const tags = cell.tags ? ` \x1b[2m[${cell.tags}]\x1b[0m` : '';
          const line = `${marker} ${cell.id} ${nameStyle}${cell.name}${reset} `
            + `\x1b[2m${cell.target}\x1b[0m${tags}`;
          lines.push(truncate(line, w));
        }
      }

      lines.push('');
      lines.push('\x1b[2m↑↓/jk 移动  Enter 连接  输入过滤  Esc 取消\x1b[0m');

      moveTo(1);
      write(lines.join(`${CSI}K\r\n`));
      write(`${CSI}K`);
      rows = lines.length;
    }

    function cleanup() {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      write(SHOW_CURSOR);
      clearScreen();
      write(ALT_SCREEN_OFF);
    }

    function finish(value) {
      cleanup();
      resolve(value);
    }

    function cancel() {
      cleanup();
      const error = new PickerError('已取消');
      error.exitCode = 130;
      reject(error);
    }

    function onData(chunk) {
      const text = chunk.toString('utf8');
      let index = 0;
      let dirty = false;
      while (index < text.length) {
        const char = text[index];
        // 方向键等 CSI 序列：ESC [ A/B/C/D
        if (char === '\x1b') {
          if (text[index + 1] === '[') {
            const code = text[index + 2];
            index += 3;
            if (code === 'A') { cursor = Math.max(0, cursor - 1); dirty = true; continue; }
            if (code === 'B') { cursor = Math.min(visible.length - 1, cursor + 1); dirty = true; continue; }
            if (code === 'H') { cursor = 0; dirty = true; continue; }
            if (code === 'F') { cursor = Math.max(0, visible.length - 1); dirty = true; continue; }
            continue;
          }
          if (text[index + 1] === 'O') { index += 3; continue; }
          cancel(); return;
        }
        index++;
        if (char === '\r' || char === '\n') {
          const chosen = visible[cursor];
          if (chosen) { finish(chosen); return; }
          continue;
        }
        if (char === '\x03') { cancel(); return; }           // Ctrl+C
        if (char === '\x04') { cancel(); return; }           // Ctrl+D
        if (char === '\x15') { filter = ''; cursor = 0; dirty = true; continue; }  // Ctrl+U
        if (char === '\x7f' || char === '\b') {              // Backspace
          filter = filter.slice(0, -1); cursor = 0; dirty = true; continue;
        }
        if (char === 'j' && !filter) { cursor = Math.min(visible.length - 1, cursor + 1); dirty = true; continue; }
        if (char === 'k' && !filter) { cursor = Math.max(0, cursor - 1); dirty = true; continue; }
        // 其余可打印字符进过滤词。控制字符一律丢弃。
        if (char >= ' ' && char !== '\x7f') { filter += char; cursor = 0; dirty = true; }
      }
      if (dirty) render();
    }

    write(ALT_SCREEN_ON);
    write(HIDE_CURSOR);
    clearScreen();
    computeVisible();
    // 初始过滤命中唯一时直接渲染（不自动选中，让用户确认）。
    render();

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    output.on('resize', render);

    // 兜底：进程被信号杀掉时恢复终端，否则光标会一直锁在隐藏状态。
    const restore = () => { try { cleanup(); } catch { /* 已清理 */ } };
    process.once('exit', restore);
    process.once('SIGINT', () => { cancel(); });
  });
}

/** 字符是否占两列（CJK / 全角标点）。 */
function isDoubleWidth(code) {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6);
}

/** 按显示列数计算宽度，ANSI 转义序列不计入。 */
export function displayWidth(text) {
  let width = 0;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\x1b') {
      const match = /^\x1b\[[0-9;]*[A-Za-z]/.exec(source.slice(index));
      if (match) { index += match[0].length - 1; continue; }
    }
    width += isDoubleWidth(source.codePointAt(index)) ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度截断。
 *
 * 规则：
 *   - ANSI 转义序列整体保留，不占宽度；
 *   - CJK 按两列算，避免中文名把行撑破；
 *   - 只有真的截掉了内容才追 `…`（正好装下时不加，否则表格每格都带省略号）。
 *     未截断时原样返回，一个字节都不改。
 */
export function truncate(text, maxWidth) {
  const source = String(text ?? '');
  if (maxWidth <= 0) return '';
  let width = 0;
  let out = '';
  let cut = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\x1b') {
      const match = /^\x1b\[[0-9;]*[A-Za-z]/.exec(source.slice(index));
      if (match) { out += match[0]; index += match[0].length - 1; continue; }
    }
    const step = isDoubleWidth(source.codePointAt(index)) ? 2 : 1;
    if (width + step > maxWidth) { cut = true; break; }
    width += step;
    out += char;
  }
  if (!cut) return out;
  // 截断必须看得见：用 … 顶替最后一个字符，而不追加。
  // 追加会溢出 maxWidth（表格错位），而静默截断会让人以为名字就长这样。
  while (out && width + 1 > maxWidth) {
    // 退一个字符（可能是双宽的，所以按显示宽度回退而不是按字节）。
    let taken = 0;
    for (let index = out.length - 1; index >= 0; index--) {
      if (out[index] === 'm' && /\x1b\[[0-9;]*[A-Za-z]$/.test(out.slice(0, index + 1))) {
        // 尾部转义序列：整段一起退掉，别把半截 ANSI 留下。
        const start = out.lastIndexOf('\x1b', index);
        out = out.slice(0, start);
        break;
      }
      taken = isDoubleWidth(out.codePointAt(index)) ? 2 : 1;
      out = out.slice(0, index);
      break;
    }
    if (!taken) break;
    width -= taken;
  }
  // 被截掉的尾部可能带着 reset（\x1b[0m）；不补回去的话颜色会&quot;漏&quot;到
  // 后续行（整块面板都变红这种错觉）。补一个重置是零成本保险。
  const needsReset = source.includes('\x1b[') && !/(\x1b\[(0|39|m)?m|\x1b\[0m)$/.test(out);
  return `${out}…${needsReset ? '\x1b[0m' : ''}`;
}
