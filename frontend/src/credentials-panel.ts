/**
 * 凭据管理页。
 *
 * 形态是**主内容区内的独立视图**（`#credentials-page-section`），不是弹窗：
 * - 左侧导航栏全程可见可点，符合“凭据管理是一个页面”的预期；
 * - 与服务器列表互斥切换，不用 iframe（不需要独立静态页，Worker/自托管都可用）。
 *
 * 默认只渲染列表，表单折叠在后面——「新建凭据」或某行的「编辑」才展开，
 * 避免一进页面就被一张空表单占满。
 *
 * 安全约定（见 AGENTS.md #47）：
 * - 列表接口只返回元数据；明文只在用户**显式点击「显示」**时经
 *   `POST /api/credentials/:id/reveal` 按需取回，服务端为每次调用留痕。
 * - 明文只写入当前表单控件，不落 localStorage、不进 URL、不写日志。
 * - 一旦收起表单 / 切换条目 / 离开页面，立即清空明文。
 */

import {
  credentialErrorMessage,
  type CredentialInput,
  type CredentialStore,
  RemoteCredentialStore,
  type StoredCredential,
} from './credential-store';
import { t, translateDocument } from './i18n';
import { confirmAction, notify } from './ui-feedback';

/** 凭据页容器（`frontend/index.html` 里声明）。 */
export const CREDENTIALS_PAGE_SECTION_ID = 'credentials-page-section';

/** 明文回显后自动隐藏的时长：避免无人看管时明文长期停在屏幕上。 */
const REVEAL_AUTO_HIDE_MS = 60_000;

/** 与服务器认证方式一一对应的凭据类型。 */
type AuthMethod = 'password' | 'publickey';

