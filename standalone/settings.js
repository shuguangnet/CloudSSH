const dictionaries = {
  'zh-CN': { 'nav.panel': '返回面板', 'nav.automation': '自动化', 'nav.mcp': 'MCP', 'nav.account': '账号设置', back: '返回面板', intro: '为外部 AI Agent 授权服务器。密码和私钥留在面板后端。', endpoint: '接口地址', create: '创建访问令牌', name: '名称', days: '有效天数（1–365）', servers: '授权服务器', permissions: '权限', read: '读取目录与文件', write: '写入文件', exec: '执行任意命令（拥有 SSH 账号的系统权限）', fingerprint: '请先在面板连接服务器并验证主机指纹。MCP 调用无需保持浏览器打开。', once: '令牌仅显示这一次，请妥善保存', copy: '复制令牌', client: 'MCP 客户端配置示例', tokens: '访问令牌', expires: '到期时间', status: '状态', audit: '调用审计', auditHint: '记录调用状态和命令摘要，不保存命令输出、令牌或服务器凭据。', time: '时间', more: '加载更早记录', revoke: '撤销', active: '有效', revoked: '已撤销', expired: '已过期', empty: '暂无记录', choose: '请选择服务器和权限', copied: '已复制', failed: '请求失败，请检查登录状态与输入。' },
  'zh-TW': { 'nav.panel': '返回面板', 'nav.automation': '自動化', 'nav.mcp': 'MCP', 'nav.account': '帳號設定', back: '返回面板', intro: '為外部 AI Agent 授權伺服器。密碼和私鑰留在面板後端。', endpoint: '介面位址', create: '建立存取權杖', name: '名稱', days: '有效天數（1–365）', servers: '授權伺服器', permissions: '權限', read: '讀取目錄與檔案', write: '寫入檔案', exec: '執行任意命令（擁有 SSH 帳號的系統權限）', fingerprint: '請先在面板連線伺服器並驗證主機指紋。MCP 呼叫無需保持瀏覽器開啟。', once: '權杖僅顯示這一次，請妥善保存', copy: '複製權杖', client: 'MCP 用戶端設定範例', tokens: '存取權杖', expires: '到期時間', status: '狀態', audit: '呼叫稽核', auditHint: '記錄呼叫狀態和命令摘要，不保存命令輸出、權杖或伺服器憑證。', time: '時間', more: '載入更早記錄', revoke: '撤銷', active: '有效', revoked: '已撤銷', expired: '已過期', empty: '暫無記錄', choose: '請選擇伺服器和權限', copied: '已複製', failed: '請求失敗，請檢查登入狀態與輸入。' },
  'en-US': { 'nav.panel': 'Back to panel', 'nav.automation': 'Automation', 'nav.mcp': 'MCP', 'nav.account': 'Account settings', back: 'Back to panel', intro: 'Authorize external AI agents to operate saved servers. Passwords and private keys stay on the backend.', endpoint: 'Endpoint', create: 'Create access token', name: 'Name', days: 'Valid days (1–365)', servers: 'Authorized servers', permissions: 'Permissions', read: 'Read directories and files', write: 'Write files', exec: 'Execute arbitrary commands (full privileges of the SSH account)', fingerprint: 'Connect in the panel and verify every host fingerprint first. MCP works while the browser is closed.', once: 'Token is shown only once. Store it securely.', copy: 'Copy token', client: 'Example MCP client configuration', tokens: 'Access tokens', expires: 'Expires', status: 'Status', audit: 'Call audit', auditHint: 'Records call status and command hashes, without outputs, tokens or server credentials.', time: 'Time', more: 'Load earlier records', revoke: 'Revoke', active: 'Active', revoked: 'Revoked', expired: 'Expired', empty: 'No records', choose: 'Select servers and permissions', copied: 'Copied', failed: 'Request failed. Check your login and input.' },
};
const $ = (id) => document.getElementById(id);
let locale = localStorage.getItem('cloudssh_locale') || navigator.language;
locale = dictionaries[locale] ? locale : locale.startsWith('zh') ? 'zh-CN' : 'en-US';
let tokens = [], servers = [], auditRows = [];
const text = (key) => dictionaries[locale][key];
function notify(message) { $('message').textContent = message; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (!response.ok) throw new Error(text('failed'));
  return response.json();
}
function translate() {
  document.documentElement.lang = locale; $('language').value = locale;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = text(element.dataset.i18n);
  renderTokens(); renderAudit();
}
function cell(row, value) { const td = document.createElement('td'); td.textContent = String(value ?? ''); row.append(td); return td; }
function emptyRow(body) { const row = document.createElement('tr'); const td = document.createElement('td'); td.className = 'empty'; td.textContent = text('empty'); row.append(td); body.append(row); }
function badgeCell(row, label, kind) {
  const td = cell(row, '');
  const badge = document.createElement('span'); badge.className = `badge ${kind}`; badge.textContent = label;
  td.append(badge); return td;
}
function renderTokens() {
  $('tokens').replaceChildren();
  for (const token of tokens) {
    const row = document.createElement('tr');
    cell(row, token.name); cell(row, token.server_ids.map((id) => servers.find((server) => server.id === id)?.name || id).join(', '));
    const scopes = cell(row, token.scopes.join(', ')); scopes.className = 'mono';
    cell(row, new Date(token.expires_at).toLocaleString(locale));
    const status = token.revoked_at ? 'revoked' : token.expires_at <= Date.now() ? 'expired' : 'active';
    badgeCell(row, text(status), { active: 'ok', revoked: 'muted', expired: 'warn' }[status]);
    const action = cell(row, '');
    if (status === 'active') {
      const button = document.createElement('button'); button.textContent = text('revoke'); button.className = 'danger';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await api(`/api/mcp/tokens/${token.id}`, { method: 'DELETE' }); await refreshTokens(); }
        catch (error) { notify(error.message); button.disabled = false; }
      }); action.append(button);
    }
    $('tokens').append(row);
  }
  if (!tokens.length) emptyRow($('tokens'));
}
function renderAudit() {
  $('audit').replaceChildren();
  for (const item of auditRows) {
    const row = document.createElement('tr');
    const time = cell(row, new Date(item.created_at).toLocaleString(locale)); time.className = 'mono';
    cell(row, tokens.find((token) => token.id === item.token_id)?.name || item.token_id);
    cell(row, servers.find((server) => server.id === item.server_id)?.name || item.server_id || '');
    const tool = cell(row, item.tool); tool.className = 'mono';
    badgeCell(row, item.status, { succeeded: 'ok', failed: 'err', started: 'muted' }[item.status] || 'warn');
    $('audit').append(row);
  }
  if (!auditRows.length) emptyRow($('audit'));
}
async function refreshTokens() { tokens = await api('/api/mcp/tokens'); renderTokens(); }
$('endpoint').textContent = `${location.origin}/mcp`;
$('language').addEventListener('change', () => { locale = $('language').value; localStorage.setItem('cloudssh_locale', locale); translate(); });
$('create-token').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  $('created').hidden = true; $('token').value = ''; $('client-config').textContent = '';
  try {
    const server_ids = [...document.querySelectorAll('input[name=server]:checked')].map((item) => Number(item.value));
    const scopes = [...document.querySelectorAll('input[name=scope]:checked')].map((item) => item.value);
    if (!server_ids.length || !scopes.length) throw new Error(text('choose'));
    const response = await api('/api/mcp/tokens', { method: 'POST', body: JSON.stringify({
      name: $('name').value, server_ids, scopes, expires_in_days: Number($('days').value),
    }) });
    $('token').value = response.token;
    $('client-config').textContent = JSON.stringify({ mcpServers: { cloudssh: { url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${response.token}` } } } }, null, 2);
    $('created').hidden = false; notify(''); await refreshTokens();
  } catch (error) { notify(error.message); } finally { button.disabled = false; }
});
$('copy').addEventListener('click', async () => {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText($('token').value);
    else {
      $('token').select();
      if (!document.execCommand('copy')) throw new Error('Copy failed');
    }
    notify(text('copied'));
  }
  catch { $('token').select(); notify(text('failed')); }
});
$('more').addEventListener('click', async () => {
  try {
    const before = auditRows.at(-1)?.id || Number.MAX_SAFE_INTEGER;
    const rows = await api(`/api/mcp/audit?before=${before}`);
    auditRows.push(...rows); renderAudit(); if (rows.length < 100) $('more').disabled = true;
  } catch (error) { notify(error.message); }
});
translate();
(async () => {
  try {
    servers = await api('/api/servers');
    for (const server of servers) {
      const label = document.createElement('label'); label.className = 'choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'server'; input.value = server.id;
      const span = document.createElement('span'); span.textContent = `${server.name} (${server.host}:${server.port})`;
      label.append(input, span); $('servers').append(label);
    }
    await refreshTokens(); auditRows = await api('/api/mcp/audit'); renderAudit();
    $('more').disabled = auditRows.length < 100;
  } catch (error) { notify(error.message); }
})();
