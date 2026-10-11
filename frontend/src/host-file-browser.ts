// File browser for private keys that already exist on the self-hosted
// deployment server (for example /root/.ssh/id_ed25519). The standalone server
// exposes /api/host-files and /api/host-file; on Cloudflare Workers these
// routes do not exist and the entry point stays hidden.
import { t } from './i18n';
import { notify } from './ui-feedback';

export interface HostFileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number | null;
}

export interface HostFileBrowserOptions {
  onSelected: (path: string, content: string) => void;
}

let availability: Promise<boolean> | null = null;

export function hostFilesAvailable(): Promise<boolean> {
  if (!availability) {
    availability = fetch('/api/host-files', { headers: { Accept: 'application/json' } })
      .then((response) => response.status !== 404)
      .catch(() => false);
  }
  return availability;
}

function formatSize(size: number | null): string {
  if (size === null || Number.isNaN(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function parentPath(dir: string): string {
  if (dir === '/') return '/';
  const trimmed = dir.replace(/\/+$/, '');
  const parent = trimmed.slice(0, trimmed.lastIndexOf('/'));
  return parent || '/';
}

export function openHostFileBrowser(options: HostFileBrowserOptions): void {
  document.getElementById('host-file-browser')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'host-file-browser';
  overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('hostFiles.title'));
  overlay.innerHTML = `
    <div class="modal-overlay absolute inset-0" data-host-file-close="1"></div>
    <div class="cyber-box bg-surface relative z-10 w-full max-w-md mx-4 p-4 shadow-2xl" role="document">
      <div class="flex items-center justify-between mb-3 pb-3 border-b border-dim">
        <div class="flex items-center gap-2 text-on-surface text-xs font-bold tracking-[0.1em]">
          <span class="material-symbols-outlined text-[var(--accent)]" style="font-size: 18px;" aria-hidden="true">dns</span>
          <span data-host-file-title>${t('hostFiles.title')}</span>
        </div>
        <button type="button" class="text-muted hover:text-on-surface cursor-pointer" data-host-file-close="1" aria-label="${t('common.close')}">
          <span class="material-symbols-outlined" style="font-size: 18px;" aria-hidden="true">close</span>
        </button>
      </div>
      <div class="flex items-center gap-2 mb-3">
        <input data-host-file-path class="terminal-input text-[12px] flex-1" style="border:1px solid var(--border-strong);padding:5px 8px;" aria-label="${t('hostFiles.pathLabel')}" spellcheck="false">
        <button type="button" data-host-file-go class="text-[11px] text-muted hover:text-primary cursor-pointer flex items-center gap-1 border border-dim px-2 py-1 hover:border-[var(--accent)] transition-all shrink-0">${t('hostFiles.go')}</button>
        <button type="button" data-host-file-up class="text-[11px] text-muted hover:text-primary cursor-pointer flex items-center gap-1 border border-dim px-2 py-1 hover:border-[var(--accent)] transition-all shrink-0" aria-label="${t('hostFiles.up')}">
          <span class="material-symbols-outlined" style="font-size: 14px;" aria-hidden="true">arrow_upward</span>
        </button>
      </div>
      <div data-host-file-list class="custom-scrollbar border border-dim overflow-y-auto" style="max-height: 320px; min-height: 160px;" role="listbox" aria-label="${t('hostFiles.title')}"></div>
      <div data-host-file-status class="text-[10px] text-muted mt-2 min-h-[14px]" role="status"></div>
      <div class="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-dim">
        <button type="button" data-host-file-cancel class="px-3 py-1.5 text-[11px] font-bold tracking-[0.1em] text-muted hover:text-on-surface border border-dim hover:border-[var(--accent)] cursor-pointer transition-all">${t('common.cancel')}</button>
        <button type="button" data-host-file-select class="px-3 py-1.5 text-[11px] font-bold tracking-[0.1em] connect-btn cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed" disabled>${t('hostFiles.selectFile')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const list = overlay.querySelector<HTMLElement>('[data-host-file-list]')!;
  const status = overlay.querySelector<HTMLElement>('[data-host-file-status]')!;
  const pathInput = overlay.querySelector<HTMLInputElement>('[data-host-file-path]')!;
  const selectButton = overlay.querySelector<HTMLButtonElement>('[data-host-file-select]')!;
  let currentPath = '/';
  let selectedFile: string | null = null;
  let loadSequence = 0;

  const close = () => overlay.remove();
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      document.removeEventListener('keydown', closeOnEscape);
      close();
    }
  };
  document.addEventListener('keydown', closeOnEscape);
  overlay.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-host-file-close],[data-host-file-cancel]')) close();
  });

  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.classList.toggle('text-error', isError);
  };

  const render = (entries: HostFileEntry[], truncated: boolean) => {
    list.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'text-[11px] text-muted p-4 text-center';
      empty.textContent = t('hostFiles.empty');
      list.appendChild(empty);
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 px-2 py-1.5 text-[12px] cursor-pointer border-b border-dim hover:bg-surface transition-all';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const isDir = entry.type === 'dir';
      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined text-muted';
      icon.style.fontSize = '16px';
      icon.textContent = isDir ? 'folder' : 'draft';
      const name = document.createElement('span');
      name.className = 'text-on-surface truncate flex-1';
      name.textContent = entry.name;
      const size = document.createElement('span');
      size.className = 'text-[10px] text-muted shrink-0';
      size.textContent = isDir ? '' : formatSize(entry.size);
      row.append(icon, name, size);
      if (isDir) {
        row.addEventListener('click', () => void load(joinPath(currentPath, entry.name)));
      } else {
        row.addEventListener('click', () => {
          selectedFile = joinPath(currentPath, entry.name);
          for (const other of list.querySelectorAll('[aria-selected="true"]')) other.setAttribute('aria-selected', 'false');
          row.setAttribute('aria-selected', 'true');
          row.classList.add('bg-surface');
          selectButton.disabled = false;
        });
        row.addEventListener('dblclick', () => void confirmSelection(joinPath(currentPath, entry.name)));
      }
      list.appendChild(row);
    }
    if (truncated) {
      const note = document.createElement('div');
      note.className = 'text-[10px] text-muted p-2 text-center';
      note.textContent = t('hostFiles.truncated');
      list.appendChild(note);
    }
  };

  const load = async (dirPath: string) => {
    const sequence = ++loadSequence;
    selectedFile = null;
    selectButton.disabled = true;
    setStatus(t('common.loading'));
    try {
      const response = await fetch(`/api/host-files?path=${encodeURIComponent(dirPath)}`, { headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      if (sequence !== loadSequence) return;
      currentPath = body.path;
      pathInput.value = currentPath;
      render(body.entries || [], !!body.truncated);
      setStatus('');
    } catch (error) {
      if (sequence !== loadSequence) return;
      list.innerHTML = '';
      setStatus((error instanceof Error ? error.message : t('hostFiles.loadFailed')) || t('hostFiles.loadFailed'), true);
    }
  };

  const confirmSelection = async (filePath: string) => {
    selectButton.disabled = true;
    setStatus(t('common.loading'));
    try {
      const response = await fetch(`/api/host-file?path=${encodeURIComponent(filePath)}`, { headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      document.removeEventListener('keydown', closeOnEscape);
      overlay.remove();
      options.onSelected(body.path ?? filePath, body.content ?? '');
    } catch (error) {
      selectButton.disabled = false;
      setStatus(t('hostFiles.readFailed'));
      notify(error instanceof Error ? error.message : t('hostFiles.readFailed'), {
        title: t('auth.readKeyTitle'),
        variant: 'danger',
      });
    }
  };

  overlay.querySelector<HTMLButtonElement>('[data-host-file-go]')!.addEventListener('click', () => {
    const typed = pathInput.value.trim();
    if (typed) void load(typed.startsWith('/') ? typed : `/${typed}`);
  });
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      overlay.querySelector<HTMLButtonElement>('[data-host-file-go]')!.click();
    }
  });
  overlay.querySelector<HTMLButtonElement>('[data-host-file-up]')!.addEventListener('click', () => void load(parentPath(currentPath)));
  selectButton.addEventListener('click', () => {
    if (selectedFile) void confirmSelection(selectedFile);
  });

  void load('/');
}
