/**
 * 凭据管理面板。
 *
 * 形态与 AIConfigPanel 一致（JS 构建的居中弹窗），因为凭据库需要同时支持
 * Worker 与自托管两种部署，走页面内弹窗比独立静态页更通用。
 *
 * 安全约定：
 * - **列表只展示元数据**，密钥正文永不回显；编辑时密钥框默认为空并提示
 *   “留空表示不修改”，这与服务端 `hasNewSecret` 的语义一致。
 * - 删除前用 confirmAction 二次确认，并把「正被 N 台服务器使用」写在确认文案里，
 *   让用户在点下去之前就知道影响面。
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

export const CREDENTIALS_MODAL_ID = 'credentials-modal';

/** 与服务器认证方式一一对应的凭据类型。 */
type AuthMethod = 'password' | 'publickey';

export class CredentialsPanel {
  private modalEl: HTMLElement | null = null;
  private credentials: StoredCredential[] = [];
  private editingId: number | null = null;
  private loading = false;

  constructor(private readonly store: CredentialStore = new RemoteCredentialStore()) {}

  isOpen(): boolean {
    return !!this.modalEl && !this.modalEl.classList.contains('hidden');
  }

  async show(): Promise<void> {
    if (!this.modalEl) this.render();
    this.modalEl!.classList.remove('hidden');
    // 打开时重置为“新建”状态，避免上次编辑残留。
    this.editingId = null;
    this.resetForm();
    await this.refresh();
  }

