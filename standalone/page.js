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
        '--bg': '#0a0a0a', '--bg-surface': '#121212', '--bg-elevated': '#131313', '--bg-terminal': '#0e0e0e',
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
        '--bg': '#0f1115', '--bg-surface': '#161a22', '--bg-elevated': '#1c222d', '--bg-terminal': '#0b0e14',
        '--text': '#e6edf3', '--text-muted': '#9ba7b4', '--text-dim': '#7d8590',
        '--accent': '#58a6ff', '--accent-secondary': '#79c0ff',
        '--border': '#30363d', '--border-strong': '#484f58',
        '--error': '#ff7b72', '--error-bg': '#3d1418', '--on-accent': '#07111f',
        '--accent-bg': 'rgba(88, 166, 255, 0.1)',
        '--ok': '#3fb950', '--ok-bg': 'rgba(63, 185, 80, 0.14)',
        '--warn': '#d29922', '--warn-bg': 'rgba(210, 153, 34, 0.14)',
        '--scrollbar-track': 'rgba(22, 26, 34, 0.7)', '--scrollbar-thumb': 'rgba(155, 167, 180, 0.35)',
        '--card-radius': '10px', '--control-radius': '6px', '--shadow-card': '0 1px 3px rgba(1, 4, 9, 0.4)',
      },
    },
    'standard-light': {
      scheme: 'light',
      vars: {
        '--bg': '#f6f8fa', '--bg-surface': '#ffffff', '--bg-elevated': '#eef2f6', '--bg-terminal': '#ffffff',
        '--text': '#1f2328', '--text-muted': '#57606a', '--text-dim': '#656d76',
        '--accent': '#0969da', '--accent-secondary': '#0550ae',
        '--border': '#d0d7de', '--border-strong': '#afb8c1',
        '--error': '#cf222e', '--error-bg': '#ffebe9', '--on-accent': '#ffffff',
        '--accent-bg': 'rgba(9, 105, 218, 0.1)',
        '--ok': '#1a7f37', '--ok-bg': 'rgba(26, 127, 55, 0.1)',
        '--warn': '#9a6700', '--warn-bg': 'rgba(158, 103, 0, 0.1)',
        '--scrollbar-track': 'rgba(208, 215, 222, 0.45)', '--scrollbar-thumb': 'rgba(87, 96, 106, 0.35)',
        '--card-radius': '10px', '--control-radius': '6px', '--shadow-card': '0 1px 3px rgba(31, 35, 40, 0.12)',
      },
    },
    'liquid-glass': {
      scheme: 'light',
      vars: {
        '--bg': '#e6ecf4', '--bg-surface': 'rgba(255, 255, 255, 0.35)', '--bg-elevated': 'rgba(255, 255, 255, 0.55)', '--bg-terminal': 'rgba(255, 255, 255, 0.88)',
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
    var selection = 'cyberpunk';
    try { selection = localStorage.getItem('cloudssh_theme_selection') || 'cyberpunk'; } catch (error) { /* private mode */ }
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

  run();
  window.addEventListener('storage', function (event) {
    if (event.key === 'cloudssh_theme_selection' || event.key === 'cloudssh_imported_theme' || event.key === null) run();
  });
})();
