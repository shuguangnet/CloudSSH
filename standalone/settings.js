const dictionaries = {
  'zh-CN': { 'nav.panel': '返回面板', 'nav.automation': '自动化', 'nav.mcp': 'MCP', 'nav.account': '账号设置', intro: '为外部 AI Agent 授权服务器。密码和私钥留在面板后端。', endpoint: '接口地址', create: '创建访问令牌', name: '名称', days: '有效天数（1–365）', servers: '授权服务器', permissions: '权限', read: '读取目录与文件', write: '写入文件', exec: '执行任意命令（拥有 SSH 账号的系统权限）', fingerprint: '请先在面板连接服务器并验证主机指纹。MCP 调用无需保持浏览器打开。', once: '令牌仅显示这一次，请妥善保存', copy: '复制令牌', client: 'MCP 客户端配置示例', tokens: '访问令牌', expires: '到期时间', status: '状态', audit: '调用审计', auditHint: '记录每次调用的状态、动作明细（命令 / SQL / 路径，自动脱敏）与来源 IP；不保存命令输出、令牌或服务器凭据。', time: '时间', more: '加载更早记录', revoke: '撤销', active: '有效', revoked: '已撤销', expired: '已过期', empty: '暂无记录', choose: '请选择服务器和权限', copied: '已复制', failed: '请求失败，请检查登录状态与输入。', selectAll: '全选', searchServers: '搜索服务器…（名称 / 主机 / 标签）', searchTokens: '按名称搜索…', noMatch: '没有匹配的服务器', allStatuses: '全部状态', allTokens: '全部令牌', allServers: '全部服务器', reset: '重置', remove: '删除', removeConfirm: '确认删除该令牌记录？删除后将从列表移除，审计记录保留。', removeActive: '请先撤销令牌再删除记录。', confirmRevoke: '确认撤销该令牌？撤销后立即失效，不可恢复。', deleteFailed: '删除失败', selectedCount: '已选 {n}/{total} 台', resultCount: '{n} 条记录', edit: '修改', editTitle: '修改访问令牌', save: '保存', cancel: '取消', disable: '临时禁用', enable: '重新启用', disabled: '已禁用', disableConfirm: '确认临时禁用该令牌？禁用后立即失效，随时可重新启用。', enableConfirm: '确认重新启用该令牌？', batchDelete: '批量删除', batchDeleteConfirm: '确认删除选中的 {n} 个令牌记录？仅已撤销或已过期的记录会被删除。', batchDeleteResult: '已删除 {n} 条，跳过 {skipped} 条（仍有效或不存在）', purge: '清理审计', confirmPurge: '确认删除当前筛选条件下的审计记录？不可恢复。', confirmPurgeAll: '确认清空全部调用审计记录？不可恢复。', purged: '已清理 {n} 条审计记录', view: '查看', viewTitle: '查看访问令牌', viewLegacy: '该令牌创建于旧版本，未保存可查看副本；如需明文请撤销后重新创建。', viewHint: '令牌等同面板密码，查看行为会写入审计。请勿在不受信任的屏幕上展开。', viewFailed: '查看失败：加密副本无法解密（密钥文件可能已更换）。', detail: '明细', sourceIp: '来源 IP' },
  'zh-TW': { 'nav.panel': '返回面板', 'nav.automation': '自動化', 'nav.mcp': 'MCP', 'nav.account': '帳號設定', intro: '為外部 AI Agent 授權伺服器。密碼和私鑰留在面板後端。', endpoint: '介面位址', create: '建立存取權杖', name: '名稱', days: '有效天數（1–365）', servers: '授權伺服器', permissions: '權限', read: '讀取目錄與檔案', write: '寫入檔案', exec: '執行任意命令（擁有 SSH 帳號的系統權限）', fingerprint: '請先在面板連線伺服器並驗證主機指紋。MCP 呼叫無需保持瀏覽器開啟。', once: '權杖僅顯示這一次，請妥善保存', copy: '複製權杖', client: 'MCP 用戶端設定範例', tokens: '存取權杖', expires: '到期時間', status: '狀態', audit: '呼叫稽核', auditHint: '記錄呼叫狀態和命令摘要，不保存命令輸出、權杖或伺服器憑證。', time: '時間', more: '載入更早記錄', revoke: '撤銷', active: '有效', revoked: '已撤銷', expired: '已過期', empty: '暫無記錄', choose: '請選擇伺服器和權限', copied: '已複製', failed: '請求失敗，請檢查登入狀態與輸入。', selectAll: '全選', searchServers: '搜尋伺服器…（名稱 / 主機 / 標籤）', searchTokens: '按名稱搜尋…', noMatch: '沒有匹配的伺服器', allStatuses: '全部狀態', allTokens: '全部權杖', allServers: '全部伺服器', reset: '重設', remove: '刪除', removeConfirm: '確認刪除該權杖記錄？刪除後將從列表移除，稽核記錄保留。', removeActive: '請先撤銷權杖再刪除記錄。', confirmRevoke: '確認撤銷該權杖？撤銷後立即失效，不可恢復。', deleteFailed: '刪除失敗', selectedCount: '已選 {n}/{total} 台', resultCount: '{n} 筆記錄', edit: '編輯', editTitle: '修改存取權杖', save: '儲存', cancel: '取消', disable: '暫時停用', enable: '重新啟用', disabled: '已停用', disableConfirm: '確認暫時停用該權杖？停用後立即失效，隨時可重新啟用。', enableConfirm: '確認重新啟用該權杖？', batchDelete: '批次刪除', batchDeleteConfirm: '確認刪除選取的 {n} 筆權杖記錄？僅已撤銷或已過期的記錄會被刪除。', batchDeleteResult: '已刪除 {n} 筆，略過 {skipped} 筆（仍有效或不存在）', purge: '清理稽核', confirmPurge: '確認刪除目前篩選條件下的稽核記錄？不可復原。', confirmPurgeAll: '確認清空全部呼叫稽核記錄？不可復原。', purged: '已清理 {n} 筆稽核記錄', view: '查看', viewTitle: '查看存取權杖', viewLegacy: '該權杖建立於舊版本，未保存可查看副本；如需明文請撤銷後重新建立。', viewHint: '權杖等同面板密碼，查看行為會寫入稽核。請勿在不受信任的螢幕上展開。', viewFailed: '查看失敗：加密副本無法解密（金鑰檔案可能已更換）。', detail: '明細', sourceIp: '來源 IP' },
  'en-US': { 'nav.panel': 'Back to panel', 'nav.automation': 'Automation', 'nav.mcp': 'MCP', 'nav.account': 'Account settings', intro: 'Authorize external AI agents to operate saved servers. Passwords and private keys stay on the backend.', endpoint: 'Endpoint', create: 'Create access token', name: 'Name', days: 'Valid days (1–365)', servers: 'Authorized servers', permissions: 'Permissions', read: 'Read directories and files', write: 'Write files', exec: 'Execute arbitrary commands (full privileges of the SSH account)', fingerprint: 'Connect in the panel and verify every host fingerprint first. MCP works while the browser is closed.', once: 'Token is shown only once. Store it securely.', copy: 'Copy token', client: 'Example MCP client configuration', tokens: 'Access tokens', expires: 'Expires', status: 'Status', audit: 'Call audit', auditHint: 'Records call status and command hashes, without outputs, tokens or server credentials.', time: 'Time', more: 'Load earlier records', revoke: 'Revoke', active: 'Active', revoked: 'Revoked', expired: 'Expired', empty: 'No records', choose: 'Select servers and permissions', copied: 'Copied', failed: 'Request failed. Check your login and input.', selectAll: 'Select all', searchServers: 'Search servers… (name / host / tags)', searchTokens: 'Search by name…', noMatch: 'No matching servers', allStatuses: 'All statuses', allTokens: 'All tokens', allServers: 'All servers', reset: 'Reset', remove: 'Delete', removeConfirm: 'Delete this token record? It will be removed from the list; audit history is kept.', removeActive: 'Revoke the token before deleting its record.', confirmRevoke: 'Revoke this token? It stops working immediately and cannot be restored.', deleteFailed: 'Delete failed', selectedCount: '{n}/{total} selected', resultCount: '{n} records', edit: 'Edit', editTitle: 'Edit access token', save: 'Save', cancel: 'Cancel', disable: 'Disable', enable: 'Enable', disabled: 'Disabled', disableConfirm: 'Disable this token temporarily? It stops working immediately and can be re-enabled anytime.', enableConfirm: 'Re-enable this token?', batchDelete: 'Delete selected', batchDeleteConfirm: 'Delete {n} selected token records? Only revoked or expired records are removed.', batchDeleteResult: 'Deleted {n}, skipped {skipped} (still active or missing)', purge: 'Purge audit', confirmPurge: 'Delete audit records matching the current filters? This cannot be undone.', confirmPurgeAll: 'Delete the entire call audit history? This cannot be undone.', purged: 'Purged {n} audit records', view: 'View', viewTitle: 'View access token', viewLegacy: 'This token was created on an older version and has no viewable copy stored; revoke and recreate it if you need the plaintext.', viewHint: 'The token is as sensitive as your panel password; each view is written to the audit log. Do not expand it on untrusted screens.', viewFailed: 'View failed: the encrypted copy could not be decrypted (the key file may have changed).', detail: 'Detail', sourceIp: 'Source IP' },
};
const $ = (id) => document.getElementById(id);
let locale = localStorage.getItem('cloudssh_locale') || navigator.language;
locale = dictionaries[locale] ? locale : locale.startsWith('zh') ? 'zh-CN' : 'en-US';
let tokens = [], servers = [], auditRows = [];
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
  // 无障碍名称：筛选下拉与服务器选择器的 aria-label 随语言切换。
  for (const element of document.querySelectorAll('[data-i18n-label]')) element.setAttribute('aria-label', text(element.dataset.i18nLabel));
  createPicker.render(); editPicker.render(); renderAuditFilters(); renderTokens(); renderAudit();
}
function cell(row, value) { const td = document.createElement('td'); td.textContent = String(value ?? ''); row.append(td); return td; }
function emptyRow(body) { const row = document.createElement('tr'); const td = document.createElement('td'); td.className = 'empty'; td.textContent = text('empty'); row.append(td); body.append(row); }
function badgeCell(row, label, kind) {
  const td = cell(row, '');
  const badge = document.createElement('span'); badge.className = `badge ${kind}`; badge.textContent = label;
  td.append(badge); return td;
}
const fill = (key, values) => text(key).replace('{n}', String(values.n)).replace('{total}', String(values.total ?? 0))
  .replace('{skipped}', String(values.skipped ?? 0));