  hide(): void {
    this.modalEl?.classList.add('hidden');
    this.editingId = null;
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

  private render(): void {
    this.modalEl = document.createElement('div');
    this.modalEl.id = CREDENTIALS_MODAL_ID;
    this.modalEl.className =
      'responsive-modal hidden fixed inset-0 z-[100] flex items-center justify-center';
    // Static markup and trusted bundled i18n only; user input is assigned through input.value.
    // pi-lens-ignore: no-inner-html, ts-xss-dom-sink
    this.modalEl.innerHTML = `
      <div class="modal-overlay absolute inset-0" id="credentials-modal-backdrop"></div>
      <div class="responsive-modal-panel cyber-box p-6 shadow-2xl relative z-10 w-full max-w-2xl mx-4">
        <div class="flex items-center justify-between mb-6 pb-4 border-b border-dim">
          <span class="text-xs font-bold tracking-[0.1em] text-[var(--accent-secondary)]" data-i18n="credential.title">凭据管理</span>
          <button id="credentials-close-btn" class="panel-close-btn" data-i18n-aria-label="common.close" aria-label="关闭" type="button">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <p class="text-[11px] text-muted mb-4" data-i18n="credential.intro"></p>
        <form id="credential-form" class="space-y-3 mb-5 pb-5 border-b border-dim">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" for="credential-name" data-i18n="credential.name">名称</label>
              <input id="credential-name" class="terminal-input text-[13px] w-full" type="text" maxlength="50" required autocomplete="off" data-i18n-placeholder="credential.namePlaceholder" placeholder="例如：生产环境部署密钥">
            </div>
            <div>
              <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" for="credential-kind" data-i18n="credential.kind">类型</label>
              <select id="credential-kind" class="terminal-input text-[13px] w-full">
                <option value="password" data-i18n="common.password">密码</option>
                <option value="publickey" data-i18n="common.privateKey">私钥</option>
              </select>
            </div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" for="credential-secret" id="credential-secret-label" data-i18n="credential.secret">密码</label>
            <textarea id="credential-secret" class="terminal-input text-[11px] w-full" rows="3" required autocomplete="off" spellcheck="false" style="resize: vertical; border: 1px solid var(--border-strong); padding: 8px;"></textarea>
            <div id="credential-secret-hint" class="text-[10px] text-muted opacity-70 mt-1"></div>
          </div>
          <div>
            <label class="block text-xs font-bold tracking-[0.1em] text-muted mb-2" for="credential-comment" data-i18n="credential.comment">备注</label>
            <input id="credential-comment" class="terminal-input text-[13px] w-full" type="text" maxlength="200" autocomplete="off" data-i18n-placeholder="credential.commentPlaceholder" placeholder="可选">
          </div>
          <p id="credential-form-error" class="text-[11px] text-[var(--error,#f87171)] hidden" role="alert"></p>
          <div class="flex items-center gap-2">
            <button id="credential-save-btn" type="submit" class="primary-btn text-[12px]" data-i18n="credential.create">新建凭据</button>
            <button id="credential-cancel-btn" type="button" class="hidden text-[12px] text-muted hover:text-primary cursor-pointer" data-i18n="common.cancel">取消</button>
          </div>
        </form>
        <div id="credential-list" class="space-y-2 max-h-[45vh] overflow-y-auto custom-scrollbar"></div>
      </div>
    `;
    document.body.appendChild(this.modalEl);

    // i18n：填充 data-i18n 标记的空节点。
    translateDocument(this.modalEl);

    this.modalEl
      .querySelector('#credentials-modal-backdrop')
      ?.addEventListener('click', () => this.hide());
    this.modalEl
      .querySelector('#credentials-close-btn')
      ?.addEventListener('click', () => this.hide());
    this.modalEl
      .querySelector('#credential-cancel-btn')
      ?.addEventListener('click', () => {
        this.editingId = null;
        this.resetForm();
      });
    this.modalEl.querySelector('#credential-kind')?.addEventListener('change', () => {
      this.syncSecretFieldForKind();
    });
    this.modalEl
      .querySelector('#credential-form')
      ?.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.handleSubmit();
      });
    this.syncSecretFieldForKind();
    this.renderList();
  }

  private currentKind(): AuthMethod {
    const select = this.modalEl?.querySelector<HTMLSelectElement>('#credential-kind');
    return select?.value === 'publickey' ? 'publickey' : 'password';
  }

  /** 密钥与密码的输入形态不同：密钥用多行等宽文本，密码用遮罩输入。 */
  private syncSecretFieldForKind(): void {
    const kind = this.currentKind();
    const isKey = kind === 'publickey';
    const label = this.modalEl?.querySelector<HTMLElement>('#credential-secret-label');
    if (label) label.textContent = isKey ? t('common.privateKey') : t('common.password');
  }

  private resetForm(): void {
    const form = this.modalEl?.querySelector<HTMLFormElement>('#credential-form');
    form?.reset();
    const secret = this.modalEl?.querySelector<HTMLTextAreaElement>('#credential-secret');
    if (secret) secret.required = true;
    const hint = this.modalEl?.querySelector<HTMLElement>('#credential-secret-hint');
    if (hint) hint.textContent = '';
    const saveBtn = this.modalEl?.querySelector<HTMLElement>('#credential-save-btn');
    if (saveBtn) saveBtn.textContent = t('credential.create');
    this.modalEl?.querySelector('#credential-cancel-btn')?.classList.add('hidden');
    this.setFormError(null);
    this.syncSecretFieldForKind();
  }

  private setFormError(message: string | null): void {
    const el = this.modalEl?.querySelector<HTMLElement>('#credential-form-error');
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
    const nameEl = this.modalEl?.querySelector<HTMLInputElement>('#credential-name');
    const secretEl = this.modalEl?.querySelector<HTMLTextAreaElement>('#credential-secret');
    const commentEl = this.modalEl?.querySelector<HTMLInputElement>('#credential-comment');
    if (!nameEl || !secretEl || !commentEl) return;

    const input: CredentialInput = {
      name: nameEl.value,
      kind: this.currentKind(),
      comment: commentEl.value,
    };
    // 编辑时密钥框留空 = 保留原密钥；新建时必须填写。
    const hasSecret = secretEl.value.trim().length > 0;
    if (hasSecret) input.secret = secretEl.value;

    this.setFormError(null);
    try {
      if (this.editingId === null) {
        await this.store.create(input);
        notify(t('credential.created'), { variant: 'success' });
      } else {
        await this.store.update(this.editingId, input);
        notify(t('credential.updated'), { variant: 'success' });
      }
      this.editingId = null;
      this.resetForm();
      await this.refresh();
    } catch (error) {
      this.setFormError(credentialErrorMessage(error));
    }
  }

  private startEdit(credential: StoredCredential): void {
    this.editingId = credential.id;
    const nameEl = this.modalEl?.querySelector<HTMLInputElement>('#credential-name');
    const kindEl = this.modalEl?.querySelector<HTMLSelectElement>('#credential-kind');
    const commentEl = this.modalEl?.querySelector<HTMLInputElement>('#credential-comment');
    const secretEl = this.modalEl?.querySelector<HTMLTextAreaElement>('#credential-secret');
    if (nameEl) nameEl.value = credential.name;
    if (kindEl) kindEl.value = credential.kind;
    if (commentEl) commentEl.value = credential.comment;
    // 密钥永不回显：留空即保留原值。
    if (secretEl) {
      secretEl.value = '';
      secretEl.required = false;
    }
    const hint = this.modalEl?.querySelector<HTMLElement>('#credential-secret-hint');
    if (hint) hint.textContent = t('credential.secretUnchanged');
    const saveBtn = this.modalEl?.querySelector<HTMLElement>('#credential-save-btn');
    if (saveBtn) saveBtn.textContent = t('credential.save');
    this.modalEl?.querySelector('#credential-cancel-btn')?.classList.remove('hidden');
    this.setFormError(null);
    this.syncSecretFieldForKind();
    nameEl?.focus();
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
      if (this.editingId === credential.id) {
        this.editingId = null;
        this.resetForm();
      }
      await this.refresh();
    } catch (error) {
      notify(credentialErrorMessage(error), { variant: 'danger' });
    }
  }

  private renderList(): void {
    const container = this.modalEl?.querySelector<HTMLElement>('#credential-list');
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

/** 全局单例：服务器表单与侧边栏入口共享同一面板与凭据列表缓存。 */
export const credentialLibrary = new CredentialsPanel();
