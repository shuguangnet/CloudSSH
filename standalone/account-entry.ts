import { stretchAdminPassword, buildAdminPasswordHash } from '../frontend/src/password-stretch';

const messages = {
  'zh-CN': { 'nav.panel': '返回面板', 'nav.automation': '自动化', 'nav.mcp': 'MCP', 'nav.account': '账号设置', back: '返回面板', title: '管理员账号设置', username: '账号', nameHint: '账号为 2–64 个字符，可使用字母、数字、点、下划线、@ 和短横线。', current: '当前密码', new: '新密码（留空则不修改）', confirm: '确认新密码', hint: '新密码须为 12–256 个字符。更改密码后需重新登录，旧 MCP 令牌也会失效。服务器配置不会删除。', save: '保存修改', mismatch: '两次输入的新密码不一致。', length: '新密码须为 12–256 个字符。', bad: '当前密码错误。', locked: '尝试过于频繁，请稍后重试。', unauthorized: '登录已过期，请返回面板重新登录。', failed: '保存失败，请刷新页面后重试。', success: '账号已更新。', changed: '密码已更新，请使用新账号和密码重新登录。', network: '网络错误，请稍后重试。', crypto: '浏览器无法处理密码，请更新浏览器后重试。', backupTitle: '备份与恢复', backupHint: '导出包含全部面板数据（服务器、凭据库、片段、MCP 令牌、自动化任务与数据库连接），为 gzip 压缩包。恢复会在下次服务重启时生效；重启前当前数据继续可用。', backupExport: '导出备份', backupRestore: '恢复备份…', cancel: '取消', confirmRestore: '确认恢复', confirmText: '当前数据会在重启时被替换（旧数据自动归档保留）。确认恢复该备份？', restoreStaged: '备份已校验并暂存，重启服务后生效。', backupFailed: '导出失败，请稍后重试。', restoreFailed: '恢复失败：', fileTooBig: '文件过大或损坏。', restorePick: '请选择一个备份包（.tar.gz）。' },
  'zh-TW': { 'nav.panel': '返回面板', 'nav.automation': '自動化', 'nav.mcp': 'MCP', 'nav.account': '帳號設定', back: '返回面板', title: '管理員帳號設定', username: '帳號', nameHint: '帳號為 2–64 個字元，可使用字母、數字、點、底線、@ 和短橫線。', current: '目前密碼', new: '新密碼（留空則不修改）', confirm: '確認新密碼', hint: '新密碼須為 12–256 個字元。修改密碼後需重新登入，舊 MCP 權杖也會失效。伺服器設定不會刪除。', save: '儲存修改', mismatch: '兩次輸入的新密碼不一致。', length: '新密碼須為 12–256 個字元。', bad: '目前密碼錯誤。', locked: '嘗試過於頻繁，請稍後再試。', unauthorized: '登入已過期，請返回面板重新登入。', failed: '儲存失敗，請重新整理後再試。', success: '帳號已更新。', changed: '密碼已更新，請使用新帳號和密碼重新登入。', network: '網路錯誤，請稍後再試。', crypto: '瀏覽器無法處理密碼，請更新瀏覽器後再試。', backupTitle: '備份與還原', backupHint: '匯出包含全部面板資料（伺服器、憑證庫、片段、MCP 權杖、自動化任務與資料庫連線），為 gzip 壓縮包。還原會在下次服務重啟時生效；重啟前目前資料繼續可用。', backupExport: '匯出備份', backupRestore: '還原備份…', cancel: '取消', confirmRestore: '確認還原', confirmText: '目前資料會在重啟時被替換（舊資料自動歸檔保留）。確認還原該備份？', restoreStaged: '備份已校驗並暫存，重啟服務後生效。', backupFailed: '匯出失敗，請稍後再試。', restoreFailed: '還原失敗：', fileTooBig: '檔案過大或損壞。', restorePick: '請選擇一個備份包（.tar.gz）。' },
  'en-US': { 'nav.panel': 'Back to panel', 'nav.automation': 'Automation', 'nav.mcp': 'MCP', 'nav.account': 'Account settings', back: 'Back to panel', title: 'Administrator account settings', username: 'Account', nameHint: 'Use 2–64 characters: letters, numbers, dots, underscores, @ and hyphens.', current: 'Current password', new: 'New password (leave blank to keep)', confirm: 'Confirm new password', hint: 'Use 12–256 characters. Changing the password requires signing in again and invalidates old MCP tokens. Server settings are preserved.', save: 'Save changes', mismatch: 'New passwords do not match.', length: 'Use a password of 12–256 characters.', bad: 'Incorrect current password.', locked: 'Too many attempts. Try again later.', unauthorized: 'Session expired. Return to the panel to sign in.', failed: 'Could not save. Reload the page and try again.', success: 'Account updated.', changed: 'Password updated. Sign in with your new account and password.', network: 'Network error. Try again later.', crypto: 'Your browser could not process the password. Update your browser and try again.', backupTitle: 'Backup & restore', backupHint: 'The export contains all panel data (servers, credential library, snippets, MCP tokens, automation tasks and database connections) as a gzip archive. A restore takes effect on the next service restart; current data stays usable until then.', backupExport: 'Export backup', backupRestore: 'Restore backup…', cancel: 'Cancel', confirmRestore: 'Restore now', confirmText: 'Current data is replaced on restart (the previous state is archived automatically). Restore this backup?', restoreStaged: 'Backup verified and staged. It takes effect after the service restarts.', backupFailed: 'Export failed. Try again later.', restoreFailed: 'Restore failed: ', fileTooBig: 'File is too large or corrupt.', restorePick: 'Choose a backup archive (.tar.gz).' },
};
type Locale = keyof typeof messages;
let locale: Locale = 'zh-CN';
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = document.getElementById('save') as HTMLButtonElement;
const text = (key: keyof typeof messages['zh-CN']) => messages[locale][key];
const notify = (value: string) => { document.getElementById('message')!.textContent = value; };
const language = document.getElementById('language') as HTMLSelectElement;
function translate() {
  document.documentElement.lang = locale;
  document.title = `CloudSSH · ${text('title')}`;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => { el.textContent = text(el.dataset.i18n as keyof typeof messages['zh-CN']); });
}
language.addEventListener('change', () => { locale = language.value as Locale; translate(); });
translate();
void (async () => {
try {
  const response = await fetch('/api/admin/account');
  if (!response.ok) throw new Error('Unauthorized');
  input('username').value = (await response.json()).username;
  button.disabled = false;
} catch { notify(text('unauthorized')); }
document.getElementById('account-form')!.addEventListener('submit', async event => {
  event.preventDefault();
  const password = input('new-password').value;
  if (password !== input('confirm-password').value) return notify(text('mismatch'));
  if (password && (password.length < 12 || password.length > 256)) return notify(text('length'));
  button.disabled = true;
  let stage = 'network';
  try {
    const configResponse = await fetch('/api/config');
    if (!configResponse.ok) throw new Error('Configuration unavailable');
    const config = await configResponse.json();
    stage = 'crypto';
    const currentKey = await stretchAdminPassword(input('current-password').value, config.passwordAuth.salt, config.passwordAuth.iterations);
    const passwordHash = password ? await buildAdminPasswordHash(password) : undefined;
    stage = 'network';
    const response = await fetch('/api/admin/account', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: input('username').value.trim(), currentKey, passwordHash }) });
    if (!response.ok) {
      notify(text(response.status === 429 ? 'locked' : response.status === 401 ? 'bad' : 'failed'));
      return;
    }
    const result = await response.json();
    input('current-password').value = ''; input('new-password').value = ''; input('confirm-password').value = '';
    notify(text(result.loginRequired ? 'changed' : 'success'));
    if (result.loginRequired) button.hidden = true;
  } catch { notify(text(stage === 'crypto' ? 'crypto' : 'network')); }
  finally { button.disabled = false; }
});