export class CredentialsPanel {
  private root: HTMLElement | null = null;
  private credentials: StoredCredential[] = [];
  private editingId: number | null = null;
  private loading = false;
  private formOpen = false;
  private visible = false;
  /** 当前已回显的明文（仅内存，用于「已显示」状态与自动隐藏）。 */
  private revealedSecret: string | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly store: CredentialStore = new RemoteCredentialStore()) {}

  isOpen(): boolean {
    return this.visible;
  }

  /**
   * 打开凭据页：默认只展示列表，表单保持收起。
   *
   * 只负责本页自身的状态与 DOM，**不碰** `.user-space-main` /
   * `#embedded-page-section` 的显隐——视图互斥统一由 `main.ts` 的
   * `showMainView()` 决定，否则两个视图会各自切换、同时可见。
   */
  async show(): Promise<void> {
    if (!this.root) this.build();
    this.visible = true;
    this.formOpen = false;
    this.editingId = null;
    this.clearRevealedSecret();
    this.resetForm();
    this.syncFormVisibility();
    await this.refresh();
  }

  /** 关闭凭据页（只清理自身状态与明文，不切换主内容区）。 */
  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    // 离开页面必须清掉明文，避免它留在 DOM 里被后续操作或截图带出。
    this.clearRevealedSecret();
    this.resetForm();
    this.formOpen = false;
    this.editingId = null;
    this.syncFormVisibility();
  }

  /** 供服务器表单等外部调用者复用列表（避免重复请求）。 */
  async listCredentials(): Promise<StoredCredential[]> {
    return this.store.list();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.renderList();
    try {
      this.credentials = await this.store.list();
    } catch (error) {
      notify(credentialErrorMessage(error), { variant: 'danger' });
      this.credentials = [];
    } finally {
      this.loading = false;
      this.renderList();
    }
  }

  // ==================== DOM 构建 ====================

  private build(): void {
    const host = document.getElementById('credentials-page-body');
    if (!host) return;
    this.root = host;

    // Static markup and trusted bundled i18n only; user input is assigned through input.value.
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.root.innerHTML = `
      <div class="max-w-5xl mx-auto p-6">
        <div class="flex items-start justify-between gap-4 mb-5">
          <div>
            <p class="text-xs text-muted opacity-70 max-w-2xl" data-i18n="credential.intro"></p>
          </div>
          <button id="credential-new-btn" type="button" class="primary-btn text-[12px] shrink-0" data-i18n="credential.create">新建凭据</button>
        </div>

        <form id="credential-form" class="cyber-box p-4 mb-5 hidden">
          <div class="flex items-center justify-between mb-4 pb-3 border-b border-dim">
            <span id="credential-form-title" class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)]" data-i18n="credential.create">新建凭据</span>
            <button id="credential-form-close" type="button" class="panel-close-btn" data-i18n-aria-label="common.close" aria-label="关闭" >
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" for="credential-name" data-i18n="credential.name">名称</label>
              <input id="credential-name" class="terminal-input text-[13px] w-full" type="text" maxlength="50" autocomplete="off" data-i18n-placeholder="credential.namePlaceholder" placeholder="例如：生产环境部署密钥">
            </div>
            <div>
              <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" for="credential-kind" data-i18n="credential.kind">类型</label>
              <select id="credential-kind" class="terminal-input text-[13px] w-full">
                <option value="password" data-i18n="common.password">密码</option>
                <option value="publickey" data-i18n="common.privateKey">私钥</option>
              </select>
            </div>
          </div>
          <div class="mt-3">
            <div class="flex items-center justify-between mb-2">
              <label class="block text-xs font-bold tracking-[0.1em] text-muted" for="credential-secret" id="credential-secret-label" data-i18n="credential.secret">密码</label>
              <div class="flex items-center gap-2">
                <button id="credential-reveal-btn" type="button" class="hidden text-[11px] text-[var(--accent)] hover:underline cursor-pointer" data-i18n="credential.reveal">显示</button>
                <button id="credential-copy-btn" type="button" class="hidden text-[11px] text-muted hover:text-primary cursor-pointer" data-i18n="credential.copy">复制</button>
              </div>
            </div>
            <textarea id="credential-secret" class="terminal-input text-[11px] w-full" rows="3" autocomplete="off" spellcheck="false" style="resize: vertical; border: 1px solid var(--border-strong); padding: 8px;"></textarea>
            <div id="credential-secret-hint" class="text-[10px] text-muted opacity-70 mt-1"></div>
          </div>
          <div class="mt-3">
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" for="credential-comment" data-i18n="credential.comment">备注</label>
            <input id="credential-comment" class="terminal-input text-[13px] w-full" type="text" maxlength="200" autocomplete="off" data-i18n-placeholder="credential.commentPlaceholder" placeholder="可选">
          </div>
          <p id="credential-form-error" class="text-[11px] text-[var(--error,#f87171)] mt-3 hidden" role="alert"></p>
          <div class="flex items-center gap-2 mt-4">
            <button id="credential-save-btn" type="submit" class="primary-btn text-[12px]" data-i18n="credential.create">新建凭据</button>
            <button id="credential-cancel-btn" type="button" class="text-[12px] text-muted hover:text-primary cursor-pointer" data-i18n="common.cancel">取消</button>
          </div>
        </form>

        <div id="credential-list" class="space-y-2"></div>
      </div>
    `;

    // i18n：填充 data-i18n 标记的空节点。
    translateDocument(this.root);

    this.root.querySelector('#credential-new-btn')?.addEventListener('click', () => {
      this.openCreateForm();
    });
    this.root
      .querySelector('#credential-form-close')
      ?.addEventListener('click', () => this.closeForm());
    this.root
      .querySelector('#credential-cancel-btn')
      ?.addEventListener('click', () => this.closeForm());
    this.root.querySelector('#credential-kind')?.addEventListener('change', () => {
      this.syncSecretFieldForKind();
    });
    this.root
      .querySelector('#credential-reveal-btn')
      ?.addEventListener('click', () => void this.toggleReveal());
    this.root
      .querySelector('#credential-copy-btn')
      ?.addEventListener('click', () => void this.copySecretField());
    // 用户一旦自己改动内容，就不再算「已回显」：否则 60 秒后的自动清除
    // 会把用户正在编辑的内容一并抹掉。
    this.root.querySelector('#credential-secret')?.addEventListener('input', () => {
      const secretEl = this.root?.querySelector<HTMLTextAreaElement>('#credential-secret');
      if (this.revealedSecret !== null && secretEl?.value !== this.revealedSecret) {
        this.clearRevealTimer();
        this.revealedSecret = null;
      }
      this.syncRevealControls();
    });
    this.root
      .querySelector('#credential-form')
      ?.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.handleSubmit();
      });
    this.syncSecretFieldForKind();
    this.renderList();
  }

  private currentKind(): AuthMethod {
    const select = this.root?.querySelector<HTMLSelectElement>('#credential-kind');
    return select?.value === 'publickey' ? 'publickey' : 'password';
  }

  /** 密钥与密码的输入形态不同：密钥用多行等宽文本，密码用遮罩输入。 */
  private syncSecretFieldForKind(): void {
    const isKey = this.currentKind() === 'publickey';
    const label = this.root?.querySelector<HTMLElement>('#credential-secret-label');
    if (label) label.textContent = isKey ? t('common.privateKey') : t('common.password');
  }

  // ==================== 表单显隐 ====================

  private syncFormVisibility(): void {
    const form = this.root?.querySelector<HTMLElement>('#credential-form');
    if (!form) return;
    form.classList.toggle('hidden', !this.formOpen);
  }

  private openCreateForm(): void {
    this.editingId = null;
    this.clearRevealedSecret();
    this.resetForm();
    this.formOpen = true;
    this.syncFormVisibility();
    this.root?.querySelector<HTMLInputElement>('#credential-name')?.focus();
  }

  private startEdit(credential: StoredCredential): void {
    this.editingId = credential.id;
    this.clearRevealedSecret();
    this.formOpen = true;
    this.syncFormVisibility();

    const nameEl = this.root?.querySelector<HTMLInputElement>('#credential-name');
    const kindEl = this.root?.querySelector<HTMLSelectElement>('#credential-kind');
    const commentEl = this.root?.querySelector<HTMLInputElement>('#credential-comment');
    const secretEl = this.root?.querySelector<HTMLTextAreaElement>('#credential-secret');
    if (nameEl) nameEl.value = credential.name;
    if (kindEl) kindEl.value = credential.kind;
    if (commentEl) commentEl.value = credential.comment;
    // 明文不随列表下发，需要用户点「显示」才按需取回。
    if (secretEl) secretEl.value = '';

    const title = this.root?.querySelector<HTMLElement>('#credential-form-title');
    if (title) title.textContent = t('credential.edit');
    const hint = this.root?.querySelector<HTMLElement>('#credential-secret-hint');
    if (hint) hint.textContent = t('credential.revealHint');
    const saveBtn = this.root?.querySelector<HTMLElement>('#credential-save-btn');
    if (saveBtn) saveBtn.textContent = t('credential.save');

    this.syncSecretFieldForKind();
    this.syncRevealControls();
    this.setFormError(null);
    nameEl?.focus();
  }

  private closeForm(): void {
    this.formOpen = false;
    this.editingId = null;
    this.clearRevealedSecret();
    this.resetForm();
    this.syncFormVisibility();
  }

  private resetForm(): void {
    const form = this.root?.querySelector<HTMLFormElement>('#credential-form');
    form?.reset();
    const hint = this.root?.querySelector<HTMLElement>('#credential-secret-hint');
    if (hint) hint.textContent = '';
    const title = this.root?.querySelector<HTMLElement>('#credential-form-title');
    if (title) title.textContent = t('credential.create');
    const saveBtn = this.root?.querySelector<HTMLElement>('#credential-save-btn');
    if (saveBtn) saveBtn.textContent = t('credential.create');
    this.setFormError(null);
    this.syncSecretFieldForKind();
    this.syncRevealControls();
  }

  // ==================== 明文回显 ====================

  /**
   * 按需取回明文并填入表单。
   *
   * 只在编辑模式可用（新建时内容就是用户自己敲的，无需回显）。
   * 服务端会为每次调用写一条留痕。
   */
  private async toggleReveal(): Promise<void> {
    const secretEl = this.root?.querySelector<HTMLTextAreaElement>('#credential-secret');
    if (!secretEl) return;

    // 已显示 → 再次点击即收起。
    if (this.revealedSecret !== null) {
      this.clearRevealedSecret();
      secretEl.value = '';
      return;
    }
    if (this.editingId === null) return;

    const button = this.root?.querySelector<HTMLButtonElement>('#credential-reveal-btn');
    if (button) button.disabled = true;
    try {
      const secret = await this.store.reveal(this.editingId);
      secretEl.value = secret;
      this.revealedSecret = secret;
      this.setFormError(null);
      this.startRevealTimer();
    } catch (error) {
      this.setFormError(credentialErrorMessage(error));
    } finally {
      if (button) button.disabled = false;
      this.syncRevealControls();
    }
  }

  /**
   * 复制密钥框里的当前内容。
   *
   * 读的是输入框实际值而不是缓存的明文：用户回显后自己改过内容时，
   * 复制的应是他眼前看到的那份，而不是服务端那份。
   */
  private async copySecretField(): Promise<void> {
    const secretEl = this.root?.querySelector<HTMLTextAreaElement>('#credential-secret');
    const value = secretEl?.value ?? '';
    if (value.length === 0) return;
    try {
      await navigator.clipboard.writeText(value);
      notify(t('credential.copied'), { variant: 'success' });
    } catch {
      // 剪贴板不可用（非安全上下文/权限拒绝）时退回选中，让用户手动复制。
      secretEl?.select();
      notify(t('credential.copyFailed'), { variant: 'warning' });
    }
  }

  /** 明文停留过久即自动清掉，减少肩窥与误截屏的暴露窗口。 */
  private startRevealTimer(): void {
    this.clearRevealTimer();
    this.revealTimer = setTimeout(() => {
      const secretEl = this.root?.querySelector<HTMLTextAreaElement>('#credential-secret');
      // 只在内容仍是回显的那一份时才清空；用户改过就不再动他的输入。
      if (this.revealedSecret !== null && secretEl?.value === this.revealedSecret) {
        secretEl.value = '';
      }
      this.revealedSecret = null;
      this.clearRevealTimer();
      this.syncRevealControls();
    }, REVEAL_AUTO_HIDE_MS);
  }

  private clearRevealTimer(): void {
    if (this.revealTimer !== null) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  /** 丢弃内存中的明文并复位「显示/隐藏」按钮状态。 */
  private clearRevealedSecret(): void {
    this.clearRevealTimer();
    this.revealedSecret = null;
    this.syncRevealControls();
  }

  private syncRevealControls(): void {
    const revealBtn = this.root?.querySelector<HTMLButtonElement>('#credential-reveal-btn');
    const copyBtn = this.root?.querySelector<HTMLButtonElement>('#credential-copy-btn');
    const secretEl = this.root?.querySelector<HTMLTextAreaElement>('#credential-secret');
    // 回显入口只在编辑既有凭据时才有意义（新建时内容本来就是用户自己输入的）。
    const canReveal = this.editingId !== null;
    revealBtn?.classList.toggle('hidden', !canReveal);
    // 复制对任何有内容的输入框都有用，因此只看内容不看模式。
    copyBtn?.classList.toggle('hidden', (secretEl?.value ?? '').length === 0);
    if (revealBtn) {
      revealBtn.textContent =
        this.revealedSecret === null ? t('credential.reveal') : t('credential.hideSecret');
    }
  }

  // ==================== 提交 / 删除 ====================

  private setFormError(message: string | null): void {
    const el = this.root?.querySelector<HTMLElement>('#credential-form-error');
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  private async handleSubmit(): Promise<void> {
    const nameEl = this.root?.querySelector<HTMLInputElement>('#credential-name');
    const secretEl = this.root?.querySelector<HTMLTextAreaElement>('#credential-secret');
    const commentEl = this.root?.querySelector<HTMLInputElement>('#credential-comment');
    if (!nameEl || !secretEl || !commentEl) return;

    const input: CredentialInput = {
      name: nameEl.value,
      kind: this.currentKind(),
      comment: commentEl.value,
    };
    // 新建时必须有内容；编辑时已回显的明文会被原样提交（等价于未修改）。
    const hasSecret = secretEl.value.trim().length > 0;
    if (hasSecret) input.secret = secretEl.value;
    if (this.editingId === null && !hasSecret) {
      this.setFormError(t('credential.error.secretRequired'));
      secretEl.focus();
      return;
    }

    this.setFormError(null);
    try {
      if (this.editingId === null) {
        await this.store.create(input);
        notify(t('credential.created'), { variant: 'success' });
      } else {
        await this.store.update(this.editingId, input);
        notify(t('credential.updated'), { variant: 'success' });
      }
      this.closeForm();
      await this.refresh();
    } catch (error) {
      this.setFormError(credentialErrorMessage(error));
    }
  }

  private async handleDelete(credential: StoredCredential): Promise<void> {
    const confirmed = await confirmAction({
      title: t('credential.deleteTitle'),
      message:
        credential.usageCount > 0
          ? t('credential.deleteInUse', {
              name: credential.name,
              count: credential.usageCount,
            })
          : t('credential.deleteConfirm', { name: credential.name }),
      confirmText: t('common.delete'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.store.remove(credential.id);
      notify(t('credential.deleted'), { variant: 'success' });
      if (this.editingId === credential.id) this.closeForm();
      await this.refresh();
    } catch (error) {
      notify(credentialErrorMessage(error), { variant: 'danger' });
    }
  }

  // ==================== 列表渲染 ====================

  private renderList(): void {
    const container = this.root?.querySelector<HTMLElement>('#credential-list');
    if (!container) return;
    container.textContent = '';

    if (this.loading) {
      const loading = document.createElement('p');
      loading.className = 'text-[12px] text-muted';
      loading.textContent = t('common.loading');
      container.appendChild(loading);
      return;
    }
    if (this.credentials.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-[12px] text-muted';
      empty.textContent = t('credential.empty');
      container.appendChild(empty);
      return;
    }

    for (const credential of this.credentials) {
      container.appendChild(this.createRow(credential));
    }
  }

  private createRow(credential: StoredCredential): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cyber-box p-3 flex items-center gap-3';

    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';

    const titleLine = document.createElement('div');
    titleLine.className = 'flex items-center gap-2 min-w-0';
    const name = document.createElement('span');
    name.className = 'text-[13px] font-bold truncate';
    name.textContent = credential.name;
    titleLine.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'text-[10px] text-muted border border-dim px-1.5 py-0.5 shrink-0';
    badge.textContent =
      credential.kind === 'publickey' ? t('common.privateKey') : t('common.password');
    titleLine.appendChild(badge);

    if (credential.usageCount > 0) {
      const usage = document.createElement('span');
      usage.className =
        'text-[10px] text-[var(--accent-secondary)] border border-dim px-1.5 py-0.5 shrink-0';
      usage.textContent = t('credential.usageBadge', { count: credential.usageCount });
      titleLine.appendChild(usage);
    }
    info.appendChild(titleLine);

    if (credential.comment) {
      const comment = document.createElement('div');
      comment.className = 'text-[11px] text-muted truncate mt-0.5';
      comment.textContent = credential.comment;
      info.appendChild(comment);
    }
    row.appendChild(info);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'text-muted hover:text-primary cursor-pointer shrink-0';
    editBtn.title = t('common.edit');
    editBtn.setAttribute('aria-label', t('common.edit'));
    const editIcon = document.createElement('span');
    editIcon.className = 'material-symbols-outlined';
    editIcon.style.fontSize = '16px';
    editIcon.textContent = 'edit';
    editBtn.appendChild(editIcon);
    editBtn.addEventListener('click', () => this.startEdit(credential));
    row.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'text-muted hover:text-[var(--error,#f87171)] cursor-pointer shrink-0';
    deleteBtn.title = t('common.delete');
    deleteBtn.setAttribute('aria-label', t('common.delete'));
    const deleteIcon = document.createElement('span');
    deleteIcon.className = 'material-symbols-outlined';
    deleteIcon.style.fontSize = '16px';
    deleteIcon.textContent = 'delete';
    deleteBtn.appendChild(deleteIcon);
    deleteBtn.addEventListener('click', () => void this.handleDelete(credential));
    row.appendChild(deleteBtn);

    return row;
  }
}

/** 全局单例：服务器表单与侧边栏入口共享同一页面与凭据列表缓存。 */
export const credentialLibrary = new CredentialsPanel();
