/**
 * 终端输出合并器（Cloudflare Worker 与 standalone 运行时共用，SSH 会话层）。
 *
 * 动机：SSH 传输层每个包到达即转发一条 WS 消息。交互回显是零星小包，
 * 但突发输出（TUI 全屏重绘、docker build 日志、tail -f、大文件 cat）会产生
 * 海量小消息，浏览器端每条消息都要过 trzsz 过滤器与 xterm 写入调度，
 * 是弱网 + 突发场景卡顿的主要来源之一。
 *
 * 策略（交互延迟优先）：
 * - 空闲（距上次冲刷 ≥ IDLE_GAP_MS）后的首包立即转发，不增加任何回显延迟；
 * - 突发期间 COALESCE_MS 窗口内的包合并为一条消息再发；
 * - 积压超过 COALESCE_MAX_BYTES 立即冲刷，缓冲有界；
 * - flush() 主动冲刷（会话优雅收尾）；reset() 丢弃未发数据并复位定时器。
 *
 * 定时器/时钟可注入（纯单测友好）；不持有 WS 或 channel 引用，
 * 发送、窗口归还等副作用全部由 send 回调完成。
 */

export const TERMINAL_OUTPUT_COALESCE_MS = 8;
export const TERMINAL_OUTPUT_IDLE_GAP_MS = 24;
export const TERMINAL_OUTPUT_COALESCE_MAX_BYTES = 256 * 1024;

export class TerminalOutputCoalescer {
  private chunks: Uint8Array[] = [];
  private pendingBytes = 0;
  private timerId: unknown = null;
  /** 上次冲刷时间；-Infinity 表示“从未冲刷”，确保会话首个包立即转发 */
  private lastFlushAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly send: (data: Uint8Array) => void,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) =>
      setTimeout(fn, ms),
    private readonly cancel: (id: unknown) => void = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    private readonly now: () => number = () => Date.now()
  ) {}

  /** 未冲刷字节数（有界性观测）。 */
  get pending(): number {
    return this.pendingBytes;
  }

  /**
   * 压入一段终端输出（stdout 的 CHANNEL_DATA 与 stderr 的 EXTENDED_DATA
   * 按到达顺序进同一队列，保持合并后相对顺序不变）。
   */
  push(data: Uint8Array): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.pendingBytes += data.length;
    const idle = this.now() - this.lastFlushAt >= TERMINAL_OUTPUT_IDLE_GAP_MS;
    if (this.pendingBytes >= TERMINAL_OUTPUT_COALESCE_MAX_BYTES || (this.timerId === null && idle)) {
      // 空闲后首包（交互回显零延迟）或积压超限：立即冲刷。
      this.flush();
      return;
    }
    if (this.timerId === null) {
      this.timerId = this.schedule(() => {
        this.timerId = null;
        this.flush();
      }, TERMINAL_OUTPUT_COALESCE_MS);
    }
  }

  /** 立即冲刷积压（若有）。 */
  flush(): void {
    if (this.timerId !== null) {
      this.cancel(this.timerId);
      this.timerId = null;
    }
    if (this.chunks.length === 0) return;
    let data: Uint8Array;
    if (this.chunks.length === 1) {
      data = this.chunks[0];
    } else {
      data = new Uint8Array(this.pendingBytes);
      let offset = 0;
      for (const chunk of this.chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
    }
    this.chunks = [];
    this.pendingBytes = 0;
    this.lastFlushAt = this.now();
    this.send(data);
  }

  /** 丢弃未发数据并复位定时器（会话销毁路径）。 */
  reset(): void {
    if (this.timerId !== null) {
      this.cancel(this.timerId);
      this.timerId = null;
    }
    this.chunks = [];
    this.pendingBytes = 0;
    this.lastFlushAt = Number.NEGATIVE_INFINITY;
  }
}