const tokenStatus = (token) => token.revoked_at ? 'revoked'
  : token.expires_at <= Date.now() ? 'expired' : token.disabled_at ? 'disabled' : 'active';
const statusBadge = { active: 'ok', disabled: 'info', expired: 'warn', revoked: 'muted' };
const serverName = (id) => servers.find((server) => server.id === id)?.name || `#${id}`;
const tokenName = (id) => tokens.find((token) => token.id === id)?.name || `#${String(id).slice(0, 8)}`;

/* ---------- 服务器多选控件（创建令牌 + 修改令牌共用） ----------
   selected 是勾选状态的唯一真源：搜索过滤会重建卡片 DOM，
   勾选不丢失；全选/取消作用于全部服务器（含被搜索隐藏的）。 */
function createServerPicker({ grid, empty, count, selectAll, search }) {
  const selected = new Set();
  function sync() {
    count.textContent = fill('selectedCount', { n: selected.size, total: servers.length });
    selectAll.checked = servers.length > 0 && selected.size === servers.length;
    selectAll.indeterminate = selected.size > 0 && selected.size < servers.length;
    for (const card of grid.querySelectorAll('.server-card')) {
      card.classList.toggle('server-card--selected', card.querySelector('input').checked);
    }
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    grid.replaceChildren();
    const visible = servers.filter((server) => !query
      || `${server.name} ${server.host} ${(server.tags || []).join(' ')}`.toLowerCase().includes(query));
    for (const server of visible) {
      const label = document.createElement('label'); label.className = 'server-card';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'server'; input.value = server.id;
      if (selected.has(server.id)) { input.checked = true; label.classList.add('server-card--selected'); }
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
    empty.hidden = visible.length > 0;
    sync();
  }
  selectAll.addEventListener('change', () => {
    selected.clear();
    if (selectAll.checked) for (const server of servers) selected.add(server.id);
    render();
  });
  grid.addEventListener('change', (event) => {
    const input = event.target;
    if (input.name !== 'server') return;
    const id = Number(input.value);
    if (input.checked) selected.add(id); else selected.delete(id);
    sync();
  });
  search.addEventListener('input', render);
  return { selected, render, sync };
}
const createPicker = createServerPicker({ grid: $('servers'), empty: $('servers-empty'), count: $('server-count'), selectAll: $('select-all'), search: $('server-search') });
const editPicker = createServerPicker({ grid: $('edit-servers'), empty: $('edit-servers-empty'), count: $('edit-server-count'), selectAll: $('edit-select-all'), search: $('edit-server-search') });

/* ---------- 访问令牌：状态/名称筛选 + 修改/禁用/撤销/删除/批量删除 ---------- */
const selectedTokens = new Set(); // 仅存当前列表内的勾选，令牌被删除后由 refreshTokens 收尾
function filteredTokens() {
  const query = $('token-filter').value.trim().toLowerCase();
  const status = $('token-status-filter').value;
  return tokens.filter((token) => (!status || tokenStatus(token) === status)
    && (!query || token.name.toLowerCase().includes(query)));
}
function rowAction(tr, label, className, handler) {
  const button = document.createElement('button');
  button.textContent = label; button.className = className;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await handler(); } catch (error) { notify(error.message); } finally { button.disabled = false; }
  });
  tr.append(button);
  return button;
}
function syncTokenSelection() {
  for (const id of [...selectedTokens]) if (!tokens.some((token) => token.id === id)) selectedTokens.delete(id);
  const visible = filteredTokens();
  const selectAll = $('token-select-all');
  const checked = visible.filter((token) => selectedTokens.has(token.id)).length;
  selectAll.checked = visible.length > 0 && checked === visible.length;
  selectAll.indeterminate = checked > 0 && checked < visible.length;
  const batch = $('token-batch-delete');
  batch.disabled = selectedTokens.size === 0;
  batch.textContent = selectedTokens.size ? `${text('batchDelete')} (${selectedTokens.size})` : text('batchDelete');
  for (const box of document.querySelectorAll('input.token-select')) {
    box.checked = selectedTokens.has(box.value);
  }
}
$('token-select-all').addEventListener('change', (event) => {
  for (const token of filteredTokens()) {
    if (event.target.checked) selectedTokens.add(token.id); else selectedTokens.delete(token.id);
  }
  syncTokenSelection();
});
$('token-batch-delete').addEventListener('click', async () => {
  const ids = [...selectedTokens];
  if (!ids.length || !window.confirm(fill('batchDeleteConfirm', { n: ids.length }))) return;
  $('token-batch-delete').disabled = true;
  try {
    const result = await api('/api/mcp/tokens/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    selectedTokens.clear();
    notify(fill('batchDeleteResult', { n: result.deleted.length, skipped: result.skipped.length }));
    await refreshTokens();
  } catch (error) { notify(error.message); } finally { syncTokenSelection(); }
});
function renderTokens() {
  const rows = filteredTokens();
  $('tokens').replaceChildren();
  for (const token of rows) {
    const tr = document.createElement('tr');
    const selectCell = cell(tr, '');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.className = 'token-select'; box.value = token.id;
    box.setAttribute('aria-label', token.name);
    box.checked = selectedTokens.has(token.id);
    box.addEventListener('change', () => {
      if (box.checked) selectedTokens.add(token.id); else selectedTokens.delete(token.id);
      syncTokenSelection();
    });
    selectCell.append(box);
    cell(tr, token.name);
    cell(tr, token.server_ids.map(serverName).join(', '));
    const scopes = cell(tr, token.scopes.join(', ')); scopes.className = 'mono';
    cell(tr, new Date(token.expires_at).toLocaleString(locale));
    const status = tokenStatus(token);
    badgeCell(tr, text(status), statusBadge[status]);
    const action = cell(tr, '');
    action.className = 'row-actions';
    // 查看令牌：对任意状态开放（撤销/过期的令牌同样可能需要核对明文），
    // 老令牌（无加密副本）在后端返回 null，弹窗内给出说明而不是报错。
    if (token.revealable) {
      rowAction(action, text('view'), 'ghost', () => { openViewToken(token); return Promise.resolve(); });
    }
    if (status === 'active' || status === 'disabled') {
      rowAction(action, text('edit'), 'ghost', () => { openEditToken(token); return Promise.resolve(); });
      rowAction(action, text(status === 'disabled' ? 'enable' : 'disable'), 'ghost', async () => {
        const enable = status === 'disabled';
        if (!window.confirm(text(enable ? 'enableConfirm' : 'disableConfirm'))) return;
        await api(`/api/mcp/tokens/${token.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !enable }) });
        await refreshTokens();
      });
    }
    if (status === 'active' || status === 'disabled') {
      rowAction(action, text('revoke'), 'danger', async () => {
        if (!window.confirm(text('confirmRevoke'))) return;
        await api(`/api/mcp/tokens/${token.id}`, { method: 'DELETE' });
        await refreshTokens();
      });
    } else {
      rowAction(action, text('remove'), 'ghost', async () => {
        if (!window.confirm(text('removeConfirm'))) return;
        try { await api(`/api/mcp/tokens/${token.id}?purge=1`, { method: 'DELETE' }); }
        catch (error) { throw new Error(error.message === 'Active tokens must be revoked before deletion' ? text('removeActive') : error.message); }
        await refreshTokens();
      });
    }
    $('tokens').append(tr);
  }
  if (!rows.length) emptyRow($('tokens'));
  $('token-count').textContent = fill('resultCount', { n: rows.length });
  syncTokenSelection();
}
$('token-filter').addEventListener('input', renderTokens);
$('token-status-filter').addEventListener('change', renderTokens);

/* ---------- 修改令牌：名称 / 授权主机 / 权限（弹窗内自行报错，不用页顶提示） ---------- */
let editingToken = null;
function openEditToken(token) {
  editingToken = token;
  $('edit-message').textContent = '';
  $('edit-name').value = token.name;
  $('edit-server-search').value = '';
  editPicker.selected.clear();
  for (const id of token.server_ids) editPicker.selected.add(id);
  for (const input of document.querySelectorAll('input[name=edit-scope]')) input.checked = token.scopes.includes(input.value);
  editPicker.render();
  $('token-edit').showModal();
}
$('edit-cancel').addEventListener('click', () => $('token-edit').close());
$('token-edit').addEventListener('close', () => { editingToken = null; });

/* ---------- 查看令牌（二次查看）：POST reveal，弹窗内展示明文 + 配置 ---------- */
let viewingToken = null;
function openViewToken(token) {
  viewingToken = token;
  $('view-message').textContent = '';
  $('view-token').value = '';
  $('view-client-config').textContent = '';
  $('view-legacy').hidden = true;
  $('view-body').hidden = true;
  $('token-view').showModal();
  api(`/api/mcp/tokens/${token.id}/reveal`, { method: 'POST' })
    .then((result) => {
      if (viewingToken !== token) return; // 弹窗已关闭/切换，丢弃过期响应
      if (!result.token) { $('view-legacy').hidden = false; return; }
      $('view-token').value = result.token;
      $('view-client-config').textContent = JSON.stringify({ mcpServers: { cloudssh: { url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${result.token}` } } } }, null, 2);
      $('view-body').hidden = false;
    })
    .catch(() => {
      if (viewingToken !== token) return;
      $('view-message').textContent = text('viewFailed');
      $('view-legacy').hidden = false;
    });
}
$('view-close').addEventListener('click', () => $('token-view').close());
$('token-view').addEventListener('close', () => {
  // 关闭即清空：明文不残留在 DOM/内存引用里。
  viewingToken = null;
  $('view-token').value = '';
  $('view-client-config').textContent = '';
});
$('view-copy').addEventListener('click', async () => {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText($('view-token').value);
    else {
      $('view-token').select();
      if (!document.execCommand('copy')) throw new Error('Copy failed');
    }
    notify(text('copied'));
  }
  catch { $('view-token').select(); notify(text('failed')); }
});
$('edit-token').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingToken) return;
  const button = $('edit-token').querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const server_ids = [...editPicker.selected];
    const scopes = [...document.querySelectorAll('input[name=edit-scope]:checked')].map((input) => input.value);
    if (!server_ids.length || !scopes.length) throw new Error(text('choose'));
    await api(`/api/mcp/tokens/${editingToken.id}`, { method: 'PATCH', body: JSON.stringify({ name: $('edit-name').value, server_ids, scopes }) });
    $('token-edit').close();
    notify('');
    await refreshTokens();
  } catch (error) { $('edit-message').textContent = error.message; } finally { button.disabled = false; }
});

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
  // 静态列表兜底：没加载到审计记录时也能按工具筛（与后端注册的工具同步）。
  rebuild($('audit-tool-filter'), [['', 'Tool: *'], ...[...new Set([...tools, ...[
    'list_servers', 'list_snippets', 'get_server_info', 'list_files', 'read_file', 'write_file',
    'download_file', 'upload_file', 'execute_command', 'run_snippet', 'token_reveal',
    'db_list_connections', 'db_schema', 'db_query', 'db_test', 'db_exec',
  ]])].sort().map((tool) => [tool, `Tool: ${tool}`])]);
  renderAudit();
}
function auditFilterParams() {
  const params = new URLSearchParams();
  const token = $('audit-token-filter').value; if (token) params.set('token_id', token);
  const server = $('audit-server-filter').value; if (server) params.set('server_id', server);
  const tool = $('audit-tool-filter').value; if (tool) params.set('tool', tool);
  const status = $('audit-status-filter').value; if (status) params.set('status', status);
  return params;
}
function auditQuery(before) {
  const params = auditFilterParams();
  if (before) params.set('before', String(before));
  return params;
}
/* 动作明细：从审计 details 里拼一行人话摘要（命令 / SQL / 路径 / 片段名 /
 * 错误）。完整 JSON 放在折叠区 <pre> 里，两者都只走 textContent，不拼 HTML。 */
