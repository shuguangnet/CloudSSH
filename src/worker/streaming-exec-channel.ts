// Streaming exec channel — same dispatcher interface as AgentExecChannel, but
// stdout is forwarded to the caller chunk-by-chunk instead of being captured.
// Used for binary streams (directory tar.gz downloads) where string decoding
// would corrupt the payload and capture limits are pointless.

export interface StreamExecResult {
  exitCode: number;
  stderr: string;
  /** true when the caller aborted after maxBytes — the channel was force-closed. */
  truncated: boolean;
}

export interface StreamingExecCallbacks {
  /** Receive one stdout chunk. Return false to abort the stream (size cap). */
  onChunk: (data: Uint8Array) => boolean;
  /** Abort signal; rejection triggers channel teardown like a timeout. */
  signal?: AbortSignal;
}

const MAX_STDERR_BYTES = 8 * 1024;

export class StreamingExecChannel {
  private channelID: number;
  private exitCode: number = -1;
  private closed: boolean = false;
  private closedResolve!: (result: StreamExecResult) => void;
  private closedPromise: Promise<StreamExecResult>;
  private openConfirmed: boolean = false;

  private stderrBytes: Uint8Array[] = [];
  private stderrLength: number = 0;
  private truncated: boolean = false;

  constructor(
    channelID: number,
    private readonly callbacks: StreamingExecCallbacks
  ) {
    this.channelID = channelID;
    this.closedPromise = new Promise<StreamExecResult>((resolve) => {
      this.closedResolve = resolve;
    });
  }

  getChannelID(): number {
    return this.channelID;
  }

  getClosedPromise(): Promise<StreamExecResult> {
    return this.closedPromise;
  }

  isOpenConfirmed(): boolean {
    return this.openConfirmed;
  }

  isOpenFailed(): boolean {
    return this.closed && !this.openConfirmed;
  }

  /** Dispatcher contract: false → stop window adjusts and terminate the channel. */
  onData(data: Uint8Array): boolean {
    const keepGoing = this.callbacks.onChunk(data);
    if (!keepGoing) this.truncated = true;
    return keepGoing;
  }

  onExtendedData(data: Uint8Array): boolean {
    const room = MAX_STDERR_BYTES - this.stderrLength;
    if (room > 0) {
      // 超出 8 KiB 预算的部分直接丢弃，避免异常进程刷屏拖垮内存。
      this.stderrBytes.push(data.subarray(0, room));
      this.stderrLength += Math.min(room, data.length);
    }
    return true;
  }

  onExitStatus(exitCode: number): void {
    this.exitCode = exitCode;
  }

  onEof(): void {
    // EOF received but channel not closed yet — wait for close
  }

  onOpenConfirmation(): void {
    this.openConfirmed = true;
  }

  onChannelOpenFailure(reasonCode: number, description: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedResolve({
      exitCode: -1,
      stderr: `Channel open failed (reason=${reasonCode}): ${description}`,
      truncated: false,
    });
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
    this.closedResolve({
      exitCode: this.exitCode,
      stderr: decoder.decode(concatChunks(this.stderrBytes, this.stderrLength)),
      truncated: this.truncated,
    });
  }

  /** Called by the session when the caller aborted (signal/timeout): resolve now. */
  resolveAborted(): void {
    if (!this.closed) {
      this.truncated = true;
      this.onClose();
    }
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
