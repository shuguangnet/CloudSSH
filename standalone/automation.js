const dictionaries = {
  'zh-CN': {
    'nav.panel': '返回面板', 'nav.automation': '自动化', 'nav.mcp': 'MCP', 'nav.account': '账号设置', back: '返回面板', title: '自动化', intro: '定时执行命令、监控服务器可达性，并在异常时推送通知。所有操作通过已验证指纹的 SSH 通道完成。',
    failed: '请求失败，请检查登录状态与输入。', empty: '暂无记录', cancel: '取消', edit: '编辑', delete: '删除', close: '关闭',
    enabledNow: '启用', on: '启用', off: '停用', confirmDelete: '确认删除？',
    tasks: '定时任务', tasksIntro: '按 cron 计划在面板后端执行命令，命令快照保存于任务中（编辑片段不影响已建任务）。',
    taskName: '名称', taskServer: '服务器', taskCommand: '命令', taskCron: '计划（cron 表达式）',
    taskTimeout: '超时（秒，30–600）', create: '创建任务', update: '保存修改',
    notifyOnFailure: '失败时推送通知', notifyOnChange: '输出变化时推送通知', cronHint: '五字段：分 时 日 月 周；', scheduleNext: '下次执行', lastRun: '上次结果', statusCol: '状态',
    presets: { m5: '每 5 分钟', h1: '每小时', d3: '每天 3:00', w1: '每周一 8:00' },
    runNow: '立即运行', history: '运行历史', loadMoreRuns: '加载更早记录',
    runStarted: '开始时间', runStatus: '结果', runDuration: '耗时', runExitCode: '退出码', runError: '错误', runOutput: '输出',
    succeeded: '成功', failedRun: '失败', running: '运行中', scheduled: '计划中', manual: '手动',
    taskSaved: '任务已保存', taskDeleted: '任务已删除', taskRunQueued: '已开始运行',
    monitors: '可用性监控', monitorsIntro: '周期性 TCP + SSH banner 探测（不做身份验证，不会触发 fail2ban）。仅支持直连服务器。',
    monitorServer: '服务器', monitorInterval: '探测间隔（秒，60–3600）', monitorThreshold: '连续失败阈值（1–10）', monitorAdd: '保存监控',
    lastCheck: '上次探测', latency: '延迟', notMonitorable: '该服务器需先连接验证；仅支持直连服务器',
    statusUp: '在线', statusDown: '宕机', statusDegraded: '异常', statusUnknown: '未知',
    monitorSaved: '监控已保存', monitorDeleted: '监控已删除',
    chart: '延迟图表', latencyMs: 'ms', chartEmpty: '暂无采样数据', hours24: '近 24 小时',
    channels: '通知渠道', channelsIntro: '任务失败与服务器宕机/恢复时推送。SMTP 密码仅保存在面板服务器上。',
    channelType: '类型', channelTarget: '目标', addChannel: '添加渠道',
    barkUrl: 'Bark 服务器 URL', barkKey: '设备 Key（可选）', telegramToken: 'Bot Token', telegramChatId: 'Chat ID',
    webhookUrl: 'Webhook URL', smtpHost: 'SMTP 服务器', smtpPort: '端口', smtpSecurity: '加密方式', smtpUser: '用户名（可选）',
    smtpPassword: '密码（可选）', smtpFrom: '发件地址', smtpTo: '收件地址',
    securitySsl: 'SSL/TLS', securityStarttls: 'STARTTLS', securityNone: '无（明文）',
    testChannels: '发送测试通知', testOk: '已发送', testFailed: '发送失败',
    channelSaved: '渠道已保存', channelDeleted: '渠道已删除',
  },
  'zh-TW': {
    'nav.panel': '返回面板', 'nav.automation': '自動化', 'nav.mcp': 'MCP', 'nav.account': '帳號設定', back: '返回面板', title: '自動化', intro: '定時執行命令、監控伺服器可達性，並在異常時推送通知。所有操作透過已驗證指紋的 SSH 通道完成。',
    failed: '請求失敗，請檢查登入狀態與輸入。', empty: '暫無記錄', cancel: '取消', edit: '編輯', delete: '刪除', close: '關閉',
    enabledNow: '啟用', on: '啟用', off: '停用', confirmDelete: '確認刪除？',
    tasks: '定時任務', tasksIntro: '按 cron 排程在面板後端執行命令，命令快照儲存於任務中（編輯片段不影響已建任務）。',
    taskName: '名稱', taskServer: '伺服器', taskCommand: '命令', taskCron: '排程（cron 運算式）',
    taskTimeout: '逾時（秒，30–600）', create: '建立任務', update: '儲存變更',
    notifyOnFailure: '失敗時推送通知', notifyOnChange: '輸出變化時推送通知', cronHint: '五欄位：分 時 日 月 週；', scheduleNext: '下次執行', lastRun: '上次結果', statusCol: '狀態',
    presets: { m5: '每 5 分鐘', h1: '每小時', d3: '每天 3:00', w1: '每週一 8:00' },
    runNow: '立即執行', history: '執行歷史', loadMoreRuns: '載入更早記錄',
    runStarted: '開始時間', runStatus: '結果', runDuration: '耗時', runExitCode: '結束代碼', runError: '錯誤', runOutput: '輸出',
    succeeded: '成功', failedRun: '失敗', running: '執行中', scheduled: '計畫中', manual: '手動',
    taskSaved: '任務已儲存', taskDeleted: '任務已刪除', taskRunQueued: '已開始執行',
    monitors: '可用性監控', monitorsIntro: '週期性 TCP + SSH banner 探測（不做身分驗證，不會觸發 fail2ban）。僅支援直連伺服器。',
    monitorServer: '伺服器', monitorInterval: '探測間隔（秒，60–3600）', monitorThreshold: '連續失敗閾值（1–10）', monitorAdd: '儲存監控',
    lastCheck: '上次探測', latency: '延遲', notMonitorable: '該伺服器需先連線驗證；僅支援直連伺服器',
    statusUp: '線上', statusDown: '當機', statusDegraded: '異常', statusUnknown: '未知',
    monitorSaved: '監控已儲存', monitorDeleted: '監控已刪除',
    chart: '延遲圖表', latencyMs: 'ms', chartEmpty: '暫無取樣資料', hours24: '近 24 小時',
    channels: '通知渠道', channelsIntro: '任務失敗與伺服器當機/恢復時推送。SMTP 密碼僅儲存在面板伺服器上。',
    channelType: '類型', channelTarget: '目標', addChannel: '新增渠道',
    barkUrl: 'Bark 伺服器 URL', barkKey: '裝置 Key（可選）', telegramToken: 'Bot Token', telegramChatId: 'Chat ID',
    webhookUrl: 'Webhook URL', smtpHost: 'SMTP 伺服器', smtpPort: '連接埠', smtpSecurity: '加密方式', smtpUser: '使用者名稱（可選）',
    smtpPassword: '密碼（可選）', smtpFrom: '寄件位址', smtpTo: '收件位址',
    securitySsl: 'SSL/TLS', securityStarttls: 'STARTTLS', securityNone: '無（明文）',
    testChannels: '傳送測試通知', testOk: '已傳送', testFailed: '傳送失敗',
    channelSaved: '渠道已儲存', channelDeleted: '渠道已刪除',
  },
  'en-US': {
    'nav.panel': 'Back to panel', 'nav.automation': 'Automation', 'nav.mcp': 'MCP', 'nav.account': 'Account settings', back: 'Back to panel', title: 'Automation', intro: 'Run commands on schedule, monitor server reachability and get push notifications on failures. Everything goes through fingerprint-verified SSH.',
    failed: 'Request failed. Check your login and input.', empty: 'No records', cancel: 'Cancel', edit: 'Edit', delete: 'Delete', close: 'Close',
    enabledNow: 'Enabled', on: 'On', off: 'Off', confirmDelete: 'Delete this item?',
    tasks: 'Scheduled tasks', tasksIntro: 'Commands run on a cron schedule in the panel backend. The command is snapshotted per task (editing snippets later does not change existing tasks).',
    taskName: 'Name', taskServer: 'Server', taskCommand: 'Command', taskCron: 'Schedule (cron expression)',
    taskTimeout: 'Timeout (s, 30–600)', create: 'Create task', update: 'Save changes',
    notifyOnFailure: 'Notify on failure', notifyOnChange: 'Notify when output changes', cronHint: 'Five fields: minute hour day month weekday; ', scheduleNext: 'Next run', lastRun: 'Last result', statusCol: 'Status',
    presets: { m5: 'Every 5 min', h1: 'Hourly', d3: 'Daily 3:00', w1: 'Mondays 8:00' },
    runNow: 'Run now', history: 'Run history', loadMoreRuns: 'Load earlier runs',
    runStarted: 'Started', runStatus: 'Result', runDuration: 'Duration', runExitCode: 'Exit code', runError: 'Error', runOutput: 'Output',
    succeeded: 'Succeeded', failedRun: 'Failed', running: 'Running', scheduled: 'Scheduled', manual: 'Manual',
    taskSaved: 'Task saved', taskDeleted: 'Task deleted', taskRunQueued: 'Run started',
    monitors: 'Uptime monitoring', monitorsIntro: 'Periodic TCP + SSH banner probes (no authentication, so fail2ban never triggers). Direct connections only.',
    monitorServer: 'Server', monitorInterval: 'Probe interval (s, 60–3600)', monitorThreshold: 'Failure threshold (1–10)', monitorAdd: 'Save monitor',
    lastCheck: 'Last probe', latency: 'Latency', notMonitorable: 'Connect and verify this server first; only direct servers are monitorable',
    statusUp: 'Up', statusDown: 'Down', statusDegraded: 'Degraded', statusUnknown: 'Unknown',
    monitorSaved: 'Monitor saved', monitorDeleted: 'Monitor deleted',
    chart: 'Latency chart', latencyMs: 'ms', chartEmpty: 'No samples yet', hours24: 'last 24 hours',
    channels: 'Notification channels', channelsIntro: 'Push on task failure and server down/recovery. SMTP passwords stay on the panel server.',
    channelType: 'Type', channelTarget: 'Target', addChannel: 'Add channel',
    barkUrl: 'Bark server URL', barkKey: 'Device key (optional)', telegramToken: 'Bot token', telegramChatId: 'Chat ID',
    webhookUrl: 'Webhook URL', smtpHost: 'SMTP host', smtpPort: 'Port', smtpSecurity: 'Encryption', smtpUser: 'Username (optional)',
    smtpPassword: 'Password (optional)', smtpFrom: 'From address', smtpTo: 'To address',
    securitySsl: 'SSL/TLS', securityStarttls: 'STARTTLS', securityNone: 'None (cleartext)',
    testChannels: 'Send test notification', testOk: 'Sent', testFailed: 'Send failed',
    channelSaved: 'Channel saved', channelDeleted: 'Channel deleted',
  },
};

