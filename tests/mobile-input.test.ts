import { describe, expect, it } from 'vitest';
import {
  applyMobileModifier,
  diffTextareaInput,
  isIOSLike,
  isMobileTerminalKey,
  isTerminalFocusReport,
  mobileTerminalKeySequence,
} from '../frontend/src/mobile-input';

describe('移动端 IME 输入补偿', () => {
  it('只发送 textarea 新增的标点和空格', () => {
    expect(diffTextareaInput('', '。')).toBe('。');
    expect(diffTextareaInput('中文', '中文 ')).toBe(' ');
    expect(diffTextareaInput('same', 'same')).toBe('');
  });

  it('对输入法替换和删除生成终端 DEL 序列', () => {
    expect(diffTextareaInput('ab', 'ac')).toBe('\x7fc');
    expect(diffTextareaInput('abcde', 'abXYde')).toBe('\x7f\x7f\x7fXYde');
    expect(diffTextareaInput('abc', 'a')).toBe('\x7f\x7f');
  });

  it('识别 iPhone、iPad 和触摸模式 iPadOS', () => {
    expect(
      isIOSLike({ userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5 })
    ).toBe(true);
    expect(isIOSLike({ userAgent: 'Mozilla/5.0', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      true
    );
    expect(isIOSLike({ userAgent: 'Mozilla/5.0', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      false
    );
    expect(
      isIOSLike({
        userAgent: 'Mozilla/5.0',
        maxTouchPoints: 5,
        userAgentData: { platform: 'macOS' },
      })
    ).toBe(true);
    expect(
      isIOSLike({
        userAgent: 'Mozilla/5.0',
        maxTouchPoints: 5,
        userAgentData: { platform: 'iOS' },
      })
    ).toBe(true);
    expect(
      isIOSLike({
        userAgent: 'Mozilla/5.0',
        maxTouchPoints: 0,
        userAgentData: { platform: 'macOS' },
      })
    ).toBe(false);
  });
});

describe('终端焦点报告识别', () => {
  it.each(['\x1b[I', '\x1b[O'])('只识别完整的焦点报告 %j', (data) => {
    expect(isTerminalFocusReport(data)).toBe(true);
  });

  it('不把方向键、Alt、粘贴、文本或拼接序列误识别为焦点报告', () => {
    for (const data of [
      '', 'I', 'O', '\x1b[A', '\x1b[1;5A', '\x1b[5~', '\x1bx',
      '\x1b[200~text\x1b[201~', '\x1b[Itext', '\x1b[I\x1b[O', '\x9bI',
    ]) {
      expect(isTerminalFocusReport(data)).toBe(false);
    }
  });
});

describe('移动端一次性修饰键', () => {
  it('将 Ctrl 字母转换成控制字符并在成功后消费状态', () => {
    expect(applyMobileModifier('c', 'ctrl')).toEqual({ data: '\x03', consumed: true });
    expect(applyMobileModifier('b', 'ctrl')).toEqual({ data: '\x02', consumed: true });
    expect(applyMobileModifier('[', 'ctrl')).toEqual({ data: '\x1b', consumed: true });
  });

  it('Alt 添加 ESC 前缀，Ctrl 保留不支持的文本但消费一次性状态', () => {
    expect(applyMobileModifier('x', 'alt')).toEqual({ data: '\x1bx', consumed: true });
    expect(applyMobileModifier(' ', 'ctrl')).toEqual({ data: '\x00', consumed: true });
    expect(applyMobileModifier('中文', 'ctrl')).toEqual({ data: '中文', consumed: true });
    expect(applyMobileModifier('ß', 'ctrl')).toEqual({ data: 'ß', consumed: true });
    expect(applyMobileModifier('x', null)).toEqual({ data: 'x', consumed: false });
  });

  it('Shift 支持字母大写、符号映射与 Tab 转 Backtab', () => {
    expect(applyMobileModifier('a', 'shift')).toEqual({ data: 'A', consumed: true });
    expect(applyMobileModifier('z', 'shift')).toEqual({ data: 'Z', consumed: true });
    expect(applyMobileModifier('1', 'shift')).toEqual({ data: '!', consumed: true });
    expect(applyMobileModifier('/', 'shift')).toEqual({ data: '?', consumed: true });
    expect(applyMobileModifier('\t', 'shift')).toEqual({ data: '\x1b[Z', consumed: true });
  });

  it('根据 application cursor mode 和修饰键生成与 xterm 一致的功能键序列', () => {
    expect(mobileTerminalKeySequence('arrow_up', false, null)).toBe('\x1b[A');
    expect(mobileTerminalKeySequence('arrow_up', true, null)).toBe('\x1bOA');
    expect(mobileTerminalKeySequence('arrow_left', true, 'ctrl')).toBe('\x1b[1;5D');
    expect(mobileTerminalKeySequence('arrow_right', false, 'shift')).toBe('\x1b[1;2C');
    expect(mobileTerminalKeySequence('home', true, 'alt')).toBe('\x1b[1;3H');
    expect(mobileTerminalKeySequence('page_up', false, 'ctrl')).toBe('\x1b[5;5~');
    expect(mobileTerminalKeySequence('escape', false, 'alt')).toBe('\x1b\x1b');

    // Delete 与 Insert
    expect(mobileTerminalKeySequence('delete', false, null)).toBe('\x1b[3~');
    expect(mobileTerminalKeySequence('delete', false, 'shift')).toBe('\x1b[3;2~');
    expect(mobileTerminalKeySequence('insert', false, null)).toBe('\x1b[2~');

    // F1–F12 功能键
    expect(mobileTerminalKeySequence('f1', false, null)).toBe('\x1bOP');
    expect(mobileTerminalKeySequence('f2', false, null)).toBe('\x1bOQ');
    expect(mobileTerminalKeySequence('f3', false, null)).toBe('\x1bOR');
    expect(mobileTerminalKeySequence('f3', false, 'shift')).toBe('\x1b[1;2R');
    expect(mobileTerminalKeySequence('f3', false, 'ctrl')).toBe('\x1b[1;5R');
    expect(mobileTerminalKeySequence('f4', false, null)).toBe('\x1bOS');
    expect(mobileTerminalKeySequence('f5', false, null)).toBe('\x1b[15~');
    expect(mobileTerminalKeySequence('f5', false, 'shift')).toBe('\x1b[15;2~');
    expect(mobileTerminalKeySequence('f10', false, null)).toBe('\x1b[21~');
    expect(mobileTerminalKeySequence('f12', false, null)).toBe('\x1b[24~');

    // 常用快捷宏
    expect(mobileTerminalKeySequence('ctrl_c', false, null)).toBe('\x03');
    expect(mobileTerminalKeySequence('ctrl_d', false, null)).toBe('\x04');
    expect(mobileTerminalKeySequence('backtab', false, null)).toBe('\x1b[Z');
  });

  it('isMobileTerminalKey 正确识别全部扩展终端功能键', () => {
    expect(isMobileTerminalKey('f3')).toBe(true);
    expect(isMobileTerminalKey('delete')).toBe(true);
    expect(isMobileTerminalKey('insert')).toBe(true);
    expect(isMobileTerminalKey('arrow_up')).toBe(true);
    expect(isMobileTerminalKey('custom_key')).toBe(false);
  });
});
