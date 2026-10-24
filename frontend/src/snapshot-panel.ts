/**
 * 配置快照历史面板（SFTP 文件「历史版本」对话框）。
 *
 * 交互契约：
 * - 只做展示与动作发起，回滚动作本身走 WebSocket（`sftp_snapshot_restore`），
 *   由 SSH 会话层复用已就绪的 SFTP 通道执行；
 * - 列表不携带内容，点「预览」才按需拉单份内容，避免打开面板就传 2MB；
 * - 回滚前必须二次确认（覆盖远端文件属破坏性操作）；
 * - 面板自身不缓存状态，每次打开重新拉取（版本可能被其它会话改写）。
 */
import { t, getLocale } from './i18n';
import { confirmAction, notify } from './ui-feedback';
import { formatTimestampWithRelative } from '../../src/server-memory-schema';
import {
  deleteSnapshot,
  fetchSnapshotContent,
  fetchSnapshots,
  type SnapshotMeta,
} from './snapshot-client';
import { formatSize } from './sftp-helpers';

const KIND_LABEL_KEYS = {
  upload: 'sftp.snapshotKindUpload',
  edit: 'sftp.snapshotKindEdit',
  delete: 'sftp.snapshotKindDelete',
  restore: 'sftp.snapshotKindRestore',
} as const;

function kindLabel(kind: SnapshotMeta['kind']): string {
  return t(KIND_LABEL_KEYS[kind] ?? 'sftp.snapshotKindUpload');
}

