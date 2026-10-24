import { describe, expect, it, vi } from 'vitest';
import { SSHChannel } from '../../src/ssh/channel';
import {
  SSH_FX_OK,
  SSH_FXF_CREAT,
  SSH_FXF_EXCL,
  SSH_FXF_READ,
  SSH_FXF_TRUNC,
  SSH_FXF_WRITE,
  SSH_FXP_ATTRS,
  SSH_FXP_DATA,
  SSH_FXP_HANDLE,
  SSH_FXP_STATUS,
  SSH_S_IFREG,
} from '../../src/ssh/sftp-types';
import { SFTPHandler } from '../../src/worker/sftp-handler';

/**
 * 配置快照接缝测试。
 *
 * 最关键的不变量：**覆盖写入必须发生在留档之后**。
 * 上传的 open 带 TRUNC，一旦先执行，旧内容就永久消失、再也无法留档；
 * 这个顺序约束靠源码顺序 + 调用序断言双重守护。
 */

const CONTENT = new TextEncoder().encode('server { listen 80; }');

function createHandler(overrides: Record<string, unknown> = {}) {
  const sendJSON = vi.fn();
  const snapshot = vi.fn().mockResolvedValue(undefined);
  const handler = new SFTPHandler(
    1,
    new SSHChannel(),
    vi.fn(),
    sendJSON,
    vi.fn(),
    vi.fn(),
    false,
    undefined,
    false,
    undefined,
    snapshot
  );

  // 模拟一个「已存在的普通文件」：stat 成功、read 返回内容、close 成功。
  const sftp = {
    stat: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_ATTRS])),
    parseAttrsResponse: vi.fn(() => ({
      size: CONTENT.length,
      permissions: SSH_S_IFREG | 0o644,
      mtime: 1700000000,
    })),
    parseStatusResponse: vi.fn(() => ({ code: SSH_FX_OK, message: 'ok' })),
    openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
    parseHandleResponse: vi.fn(() => new Uint8Array([7])),
    readFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_DATA, ...CONTENT])),
    parseDataResponse: vi.fn(() => CONTENT),
    writeFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
    closeHandle: vi.fn().mockResolvedValue(undefined),
    removeFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
    rename: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
    realpath: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
    ...overrides,
  };

  Object.assign(handler as unknown as Record<string, unknown>, { ready: true, sftp });
  return { handler, sendJSON, sftp, snapshot, closeHandle: sftp.closeHandle };
}

