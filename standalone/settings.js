const dictionaries = {
  'zh-CN': { 'nav.panel': '返回面板', 'nav.automation': '自动化', 'nav.mcp': 'MCP', 'nav.account': '账号设置', intro: '为外部 AI Agent 授权服务器。密码和私钥留在面板后端。', endpoint: '接口地址', create: '创建访问令牌', name: '名称', days: '有效天数（1–365）', servers: '授权服务器', permissions: '权限', read: '读取目录与文件', write: '写入文件', exec: '执行任意命令（拥有 SSH 账号的系统权限）', fingerprint: '请先在面板连接服务器并验证主机指纹。MCP 调用无需保持浏览器打开。', once: '令牌仅显示这一次，请妥善保存', copy: '复制令牌', client: 'MCP 客户端配置示例', tokens: '访问令牌', expires: '到期时间', status: '状态', audit: '调用审计', auditHint: '记录调用状态和命令摘要，不保存命令输出、令牌或服务器凭据。', time: '时间', more: '加载更早记录', revoke: '撤销', active: '有效', revoked: '已撤销', expired: '已过期', empty: '暂无记录', choose: '请选择服务器和权限', copied: '已复制', failed: '请求失败，请检查登录状态与输入。', selectAll: '全选', searchServers: '搜索服务器…（名称 / 主机 / 标签）', searchTokens: '按名称搜索…', noMatch: '没有匹配的服务器', allStatuses: '全部状态', allTokens: '全部令牌', allServers: '全部服务器', reset: '重置', remove: '删除', removeConfirm: '确认删除该令牌记录？删除后将从列表移除，审计记录保留。', removeActive: '请先撤销令牌再删除记录。', confirmRevoke: '确认撤销该令牌？撤销后立即失效，不可恢复。', deleteFailed: '删除失败', selectedCount: '已选 {n}/{total} 台', resultCount: '{n} 条记录' },
  'zh-TW': { 'nav.panel': '返回面板', 'nav.automation': '自動化', 'nav.mcp': 'MCP', 'nav.account': '帳號設定', intro: '為外部 AI Agent 授權伺服器。密碼和私鑰留在面板後端。', endpoint: '介面位址', create: '建立存取權杖', name: '名稱', days: '有效天數（1–365）', servers: '授權伺服器', permissions: '權限', read: '讀取目錄與檔案', write: '寫入檔案', exec: '執行任意命令（擁有 SSH 帳號的系統權限）', fingerprint: '請先在面板連線伺服器並驗證主機指紋。MCP 呼叫無需保持瀏覽器開啟。', once: '權杖僅顯示這一次，請妥善保存', copy: '複製權杖', client: 'MCP 用戶端設定範例', tokens: '存取權杖', expires: '到期時間', status: '狀態', audit: '呼叫稽核', auditHint: '記錄呼叫狀態和命令摘要，不保存命令輸出、權杖或伺服器憑證。', time: '時間', more: '載入更早記錄', revoke: '撤銷', active: '有效', revoked: '已撤銷', expired: '已過期', empty: '暫無記錄', choose: '請選擇伺服器和權限', copied: '已複製', failed: '請求失敗，請檢查登入狀態與輸入。', selectAll: '全選', searchServers: '搜尋伺服器…（名稱 / 主機 / 標籤）', searchTokens: '按名稱搜尋…', noMatch: '沒有匹配的伺服器', allStatuses: '全部狀態', allTokens: '全部權杖', allServers: '全部伺服器', reset: '重設', remove: '刪除', removeConfirm: '確認刪除該權杖記錄？刪除後將從列表移除，稽核記錄保留。', removeActive: '請先撤銷權杖再刪除記錄。', confirmRevoke: '確認撤銷該權杖？撤銷後立即失效，不可恢復。', deleteFailed: '刪除失敗', selectedCount: '已選 {n}/{total} 台', resultCount: '{n} 筆記錄' },
  'en-US': { 'nav.panel': 'Back to panel', 'nav.automation': 'Automation', 'nav.mcp': 'MCP', 'nav.account': 'Account settings', intro: 'Authorize external AI agents to operate saved servers. Passwords and private keys stay on the backend.', endpoint: 'Endpoint', create: 'Create access token', name: 'Name', days: 'Valid days (1–365)', servers: 'Authorized servers', permissions: 'Permissions', read: 'Read directories and files', write: 'Write files', exec: 'Execute arbitrary commands (full privileges of the SSH account)', fingerprint: 'Connect in the panel and verify every host fingerprint first. MCP works while the browser is closed.', once: 'Token is shown only once. Store it securely.', copy: 'Copy token', client: 'Example MCP client configuration', tokens: 'Access tokens', expires: 'Expires', status: 'Status', audit: 'Call audit', auditHint: 'Records call status and command hashes, without outputs, tokens or server credentials.', time: 'Time', more: 'Load earlier records', revoke: 'Revoke', active: 'Active', revoked: 'Revoked', expired: 'Expired', empty: 'No records', choose: 'Select servers and permissions', copied: 'Copied', failed: 'Request failed. Check your login and input.', selectAll: 'Select all', searchServers: 'Search servers… (name / host / tags)', searchTokens: 'Search by name…', noMatch: 'No matching servers', allStatuses: 'All statuses', allTokens: 'All tokens', allServers: 'All servers', reset: 'Reset', remove: 'Delete', removeConfirm: 'Delete this token record? It will be removed from the list; audit history is kept.', removeActive: 'Revoke the token before deleting its record.', confirmRevoke: 'Revoke this token? It stops working immediately and cannot be restored.', deleteFailed: 'Delete failed', selectedCount: '{n}/{total} selected', resultCount: '{n} records' },
};
const $ = (id) => document.getElementById(id);
let locale = localStorage.getItem('cloudssh_locale') || navigator.language;
locale = dictionaries[locale] ? locale : locale.startsWith('zh') ? 'zh-CN' : 'en-US';
let tokens = [], servers = [], auditRows = [], auditFiltered = false;
const text = (key) => dictionaries[locale][key];
function notify(message) { $('message').textContent = message; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || text('failed'));
  }
  return response.json();
}
function translate() {
  document.documentElement.lang = locale; $('language').value = locale;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = text(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) element.placeholder = text(element.dataset.i18nPlaceholder);
  renderServerPicker(); renderAuditFilters(); renderTokens(); renderAudit();
}
function cell(row, value) { const td = document.createElement('td'); td.textContent = String(value ?? ''); row.append(td); return td; }
function emptyRow(body) { const row = document.createElement('tr'); const td = document.createElement('td'); td.className = 'empty'; td.textContent = text('empty'); row.append(td); body.append(row); }
function badgeCell(row, label, kind) {
  const td = cell(row, '');
  const badge = document.createElement('span'); badge.className = `badge ${kind}`; badge.textContent = label;
  td.append(badge); return td;
}
const fill = (key, values) => text(key).replace('{n}', String(values.n)).replace('{total}', String(values.total));
const tokenStatus = (token) => token.revoked_at ? 'revoked' : token.expires_at <= Date.now() ? 'expired' : 'active';
const serverName = (id) => servers.find((server) => server.id === id)?.name || `#${id}`;
const tokenName = (id) => tokens.find((token) => token.id === id)?.name || `#${String(id).slice(0, 8)}`;

