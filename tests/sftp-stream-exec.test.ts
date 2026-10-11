import { describe, expect, it } from 'vitest';
import {
  buildFindCommand,
  buildTarCommand,
  normalizeRemotePath,
  shellQuote,
} from '../src/worker/sftp-handler';
import { StreamingExecChannel } from '../src/worker/streaming-exec-channel';

describe('shellQuote', () => {
  it('wraps plain values in single quotes', () => {
    expect(shellQuote('nginx:alpine')).toBe("'nginx:alpine'");
  });

  it('escapes embedded single quotes with the POSIX recipe', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralizes substitution and command chaining', () => {
    const quoted = shellQuote('$(rm -rf /); `id`');
    // 安全依赖整体单引号包裹：内部字符原样传递，不会被 shell 解释
    expect(quoted).toBe("'$(rm -rf /); `id`'");
    expect(quoted.startsWith("'")).toBe(true);
  });
});

describe('normalizeRemotePath', () => {
  it('strips trailing slashes', () => {
    expect(normalizeRemotePath('/var/log/')).toBe('/var/log');
    expect(normalizeRemotePath('/var/log///')).toBe('/var/log');
  });

  it('keeps the root path as-is', () => {
    expect(normalizeRemotePath('/')).toBe('/');
  });

  it('rejects empty and whitespace-only paths', () => {
    expect(normalizeRemotePath('')).toBe('');
    expect(normalizeRemotePath('   ')).toBe('');
  });

  it('throws on NUL and newline smuggled inside the path', () => {
    expect(() => normalizeRemotePath('/etc/\npasswd')).toThrow();
    expect(() => normalizeRemotePath('/etc/\0passwd')).toThrow();
  });
});

describe('buildTarCommand', () => {
  it('archives relative to the parent directory', () => {
    expect(buildTarCommand('/var/log/nginx')).toBe("tar czf - -C '/var/log' 'nginx'");
  });

  it('handles directories directly under root', () => {
    expect(buildTarCommand('/etc')).toBe("tar czf - -C '/' 'etc'");
  });

  it('refuses the root directory and oversized paths', () => {
    expect(() => buildTarCommand('/')).toThrow(/根目录/);
    expect(() => buildTarCommand('/'.padEnd(5000, 'a'))).toThrow(/路径过长/);
  });

  it('single-quotes tricky directory names', () => {
    expect(buildTarCommand('/srv/my data;rm')).toBe("tar czf - -C '/srv' 'my data;rm'");
  });
});

describe('buildFindCommand', () => {
  it('searches the directory with -xdev, bounded depth and head', () => {
    const command = buildFindCommand('/srv', 'nginx', 4);
    expect(command).toContain("find '/srv'");
    expect(command).toContain('-xdev -maxdepth 4');
    expect(command).toContain("-iname '*nginx*'");
    expect(command).toContain('head -n 300');
  });

  it('clamps depth into 1..8', () => {
    expect(buildFindCommand('/srv', 'x', 99)).toContain('-maxdepth 8');
    expect(buildFindCommand('/srv', 'x', 0)).toContain('-maxdepth 1');
    expect(buildFindCommand('/srv', 'x')).toContain('-maxdepth 4');
  });

  it('rejects empty patterns', () => {
    expect(() => buildFindCommand('/srv', '   ')).toThrow(/不能为空/);
  });

  it('rejects shell metacharacters but keeps glob syntax and CJK', () => {
    expect(() => buildFindCommand('/srv', 'a;id')).toThrow();
    expect(() => buildFindCommand('/srv', "a'b")).toThrow();
    expect(() => buildFindCommand('/srv', '$x')).toThrow();
    expect(buildFindCommand('/srv', '日志*')).toContain('日志*');
    expect(buildFindCommand('/srv', 'app?.log')).toContain('app?.log');
  });

  it('defaults the search root to the working directory', () => {
    expect(buildFindCommand('', 'conf')).toContain("find '.'");
  });
});

describe('StreamingExecChannel', () => {
  function makeChannel() {
    const chunks: Uint8Array[] = [];
    const channel = new StreamingExecChannel(7, {
      onChunk: (data) => {
        chunks.push(data);
        return true;
      },
    });
    return { channel, chunks };
  }

  it('forwards stdout chunks and resolves with exit code and stderr', () => {
    const { channel, chunks } = makeChannel();
    channel.onOpenConfirmation();
    expect(channel.onData(new Uint8Array([1, 2, 3]))).toBe(true);
    channel.onExtendedData(new TextEncoder().encode('warn'));
    channel.onExitStatus(0);
    channel.onClose();

    expect(chunks.map((chunk) => Array.from(chunk))).toEqual([[1, 2, 3]]);
    expect(channel.getClosedPromise()).resolves.toEqual({
      exitCode: 0,
      stderr: 'warn',
      truncated: false,
    });
  });

  it('reports truncated when the consumer hits its cap', async () => {
    let calls = 0;
    const channel = new StreamingExecChannel(8, {
      onChunk: () => ++calls <= 1, // allow the first chunk, refuse the second
    });
    channel.onOpenConfirmation();
    channel.onData(new Uint8Array([1]));
    expect(channel.onData(new Uint8Array([2]))).toBe(false);
    channel.onExitStatus(0);
    channel.onClose();

    const result = await channel.getClosedPromise();
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('resolves with an error when the channel open is rejected', async () => {
    const channel = new StreamingExecChannel(9, { onChunk: () => true });
    channel.onChannelOpenFailure(2, 'nope');
    expect(channel.isOpenFailed()).toBe(true);
    const result = await channel.getClosedPromise();
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('nope');
  });

  it('caps retained stderr at 8 KiB', async () => {
    const channel = new StreamingExecChannel(10, { onChunk: () => true });
    channel.onOpenConfirmation();
    channel.onExtendedData(new Uint8Array(16 * 1024).fill(0x61));
    channel.onExitStatus(1);
    channel.onClose();
    const result = await channel.getClosedPromise();
    expect(result.stderr.length).toBeLessThanOrEqual(8 * 1024 + 16);
  });
});