function timeLabel(timestamp: number): string {
  return formatTimestampWithRelative(timestamp, Date.now(), getLocale());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 判断快照内容是否可安全预览（含 NUL 即视为二进制，与编辑器口径一致）。 */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

export type SnapshotPanelOptions = {
  serverId: number;
  path: string;
  /** 发起回滚（写 WebSocket 消息）。面板不直接碰底层连接。 */
  requestRestore: (snapshotId: number, onResult: (ok: boolean, message?: string) => void) => void;
  /** 回滚成功后刷新文件列表。 */
  refresh: () => void;
};

/**
 * 打开「历史版本」对话框。返回的 Promise 在面板关闭时 resolve。
 */
export function openSnapshotPanel(options: SnapshotPanelOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[210] flex items-center justify-center';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('sftp.snapshotTitle'));

    const panel = document.createElement('div');
    panel.className =
      'cyber-box bg-surface relative z-10 w-full max-w-2xl mx-4 flex flex-col max-h-[80vh] shadow-2xl';

    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-3 px-4 pt-4 pb-2';
    const heading = document.createElement('div');
    heading.className = 'min-w-0';
    const title = document.createElement('h2');
    title.className = 'text-sm font-semibold text-on-surface';
    title.textContent = t('sftp.snapshotTitle');
    const subtitle = document.createElement('p');
    subtitle.className = 'text-[10px] text-muted mt-0.5';
    subtitle.textContent = t('sftp.snapshotSubtitle');
    const pathLine = document.createElement('p');
    pathLine.className = 'text-[11px] text-muted mt-1 font-mono break-all';
    pathLine.textContent = options.path;
    heading.append(title, subtitle, pathLine);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className =
      'shrink-0 text-muted hover:text-primary transition-colors bg-transparent border-none cursor-pointer';
    closeBtn.setAttribute('aria-label', t('common.close'));
    closeBtn.innerHTML =
      '<span class="material-symbols-outlined" aria-hidden="true">close</span>';
    header.append(heading, closeBtn);

    const list = document.createElement('div');
    list.className = 'custom-scrollbar overflow-y-auto px-4 pb-4 flex-1';
    list.setAttribute('role', 'list');
    const status = document.createElement('div');
    status.className = 'text-[10px] text-muted px-4 pb-3 min-h-[14px]';
    status.setAttribute('role', 'status');

    panel.append(header, list, status);
    overlay.append(panel);

    let closed = false;
    let busy = false;
    const teardown = (): void => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve();
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        teardown();
      }
    };

    closeBtn.addEventListener('click', () => { if (!busy) teardown(); });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay && !busy) teardown();
    });
    document.addEventListener('keydown', onKeydown, true);

    const setStatus = (text: string): void => { status.textContent = text; };

    const renderEmpty = (): void => {
      list.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'text-center py-10';
      const icon = document.createElement('div');
      icon.className = 'material-symbols-outlined text-muted opacity-40';
      icon.style.fontSize = '32px';
      icon.textContent = 'history';
      const text = document.createElement('p');
      text.className = 'text-[12px] text-muted mt-2';
      text.textContent = t('sftp.snapshotEmpty');
      const hint = document.createElement('p');
      hint.className = 'text-[10px] text-muted opacity-70 mt-1';
      hint.textContent = t('sftp.snapshotEmptyHint');
      empty.append(icon, text, hint);
      list.append(empty);
    };

    /** 单行卡片：时间 / 来源 / 大小 + 预览、回滚、删除。 */
    const renderRow = (snapshot: SnapshotMeta): HTMLElement => {
      const row = document.createElement('div');
      row.className =
        'border border-dim bg-surface-variant/30 px-3 py-2 mb-2 flex items-center gap-3';
      row.setAttribute('role', 'listitem');

      const meta = document.createElement('div');
      meta.className = 'min-w-0 flex-1';
      const time = document.createElement('div');
      time.className = 'text-[12px] text-on-surface truncate';
      time.textContent = timeLabel(snapshot.created_at);
      const detail = document.createElement('div');
      detail.className = 'text-[10px] text-muted mt-0.5 flex items-center gap-2 flex-wrap';
      const kind = document.createElement('span');
      kind.className = 'px-1.5 py-0.5 border border-dim text-[10px]';
      kind.textContent = kindLabel(snapshot.kind);
      const size = document.createElement('span');
      size.textContent = formatSize(snapshot.size);
      const hash = document.createElement('span');
      hash.className = 'font-mono opacity-60';
      hash.textContent = snapshot.sha256 ? snapshot.sha256.slice(0, 8) : '';
      detail.append(kind, size, hash);
      meta.append(time, detail);

      const actions = document.createElement('div');
      actions.className = 'flex items-center gap-1 shrink-0';

      const makeButton = (label: string, iconName: string, extra: string): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className =
          `text-[10px] px-2 py-1 border border-dim text-muted hover:text-primary ` +
          `hover:border-[var(--accent)] transition-colors bg-transparent cursor-pointer ${extra}`;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML =
          `<span class="material-symbols-outlined" style="font-size:14px" aria-hidden="true">${iconName}</span>`;
        return button;
      };

      // 预览：按需拉内容，二进制或超限时提示不可预览。
      const previewBtn = makeButton(t('sftp.snapshotCopyContent'), 'visibility', '');
      previewBtn.addEventListener('click', () => {
        if (busy) return;
        busy = true;
        setStatus(t('sftp.snapshotBusy'));
        void fetchSnapshotContent(options.serverId, snapshot.id)
          .then(async (content) => {
            if (!content) {
              setStatus(t('sftp.snapshotLoadFailed'));
              return;
            }
            if (looksBinary(content.bytes)) {
              setStatus(t('sftp.snapshotPreviewBinary'));
              return;
            }
            const text = new TextDecoder('utf-8', { fatal: false }).decode(content.bytes);
            await openContentViewer(snapshot, text);
            setStatus('');
          })
          .finally(() => { busy = false; });
      });

      const restoreBtn = makeButton(t('sftp.snapshotRestore'), 'restore', '');
      restoreBtn.addEventListener('click', () => {
        if (busy) return;
        void (async () => {
          const ok = await confirmAction({
            title: t('sftp.snapshotRestoreTitle'),
            message: t('sftp.snapshotRestoreMessage', {
              name: options.path.split('/').pop() ?? options.path,
              time: timeLabel(snapshot.created_at),
              size: formatSize(snapshot.size),
            }),
            confirmText: t('sftp.snapshotRestoreConfirm'),
            cancelText: t('common.cancel'),
            variant: 'danger',
          });
          if (!ok) return;
          busy = true;
          setStatus(t('sftp.snapshotBusy'));
          options.requestRestore(snapshot.id, (success, message) => {
            busy = false;
            if (success) {
              setStatus(t('sftp.snapshotRestored', { time: timeLabel(snapshot.created_at) }));
              options.refresh();
              void load();
            } else {
              setStatus('');
              notify(t('sftp.snapshotRestoreFailed', { message: message ?? '' }), {
                variant: 'danger',
              });
            }
          });
        })();
      });

      const deleteBtn = makeButton(t('common.delete'), 'delete', 'hover:text-error');
      deleteBtn.addEventListener('click', () => {
        if (busy) return;
        void (async () => {
          const ok = await confirmAction({
            title: t('sftp.snapshotDeleteTitle'),
            message: t('sftp.snapshotDeleteMessage'),
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
            variant: 'danger',
          });
          if (!ok) return;
          busy = true;
          setStatus(t('sftp.snapshotBusy'));
          const removed = await deleteSnapshot(options.serverId, snapshot.id);
          busy = false;
          if (removed) {
            setStatus(t('sftp.snapshotDeleted'));
            void load();
          } else {
            setStatus('');
            notify(t('sftp.snapshotDeleteFailed'), { variant: 'danger' });
          }
        })();
      });

      actions.append(previewBtn, restoreBtn, deleteBtn);
      row.append(meta, actions);
      return row;
    };

    const load = async (): Promise<void> => {
      setStatus(t('sftp.snapshotBusy'));
      const snapshots = await fetchSnapshots(options.serverId, options.path);
      if (closed) return;
      setStatus('');
      if (snapshots.length === 0) {
        renderEmpty();
        return;
      }
      list.replaceChildren();
      for (const snapshot of snapshots) list.append(renderRow(snapshot));
    };

    void load();
  });
}

