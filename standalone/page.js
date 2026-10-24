/* CloudSSH standalone pages — follow the main panel's theme.
   Reads the panel's persisted theme selection (same origin, shared
   localStorage) and mirrors the panel's CSS variables onto this page.
   Classic script on purpose: loaded via <script defer> before the page's own
   script, CSP script-src 'self' compliant (no inline code). */
(function () {
  'use strict';

  /* Mirrors frontend UI_THEMES plus page-only semantic colors (--ok/--warn,
     radii, card shadow). Keep in sync with frontend/src/theme.ts UI_THEMES. */
  var THEMES = {
    cyberpunk: {
      scheme: 'dark',
      vars: {
        '--bg': '#0a0a0a', '--bg-surface': '#121212', '--bg-inset': '#0c0c0c', '--bg-elevated': '#131313', '--bg-terminal': '#0e0e0e',
        '--text': '#4af626', '--text-muted': '#bbccb0', '--text-dim': '#3c4b36',
        '--accent': '#4af626', '--accent-secondary': '#14d1ff',
        '--border': '#1f1f1f', '--border-strong': '#3c4b36',
        '--error': '#ffb4ab', '--error-bg': '#93000a', '--on-accent': '#022100',
        '--accent-bg': 'rgba(74, 246, 38, 0.1)',
        '--ok': '#4af626', '--ok-bg': 'rgba(74, 246, 38, 0.12)',
        '--warn': '#e8c15a', '--warn-bg': 'rgba(232, 193, 90, 0.12)',
        '--scrollbar-track': 'rgba(28, 27, 27, 0.5)', '--scrollbar-thumb': 'rgba(60, 75, 54, 0.8)',
        '--card-radius': '2px', '--control-radius': '2px', '--shadow-card': 'none',
      },
    },
    'standard-dark': {
      scheme: 'dark',
      vars: {
        '--bg': '#0a1526', '--bg-surface': '#101f38', '--bg-inset': '#0c1830', '--bg-elevated': '#16294a', '--bg-terminal': '#0a1424',
        '--text': '#e3ecfb', '--text-muted': '#9db0cd', '--text-dim': '#7286ab',
        '--accent': '#4c8dff', '--accent-secondary': '#7ab5ff',
        '--border': '#22365c', '--border-strong': '#35527f',
        '--error': '#ff7a85', '--error-bg': '#3d1420', '--on-accent': '#06122b',
        '--accent-bg': 'rgba(76, 141, 255, 0.12)',
        '--ok': '#52d98a', '--ok-bg': 'rgba(82, 217, 138, 0.14)',
        '--warn': '#f2c14e', '--warn-bg': 'rgba(242, 193, 78, 0.14)',
        '--scrollbar-track': 'rgba(16, 31, 56, 0.7)', '--scrollbar-thumb': 'rgba(157, 176, 205, 0.32)',
        '--card-radius': '9px', '--control-radius': '6px', '--shadow-card': '0 4px 16px rgba(2, 8, 20, 0.35)',
      },
    },
    'standard-light': {
      scheme: 'light',
      vars: {
        '--bg': '#eef4fc', '--bg-surface': '#ffffff', '--bg-inset': '#f2f7fd', '--bg-elevated': '#f7fafe', '--bg-terminal': '#ffffff',
        '--text': '#17233b', '--text-muted': '#516381', '--text-dim': '#4a5c7c',
        '--accent': '#0d68dd', '--accent-secondary': '#0a7ad6',
        '--border': '#dbe5f2', '--border-strong': '#b8cbe6',
        '--error': '#c62f3a', '--error-bg': '#fdeff0', '--on-accent': '#ffffff',
        '--accent-bg': 'rgba(13, 104, 221, 0.08)',
        '--ok': '#157f43', '--ok-bg': 'rgba(21, 127, 67, 0.1)',
        '--warn': '#9a6700', '--warn-bg': 'rgba(154, 103, 0, 0.1)',
        '--scrollbar-track': 'rgba(219, 229, 242, 0.5)', '--scrollbar-thumb': 'rgba(81, 99, 129, 0.32)',
        '--card-radius': '9px', '--control-radius': '6px', '--shadow-card': '0 2px 10px rgba(23, 35, 59, 0.1)',
      },
    },
    'liquid-glass': {
      scheme: 'light',
      vars: {
        '--bg': '#e6ecf4', '--bg-surface': 'rgba(255, 255, 255, 0.35)', '--bg-inset': 'rgba(255, 255, 255, 0.22)', '--bg-elevated': 'rgba(255, 255, 255, 0.55)', '--bg-terminal': 'rgba(255, 255, 255, 0.88)',
        '--text': '#1d1d1f', '--text-muted': '#515154', '--text-dim': '#69696e',
        '--accent': '#0066da', '--accent-secondary': '#5856d6',
        '--border': 'rgba(0, 0, 0, 0.1)', '--border-strong': 'rgba(0, 0, 0, 0.18)',
        '--error': '#d70015', '--error-bg': 'rgba(215, 0, 21, 0.12)', '--on-accent': '#ffffff',
        '--accent-bg': 'rgba(0, 102, 218, 0.1)',
        '--ok': '#157347', '--ok-bg': 'rgba(21, 115, 71, 0.12)',
        '--warn': '#9a6700', '--warn-bg': 'rgba(158, 103, 0, 0.12)',
        '--scrollbar-track': 'rgba(0, 0, 0, 0.03)', '--scrollbar-thumb': 'rgba(0, 0, 0, 0.18)',
        '--card-radius': '14px', '--control-radius': '8px', '--shadow-card': '0 8px 24px rgba(20, 24, 33, 0.12)',
      },
    },
  };

  function apply(entry) {
    var root = document.documentElement;
    var vars = entry.vars;
    for (var key in vars) root.style.setProperty(key, vars[key]);
    root.style.colorScheme = entry.scheme;
  }

  function readCustom() {
    try {
      var raw = localStorage.getItem('cloudssh_imported_theme');
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !data.ui || typeof data.ui !== 'object') return null;
      return data;
    } catch (error) { return null; }
  }

  function run() {
    /* 与主面板保持一致：企业蓝改版后的默认主题为 standard-light，
       并做同口径的一次性老默认（cyberpunk）迁移 */
    var selection = 'standard-light';
    try {
      selection = localStorage.getItem('cloudssh_theme_selection') || 'standard-light';
      if (selection === 'cyberpunk' && !localStorage.getItem('cloudssh_theme_enterprise_v3')) {
        localStorage.setItem('cloudssh_theme_enterprise_v3', '1');
        selection = 'standard-light';
        localStorage.setItem('cloudssh_theme_selection', selection);
      }
    } catch (error) { /* private mode */ }
    if (THEMES[selection]) return apply(THEMES[selection]);
    var custom = readCustom();
    var base = THEMES[custom && custom.colorScheme === 'light' ? 'standard-light' : 'standard-dark'];
    if (!custom) return apply(base);
    var merged = {};
    for (var key in base.vars) merged[key] = base.vars[key];
    for (var customKey in custom.ui) {
      if (typeof custom.ui[customKey] === 'string' && customKey.indexOf('--') === 0) merged[customKey] = custom.ui[customKey];
    }
    apply({ scheme: custom.colorScheme === 'light' ? 'light' : 'dark', vars: merged });
  }

  /* ---------- Shared side navigation ----------
     Injects a left menu (panel / automation / MCP / account) into every
     standalone utility page marked <body data-page="...">. The current page
     is highlighted; the language selector moves into the sidebar footer.
     When the page is embedded in the main panel's iframe, the sidebar hides
     (the outer panel already provides navigation). Classic DOM building on
     purpose: CSP script-src 'self' allows no inline handlers. */
  var NAV_ICONS = {
    panel: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="14" width="18" height="5" rx="1"/><circle cx="7" cy="6.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="0.9" fill="currentColor" stroke="none"/></svg>',
    automation: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    mcp: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.3"/><circle cx="5" cy="18" r="2.3"/><circle cx="19" cy="18" r="2.3"/><path d="M12 7.3 6.5 16M12 7.3l5.5 8.8M7.3 18h9.4"/></svg>',
    database: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/></svg>',
    account: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c1.4-3.2 4-4.8 7-4.8s5.6 1.6 7 4.8"/></svg>',
  };

  function buildLanguageSelect() {
    var existing = document.getElementById('language');
    if (existing) return existing;
    var select = document.createElement('select');
    select.id = 'language';
    select.setAttribute('aria-label', 'Language');
    select.innerHTML = '<option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option>';
    return select;
  }

  function injectSideNav() {
    var page = document.body.getAttribute('data-page');
    if (!page) return;
    var embedded = false;
    try { embedded = window.self !== window.top; } catch (error) { embedded = true; }
    if (embedded) document.body.classList.add('embedded-page');
    var items = [
      { id: 'panel', href: '/', key: 'nav.panel' },
      { id: 'automation', href: '/automation', key: 'nav.automation' },
      { id: 'mcp', href: '/mcp/settings', key: 'nav.mcp' },
      { id: 'database', href: '/database', key: 'nav.database' },
      { id: 'account', href: '/account/settings', key: 'nav.account' },
    ];
    var html = '<a class="page-side-brand" href="/">CloudSSH</a><nav class="page-side-menu">';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var active = item.id === page;
      html += '<a class="page-side-item' + (active ? ' page-side-item--active' : '') + '" href="' + item.href + '"' +
        (active ? ' aria-current="page"' : '') + '>' + NAV_ICONS[item.id] + '<span data-i18n="' + item.key + '"></span></a>';
    }
    html += '</nav><div class="page-side-foot"></div>';
    var aside = document.createElement('aside');
    aside.className = 'page-side-nav';
    aside.setAttribute('aria-label', 'CloudSSH');
    aside.innerHTML = html;
    document.body.insertBefore(aside, document.body.firstChild);
    document.body.classList.add('has-side-nav');
    aside.querySelector('.page-side-foot').appendChild(buildLanguageSelect());
  }

  run();
  injectSideNav();
  window.addEventListener('storage', function (event) {
    if (event.key === 'cloudssh_theme_selection' || event.key === 'cloudssh_imported_theme' || event.key === null) run();
  });
})();
