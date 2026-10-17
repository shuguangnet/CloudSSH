/* CloudSSH 数据库页面。
   与 automation.js 同一套约定：classic script、无内联处理器（CSP script-src
   'self'）、i18n 用 data-i18n 属性 + dictionaries 三语。 */
const dictionaries = {
  'zh-CN': {
    'nav.panel': '返回面板', 'nav.automation': '自动化', 'nav.mcp': 'MCP',
    'nav.database': '数据库', 'nav.account': '账号设置',
    title: '数据库', intro: '为 MCP Agent 提供受控的数据库访问。密码在面板端加密保存，Agent 只拿到查询结果，永远看不到凭据。',
    failed: '请求失败，请检查登录状态与输入。', empty: '暂无记录', cancel: '取消', edit: '编辑', delete: '删除',
    create: '创建连接', update: '保存修改', createProxy: '创建代理', confirmDelete: '确认删除？',

    driversWarning: '数据库驱动未安装', driversWarningIntro: '当前部署缺少部分数据库驱动，对应类型的连接将无法建立。在服务器上执行以下命令后重启面板：',
    driversMissing: '缺少驱动',

    connections: '数据库连接', connectionsIntro: '每个连接保存一台数据库的访问方式。只读连接会在把 SQL 发给数据库之前拦下写语句。',
    connName: '名称', connEngine: '类型', connHost: '主机', connPort: '端口', connDatabase: '数据库名',
    connUsername: '用户名', connPassword: '密码', connProxy: '代理', connReadOnly: '只读（拒绝写语句）',
    passwordKeepHint: '留空则保留原密码', passwordSet: '已保存密码，留空保持不变',
    proxyDirectOption: '不使用代理（直连）',
    readOnlyHint: '只读是防手滑的闸门，不是安全边界——真正的权限控制请在数据库侧用只读账号实现。',
    targetCol: '目标', modeCol: '模式', testConnection: '测试连接', testing: '测试中…',
    testOk: '连接成功', testFail: '连接失败', connSaved: '连接已保存', connDeleted: '连接已删除',
    readOnlyBadge: '只读', readWriteBadge: '可写',

    proxies: '代理', proxiesIntro: '数据库在不可直连的网络里时，先经代理转发。SOCKS5 与 HTTP CONNECT 适合堡垒机，SSH 跳板复用面板已有服务器的连接。',
    proxyName: '名称', proxyKind: '类型', proxyHost: '主机', proxyPort: '端口',
    proxyUsername: '用户名（可选）', proxyPassword: '密码（可选）',
    proxySaved: '代理已保存', proxyDeleted: '代理已删除', proxySshHint: 'SSH 跳板请填写面板中已保存服务器的地址，认证沿用该服务器的凭据。',

    console: '查询控制台', consoleIntro: '在面板里直接验证 SQL 与权限。结果会按行数/列数/单元格长度截断，只读连接无法执行写语句。',
    consoleConnection: '连接', consoleTimeout: '超时（毫秒）', consoleSql: 'SQL / Redis 命令',
    runQuery: '执行', clearResult: '清空结果', noConnection: '请先创建一个连接', querying: '执行中…',
    queryOk: '返回 {rows} 行（耗时 {ms}）', queryTruncated: '结果已截断：共 {total} 行，仅返回 {shown} 行',
    errReadOnly: '该连接是只读的，已拒绝执行写语句。如需写入，请先关闭该连接的「只读」开关。',
    errDriver: '缺少数据库驱动，请按上方提示安装后重启面板。',

    audit: '访问审计', auditIntro: '只记录 SQL 的 SHA-256 指纹、影响行数与耗时，不保存 SQL 正文和任何查询结果。',
    auditTime: '时间', auditTool: '来源', auditRows: '行数', auditDuration: '耗时', auditFingerprint: 'SQL 指纹',
    refresh: '刷新', statusCol: '状态',
    statusSucceeded: '成功', statusFailed: '失败', statusStarted: '开始', statusDenied: '拒绝', statusUnknown: '未知',
  },
  'zh-TW': {
    'nav.panel': '返回面板', 'nav.automation': '自動化', 'nav.mcp': 'MCP',
    'nav.database': '資料庫', 'nav.account': '帳號設定',
    title: '資料庫', intro: '為 MCP Agent 提供受控的資料庫存取。密碼在面板端加密保存，Agent 只拿到查詢結果，永遠看不到憑據。',
    failed: '請求失敗，請檢查登入狀態與輸入。', empty: '暫無記錄', cancel: '取消', edit: '編輯', delete: '刪除',
    create: '建立連線', update: '儲存修改', createProxy: '建立代理', confirmDelete: '確認刪除？',

    driversWarning: '資料庫驅動未安裝', driversWarningIntro: '目前部署缺少部分資料庫驅動，對應類型的連線將無法建立。在伺服器上執行以下命令後重啟面板：',
    driversMissing: '缺少驅動',

    connections: '資料庫連線', connectionsIntro: '每個連線保存一台資料庫的存取方式。唯讀連線會在把 SQL 送給資料庫之前攔下寫入語句。',
    connName: '名稱', connEngine: '類型', connHost: '主機', connPort: '連接埠', connDatabase: '資料庫名',
    connUsername: '使用者名稱', connPassword: '密碼', connProxy: '代理', connReadOnly: '唯讀（拒絕寫入語句）',
    passwordKeepHint: '留空則保留原密碼', passwordSet: '已儲存密碼，留空保持不變',
    proxyDirectOption: '不使用代理（直連）',
    readOnlyHint: '唯讀是防手滑的閘門，不是安全邊界——真正的權限控制請在資料庫端用唯讀帳號實現。',
    targetCol: '目標', modeCol: '模式', testConnection: '測試連線', testing: '測試中…',
    testOk: '連線成功', testFail: '連線失敗', connSaved: '連線已儲存', connDeleted: '連線已刪除',
    readOnlyBadge: '唯讀', readWriteBadge: '可寫',

    proxies: '代理', proxiesIntro: '資料庫在不可直連的網路裡時，先經代理轉送。SOCKS5 與 HTTP CONNECT 適合堡壘機，SSH 跳板沿用面板已有伺服器的連線。',
    proxyName: '名稱', proxyKind: '類型', proxyHost: '主機', proxyPort: '連接埠',
    proxyUsername: '使用者名稱（選填）', proxyPassword: '密碼（選填）',
    proxySaved: '代理已儲存', proxyDeleted: '代理已刪除', proxySshHint: 'SSH 跳板請填寫面板中已儲存伺服器的位址，認證沿用該伺服器的憑據。',

    console: '查詢主控台', consoleIntro: '在面板裡直接驗證 SQL 與權限。結果會按列數/欄數/儲存格長度截斷，唯讀連線無法執行寫入語句。',
    consoleConnection: '連線', consoleTimeout: '逾時（毫秒）', consoleSql: 'SQL / Redis 命令',
    runQuery: '執行', clearResult: '清空結果', noConnection: '請先建立一個連線', querying: '執行中…',
    queryOk: '傳回 {rows} 列（耗時 {ms}）', queryTruncated: '結果已截斷：共 {total} 列，僅傳回 {shown} 列',
    errReadOnly: '該連線是唯讀的，已拒絕執行寫入語句。如需寫入，請先關閉該連線的「唯讀」開關。',
    errDriver: '缺少資料庫驅動，請依上方提示安裝後重啟面板。',

    audit: '存取稽核', auditIntro: '只記錄 SQL 的 SHA-256 指紋、影響列數與耗時，不保存 SQL 正文和任何查詢結果。',
    auditTime: '時間', auditTool: '來源', auditRows: '列數', auditDuration: '耗時', auditFingerprint: 'SQL 指紋',
    refresh: '重新整理', statusCol: '狀態',
    statusSucceeded: '成功', statusFailed: '失敗', statusStarted: '開始', statusDenied: '拒絕', statusUnknown: '未知',
  },
  'en-US': {
    'nav.panel': 'Panel', 'nav.automation': 'Automation', 'nav.mcp': 'MCP',
    'nav.database': 'Databases', 'nav.account': 'Account',
    title: 'Databases', intro: 'Give MCP agents controlled database access. Passwords are encrypted on the panel; agents only ever receive query results.',
    failed: 'Request failed. Check your session and input.', empty: 'Nothing here yet', cancel: 'Cancel', edit: 'Edit', delete: 'Delete',
    create: 'Create connection', update: 'Save changes', createProxy: 'Create proxy', confirmDelete: 'Delete this?',

    driversWarning: 'Database drivers are missing', driversWarningIntro: 'This deployment is missing some database drivers, so those connection types cannot be used. Run the command below on the server, then restart the panel:',
    driversMissing: 'Missing driver',

    connections: 'Database connections', connectionsIntro: 'Each connection stores how to reach one database. Read-only connections reject write statements before they reach the server.',
    connName: 'Name', connEngine: 'Engine', connHost: 'Host', connPort: 'Port', connDatabase: 'Database',
    connUsername: 'Username', connPassword: 'Password', connProxy: 'Proxy', connReadOnly: 'Read-only (reject writes)',
    passwordKeepHint: 'Leave blank to keep the current password', passwordSet: 'A password is stored; leave blank to keep it',
    proxyDirectOption: 'No proxy (direct)',
    readOnlyHint: 'Read-only is a guard rail, not a security boundary — enforce real limits with a read-only database account.',
    targetCol: 'Target', modeCol: 'Mode', testConnection: 'Test connection', testing: 'Testing…',
    testOk: 'Connection succeeded', testFail: 'Connection failed', connSaved: 'Connection saved', connDeleted: 'Connection deleted',
    readOnlyBadge: 'read-only', readWriteBadge: 'writable',

    proxies: 'Proxies', proxiesIntro: 'When a database is unreachable directly, route through a proxy. SOCKS5 and HTTP CONNECT fit jump hosts; an SSH proxy reuses a saved server.',
    proxyName: 'Name', proxyKind: 'Kind', proxyHost: 'Host', proxyPort: 'Port',
    proxyUsername: 'Username (optional)', proxyPassword: 'Password (optional)',
    proxySaved: 'Proxy saved', proxyDeleted: 'Proxy deleted', proxySshHint: 'For an SSH proxy, enter the address of a server already saved in the panel; its credentials are reused.',

    console: 'Query console', consoleIntro: 'Verify SQL and permissions right here. Results are truncated by rows, columns and cell length; read-only connections cannot write.',
    consoleConnection: 'Connection', consoleTimeout: 'Timeout (ms)', consoleSql: 'SQL / Redis command',
    runQuery: 'Run', clearResult: 'Clear result', noConnection: 'Create a connection first', querying: 'Running…',
    queryOk: 'Returned {rows} rows in {ms}', queryTruncated: 'Truncated: {total} rows total, {shown} returned',
    errReadOnly: 'This connection is read-only, so the write was rejected. Turn off read-only for this connection to allow writes.',
    errDriver: 'A database driver is missing. Install it as shown above, then restart the panel.',

    audit: 'Access audit', auditIntro: 'Only the SQL SHA-256 fingerprint, row counts and durations are recorded — never SQL text or results.',
    auditTime: 'Time', auditTool: 'Source', auditRows: 'Rows', auditDuration: 'Duration', auditFingerprint: 'SQL fingerprint',
    refresh: 'Refresh', statusCol: 'Status',
    statusSucceeded: 'succeeded', statusFailed: 'failed', statusStarted: 'started', statusDenied: 'denied', statusUnknown: 'unknown',
  },
};