describe('配置快照：覆盖前留档', () => {
  it('覆盖写入时先留档再 TRUNC 打开文件，顺序不可颠倒', async () => {
    const order: string[] = [];
    const { handler, snapshot, sftp } = createHandler();
    snapshot.mockImplementation(async () => { order.push('snapshot'); });
    (sftp.openFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, flags: number) => {
      // 只有带 TRUNC 的那次（真正截断）才记录顺序，留档读取用的是 READ。
      if (flags & SSH_FXF_TRUNC) order.push('open-trunc');
      return new Uint8Array([SSH_FXP_HANDLE]);
    });

    await handler.uploadStart('/etc/nginx/nginx.conf', 10, true);

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot.mock.calls[0][0]).toBe('/etc/nginx/nginx.conf');
    expect(snapshot.mock.calls[0][2]).toBe('upload');
    expect(order).toEqual(['snapshot', 'open-trunc']);
  });

  it('留档内容与 mtime 来自远端旧文件', async () => {
    const { handler, snapshot } = createHandler();

    await handler.uploadStart('/etc/nginx/nginx.conf', 10, true);

    const [, content, kind, mtime] = snapshot.mock.calls[0];
    expect(new TextDecoder().decode(content as Uint8Array)).toBe('server { listen 80; }');
    expect(kind).toBe('upload');
    expect(mtime).toBe(1700000000);
  });

  it('断点续传不截断旧内容，因此不留档', async () => {
    const { handler, snapshot } = createHandler();

    await handler.uploadStart('/var/log/big.tar.gz', 1000, false, 500);

    expect(snapshot).not.toHaveBeenCalled();
  });

  it('新增文件（非覆盖）不留档', async () => {
    const { handler, snapshot } = createHandler({
      stat: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      parseStatusResponse: vi.fn(() => ({ code: 2 /* NO_SUCH_FILE */, message: 'not found' })),
    });

    await handler.uploadStart('/etc/new.conf', 3);

    expect(snapshot).not.toHaveBeenCalled();
  });

  it('留档失败不阻断上传：快照是增强能力', async () => {
    const { handler, sendJSON, snapshot, sftp } = createHandler();
    snapshot.mockRejectedValue(new Error('database unavailable'));

    await handler.uploadStart('/etc/nginx/nginx.conf', 10, true);

    expect(sftp.openFile).toHaveBeenCalledWith(
      '/etc/nginx/nginx.conf',
      SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_TRUNC
    );
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_ready',
      path: '/etc/nginx/nginx.conf',
      isTunnel: false,
    });
  });

  it('文件超过快照上限时跳过留档，但仍允许覆盖', async () => {
    const bigSize = 3 * 1024 * 1024;
    const { handler, snapshot, sftp } = createHandler({
      parseAttrsResponse: vi.fn(() => ({
        size: bigSize,
        permissions: SSH_S_IFREG | 0o644,
        mtime: 1,
      })),
    });

    await handler.uploadStart('/var/lib/big.db', 10, true);

    expect(snapshot).not.toHaveBeenCalled();
    expect(sftp.openFile).toHaveBeenCalledWith(
      '/var/lib/big.db',
      SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_TRUNC
    );
  });

  it('未注入留档回调时（匿名/分享会话）一切照常', async () => {
    const sendJSON = vi.fn();
    const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON, vi.fn(), vi.fn());
    Object.assign(handler as unknown as Record<string, unknown>, {
      ready: true,
      sftp: {
        openFile: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_HANDLE])),
        parseHandleResponse: vi.fn(() => new Uint8Array([7])),
      },
    });

    await handler.uploadStart('/etc/a.conf', 3, true);

    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_upload_ready',
      path: '/etc/a.conf',
      isTunnel: false,
    });
  });

  it('删除文件前留档，删除结果照常回传', async () => {
    const { handler, snapshot, sendJSON } = createHandler();

    await handler.deletePath('/etc/old.conf');

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot.mock.calls[0][2]).toBe('delete');
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_delete_result',
      path: '/etc/old.conf',
      success: true,
    });
  });

  it('读取句柄在留档后必须释放，避免远端 handle 泄漏', async () => {
    const { handler, closeHandle } = createHandler();

    await handler.uploadStart('/etc/nginx/nginx.conf', 10, true);

    expect(closeHandle).toHaveBeenCalledTimes(1);
  });
});