const PRESET_EXPRESSIONS = { m5: '*/5 * * * *', h1: '0 * * * *', d3: '0 3 * * *', w1: '0 8 * * 1' };
const $ = (id) => document.getElementById(id);
let locale = localStorage.getItem('cloudssh_locale') || navigator.language;
locale = dictionaries[locale] ? locale : locale.startsWith('zh') ? 'zh-CN' : 'en-US';
const text = (key) => dictionaries[locale][key];
let servers = [], tasks = [], monitors = [], channels = [], runsTask = null, runs = [];

function notify(message) { $('message').textContent = message ?? ''; }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || text('failed'));
  return body;
}

function cell(row, value) { const td = document.createElement('td'); td.textContent = String(value ?? ''); row.append(td); return td; }
function emptyRow(body) { const row = document.createElement('tr'); const td = document.createElement('td'); td.className = 'empty'; td.textContent = text('empty'); row.append(td); body.append(row); }
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
const serverName = (id) => servers.find((server) => server.id === id)?.name || `#${id}`;
const formatTime = (ts) => ts ? new Date(ts).toLocaleString(locale) : '—';
const formatDuration = (ms) => ms === null || ms === undefined ? '—' : (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function translate() {
  document.documentElement.lang = locale; $('language').value = locale;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = text(element.dataset.i18n);
  renderPresets(); renderTasks(); renderMonitors(); renderChannels(); renderChannelConfig(); renderRuns(); updateChartTitle();
}

// ---------- scheduled tasks ----------
function renderPresets() {
  const holder = $('presets'); holder.replaceChildren();
  for (const [key, expression] of Object.entries(PRESET_EXPRESSIONS)) {
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'preset'; link.textContent = text('presets')[key];
    link.addEventListener('click', () => { $('task-cron').value = expression; });
    holder.append(link);
  }
}

function renderTasks() {
  const body = $('tasks'); body.replaceChildren();
  for (const task of tasks) {
    const row = document.createElement('tr');
    cell(row, task.name);
    cell(row, task.server_name ?? serverName(task.server_id));
    cell(row, task.cron_expr);
    cell(row, task.enabled ? formatTime(task.next_run_at) : '—');
    const last = cell(row, '');
    if (task.last_status) {
      last.textContent = `${text(task.last_status === 'succeeded' ? 'succeeded' : 'failedRun')} · ${formatTime(task.last_run_at)}`;
      last.className = task.last_status === 'succeeded' ? 'ok' : 'err';
    } else last.textContent = '—';
    badgeCell(row, task.enabled ? text('on') : text('off'), task.enabled ? 'ok' : 'muted');
    const action = cell(row, '');
    action.append(button(text('runNow'), async (event) => {
      event.target.disabled = true;
      try {
        await api(`/api/automation/cron/${task.id}/run`, { method: 'POST' });
        notify(text('taskRunQueued'));
        await refreshTasks(); if (runsTask === task.id) await loadRuns(task.id, true);
      } catch (error) { notify(error.message); event.target.disabled = false; }
    }));
    action.append(button(text('history'), () => { void loadRuns(task.id, true); }));
    action.append(button(text('edit'), () => {
      $('task-id').value = task.id; $('task-name').value = task.name; $('task-server').value = task.server_id;
      $('task-command').value = task.command; $('task-cron').value = task.cron_expr; $('task-timeout').value = task.timeout_seconds;
      $('task-notify').checked = !!task.notify_on_failure; $('task-notify-change').checked = !!task.notify_on_change; $('task-enabled').checked = !!task.enabled;
      $('task-save').textContent = text('update'); $('task-cancel').hidden = false;
      $('task-form').scrollIntoView({ behavior: 'smooth' });
    }));
    action.append(button(text('delete'), async (event) => {
      if (!confirm(text('confirmDelete'))) return;
      event.target.disabled = true;
      try { await api(`/api/automation/cron/${task.id}`, { method: 'DELETE' }); notify(text('taskDeleted')); await refreshTasks(); }
      catch (error) { notify(error.message); event.target.disabled = false; }
    }, 'danger'));
    body.append(row);
  }
  if (!tasks.length) emptyRow(body);
}

async function refreshTasks() {
  tasks = (await api('/api/automation/cron')).tasks;
  renderTasks();
}

async function loadRuns(taskId, reset) {
  runsTask = taskId; $('runs-panel').hidden = false;
  if (reset) runs = [];
  const before = reset ? Number.MAX_SAFE_INTEGER : (runs.at(-1)?.id ?? Number.MAX_SAFE_INTEGER);
  const page = (await api(`/api/automation/cron/${taskId}/runs?before=${before}`)).runs;
  runs.push(...page);
  $('runs-title').textContent = `· ${serverName((tasks.find((task) => task.id === taskId))?.server_id ?? '')}`;
  $('more-runs').disabled = page.length < 20;
  renderRuns(); updateChartTitle();
  $('runs-panel').scrollIntoView({ behavior: 'smooth' });
}

function renderRuns() {
  if ($('runs-panel').hidden) return;
  const body = $('runs'); body.replaceChildren();
  for (const run of runs) {
    const row = document.createElement('tr');
    const status = run.status === 'succeeded' ? 'succeeded' : run.status === 'running' ? 'running' : 'failedRun';
    cell(row, `${formatTime(run.started_at)}${run.trigger === 'manual' ? ` (${text('manual')})` : ''}`);
    badgeCell(row, text(status), run.status === 'succeeded' ? 'ok' : (run.status === 'running' ? 'warn' : 'err'));
    const duration = cell(row, formatDuration(run.duration_ms)); duration.className = 'mono';
    const exitCode = cell(row, run.exit_code ?? '—'); exitCode.className = 'mono';
    const errorCell = cell(row, run.error ?? '');
    if (run.output) {
      row.classList.add('clickable');
      row.addEventListener('click', () => {
        $('run-output').textContent = run.output || '';
        $('run-output-box').hidden = false;
      });
    }
    body.append(row);
    void errorCell;
  }
  if (!runs.length) emptyRow(body);
}

// ---------- uptime monitors ----------
function renderMonitors() {
  const body = $('monitors'); body.replaceChildren();
  for (const monitor of monitors) {
    const row = document.createElement('tr');
    cell(row, monitor.server_name ?? serverName(monitor.server_id));
    const status = monitor.status ? { up: 'statusUp', down: 'statusDown', degraded: 'statusDegraded' }[monitor.status] || 'statusUnknown' : 'statusUnknown';
    const statusCell = badgeCell(row, text(status), monitor.status === 'up' ? 'ok' : monitor.status === 'down' ? 'err' : 'warn');
    void statusCell;
    cell(row, formatTime(monitor.last_probe_at));
    const latency = cell(row, monitor.last_latency_ms !== null && monitor.last_latency_ms !== undefined ? `${monitor.last_latency_ms}${text('latencyMs')}` : '—'); latency.className = 'mono';
    const interval = cell(row, `${monitor.interval_seconds}s`); interval.className = 'mono';
    cell(row, monitor.last_error ?? '');
    const action = cell(row, '');
    action.append(button(text('chart'), () => { void loadChart(monitor.server_id); }));
    action.append(button(text('edit'), () => {
      $('monitor-server').value = monitor.server_id;
      $('monitor-interval').value = monitor.interval_seconds;
      $('monitor-threshold').value = monitor.failure_threshold;
    }));
    action.append(button(text('delete'), async (event) => {
      if (!confirm(text('confirmDelete'))) return;
      event.target.disabled = true;
      try { await api(`/api/automation/monitor/${monitor.server_id}`, { method: 'DELETE' }); notify(text('monitorDeleted')); await refreshMonitors(); $('chart-panel').hidden = true; }
      catch (error) { notify(error.message); event.target.disabled = false; }
    }, 'danger'));
    body.append(row);
  }
  if (!monitors.length) emptyRow(body);
}

async function refreshMonitors() {
  monitors = (await api('/api/automation/monitor')).monitors;
  renderMonitors();
}

let chartServer = null;
function updateChartTitle() {
  if (chartServer) $('chart-title').textContent = `· ${serverName(chartServer)} (${text('hours24')})`;
}

async function loadChart(serverId) {
  chartServer = serverId;
  $('chart-panel').hidden = false;
  updateChartTitle();
  const samples = (await api(`/api/automation/monitor/${serverId}/samples?hours=24`)).samples;
  const svg = $('chart');
  svg.replaceChildren();
  const width = 600; const height = 140; const pad = 8;
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  if (!samples.length) {
    label.setAttribute('x', width / 2); label.setAttribute('y', height / 2); label.setAttribute('text-anchor', 'middle');
    label.textContent = text('chartEmpty'); svg.append(label); return;
  }
  const t0 = samples[0].ts; const t1 = samples.at(-1).ts || t0 + 1;
  const okSamples = samples.filter((sample) => sample.ok && sample.latency_ms !== null);
  const maxLatency = Math.max(50, ...okSamples.map((sample) => sample.latency_ms)) * 1.15;
  const x = (ts) => pad + ((ts - t0) / Math.max(1, t1 - t0)) * (width - pad * 2);
  const y = (ms) => height - pad - (Math.min(ms ?? 0, maxLatency) / maxLatency) * (height - pad * 2 - 14);
  const baseline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  baseline.setAttribute('x1', pad); baseline.setAttribute('x2', width - pad);
  baseline.setAttribute('y1', height - pad); baseline.setAttribute('y2', height - pad);
  baseline.setAttribute('class', 'axis'); svg.append(baseline);
  const points = okSamples.map((sample) => `${x(sample.ts).toFixed(1)},${y(sample.latency_ms).toFixed(1)}`).join(' ');
  if (points) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points); line.setAttribute('class', 'line'); svg.append(line);
  }
  for (const sample of samples.filter((item) => !item.ok)) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x(sample.ts).toFixed(1)); dot.setAttribute('cy', height - pad - 4); dot.setAttribute('r', 2.5);
    dot.setAttribute('class', 'fail'); svg.append(dot);
  }
  for (const fraction of [0, 0.5, 1]) {
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tick.setAttribute('x', pad + 2); tick.setAttribute('y', pad + 10 + fraction * (height - pad * 2 - 24));
    tick.setAttribute('class', 'tick');
    tick.textContent = `${Math.round(maxLatency * (1 - fraction))}${text('latencyMs')}`;
    svg.append(tick);
  }
  $('chart-panel').scrollIntoView({ behavior: 'smooth' });
}

