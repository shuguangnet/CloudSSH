import { stretchAdminPassword, buildAdminPasswordHash } from '../frontend/src/password-stretch';

const messages = {
  'zh-CN': { back: '返回面板', title: '管理员账号设置', username: '账号', nameHint: '账号为 2–64 个字符，可使用字母、数字、点、下划线、@ 和短横线。', current: '当前密码', new: '新密码（留空则不修改）', confirm: '确认新密码', hint: '新密码须为 12–256 个字符。更改密码后需重新登录，旧 MCP 令牌也会失效。服务器配置不会删除。', save: '保存修改', mismatch: '两次输入的新密码不一致。', length: '新密码须为 12–256 个字符。', bad: '当前密码错误。', locked: '尝试过于频繁，请稍后重试。', unauthorized: '登录已过期，请返回面板重新登录。', failed: '保存失败，请刷新页面后重试。', success: '账号已更新。', changed: '密码已更新，请使用新账号和密码重新登录。', network: '网络错误，请稍后重试。', crypto: '浏览器无法处理密码，请更新浏览器后重试。' },
  'zh-TW': { back: '返回面板', title: '管理員帳號設定', username: '帳號', nameHint: '帳號為 2–64 個字元，可使用字母、數字、點、底線、@ 和短橫線。', current: '目前密碼', new: '新密碼（留空則不修改）', confirm: '確認新密碼', hint: '新密碼須為 12–256 個字元。修改密碼後需重新登入，舊 MCP 權杖也會失效。伺服器設定不會刪除。', save: '儲存修改', mismatch: '兩次輸入的新密碼不一致。', length: '新密碼須為 12–256 個字元。', bad: '目前密碼錯誤。', locked: '嘗試過於頻繁，請稍後再試。', unauthorized: '登入已過期，請返回面板重新登入。', failed: '儲存失敗，請重新整理後再試。', success: '帳號已更新。', changed: '密碼已更新，請使用新帳號和密碼重新登入。', network: '網路錯誤，請稍後再試。', crypto: '瀏覽器無法處理密碼，請更新瀏覽器後再試。' },
  'en-US': { back: 'Back to panel', title: 'Administrator account settings', username: 'Account', nameHint: 'Use 2–64 characters: letters, numbers, dots, underscores, @ and hyphens.', current: 'Current password', new: 'New password (leave blank to keep)', confirm: 'Confirm new password', hint: 'Use 12–256 characters. Changing the password requires signing in again and invalidates old MCP tokens. Server settings are preserved.', save: 'Save changes', mismatch: 'New passwords do not match.', length: 'Use a password of 12–256 characters.', bad: 'Incorrect current password.', locked: 'Too many attempts. Try again later.', unauthorized: 'Session expired. Return to the panel to sign in.', failed: 'Could not save. Reload the page and try again.', success: 'Account updated.', changed: 'Password updated. Sign in with your new account and password.', network: 'Network error. Try again later.', crypto: 'Your browser could not process the password. Update your browser and try again.' },
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

})();
