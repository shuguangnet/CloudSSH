// sse-stream 纯函数单测：SSE 跨 chunk 分帧、坏行容错、输出裁剪。
import { describe, it, expect } from 'vitest';
import { createSseParser, capOutput } from '../frontend/src/sse-stream';

describe('createSseParser', () => {
  it('parses complete frames in a single chunk', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('data: {"type":"run_start","total":2}\n\ndata: {"type":"run_done"}\n\n');
    expect(events).toEqual([
      { type: 'run_start', total: 2 },
      { type: 'run_done' },
    ]);
  });

  it('reassembles frames split across chunk boundaries', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('data: {"type":"out');
    parser.push('put","text":"hel');
    parser.push('lo"}\n\ndata: {"type":"ru');
    parser.push('n_done"}\n\n');
    expect(events).toEqual([
      { type: 'output', text: 'hello' },
      { type: 'run_done' },
    ]);
  });

  it('flushes a trailing frame without blank line on end()', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('data: {"type":"run_done"}');
    expect(events).toEqual([]);
    parser.end();
    expect(events).toEqual([{ type: 'run_done' }]);
  });

  it('ignores comment lines, non-data lines and malformed JSON', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push(': ping\n\nid: 1\ndata: not-json\n\ndata: {"type":"run_done"}\n\n');
    expect(events).toEqual([{ type: 'run_done' }]);
  });

  it('drops frames without a type field', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('data: {"nope":1}\n\ndata: {"type":"run_start"}\n\n');
    expect(events).toEqual([{ type: 'run_start' }]);
  });

  it('handles multi-line data within one frame as separate events', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('data: {"type":"output","text":"a"}\ndata: {"type":"output","text":"b"}\n\n');
    expect(events.map((event) => (event as { text: string }).text)).toEqual(['a', 'b']);
  });
});

describe('capOutput', () => {
  it('keeps short text intact', () => {
    expect(capOutput('hello', 1024)).toBe('hello');
  });

  it('trims from the head when over the cap', () => {
    const text = 'x'.repeat(4096);
    const capped = capOutput(text, 1024);
    expect(capped.length).toBe(512);
    expect(capped).toBe(text.slice(-512));
  });

  it('defaults to 256 KiB', () => {
    const text = 'y'.repeat(300 * 1024);
    expect(capOutput(text).length).toBe(128 * 1024);
  });
});