// ---------- notification channels ----------
function channelFields(type) {
  const fields = {
    bark: [['url', 'barkUrl', 'url', true], ['key', 'barkKey', 'text', false]],
    telegram: [['token', 'telegramToken', 'password', true], ['chat_id', 'telegramChatId', 'text', true]],
    webhook: [['url', 'webhookUrl', 'url', true]],
    smtp: [['host', 'smtpHost', 'text', true], ['port', 'smtpPort', 'number', true], ['security', 'smtpSecurity', 'select', true],
      ['username', 'smtpUser', 'text', false], ['password', 'smtpPassword', 'password', false],
      ['from', 'smtpFrom', 'email', true], ['to', 'smtpTo', 'email', true]],
  };
  return fields[type] || [];
}

function renderChannelConfig() {
  const type = $('channel-type').value;
  const holder = $('channel-config'); holder.replaceChildren();
  const existing = channels.find((channel) => channel.id === Number($('channel-id').value || 0));
  for (const [name, labelKey, inputType, required] of channelFields(type)) {
    const label = document.createElement('label');
    const span = document.createElement('span'); span.textContent = text(labelKey);
    let input;
    if (inputType === 'select') {
      input = document.createElement('select');
      for (const [value, key] of [['ssl', 'securitySsl'], ['starttls', 'securityStarttls'], ['none', 'securityNone']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = text(key); input.append(option);
      }
    } else {
      input = document.createElement('input');
      input.type = inputType === 'number' ? 'number' : inputType;
      if (inputType === 'number') { input.min = 1; input.max = 65535; input.value = '465'; }
      if (name === 'url') input.placeholder = 'https://';
      input.autocomplete = 'off'; input.spellcheck = false;
    }
    input.name = name; input.required = required;
    if (existing?.type === type) {
      const value = existing.config[name];
      if (value !== undefined && value !== null) {
        if (name === 'password') input.value = '__keep__';
        else input.value = value;
      }
    }
    label.append(span, input); holder.append(label);
  }
}

function channelTarget(channel) {
  const config = channel.config || {};
  if (channel.type === 'bark') return config.url;
  if (channel.type === 'telegram') return `chat ${config.chat_id}`;
  if (channel.type === 'webhook') return config.url;
  if (channel.type === 'smtp') return `${config.host}:${config.port} → ${config.to}`;
  return '';
}

function renderChannels() {
  const body = $('channels'); body.replaceChildren();
  for (const channel of channels) {
    const row = document.createElement('tr');
    const type = cell(row, channel.type.toUpperCase()); type.className = 'mono';
    const target = cell(row, channelTarget(channel)); target.className = 'mono';
    badgeCell(row, channel.enabled ? text('on') : text('off'), channel.enabled ? 'ok' : 'muted');
    const action = cell(row, '');
    action.append(button(text('edit'), () => {
      $('channel-id').value = channel.id; $('channel-type').value = channel.type;
      $('channel-enabled').checked = !!channel.enabled;
      renderChannelConfig();
      $('channel-save').textContent = text('update'); $('channel-cancel').hidden = false;
    }));
    action.append(button(text('delete'), async (event) => {
      if (!confirm(text('confirmDelete'))) return;
      event.target.disabled = true;
      try { await api(`/api/automation/notifications/${channel.id}`, { method: 'DELETE' }); notify(text('channelDeleted')); await refreshChannels(); }
      catch (error) { notify(error.message); event.target.disabled = false; }
    }, 'danger'));
    body.append(row);
  }
  if (!channels.length) emptyRow(body);
}

async function refreshChannels() {
  channels = (await api('/api/automation/notifications')).channels;
  renderChannels();
}

// ---------- wiring ----------
$('language').addEventListener('change', () => { locale = $('language').value; localStorage.setItem('cloudssh_locale', locale); translate(); });

$('task-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const submitter = event.submitter; submitter.disabled = true;
  const body = {
    name: $('task-name').value, server_id: Number($('task-server').value), command: $('task-command').value,
    cron_expr: $('task-cron').value.trim(), timeout_seconds: Number($('task-timeout').value),
    notify_on_failure: $('task-notify').checked, notify_on_change: $('task-notify-change').checked, enabled: $('task-enabled').checked,
  };
  try {
    if ($('task-id').value) await api(`/api/automation/cron/${$('task-id').value}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/automation/cron', { method: 'POST', body: JSON.stringify(body) });
    notify(text('taskSaved')); resetTaskForm(); await refreshTasks();
  } catch (error) { notify(error.message); }
  finally { submitter.disabled = false; }
});

function resetTaskForm() {
  $('task-id').value = ''; $('task-form').reset();
  $('task-timeout').value = 120; $('task-cron').value = '*/5 * * * *';
  $('task-notify').checked = true; $('task-notify-change').checked = false; $('task-enabled').checked = true;
  $('task-save').textContent = text('create'); $('task-cancel').hidden = true;
}
$('task-cancel').addEventListener('click', resetTaskForm);

$('more-runs').addEventListener('click', () => { if (runsTask) void loadRuns(runsTask, false); });

$('monitor-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const submitter = event.submitter; submitter.disabled = true;
  try {
    await api(`/api/automation/monitor/${Number($('monitor-server').value)}`, {
      method: 'PUT',
      body: JSON.stringify({ interval_seconds: Number($('monitor-interval').value), failure_threshold: Number($('monitor-threshold').value), enabled: true }),
    });
    notify(text('monitorSaved')); await refreshMonitors();
  } catch (error) { notify(error.message); }
  finally { submitter.disabled = false; }
});

$('channel-type').addEventListener('change', renderChannelConfig);
$('channel-cancel').addEventListener('click', () => {
  $('channel-id').value = ''; renderChannelConfig();
  $('channel-enabled').checked = true;
  $('channel-save').textContent = text('addChannel'); $('channel-cancel').hidden = true;
});

$('channel-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const submitter = event.submitter; submitter.disabled = true;
  const type = $('channel-type').value;
  const config = {};
  for (const [name] of channelFields(type)) {
    const input = $('channel-config').querySelector(`[name=${name}]`);
    if (!input) continue;
    if (input.tagName === 'SELECT') config[name] = input.value;
    else if (input.value !== '' && !(name === 'password' && input.value === '__keep__')) {
      config[name] = input.type === 'number' ? Number(input.value) : input.value;
    }
  }
  const existing = channels.find((channel) => channel.id === Number($('channel-id').value || 0));
  // Password edit keeps the stored value when untouched.
  if (existing?.type === type && config.password === undefined) config.password = existing.config.password;
  try {
    if (existing) await api(`/api/automation/notifications/${existing.id}`, { method: 'PUT', body: JSON.stringify({ type, config, enabled: $('channel-enabled').checked }) });
    else await api('/api/automation/notifications', { method: 'POST', body: JSON.stringify({ type, config, enabled: $('channel-enabled').checked }) });
    notify(text('channelSaved'));
    $('channel-id').value = ''; renderChannelConfig(); $('channel-enabled').checked = true;
    $('channel-save').textContent = text('addChannel'); $('channel-cancel').hidden = true;
    await refreshChannels();
  } catch (error) { notify(error.message); }
  finally { submitter.disabled = false; }
});

$('channel-test').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try {
    const results = (await api('/api/automation/notifications/test', { method: 'POST' })).results;
    const okCount = results.filter((result) => result.ok).length;
    notify(`${okCount}/${results.length} ${text('testOk')}${results.some((result) => !result.ok) ? ` · ${text('testFailed')}: ${results.filter((result) => !result.ok).map((result) => result.error).join('; ')}` : ''}`);
  } catch (error) { notify(error.message); }
  finally { event.target.disabled = false; }
});

translate();
(async () => {
  try {
    servers = await api('/api/servers');
    for (const select of [$('task-server'), $('monitor-server')]) {
      select.replaceChildren();
      for (const server of servers) {
        const option = document.createElement('option');
        option.value = server.id; option.textContent = `${server.name} (${server.host})`;
        select.append(option);
      }
    }
    await Promise.all([refreshTasks(), refreshMonitors(), refreshChannels()]);
    const interval = setInterval(async () => {
      try { await Promise.all([refreshTasks(), refreshMonitors()]); } catch { clearInterval(interval); }
    }, 20000);
  } catch (error) { notify(error.message); }
})();
