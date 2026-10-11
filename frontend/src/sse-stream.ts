// SSE 流解析与文本裁剪：纯函数、零依赖（供 batch-panel 与 vitest 共用）。
// 帧格式与后端约定一致：`data: {json}\n\n`，空行分帧，注释/其他字段行忽略。

export interface BatchEvent {
  type: 'run_start' | 'server_start' | 'output' | 'server_done' | 'server_error' | 'run_done';
  total?: number;
  requested?: number;
  completed?: number;
  server_id?: number;
  name?: string;
  text?: string;
  exit_code?: number | null;
  bytes?: number;
  truncated?: boolean;
  stderr?: string;
  duration_ms?: number;
  message?: string;
}

/** SSE 帧切分器：跨 chunk 缓冲，按空行分帧，忽略非 data 行与坏 JSON。 */
export function createSseParser(onEvent: (event: BatchEvent) => void): { push: (chunk: string) => void; end: () => void } {
  let buffer = '';
  const flushFrame = (frame: string) => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const parsed = JSON.parse(line.slice(6)) as BatchEvent;
        if (parsed && typeof parsed.type === 'string') onEvent(parsed);
      } catch { /* 不完整或异常帧直接丢弃 */ }
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        flushFrame(frame);
      }
    },
    end() {
      if (buffer.trim()) flushFrame(buffer);
      buffer = '';
    },
  };
}

/** 输出上限：超限从头部截半，避免长时间命令把 DOM/内存拖爆。 */
export function capOutput(text: string, max = 256 * 1024): string {
  if (text.length <= max) return text;
  return text.slice(-Math.floor(max / 2));
}