function detailSummary(details) {
  if (!details || typeof details !== 'object') return '';
  const parts = [];
  if (details.snippet_name) parts.push(`[${details.snippet_name}]`);
  if (details.command) parts.push(`$ ${details.command}`);
  if (details.sql) parts.push(details.sql);
  if (details.path) parts.push(details.path);
  if (details.table) parts.push(details.table);
  if (details.connection_name) parts.push(`${details.engine || 'db'}:${details.connection_name}`);
  if (details.name) parts.push(details.name);
  const meta = [];
  if (details.bytes !== undefined) meta.push(`${details.bytes}B`);
  if (details.max_bytes !== undefined) meta.push(`max ${details.max_bytes}B`);
  if (details.offset !== undefined) meta.push(`@${details.offset}`);
  if (details.append === true) meta.push('append');
  if (details.append === false) meta.push('replace');
  if (details.exit_code !== undefined) meta.push(`exit=${details.exit_code}`);
  if (meta.length) parts.push(meta.join(' '));
  if (details.error) parts.push(`! ${details.error}`);
  const summary = parts.join(' · ');
  return summary.length > 96 ? `${summary.slice(0, 96)}…` : summary;
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
    // 明细：折叠展示，摘要一行 + 完整 details JSON；无 details 时留空。
    let details = null;
    try { details = item.details ? JSON.parse(item.details) : null; } catch { details = null; }
    const summary = detailSummary(details);
    const detailCell = cell(tr, '');
    if (summary || details) {
      const box = document.createElement('details');
      const caption = document.createElement('summary'); caption.textContent = summary || '{…}';
      const pre = document.createElement('pre'); pre.className = 'mono'; pre.textContent = JSON.stringify(details, null, 2);
      box.append(caption, pre); detailCell.append(box);
    }
    const ip = cell(tr, item.ip || '—'); ip.className = 'mono';
    $('audit').append(tr);
  }
  if (!auditRows.length) emptyRow($('audit'));
}
async function refreshAudit() {
  const query = auditQuery();
  auditRows = await api(`/api/mcp/audit${query.size ? `?${query}` : ''}`);
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
// 清理审计：不带筛选 = 清空全部（需 all=true 显式确认），带筛选 = 只删匹配记录。
$('audit-purge').addEventListener('click', async () => {
  const params = auditFilterParams();
  if (!window.confirm(text(params.size ? 'confirmPurge' : 'confirmPurgeAll'))) return;
  $('audit-purge').disabled = true;
  try {
    const body = Object.fromEntries(params.entries());
    if (body.server_id) body.server_id = Number(body.server_id);
    if (!params.size) body.all = true;
    const result = await api('/api/mcp/audit/purge', { method: 'POST', body: JSON.stringify(body) });
    notify(fill('purged', { n: result.deleted }));
    await refreshAudit();
  } catch (error) { notify(error.message); } finally { $('audit-purge').disabled = false; }
});

async function refreshTokens() { tokens = await api('/api/mcp/tokens'); renderAuditFilters(); renderTokens(); }
$('endpoint').textContent = `${location.origin}/mcp`;
$('language').addEventListener('change', () => { locale = $('language').value; localStorage.setItem('cloudssh_locale', locale); translate(); });
$('create-token').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  $('created').hidden = true; $('token').value = ''; $('client-config').textContent = '';
  try {
    const server_ids = [...createPicker.selected];
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
    createPicker.render();
    editPicker.render();
    await refreshTokens();
    await refreshAudit();
  } catch (error) { notify(error.message); }
})();