const $ = (id) => document.getElementById(id);
let locale = localStorage.getItem('cloudssh_locale') || navigator.language;
locale = dictionaries[locale] ? locale : locale.startsWith('zh') ? 'zh-CN' : 'en-US';
const text = (key) => dictionaries[locale][key] ?? key;
/** 带占位符的文案：format('queryOk', {rows: 3, ms: 12})。 */
const format = (key, values) => String(text(key)).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');

let connections = [], proxies = [], engines = {}, editingConnection = null, editingProxy = null;

function notify(message) { $('message').textContent = message ?? ''; }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(localizedError(body));
  return body;
}

/**
 * 后端错误优先按 code 映射成本地化文案，映射不到才回落到服务端原文。
 * 这样界面语言与用户选择一致，同时保留后端的具体诊断信息（如哪个语法错）。
 */
function localizedError(body) {
  if (body?.code === 'readOnly') return text('errReadOnly');
  if (body?.code === 'driverMissing') return text('errDriver');
  return body?.error || text('failed');
}

function cell(row, value) { const td = document.createElement('td'); td.textContent = String(value ?? ''); row.append(td); return td; }
function emptyRow(body, columns) {
  const row = document.createElement('tr'); const td = document.createElement('td');
  td.className = 'empty'; td.colSpan = columns; td.textContent = text('empty'); row.append(td); body.append(row);
}
function badgeCell(row, label, kind) {
  const td = cell(row, '');
  const badge = document.createElement('span'); badge.className = `badge ${kind}`; badge.textContent = label;
  td.append(badge); return td;
}
function button(label, handler, variant) {
  const element = document.createElement('button');
  element.type = 'button'; element.textContent = label;
  if (variant) element.className = variant;
  element.addEventListener('click', handler);
  return element;
}
const formatTime = (ts) => ts ? new Date(ts).toLocaleString(locale) : '—';
const formatDuration = (ms) => ms === null || ms === undefined ? '—' : (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const engineLabel = (engine) => ({ mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', redis: 'Redis' }[engine] || engine);
const proxyName = (id) => proxies.find((proxy) => proxy.id === id)?.name || '';

function translate() {
  document.documentElement.lang = locale;
  const select = $('language'); if (select) select.value = locale;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = text(element.dataset.i18n);
  renderDrivers(); renderConnections(); renderProxies(); renderConsoleConnections(); updateProxyFormMode();
}

// ---------- 驱动状态 ----------
function renderDrivers() {
  const missing = Object.values(engines).filter((entry) => !entry.available);
  $('drivers-warning').hidden = missing.length === 0;
  if (missing.length === 0) return;
  const list = $('drivers-missing'); list.replaceChildren();
  for (const entry of missing) {
    const item = document.createElement('li');
    item.textContent = `${text('driversMissing')}: ${entry.engine} → ${entry.package}`;
    list.append(item);
  }
  // 只列真正缺的包，避免让用户重复装已有的。
  const packages = [...new Set(missing.map((entry) => entry.package))];
  $('drivers-command').textContent = `pnpm add ${packages.join(' ')}`;
}

// ---------- 连接 ----------
function renderConnections() {
  const body = $('connections'); body.replaceChildren();
  if (connections.length === 0) return emptyRow(body, 6);
  for (const connection of connections) {
    const row = document.createElement('tr');
    cell(row, connection.name);
    cell(row, engineLabel(connection.engine));
    cell(row, `${connection.host}:${connection.port}${connection.database ? ` / ${connection.database}` : ''}`);
    cell(row, connection.proxyId ? proxyName(connection.proxyId) || `#${connection.proxyId}` : '—');
    badgeCell(row, connection.readOnly ? text('readOnlyBadge') : text('readWriteBadge'), connection.readOnly ? 'ok' : 'warn');
    const actions = cell(row, '');
    actions.append(
      button(text('edit'), () => startEditConnection(connection), 'ghost small'),
      button(text('testConnection'), (event) => testSavedConnection(connection, event.target), 'ghost small'),
      button(text('delete'), () => removeConnection(connection), 'ghost small danger'),
    );
    body.append(row);
  }
}

function updateProxyOptions() {
  const select = $('conn-proxy');
  const current = select.value;
  select.replaceChildren();
  const direct = document.createElement('option');
  direct.value = ''; direct.textContent = text('proxyDirectOption');
  select.append(direct);
  for (const proxy of proxies) {
    const option = document.createElement('option');
    option.value = String(proxy.id);
    option.textContent = `${proxy.name} (${proxy.kind})`;
    select.append(option);
  }
  // 保留用户选择；编辑时若连接引用了已删代理也不会静默改成直连。
  select.value = current;
}

function fillEngineDefaults() {
  const engine = $('conn-engine').value;
  const port = $('conn-port');
  // 只在端口为空或仍是「上一个引擎的默认值」时才覆盖，尊重用户手填。
  const defaults = { mysql: 3306, mariadb: 3306, postgres: 5432, redis: 6379 };
  const otherDefaults = Object.values(defaults).map(String);
  if (!port.value || otherDefaults.includes(port.value)) port.value = String(defaults[engine] ?? '');
  // Redis 的「库名」是一个数字索引，不是数据库名。
  const database = $('conn-database');
  if (engine === 'redis') {
    database.placeholder = '0';
    if (!database.value) database.value = '0';
  } else {
    database.placeholder = 'app';
    if (database.value === '0') database.value = '';
  }
}

function resetConnectionForm() {
  editingConnection = null;
  $('connection-id').value = '';
  $('conn-name').value = '';
  $('conn-engine').value = 'mysql';
  $('conn-host').value = '';
  $('conn-port').value = '3306';
  $('conn-database').value = '';
  $('conn-username').value = '';
  $('conn-password').value = '';
  $('conn-password').placeholder = '';
  $('conn-proxy').value = '';
  $('conn-readonly').checked = true;
  $('conn-save').textContent = text('create');
  $('conn-cancel').hidden = true;
  $('conn-password-hint').textContent = text('passwordKeepHint');
}

function startEditConnection(connection) {
  editingConnection = connection;
  $('connection-id').value = String(connection.id);
  $('conn-name').value = connection.name;
  $('conn-engine').value = connection.engine;
  $('conn-host').value = connection.host;
  $('conn-port').value = String(connection.port);
  $('conn-database').value = connection.database || '';
  $('conn-username').value = connection.username || '';
  // 密码永远不回填：服务端只回 hasPassword 布尔值。
  $('conn-password').value = '';
  $('conn-password').placeholder = connection.hasPassword ? '••••••••' : '';
  $('conn-password-hint').textContent = connection.hasPassword ? text('passwordSet') : text('passwordKeepHint');
  $('conn-proxy').value = connection.proxyId ? String(connection.proxyId) : '';
  $('conn-readonly').checked = connection.readOnly;
  $('conn-save').textContent = text('update');
  $('conn-cancel').hidden = false;
  $('conn-name').focus();
}

function connectionPayload() {
  const payload = {
    name: $('conn-name').value.trim(),
    engine: $('conn-engine').value,
    host: $('conn-host').value.trim(),
    port: Number($('conn-port').value),
    database: $('conn-database').value.trim(),
    username: $('conn-username').value.trim(),
    readOnly: $('conn-readonly').checked,
    proxyId: $('conn-proxy').value ? Number($('conn-proxy').value) : null,
  };
  const password = $('conn-password').value;
  // 编辑时留空 = 保留原密码，所以不能把空串发上去（那会被当成「清空」）。
  if (password || !editingConnection) payload.password = password;
  return payload;
}

async function saveConnection(event) {
  event.preventDefault();
  try {
    const payload = connectionPayload();
    if (editingConnection) await api(`/api/db/connections/${editingConnection.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/db/connections', { method: 'POST', body: JSON.stringify(payload) });
    notify(text('connSaved'));
    resetConnectionForm();
    await refresh();
  } catch (error) { notify(error.message); }
}

async function removeConnection(connection) {
  if (!confirm(text('confirmDelete'))) return;
  try {
    await api(`/api/db/connections/${connection.id}`, { method: 'DELETE' });
    notify(text('connDeleted'));
    await refresh();
  } catch (error) { notify(error.message); }
}

async function testSavedConnection(connection, buttonElement) {
  const original = buttonElement.textContent;
  buttonElement.disabled = true; buttonElement.textContent = text('testing');
  try {
    const result = await api(`/api/db/connections/${connection.id}/test`, { method: 'POST', body: '{}' });
    notify(result.ok ? `${text('testOk')} (${formatDuration(result.durationMs)})` : `${text('testFail')}: ${result.error}`);
  } catch (error) { notify(`${text('testFail')}: ${error.message}`); }
  finally { buttonElement.disabled = false; buttonElement.textContent = original; }
}

async function testFormConnection() {
  const id = $('connection-id').value;
  if (!id) {
    // 还没保存的连接：先建再测会很脏，直接提示用户先保存。
    notify(text('connSaved'));
    return;
  }
  const element = $('conn-test');
  const original = element.textContent;
  element.disabled = true; element.textContent = text('testing');
  try {
    // 把当前表单（含新密码、未保存的改动）一起发过去，服务端只在内存里合成。
    const result = await api(`/api/db/connections/${id}/test`, {
      method: 'POST', body: JSON.stringify(connectionPayload()),
    });
    notify(result.ok ? `${text('testOk')} (${formatDuration(result.durationMs)})` : `${text('testFail')}: ${result.error}`);
  } catch (error) { notify(`${text('testFail')}: ${error.message}`); }
  finally { element.disabled = false; element.textContent = original; }
}

// ---------- 代理 ----------
function updateProxyFormMode() {
  // SSH 代理不用 host/port，而是复用面板里已有服务器的地址——这里只提示。
  const isSsh = $('proxy-kind').value === 'ssh';
  $('proxy-host').required = !isSsh;
  $('proxy-port').required = !isSsh;
  let hint = $('proxy-ssh-hint');
  if (isSsh) {
    if (!hint) {
      hint = document.createElement('p');
      hint.id = 'proxy-ssh-hint'; hint.className = 'hint';
      $('proxy-endpoint-fields').after(hint);
    }
    hint.textContent = text('proxySshHint');
  } else if (hint) { hint.remove(); }
}

function renderProxies() {
  const body = $('proxies'); body.replaceChildren();
  if (proxies.length === 0) return emptyRow(body, 4);
  for (const proxy of proxies) {
    const row = document.createElement('tr');
    cell(row, proxy.name);
    cell(row, proxy.kind);
    cell(row, proxy.kind === 'ssh' ? (proxy.username ? `${proxy.username}@${proxy.host}` : proxy.host)
      : `${proxy.host}:${proxy.port}`);
    const actions = cell(row, '');
    actions.append(
      button(text('edit'), () => startEditProxy(proxy), 'ghost small'),
      button(text('delete'), () => removeProxy(proxy), 'ghost small danger'),
    );
    body.append(row);
  }
}

function resetProxyForm() {
  editingProxy = null;
  $('proxy-id').value = '';
  $('proxy-name').value = '';
  $('proxy-kind').value = 'socks5';
  $('proxy-host').value = '';
  $('proxy-port').value = '';
  $('proxy-username').value = '';
  $('proxy-password').value = '';
  $('proxy-password').placeholder = '';
  $('proxy-save').textContent = text('createProxy');
  $('proxy-cancel').hidden = true;
  updateProxyFormMode();
}

function startEditProxy(proxy) {
  editingProxy = proxy;
  $('proxy-id').value = String(proxy.id);
  $('proxy-name').value = proxy.name;
  $('proxy-kind').value = proxy.kind;
  $('proxy-host').value = proxy.host;
  $('proxy-port').value = String(proxy.port);
  $('proxy-username').value = proxy.username || '';
  $('proxy-password').value = '';
  $('proxy-password').placeholder = proxy.hasPassword ? '••••••••' : '';
  $('proxy-save').textContent = text('update');
  $('proxy-cancel').hidden = false;
  updateProxyFormMode();
}

function proxyPayload() {
  const payload = {
    name: $('proxy-name').value.trim(),
    kind: $('proxy-kind').value,
    host: $('proxy-host').value.trim(),
    port: Number($('proxy-port').value),
    username: $('proxy-username').value.trim(),
  };
  const password = $('proxy-password').value;
  if (password || !editingProxy) payload.password = password;
  return payload;
}

async function saveProxy(event) {
  event.preventDefault();
  try {
    const payload = proxyPayload();
    if (editingProxy) await api(`/api/db/proxies/${editingProxy.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/db/proxies', { method: 'POST', body: JSON.stringify(payload) });
    notify(text('proxySaved'));
    resetProxyForm();
    await refresh();
  } catch (error) { notify(error.message); }
}

async function removeProxy(proxy) {
  if (!confirm(text('confirmDelete'))) return;
  try {
    await api(`/api/db/proxies/${proxy.id}`, { method: 'DELETE' });
    notify(text('proxyDeleted'));
    await refresh();
  } catch (error) { notify(error.message); }
}

// ---------- 控制台 ----------
function renderConsoleConnections() {
  const select = $('console-connection');
  const current = select.value;
  select.replaceChildren();
  if (connections.length === 0) {
    const option = document.createElement('option');
    option.value = ''; option.textContent = text('noConnection');
    select.append(option);
    return;
  }
  for (const connection of connections) {
    const option = document.createElement('option');
    option.value = String(connection.id);
    option.textContent = `${connection.name} — ${engineLabel(connection.engine)}`;
    select.append(option);
  }
  if (current && connections.some((connection) => String(connection.id) === current)) select.value = current;
}

function renderResult(result) {
  const holder = $('console-result');
  const head = $('console-head'); const body = $('console-body');
  head.replaceChildren(); body.replaceChildren();
  const columns = result.columns?.length ? result.columns : ['value'];
  for (const column of columns) {
    const th = document.createElement('th'); th.textContent = column; head.append(th);
  }
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (const column of columns) {
      const td = document.createElement('td');
      const value = row[column];
      td.textContent = value === null || value === undefined ? 'NULL' : String(value);
      tr.append(td);
    }
    body.append(tr);
  }
  holder.hidden = false;
}

async function runQuery() {
  const connectionId = Number($('console-connection').value);
  if (!connectionId) { notify(text('noConnection')); return; }
  const sql = $('console-sql').value;
  if (!sql.trim()) return;
  const status = $('console-status');
  status.textContent = text('querying');
  try {
    const result = await api('/api/db/query', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId, sql,
        timeout_ms: Number($('console-timeout').value) || 30000,
      }),
    });
    renderResult(result);
    status.textContent = result.truncated
      ? format('queryTruncated', { total: result.rowCount, shown: result.returnedRows })
      : format('queryOk', { rows: result.rowCount, ms: formatDuration(result.durationMs) });
    await loadAudit();
  } catch (error) {
    $('console-result').hidden = true;
    status.textContent = error.message;
  }
}

// ---------- 审计 ----------
function auditStatusLabel(status) {
  return ({ succeeded: text('statusSucceeded'), failed: text('statusFailed'), started: text('statusStarted'),
    denied: text('statusDenied'), unknown: text('statusUnknown') })[status] || status;
}

async function loadAudit() {
  try {
    const data = await api('/api/db/audit?limit=100');
    const body = $('audit'); body.replaceChildren();
    if (data.audit.length === 0) return emptyRow(body, 7);
    for (const entry of data.audit) {
      const row = document.createElement('tr');
      cell(row, formatTime(entry.created_at));
      cell(row, entry.connection_name);
      cell(row, entry.tool);
      badgeCell(row, auditStatusLabel(entry.status), entry.status === 'succeeded' ? 'ok' : entry.status === 'failed' ? 'bad' : 'warn');
      cell(row, entry.row_count ?? '—');
      cell(row, formatDuration(entry.duration_ms));
      // 指纹只显示前 12 位：够用来对比两次相同 SQL，又不占屏。
      cell(row, entry.sql_sha256 ? `${entry.sql_sha256.slice(0, 12)}…` : '—');
      body.append(row);
    }
  } catch { /* 审计失败不影响主流程 */ }
}

// ---------- 汇总 ----------
async function refresh() {
  const data = await api('/api/db/connections');
  connections = data.connections; proxies = data.proxies;
  updateProxyOptions();
  renderConnections(); renderProxies(); renderConsoleConnections();
}

async function boot() {
  try {
    const driverData = await api('/api/db/drivers');
    engines = driverData.engines;
  } catch { engines = {}; }
  try { await refresh(); } catch (error) { notify(error.message); }
  translate();
  resetConnectionForm(); resetProxyForm();
  renderDrivers();
  await loadAudit();

  $('language').addEventListener('change', (event) => {
    locale = event.target.value;
    localStorage.setItem('cloudssh_locale', locale);
    translate();
  });
  $('connection-form').addEventListener('submit', saveConnection);
  $('conn-cancel').addEventListener('click', resetConnectionForm);
  $('conn-test').addEventListener('click', testFormConnection);
  $('conn-engine').addEventListener('change', fillEngineDefaults);
  $('proxy-form').addEventListener('submit', saveProxy);
  $('proxy-cancel').addEventListener('click', resetProxyForm);
  $('proxy-kind').addEventListener('change', updateProxyFormMode);
  $('console-run').addEventListener('click', runQuery);
  $('console-clear').addEventListener('click', () => { $('console-result').hidden = true; $('console-status').textContent = ''; });
  $('audit-refresh').addEventListener('click', loadAudit);
  // Ctrl/Cmd+Enter 执行，符合 SQL 客户端的肌肉记忆。
  $('console-sql').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runQuery(); }
  });
}

boot();
