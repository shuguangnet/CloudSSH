import { describe, expect, it } from 'vitest';
import { SFTPHandler } from '../src/worker/sftp-handler';
import type { StreamExecFn } from '../src/worker/sftp-handler';

/**
 * 协议级测试：不建立真实 SSH 连接，用假 streamExec 驱动 SFTPHandler，
 * 验证目录打包下载与远端搜索对前端的消息序列。
 */

interface Captured {
  json: any[];
  binary: Uint8Array[];
}

function makeHandler(streamExec: StreamExecFn): { handler: SFTPHandler; captured: Captured } {
  const captured: Captured = { json: [], binary: [] };
  const handler = new SFTPHandler(
    1, // channelID
    { isClosed: () => true } as never, // channel：打包/搜索路径不触碰 SFTP 通道
    async () => {}, // sendEncrypted
    (msg) => captured.json.push(msg),
    (data) => captured.binary.push(data),
    () => {},
    false,
    undefined,
    false,
    streamExec
  );
  return { handler, captured };
}

function tarStream(): StreamExecFn {
  return async (command, options) => {
    expect(command).toBe("tar czf - -C '/srv' 'site'");
    options.onChunk(new Uint8Array([0x1f, 0x8b])); // gzip magic
    options.onChunk(new Uint8Array([0x08, 0x00]));
    return { exitCode: 0, stderr: '', truncated: false };
  };
}

describe('SFTPHandler.downloadDirectory protocol', () => {
  it('streams tar output through download messages', async () => {
    const { handler, captured } = makeHandler(tarStream());
    await handler.downloadDirectory('/srv/site');

    expect(captured.json[0]).toEqual({ type: 'sftp_download_start', filename: 'site.tar.gz', size: 0 });
    expect(Array.from(captured.binary[0])).toEqual([0x1f, 0x8b]);
    expect(Array.from(captured.binary[1])).toEqual([0x08, 0x00]);
    expect(captured.json.at(-1)).toEqual({
      type: 'sftp_download_done',
      filename: 'site.tar.gz',
      size: 4,
    });
  });

  it('emits a failed download and error when tar exits non-zero', async () => {
    const { handler, captured } = makeHandler(async () => ({
      exitCode: 2,
      stderr: 'tar: cannot open',
      truncated: false,
    }));
    await handler.downloadDirectory('/srv/missing');

    const failed = captured.json.find((m) => m.type === 'sftp_download_failed');
    expect(failed).toEqual({ type: 'sftp_download_failed', reason: 'remote_error' });
    const error = captured.json.find((m) => m.type === 'sftp_error');
    expect(error?.message).toContain('tar');
  });

  it('aborts the stream once the archive exceeds the size cap', async () => {
    const { handler, captured } = makeHandler(async (_command, options) => {
      options.onChunk(new Uint8Array(1024));
      return { exitCode: 0, stderr: '', truncated: true };
    });
    await handler.downloadDirectory('/srv/huge');

    const failed = captured.json.find((m) => m.type === 'sftp_download_failed');
    expect(failed).toEqual({ type: 'sftp_download_failed', reason: 'exceeds_size_limit' });
  });

  it('refuses the root directory without touching exec', async () => {
    let execCalled = false;
    const { handler, captured } = makeHandler(async () => {
      execCalled = true;
      return { exitCode: 0, stderr: '', truncated: false };
    });
    await handler.downloadDirectory('/');
    expect(execCalled).toBe(false);
    expect(captured.json.find((m) => m.type === 'sftp_error')?.message).toContain('根目录');
  });
});

describe('SFTPHandler.searchFiles protocol', () => {
  it('returns decoded, capped matches with the search root', async () => {
    const { handler, captured } = makeHandler(async (_command, options) => {
      options.onChunk(new TextEncoder().encode('/srv/site/app.log\n/srv/site/lib\n'));
      return { exitCode: 0, stderr: '', truncated: false };
    });
    await handler.searchFiles('/srv', 'app');
    const result = captured.json.find((m) => m.type === 'sftp_search_result');
    expect(result).toEqual({
      type: 'sftp_search_result',
      path: '/srv',
      matches: ['/srv/site/app.log', '/srv/site/lib'],
    });
  });

  it('caps matches at 300 entries', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `/srv/f${i}.txt`).join('\n');
    const { handler, captured } = makeHandler(async (_command, options) => {
      options.onChunk(new TextEncoder().encode(lines));
      return { exitCode: 0, stderr: '', truncated: false };
    });
    await handler.searchFiles('/srv', 'f');
    const result = captured.json.find((m) => m.type === 'sftp_search_result');
    expect(result?.matches?.length).toBe(300);
  });

  it('surfaces find failures through sftp_error', async () => {
    const { handler, captured } = makeHandler(async () => ({
      exitCode: 1,
      stderr: 'find: permission denied',
      truncated: false,
    }));
    await handler.searchFiles('/srv', 'x');
    const error = captured.json.find((m) => m.type === 'sftp_error');
    expect(error?.operation).toBe('search');
    expect(error?.message).toContain('permission denied');
  });
});