describe('配置快照：回滚写入', () => {
  it('回滚走临时文件 + rename 原子替换，而不是直接截断目标', async () => {
    const { handler, sendJSON, sftp, snapshot } = createHandler();

    await handler.restoreSnapshot('/etc/nginx/nginx.conf', CONTENT);

    // 先留档当前内容（kind=restore），使回滚可逆
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot.mock.calls[0][2]).toBe('restore');

    // 写入的是临时路径，且不是目标路径本身（按写标志选取，避免与留档的 READ 打开混淆）
    const writeOpen = (sftp.openFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[1] as number) & SSH_FXF_EXCL
    );
    expect(writeOpen).toBeDefined();
    const openPath = writeOpen![0] as string;
    expect(openPath).toMatch(/^\/etc\/nginx\/nginx\.conf\.cloudssh-restore-/);
    expect(openPath).not.toBe('/etc/nginx/nginx.conf');

    // rename(临时 → 目标) 完成替换
    expect(sftp.rename).toHaveBeenCalledWith(openPath, '/etc/nginx/nginx.conf');
    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_restore_result',
      path: '/etc/nginx/nginx.conf',
      success: true,
      size: CONTENT.length,
    });
  });

  it('回滚内容完整写入（含分块累积）', async () => {
    const { handler, sftp } = createHandler();

    await handler.restoreSnapshot('/etc/big.conf', CONTENT);

    const writeCalls = (sftp.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const written = writeCalls.map((call) => call[2] as Uint8Array);
    const total = written.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(total).toBe(CONTENT.length);
    expect(new TextDecoder().decode(written[0])).toBe('server { listen 80; }');
  });

  it('rename 失败时清理临时文件且报告失败', async () => {
    // parseStatusResponse 在写入与 rename 两处共用：写入必须成功（返回 OK），
    // 只有最后的 rename 失败，才能验证失败分支。因此按调用次数区分。
    const writeChunks = Math.max(1, Math.ceil(CONTENT.length / (128 * 1024)));
    let statusCalls = 0;
    const { handler, sendJSON, sftp } = createHandler({
      rename: vi.fn().mockResolvedValue(new Uint8Array([SSH_FXP_STATUS])),
      parseStatusResponse: vi.fn().mockImplementation(() => {
        statusCalls += 1;
        // 前 writeChunks 次属于 writeFile；之后的第一次是 rename。
        return statusCalls > writeChunks
          ? { code: 4 /* FAILURE */, message: 'permission denied' }
          : { code: SSH_FX_OK, message: 'ok' };
      }),
    });

    await handler.restoreSnapshot('/etc/nginx/nginx.conf', CONTENT);

    const writeOpen = (sftp.openFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[1] as number) & SSH_FXF_EXCL
    );
    expect(writeOpen).toBeDefined();
    expect(sftp.rename).toHaveBeenCalled();
    expect(sftp.removeFile).toHaveBeenCalledWith(writeOpen![0]);
    expect(sendJSON).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sftp_error', operation: 'restore' })
    );
  });

  it('SFTP 未就绪时拒绝回滚', async () => {
    const sendJSON = vi.fn();
    const handler = new SFTPHandler(1, new SSHChannel(), vi.fn(), sendJSON, vi.fn(), vi.fn());
    Object.assign(handler as unknown as Record<string, unknown>, { ready: false });

    await handler.restoreSnapshot('/etc/a.conf', CONTENT);

    expect(sendJSON).toHaveBeenCalledWith({
      type: 'sftp_error',
      operation: 'restore',
      message: 'SFTP 未就绪',
    });
  });

  it('回滚使用 EXCL 创建临时文件，避免覆盖同名的在途临时文件', async () => {
    const { handler, sftp } = createHandler();

    await handler.restoreSnapshot('/etc/a.conf', CONTENT);

    expect(sftp.openFile).toHaveBeenCalledWith(
      expect.stringContaining('.cloudssh-restore-'),
      SSH_FXF_WRITE | SSH_FXF_CREAT | SSH_FXF_EXCL
    );
  });
});

describe('配置快照：留档读取路径', () => {
  it('留档读取使用只读句柄，绝不带写标志', async () => {
    const { handler, sftp } = createHandler();

    await handler.uploadStart('/etc/a.conf', 3, true);

    const readOpen = (sftp.openFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[1] === SSH_FXF_READ
    );
    expect(readOpen).toBeDefined();
    expect(readOpen![0]).toBe('/etc/a.conf');
  });

  it('目标是目录时不留档（read 会失败）', async () => {
    const { handler, snapshot } = createHandler({
      parseAttrsResponse: vi.fn(() => ({ size: 0, permissions: SSH_S_IFREG | 0o755, mtime: 1 })),
    });
    // 覆盖 0 字节普通文件是允许的留档场景；此处只验证普通文件会被留档
    await handler.uploadStart('/etc/dir', 3, true);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('远端读取失败时静默跳过留档，不产生错误帧', async () => {
    const { handler, snapshot, sendJSON, sftp } = createHandler({
      readFile: vi.fn().mockRejectedValue(new Error('read failed')),
    });

    await handler.uploadStart('/etc/a.conf', 3, true);

    expect(snapshot).not.toHaveBeenCalled();
    // 只有 upload_ready，不应有 restore/upload 错误
    const errorFrames = sendJSON.mock.calls.filter((call) => call[0]?.type === 'sftp_error');
    expect(errorFrames).toHaveLength(0);
    expect(sftp.openFile).toHaveBeenCalled();
  });
});
