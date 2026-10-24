import { describe, expect, it } from 'vitest';
import {
  TERMINAL_OUTPUT_COALESCE_MS,
  TERMINAL_OUTPUT_COALESCE_MAX_BYTES,
  TERMINAL_OUTPUT_IDLE_GAP_MS,
  TerminalOutputCoalescer,
} from '../../src/worker/terminal-output-coalescer';

/** 手动时钟 + 定时器队列，模拟真实合并窗口语义。 */
function createHarness() {
  let now = 0;
  const timers: { id: number; fireAt: number; fn: () => void; fired: boolean }[] = [];
  let nextId = 1;
  const sent: Uint8Array[] = [];
  const coalescer = new TerminalOutputCoalescer(
    (data) => sent.push(data),
    (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fireAt: now + ms, fn, fired: false });
      return id;
    },
    (id) => {
      const timer = timers.find((t) => t.id === id);
      if (timer) timer.fired = true;
    },
    () => now
  );
  return {
    coalescer,
    sent,
    push: (text: string) => coalescer.push(new TextEncoder().encode(text)),
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = timers.filter((t) => !t.fired && t.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt)[0];
        if (!next) break;
        now = next.fireAt;
        next.fired = true;
        next.fn();
      }
      now = target;
    },
  };
}

describe('TerminalOutputCoalescer', () => {
  it('空闲后的首包立即转发（交互回显零延迟）', () => {
    const h = createHarness();
    h.push('echo');
    expect(h.sent).toHaveLength(1);
    expect(new TextDecoder().decode(h.sent[0])).toBe('echo');
    expect(h.coalescer.pending).toBe(0);
  });

  it('突发期间 8ms 窗口内的包合并为一条消息', () => {
    const h = createHarness();
    h.push('a'); // 空闲首包 → 立即发
    expect(h.sent).toHaveLength(1);
    h.push('b');
    h.push('c');
    h.push('d');
    // 窗口内未冲刷
    expect(h.sent).toHaveLength(1);
    expect(h.coalescer.pending).toBe(3);
    h.advance(TERMINAL_OUTPUT_COALESCE_MS);
    expect(h.sent).toHaveLength(2);
    expect(new TextDecoder().decode(h.sent[1])).toBe('bcd');
    expect(h.coalescer.pending).toBe(0);
  });

  it('stdout 与 stderr 按到达顺序合并', () => {
    const h = createHarness();
    h.push('out1'); // immediate
    h.push('err1');
    h.push('out2');
    h.advance(TERMINAL_OUTPUT_COALESCE_MS);
    expect(new TextDecoder().decode(h.sent[1])).toBe('err1out2');
  });

  it('积压超过硬上限立即冲刷，不等待窗口', () => {
    const h = createHarness();
    h.push('first'); // immediate
    const big = new Uint8Array(TERMINAL_OUTPUT_COALESCE_MAX_BYTES + 1);
    h.coalescer.push(big);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toBe(big);
  });

  it('flush 主动冲刷且空 flush 无副作用', () => {
    const h = createHarness();
    h.coalescer.flush();
    expect(h.sent).toHaveLength(0);
    h.push('x'); // immediate
    h.push('y');
    h.coalescer.flush();
    expect(h.sent).toHaveLength(2);
    expect(new TextDecoder().decode(h.sent[1])).toBe('y');
  });

  it('reset 丢弃未发数据并取消定时器', () => {
    const h = createHarness();
    h.push('a'); // immediate
    h.push('pending');
    h.coalescer.reset();
    expect(h.coalescer.pending).toBe(0);
    h.advance(TERMINAL_OUTPUT_COALESCE_MS * 4);
    expect(h.sent).toHaveLength(1);
    // reset 后回到空闲态：新包立即发
    h.push('after');
    expect(h.sent).toHaveLength(2);
    expect(new TextDecoder().decode(h.sent[1])).toBe('after');
  });

  it('合并边界与 IDLE_GAP 语义：冲刷后 24ms 内的包走窗口、之外立即发', () => {
    const h = createHarness();
    h.push('1'); // immediate（lastFlushAt=0）
    h.push('2'); // 距上次冲刷 < 24ms → 进窗口
    h.advance(TERMINAL_OUTPUT_COALESCE_MS); // flush "2"
    expect(h.sent).toHaveLength(2);
    h.advance(TERMINAL_OUTPUT_IDLE_GAP_MS);
    h.push('3'); // 距上次冲刷 ≥ 24ms → 立即发
    expect(h.sent).toHaveLength(3);
    expect(new TextDecoder().decode(h.sent[2])).toBe('3');
  });

  it('零长度包直接忽略', () => {
    const h = createHarness();
    h.coalescer.push(new Uint8Array(0));
    expect(h.sent).toHaveLength(0);
    expect(h.coalescer.pending).toBe(0);
  });
});
