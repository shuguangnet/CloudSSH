// 设置页（standalone/settings.html + settings.js）的静态一致性：
// 三语词典键与占位符对齐、HTML/JS 引用的文案键必须存在、JS 取用的 DOM id 必须在 HTML 中定义。
// 这些页面不做打包，靠字符串 id 互相连接，拼错只会静默失败，因此需要静态把关。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('standalone/settings.html', 'utf8');
const js = readFileSync('standalone/settings.js', 'utf8');

// 词典是文件开头的对象字面量，直接求值读取（受控文件，测试内可接受）。
const literal = js.slice(js.indexOf('const dictionaries = {') + 'const dictionaries = '.length, js.indexOf('\nconst ', js.indexOf('const dictionaries = {')));
const dictionaries = new Function(`return ${literal.trim().replace(/;\s*$/, '')}`)();
const locales = Object.keys(dictionaries);
const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('settings page dictionaries stay aligned across locales', () => {
  assert.deepEqual(locales, ['zh-CN', 'zh-TW', 'en-US']);
  const [reference, ...rest] = locales.map((locale) => Object.keys(dictionaries[locale]).sort());
  assert.ok(reference.length > 60, `expected the full key set, got ${reference.length}`);
  for (const [index, keys] of rest.entries()) assert.deepEqual(keys, reference, `${locales[index + 1]} key set`);
  for (const key of reference) {
    const values = locales.map((locale) => dictionaries[locale][key]);
    for (const value of values) assert.equal(typeof value, 'string', `${key} must be a string`);
    assert.ok(values.every((value) => value.trim().length > 0), `${key} must not be empty`);
    assert.deepEqual(placeholders(values[1]), placeholders(values[0]), `${key} placeholders (zh-TW)`);
    assert.deepEqual(placeholders(values[2]), placeholders(values[0]), `${key} placeholders (en-US)`);
  }
});

test('settings page references only defined translation keys and DOM ids', () => {
  const known = new Set(Object.keys(dictionaries['zh-CN']));
  const referenced = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);

  const fromHtml = [
    ...referenced(html, /data-i18n="([^"]+)"/g),
    ...referenced(html, /data-i18n-label="([^"]+)"/g),
    ...referenced(html, /data-i18n-placeholder="([^"]+)"/g),
  ];
  const fromJs = [
    ...referenced(js, /text\('([a-zA-Z]+)'\)/g),
    ...referenced(js, /fill\('([a-zA-Z]+)'/g),
    // 状态与权限文案是按变量取用的，这里显式列出以覆盖动态分支。
    ...['active', 'disabled', 'expired', 'revoked', 'read', 'write', 'exec', 'allStatuses', 'allTokens', 'allServers'].map((key) => key),
  ];
  assert.ok(fromHtml.length >= 60, `expected the translated attributes, got ${fromHtml.length}`);
  for (const key of [...fromHtml, ...fromJs]) assert.ok(known.has(key), `missing translation key: ${key}`);

  // data-i18n-label/placeholder 之外的属性必须真的被应用（否则页面停留在中文占位）。
  assert.match(js, /data-i18n-label.*aria-label|setAttribute\('aria-label'/, 'settings.js must apply data-i18n-label');
  assert.match(js, /data-i18n-placeholder/, 'settings.js must apply data-i18n-placeholder');

  // page.js（表单页共享页头）在运行时注入语言下拉，其 id 也算已定义。
  const pageJs = readFileSync('standalone/page.js', 'utf8');
  assert.match(html, /src="\/page\.js"/, 'settings.html must load the shared header script');
  const htmlIds = new Set([...referenced(html, /id="([^"]+)"/g), ...referenced(pageJs, /\.id = '([^']+)'/g)]);
  const jsIds = referenced(js, /\$\('([^']+)'\)/g);
  assert.ok(jsIds.length > 20, `expected the script to look up elements, got ${jsIds.length}`);
  for (const id of new Set(jsIds)) assert.ok(htmlIds.has(id), `settings.js references missing element id: ${id}`);
});

test('settings page exposes the token management controls', () => {
  const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  for (const id of ['token-select-all', 'token-batch-delete', 'audit-purge', 'token-edit', 'edit-token', 'edit-servers', 'edit-message']) {
    assert.ok(htmlIds.includes(id), `missing control: ${id}`);
  }
  // 状态筛选与徽章需要支持“已禁用”，否则禁用态在界面上不可见。
  assert.match(html, /<option value="disabled"/, 'status filter must offer the disabled state');
  assert.match(js, /disabled: 'info'/, 'disabled tokens need their own badge style');
  assert.match(readFileSync('standalone/page.css', 'utf8'), /\.badge\.info/, 'page.css must define the info badge');
  // 编辑表单必须能同时提交名称、授权主机与权限。
  for (const field of ['name="edit-scope"', 'id="edit-servers"', 'id="edit-name"']) assert.ok(html.includes(field), `edit form missing ${field}`);
});