/* ---------- 创建令牌：服务器多选 / 全选 / 搜索 ---------- */
function renderServerPicker() {
  const query = $('server-search').value.trim().toLowerCase();
  const grid = $('servers'); grid.replaceChildren();
  const visible = servers.filter((server) => !query
    || `${server.name} ${server.host} ${(server.tags || []).join(' ')}`.toLowerCase().includes(query));
  for (const server of visible) {
    const label = document.createElement('label'); label.className = 'server-card';
    const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'server'; input.value = server.id;
    const body = document.createElement('span'); body.className = 'server-card__body';
    const name = document.createElement('span'); name.className = 'server-card__name'; name.textContent = server.name;
    const host = document.createElement('span'); host.className = 'server-card__host'; host.textContent = `${server.host}:${server.port}`;
    body.append(name, host);
    if ((server.tags || []).length) {
      const tags = document.createElement('span'); tags.className = 'server-card__tags';
      tags.textContent = (server.tags || []).join(' · '); body.append(tags);
    }
    label.append(input, body); grid.append(label);
  }
  $('servers-empty').hidden = visible.length > 0;
  syncSelectionState();
}
function syncSelectionState() {
  const checked = [...document.querySelectorAll('input[name=server]:checked')];
  const all = [...document.querySelectorAll('input[name=server]')];
  $('server-count').textContent = fill('selectedCount', { n: checked.length, total: servers.length });
  const selectAll = $('select-all');
  selectAll.checked = all.length > 0 && checked.length === all.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  for (const card of document.querySelectorAll('.server-card')) {
    card.classList.toggle('server-card--selected', card.querySelector('input').checked);
  }
}
$('select-all').addEventListener('change', (event) => {
  const { checked } = event.target;
  for (const input of document.querySelectorAll('input[name=server]')) input.checked = checked;
  syncSelectionState();
});
$('servers').addEventListener('change', syncSelectionState);
$('server-search').addEventListener('input', () => renderServerPicker());