// ---------- 备份导出 / 恢复 ----------
const exportButton = document.getElementById('backup-export') as HTMLButtonElement;
const restoreButton = document.getElementById('backup-restore') as HTMLButtonElement;
const restoreInput = document.getElementById('backup-file') as HTMLInputElement;
const restoreDialog = document.getElementById('restore-confirm') as HTMLDialogElement;
const restoreText = document.getElementById('restore-text') as HTMLParagraphElement;
let pendingFile: File | null = null;

exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  try {
    const response = await fetch('/api/backup/export', { method: 'POST' });
    if (!response.ok) throw new Error(String(response.status));
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = match?.[1] ?? 'cloudssh-backup.tar.gz';
    anchor.click();
    URL.revokeObjectURL(url);
  } catch { notify(text('backupFailed')); }
  finally { exportButton.disabled = false; }
});

restoreInput.addEventListener('change', () => {
  const file = restoreInput.files?.[0] ?? null;
  restoreInput.value = '';
  if (!file) return;
  pendingFile = file;
  // 文件数未知（服务端校验后才返回），对话框只确认意图，不预填数量
  restoreText.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MiB)\n${text('confirmText')}`;
  restoreDialog.showModal();
});

restoreDialog.addEventListener('close', () => {
  if (restoreDialog.returnValue !== 'ok' || !pendingFile) return;
  const file = pendingFile;
  pendingFile = null;
  void (async () => {
    restoreButton.disabled = true;
    try {
      const response = await fetch('/api/backup/restore', { method: 'POST', body: file });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
      notify(text('restoreStaged'));
    } catch (error) {
      notify(text('restoreFailed') + (error instanceof Error ? error.message : ''));
    } finally { restoreButton.disabled = false; }
  })();
});

})();