/**
 * 内容预览子面板：只读展示某一份快照的文本内容，可一键复制。
 *
 * 用独立浮层而非替换主列表，避免丢掉「我现在在看哪一版」的上下文。
 */
function openContentViewer(snapshot: SnapshotMeta, text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[220] flex items-center justify-center';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const panel = document.createElement('div');
    panel.className =
      'cyber-box bg-surface relative z-10 w-full max-w-3xl mx-4 flex flex-col max-h-[80vh] shadow-2xl';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-3 px-4 py-3';
    const label = document.createElement('div');
    label.className = 'text-[12px] text-on-surface truncate';
    label.textContent = `${timeLabel(snapshot.created_at)} · ${formatSize(snapshot.size)}`;
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className =
      'text-[10px] px-2 py-1 border border-dim text-muted hover:text-primary ' +
      'hover:border-[var(--accent)] transition-colors bg-transparent cursor-pointer';
    copyBtn.textContent = t('sftp.snapshotCopyContent');
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(text).then(
        () => notify(t('sftp.snapshotCopied'), { variant: 'success' }),
        () => notify(t('sftp.snapshotCopied'), { variant: 'danger' })
      );
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className =
      'text-muted hover:text-primary transition-colors bg-transparent border-none cursor-pointer';
    closeBtn.setAttribute('aria-label', t('common.close'));
    closeBtn.innerHTML =
      '<span class="material-symbols-outlined" aria-hidden="true">close</span>';

    actions.append(copyBtn, closeBtn);

    const body = document.createElement('pre');
    body.className =
      'custom-scrollbar overflow-auto px-4 pb-4 text-[11px] font-mono whitespace-pre-wrap break-words text-on-surface flex-1';
    // textContent 而非 innerHTML：内容来自远端文件，绝不可当 HTML 解析。
    body.textContent = text;

    header.append(label, actions);
    panel.append(header, body);
    overlay.append(panel);

    const teardown = (): void => {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve();
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        teardown();
      }
    };

    closeBtn.addEventListener('click', teardown);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) teardown(); });
    document.addEventListener('keydown', onKeydown, true);

    document.body.append(overlay);
  });
}