/* ---------- 访问令牌：状态/名称筛选 + 撤销/删除 ---------- */
function filteredTokens() {
  const query = $('token-filter').value.trim().toLowerCase();
  const status = $('token-status-filter').value;
  return tokens.filter((token) => (!status || tokenStatus(token) === status)
    && (!query || token.name.toLowerCase().includes(query)));
}
function renderTokens() {
  const rows = filteredTokens();
  $('tokens').replaceChildren();
  for (const token of rows) {
    const tr = document.createElement('tr');
    cell(tr, token.name);
    cell(tr, token.server_ids.map(serverName).join(', '));
    const scopes = cell(tr, token.scopes.join(', ')); scopes.className = 'mono';
    cell(tr, new Date(token.expires_at).toLocaleString(locale));
    const status = tokenStatus(token);
    badgeCell(tr, text(status), { active: 'ok', revoked: 'muted', expired: 'warn' }[status]);
    const action = cell(tr, '');
    action.className = 'row-actions';
    if (status === 'active') {
      const revoke = document.createElement('button'); revoke.textContent = text('revoke'); revoke.className = 'danger';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(text('confirmRevoke'))) return;
        revoke.disabled = true;
        try { await api(`/api/mcp/tokens/${token.id}`, { method: 'DELETE' }); await refreshTokens(); }
        catch (error) { notify(error.message); revoke.disabled = false; }
      });
      action.append(revoke);
    } else {
      const remove = document.createElement('button'); remove.textContent = text('remove'); remove.className = 'ghost';
      remove.addEventListener('click', async () => {
        if (!window.confirm(text('removeConfirm'))) return;
        remove.disabled = true;
        try { await api(`/api/mcp/tokens/${token.id}?purge=1`, { method: 'DELETE' }); await refreshTokens(); }
        catch (error) { notify(error.message === 'Active tokens must be revoked before deletion' ? text('removeActive') : error.message); remove.disabled = false; }
      });
      action.append(remove);
    }
    $('tokens').append(tr);
  }
  if (!rows.length) emptyRow($('tokens'));
  $('token-count').textContent = fill('resultCount', { n: rows.length });
}
$('token-filter').addEventListener('input', renderTokens);
$('token-status-filter').addEventListener('change', renderTokens);

/* ---------- 调用审计：组合筛选 + 服务端分页 ---------- */
function renderAuditFilters() {
  const rebuild = (select, options) => {
    const current = select.value; select.replaceChildren();
    for (const [value, label] of options) {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      select.append(option);
    }
    select.value = [...select.options].some((option) => option.value === current) ? current : '';
  };
  rebuild($('audit-token-filter'), [['', text('allTokens')], ...tokens.map((token) => [token.id, token.name])]);
  rebuild($('audit-server-filter'), [['', text('allServers')], ...servers.map((server) => [String(server.id), server.name])]);
  const tools = new Set(auditRows.map((item) => item.tool));
  rebuild($('audit-tool-filter'), [['', 'Tool: *'], ...[...new Set([...tools, ...['list_servers', 'list_snippets', 'get_server_info', 'list_files', 'read_file', 'download_file']])].sort().map((tool) => [tool, `Tool: ${tool}`])]);
  renderAudit();
}
function auditQuery(before) {
  const params = new URLSearchParams();
  if (before) params.set('before', String(before));
  const token = $('audit-token-filter').value; if (token) params.set('token_id', token);
  const server = $('audit-server-filter').value; if (server) params.set('server_id', server);
  const tool = $('audit-tool-filter').value; if (tool) params.set('tool', tool);
  const status = $('audit-status-filter').value; if (status) params.set('status', status);
  return params;
}
function renderAudit() {
  $('audit').replaceChildren();
  for (const item of auditRows) {
    const tr = document.createElement('tr');
    const time = cell(tr, new Date(item.created_at).toLocaleString(locale)); time.className = 'mono';
    cell(tr, tokenName(item.token_id));
    cell(tr, item.server_id ? serverName(item.server_id) : '');
    const tool = cell(tr, item.tool); tool.className = 'mono';
    badgeCell(tr, item.status, { succeeded: 'ok', failed: 'err', started: 'muted', denied: 'warn', unknown: 'warn' }[item.status] || 'warn');
    $('audit').append(tr);
  }
  if (!auditRows.length) emptyRow($('audit'));
}
async function refreshAudit() {
  const query = auditQuery();
  auditRows = await api(`/api/mcp/audit${query.size ? `?${query}` : ''}`);
  auditFiltered = Boolean($('audit-token-filter').value || $('audit-server-filter').value || $('audit-tool-filter').value || $('audit-status-filter').value);
  renderAudit();
  $('more').disabled = auditRows.length < 100;
}
for (const id of ['audit-token-filter', 'audit-server-filter', 'audit-tool-filter', 'audit-status-filter']) {
  $(id).addEventListener('change', refreshAudit);
}
$('audit-reset').addEventListener('click', async () => {
  $('audit-token-filter').value = ''; $('audit-server-filter').value = '';
  $('audit-tool-filter').value = ''; $('audit-status-filter').value = '';
  await refreshAudit();
});

async function refreshTokens() { tokens = await api('/api/mcp/tokens'); renderAuditFilters(); renderTokens(); }
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
    const before = auditRows.at(-1)?.id;
    const query = auditQuery(before);
    const rows = await api(`/api/mcp/audit${query.size ? `?${query}` : ''}`);
    auditRows.push(...rows); renderAudit(); if (rows.length < 100) $('more').disabled = true;
  } catch (error) { notify(error.message); }
});
translate();
(async () => {
  try {
    servers = await api('/api/servers');
    renderServerPicker();
    await refreshTokens();
    await refreshAudit();
  } catch (error) { notify(error.message); }
})();
