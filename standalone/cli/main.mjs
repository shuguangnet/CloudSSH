#!/usr/bin/env node
/**
 * CloudSSH 命令行客户端。
 *
 * 架构：纯客户端。本地终端 ──HTTPS/WS──> 面板 ──SSH──> 目标服务器。
 * 凭据、跳板链、主机指纹、审计全部在面板侧；本进程只持有访问令牌。
 * 这既是安全边界，也意味着 CLI 换机器可用、无需重新录一遍密码。
 *
 * 核心 UX：**唯一命中即直连**。
 *   cssh              交互选择（输入过滤，Enter 连接）
 *   cssh prod         名字/主机/标签/id 唯一命中 → 直接连
 *   cssh @db          按标签
 *   cssh 42           按 id
 *   cssh -            重连上次的服务器
 *   cssh prod -- uptime     一次性命令，退出码透传
 */

import { readFileSync, statSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, resolve } from 'node:path';

import { createClient, CliError, readNdjson } from './api.mjs';
import {
  resolveSettings, writeConfig, readConfig, clearConfig, configPath,
  configFilePermissions, ConfigError,
} from './config.mjs';
import { matchServers, nearestServers } from './match.mjs';
import { pick, PickerError } from './picker.mjs';
import { connectTerminal, runTerminal, recordKnownHost, TerminalError } from './terminal.mjs';

const VERSION = '2.6.4';

// ==================== 输出helpers ====================

const isColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (isColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const out = (line = '') => process.stdout.write(`${line}\n`);
const err = (line = '') => process.stderr.write(`${line}\n`);

function fail(message, code = 1) {
  err(`${red('✗')} ${message}`);
  process.exitCode = code;
}

// ==================== 参数解析 ====================
//
// 手写而不是用 commander/yargs：零依赖是本项目的既定取向，
// 而 CLI 需要处理的形态其实只有「子命令 + 少数几个 flag + 尾部命令」。
// 约定：`--` 之后的一切原样传给远端 shell，不做任何解释。

const KNOWN_COMMANDS = new Set([
  'login', 'logout', 'whoami', 'ls', 'list', 'l',
  'ssh', 'exec', 'run', 'cp', 'up', 'down',
  'snippet', 'snip', 'db', 'forget', 'aliases', 'help', 'version',
]);

function parseArgv(argv) {
  const args = { _: [], flags: {}, rest: [], command: '' };
  let rest = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (rest) { args.rest.push(token); continue; }
    if (token === '--') { rest = true; continue; }
    if (token.startsWith('--')) {
      const [key, inlineValue] = token.slice(2).split('=');
      if (inlineValue !== undefined) { args.flags[key] = inlineValue; continue; }
      // 布尔型 flag 不吞下一个参数（避免 `--yes prod` 把 prod 吃掉）。
      const BOOLEAN = new Set(['yes', 'insecure', 'help', 'version', 'json', 'stream', 'all', 'force']);
      if (BOOLEAN.has(key)) { args.flags[key] = true; continue; }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) { args.flags[key] = next; index++; }
      else args.flags[key] = true;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      // 短 flag：-y / -f / -h / -v
      for (const char of token.slice(1)) {
        if (char === 'y') args.flags.yes = true;
        else if (char === 'f') args.flags.force = true;
        else if (char === 'h') args.flags.help = true;
        else if (char === 'v') args.flags.version = true;
        else if (char === 's') args.flags.stream = true;
      }
      continue;
    }
    args._.push(token);
  }
  args.command = args._.shift() || '';
  return args;
}

// ==================== 上下文 ====================

/** 建立「设置 + 客户端」，未配置时给出可执行的修复命令。 */
function makeContext(flags) {
  const settings = resolveSettings({ flags });
  if (!settings.baseUrl) {
    throw new CliError(
      '未配置面板地址。请执行：cssh login https://你的面板地址'
    );
  }
  if (!settings.token) {
    throw new CliError(
      `未配置访问令牌。请在面板「MCP 令牌」创建一把（需含 read/exec/write 权限），然后执行：\n`
      + `  cssh login ${settings.baseUrl}`
    );
  }
  const api = createClient({
    baseUrl: settings.baseUrl, token: settings.token, insecure: settings.insecure,
  });
  return { settings, api };
}

/** 从 stdin 读一行（用于令牌输入，支持管道）。 */
function readLineFromStdin(promptText) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) process.stderr.write(promptText);
    let done = false;
    rl.once('line', (line) => { done = true; rl.close(); resolvePromise(line.trim()); });
    rl.once('close', () => { if (!done) resolvePromise(''); });
  });
}

/** 从 stdin 读密码式输入（不回显）。非 TTY 时直接读一行。 */
function readSecret(promptText) {
  return new Promise((resolvePromise) => {
    if (!process.stdin.isTTY) { readLineFromStdin('').then(resolvePromise); return; }
    process.stderr.write(promptText);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let buffer = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolvePromise(buffer.trim());
          return;
        }
        if (char === '\x03') { // Ctrl+C
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (char === '\x7f' || char === '\b') { buffer = buffer.slice(0, -1); continue; }
        if (char >= ' ') buffer += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** 读取整份 stdin（管道场景）。 */
async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ==================== 选择服务器 ====================

/**
 * 把「用户输入」解析成唯一一台服务器。
 *
 * 这是「快捷」的核心：唯一命中直接返回，多命中才交互选择，
 * 零命中给近似建议并失败。**绝不猜**——连错生产服务器的代价太高。
 */
async function resolveServer(api, query, { allowPicker = true } = {}) {
  const servers = await api.servers();
  if (servers.length === 0) {
    throw new CliError('该令牌未授权任何服务器。请在面板创建令牌时勾选要允许的服务器');
  }

  if (!query) {
    if (!allowPicker) throw new CliError('请指定服务器名称或 id');
    return pick({ items: servers, title: '选择服务器' });
  }

  // `-` = 上次连过的那台
  const actualQuery = query === '-' ? readConfig().lastServer || '' : query;
  if (query === '-' && !actualQuery) {
    throw new CliError('还没有连接记录。先连一次任意服务器，之后 cssh - 就能重连');
  }

  const aliases = readConfig().aliases || {};
  const { exact, matches } = matchServers(servers, actualQuery, { aliases });

  if (exact) return exact;

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    if (!allowPicker) {
      // 非交互场景不能静默挑一个：把候选列清楚让人自己决定。
      const list = matches.slice(0, 8).map((item) => `  ${item.id}  ${item.name}  ${item.host}`).join('\n');
      throw new CliError(`“${actualQuery}” 命中 ${matches.length} 台服务器，请用更精确的名称或 id：\n${list}`);
    }
    out(dim(`“${actualQuery}” 命中 ${matches.length} 台，请选择：`));
    // 多命中时把过滤词预填进去，用户继续输入就能继续收窄。
    return pick({ items: matches, title: `匹配“${actualQuery}”`, filter: actualQuery });
  }

  const nearest = nearestServers(servers, actualQuery);
  if (nearest.length) {
    const list = nearest.map((item) => `  ${item.id}  ${item.name}  ${item.host}`).join('\n');
    throw new CliError(`找不到匹配“${actualQuery}”的服务器。是不是想连：\n${list}`);
  }
  throw new CliError(`找不到匹配“${actualQuery}”的服务器。用 cssh ls 查看全部`);
}

/** 记录「上次连过」，供 cssh - 使用。 */
function rememberServer(server) {
  try {
    const config = readConfig();
    writeConfig({ ...config, lastServer: server.name });
  } catch { /* 记录失败不影响连接 */ }
}

// ==================== 子命令 ====================

async function cmdLogin(args) {
  const positionalUrl = args._[0];
  const stored = readConfig();

  // 地址：优先命令行，其次已有配置，最后交互询问。
  let baseUrl = positionalUrl || stored.baseUrl || '';
  if (!baseUrl) {
    baseUrl = await readLineFromStdin('面板地址（例如 https://panel.example.com）：');
  }
  if (!baseUrl) throw new CliError('未提供面板地址');

  // 令牌：优先环境变量（CI 友好），否则不回显地询问。
  // 绝不用位置参数接收令牌——那会进 shell 历史和 ps 输出。
  let token = process.env.CLOUDSSH_TOKEN || '';
  if (!token && args.flags.token) {
    err(yellow('⚠ --token 会在 shell 历史与进程列表里留下令牌；建议改用 CLOUDSSH_TOKEN 环境变量'));
    token = String(args.flags.token);
  }
  if (!token) {
    err('请在面板「MCP 令牌」页面创建令牌（勾选 read / exec / write 与要访问的服务器）。');
    token = await readSecret('粘贴访问令牌（输入不回显）：');
  }
  if (!token) throw new CliError('未提供访问令牌');

  // 先验证再落盘：写进去才发现是错的令牌，比当场失败难排查得多。
  const insecure = args.flags.insecure === true || stored.insecure === true;
  const settings = resolveSettings({ flags: { url: baseUrl, token, insecure } });
  const api = createClient({ baseUrl: settings.baseUrl, token, insecure });
  let who;
  try {
    who = await api.whoami();
  } catch (error) {
    if (error instanceof CliError && error.status === 401) {
      throw new CliError('令牌校验失败：请确认令牌未过期、未被撤销，且面板地址正确');
    }
    throw error;
  }

  const file = writeConfig({
    baseUrl: settings.baseUrl,
    token,
    ...(insecure ? { insecure: true } : {}),
    ...(stored.aliases ? { aliases: stored.aliases } : {}),
    ...(stored.lastServer ? { lastServer: stored.lastServer } : {}),
  });

  out(`${green('✓')} 已登录 ${bold(settings.baseUrl)}`);
  out(`  身份：${who.name || who.github_id}  权限：${who.scopes.join(', ')}`);
  out(`  授权服务器：${who.server_ids.length} 台  授权数据库：${(who.db_connection_ids || []).length} 个`);
  if (who.expires_at) {
    const expires = new Date(who.expires_at);
    const days = Math.ceil((expires.getTime() - Date.now()) / 86400000);
    out(`  令牌将于 ${expires.toLocaleDateString('zh-CN')} 过期（${days} 天后）`);
  }
  out(dim(`  配置已写入 ${file}（权限 0600）`));

  const perms = configFilePermissions();
  if (perms?.tooOpen) {
    err(yellow(`⚠ 配置文件权限为 ${perms.mode.toString(8)}，建议执行 chmod 600 ${configPath()}`));
  }
}

async function cmdLogout() {
  const removed = clearConfig();
  out(removed ? `${green('✓')} 已清除本地配置与令牌` : dim('本地没有配置文件，无需清除'));
  out(dim('注意：这只是删除本机副本；令牌本身仍在面板有效，如需彻底作废请到面板撤销'));
}

async function cmdWhoami(args) {
  const { settings, api } = makeContext(args.flags);
  const who = await api.whoami();
  if (args.flags.json) { out(JSON.stringify(who, null, 2)); return; }
  out(`面板    ${bold(settings.baseUrl)}`);
  out(`身份    ${who.name || who.github_id}`);
  out(`权限    ${who.scopes.join(', ')}`);
  out(`服务器  ${who.server_ids.length} 台（${who.server_ids.join(', ')}）`);
  const dbs = who.db_connection_ids || [];
  out(`数据库  ${dbs.length} 个${dbs.length ? `（${dbs.join(', ')}）` : ''}`);
  if (who.expires_at) {
    const days = Math.ceil((who.expires_at - Date.now()) / 86400000);
    out(`有效期  还剩 ${days} 天${days < 7 ? red('（即将过期）') : ''}`);
  }
  if (settings.source !== 'file') {
    out(dim(`令牌来源：${settings.source === 'env' ? '环境变量 CLOUDSSH_TOKEN' : '命令行参数'}（未写入本地配置文件）`));
  }
}

function formatServerRow(server) {
  const tags = server.tags?.length ? dim(` [${server.tags.join(',')}]`) : '';
  const target = dim(`${server.username}@${server.host}:${server.port}`);
  return `  ${String(server.id).padStart(3)}  ${server.name}${tags}  ${target}`;
}

async function cmdLs(args) {
  const { api } = makeContext(args.flags);
  const servers = await api.servers();
  if (args.flags.json) { out(JSON.stringify({ servers }, null, 2)); return; }
  if (servers.length === 0) {
    out(yellow('该令牌未授权任何服务器'));
    out(dim('到面板「MCP 令牌」里编辑这把令牌，勾选要放行的服务器'));
    return;
  }
  const query = args._[0] || '';
  const aliases = readConfig().aliases || {};
  const { matches } = query
    ? matchServers(servers, query, { aliases })
    : { matches: servers };
  if (matches.length === 0) {
    out(yellow(`没有匹配“${query}”的服务器`));
    return;
  }
  out(bold(`${matches.length} 台服务器`) + dim(`（共授权 ${servers.length} 台）`));
  for (const server of matches) out(formatServerRow(server));
  out();
  out(dim('cssh <名称>   直接连接    cssh        交互选择'));
}

/**
 * 把 `-- command…` 或位置参数拼成远端命令行。
 *
 * 优先用 `--` 之后的原样内容：这是唯一不会被本地 flag 解析吃掉的
 * 形式，也是 `cssh prod -- systemctl status x -l` 能正常工作的前提。
 */
function remoteCommand(args) {
  if (args.rest.length) return args.rest.join(' ');
  return args._.join(' ');
}

async function cmdExec(args) {
  const { api } = makeContext(args.flags);
  // 第一个位置参数是服务器，剩下的（无 `--` 时）拼成命令。
  const rest = [...args._];
  const query = rest.shift() || '';
  if (!query) throw new CliError('用法：cssh exec <服务器> -- <命令>');
  const server = await resolveServer(api, query, { allowPicker: false });
  const command = args.rest.length ? args.rest.join(' ') : rest.join(' ');
  if (!command.trim()) throw new CliError('缺少要执行的命令，例如：cssh prod -- uptime -d');
  return execOn(api, server, args, command);
}

/** 在已解析的服务器上执行一条一次性命令，退出码透传。 */
async function execOn(api, server, args, explicitCommand) {
  const command = explicitCommand ?? args.rest.join(' ');
  if (!command.trim()) throw new CliError('缺少要执行的命令');
  const timeoutMs = args.flags.timeout ? Number(args.flags.timeout) * 1000 : undefined;

  if (args.flags.stream) {
    // 流式：边跑边打印，适用于长时间构建 / 日志追踪。
    const response = await api.execStream(server.id, command, { timeoutMs });
    let exitCode = 0;
    let stderrText = '';
    for await (const event of readNdjson(response)) {
      if (event.type === 'output') process.stdout.write(event.text);
      else if (event.type === 'done') { exitCode = event.exitCode ?? 0; stderrText = event.stderr || ''; }
      else if (event.type === 'error') throw new CliError(event.message);
    }
    if (stderrText) process.stderr.write(stderrText);
    process.exit(exitCode);
  }

  const result = await api.exec(server.id, command, { timeoutMs });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.truncated) err(yellow('（输出已被面板截断，考虑用 --stream 或分页查看）'));
  // 退出码透传：脚本里 `cssh prod -- false || echo failed` 必须能生效。
  process.exit(result.exitCode ?? 0);
}

/**
 * 文件传输。`cssh cp up <本地> <远端服务器>:<远端路径>`
 *                 `cssh cp down <远端服务器>:<远端路径> <本地>`
 *                 `cssh cp up ./x prod:/tmp/x`  （省略 up/down：按远端前缀带 `:` 判定方向）
 */
async function cmdCp(args) {
  const { api } = makeContext(args.flags);
  const parts = [...args._];
  let direction = '';
  if (parts[0] === 'up' || parts[0] === 'down') direction = parts.shift();
  const [source, target] = parts;
  if (!source || !target) {
    throw new CliError(
      '用法：\n'
      + '  cssh cp up   ./local.txt  prod:/tmp/remote.txt\n'
      + '  cssh cp down prod:/var/log/x.log  ./x.log'
    );
  }

  if (!direction) {
    direction = source.includes(':') && !/^[A-Za-z]:[\\/]/.test(source) ? 'down' : 'up';
  }

  if (direction === 'up') {
    await uploadFile(api, source, target, args.flags);
  } else {
    await downloadFile(api, source, target, args.flags);
  }
}

/** 解析 `server:/path` 形式的目标。 */
function parseRemoteSpec(spec) {
  const match = /^([^:]+):(.+)$/.exec(String(spec));
  if (!match) throw new CliError(`无法解析“${spec}”，正确格式是 服务器:/绝对路径`);
  return { server: match[1], path: match[2] };
}

async function uploadFile(api, localPath, remoteSpec, flags) {
  const { server: query, path: remotePath } = parseRemoteSpec(remoteSpec);
  if (!remotePath.startsWith('/')) throw new CliError('远端路径必须是绝对路径');
  const server = await resolveServer(api, query, { allowPicker: false });

  const stats = statSync(localPath);
  if (!stats.isFile()) throw new CliError(`${localPath} 不是普通文件（暂不支持目录上传）`);
  const size = stats.size;
  if (!flags.force && process.stdin.isTTY) {
    out(`将上传 ${bold(basename(localPath))} (${formatBytes(size)}) → ${bold(`${server.name}:${remotePath}`)}`);
    const answer = await readLineFromStdin('继续？[y/N] ');
    if (!/^y(es)?$/i.test(answer)) { out(dim('已取消')); return; }
  }

  // 分块：每块 128KB 原始字节（base64 后约 175K 字符），仍在服务端
  // 128000 字符的 base64 预算内。
  const CHUNK = 96 * 1024;
  const handle = readFileSync(localPath);
  let offset = 0;
  let first = true;
  while (offset < handle.length || (first && handle.length === 0)) {
    const chunk = handle.subarray(offset, Math.min(offset + CHUNK, handle.length));
    await api.upload(server.id, remotePath, chunk.toString('base64'), { append: !first });
    first = false;
    offset += chunk.length;
    if (size > 0) {
      const percent = Math.min(100, Math.round((offset / size) * 100));
      if (process.stderr.isTTY) process.stderr.write(`\r上传中 ${percent}% (${formatBytes(offset)}/${formatBytes(size)})`);
    }
    if (handle.length === 0) break;
  }
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  out(`${green('✓')} 已上传到 ${server.name}:${remotePath}（${formatBytes(size)}）`);
}

async function downloadFile(api, remoteSpec, localPath, flags) {
  const { server: query, path: remotePath } = parseRemoteSpec(remoteSpec);
  if (!remotePath.startsWith('/')) throw new CliError('远端路径必须是绝对路径');
  const server = await resolveServer(api, query, { allowPicker: false });

  const destination = resolve(localPath);
  // 覆盖保护：只有显式 --force 才写已存在的文件。
  if (!flags.force) {
    try {
      statSync(destination);
      throw new CliError(`${destination} 已存在。加 --force 覆盖，或换一个目标路径`);
    } catch (error) {
      if (error instanceof CliError) throw error;
    }
  }

  const stream = createWriteStream(destination, { mode: 0o600 });
  let offset = 0;
  let total = null;
  try {
    for (;;) {
      const chunk = await api.download(server.id, remotePath, { offset });
      if (total === null) total = chunk.size;
      if (chunk.chunkBytes > 0) {
        const buffer = Buffer.from(chunk.contentBase64, 'base64');
        await new Promise((resolvePromise, rejectPromise) => {
          stream.write(buffer, (error) => (error ? rejectPromise(error) : resolvePromise()));
        });
        offset += chunk.chunkBytes;
      }
      if (process.stderr.isTTY && total) {
        const percent = Math.min(100, Math.round((offset / total) * 100));
        process.stderr.write(`\r下载中 ${percent}% (${formatBytes(offset)}/${formatBytes(total)})`);
      }
      if (!chunk.truncated) break;
      if (chunk.chunkBytes === 0) break;
    }
  } finally {
    await new Promise((resolvePromise) => stream.end(resolvePromise));
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  }
  out(`${green('✓')} 已下载 ${server.name}:${remotePath} → ${destination}（${formatBytes(offset)}）`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function cmdSnippet(args) {
  const { api } = makeContext(args.flags);
  const action = args._[0] || 'ls';
  const snippets = await api.snippets();

  if (action === 'ls' || action === 'list') {
    if (snippets.length === 0) { out(dim('面板里还没有命令片段')); return; }
    const query = args._[1] || '';
    const filtered = query
      ? snippets.filter((item) => `${item.name} ${item.category} ${item.command}`.toLowerCase().includes(query.toLowerCase()))
      : snippets;
    for (const item of filtered) {
      const category = item.category ? dim(` [${item.category}]`) : '';
      out(`  ${String(item.id).padStart(3)}  ${item.name}${category}`);
      out(dim(`       ${item.command.split('\n')[0].slice(0, 100)}`));
    }
    return;
  }

  if (action === 'run') {
    const identifier = args._[1];
    if (!identifier) throw new CliError('用法：cssh snippet run <片段名称或 id> [服务器]');
    const snippet = /^\d+$/.test(identifier)
      ? snippets.find((item) => item.id === Number(identifier))
      : snippets.find((item) => item.name === identifier)
        || snippets.find((item) => item.name.toLowerCase().includes(identifier.toLowerCase()));
    if (!snippet) throw new CliError(`找不到命令片段“${identifier}”`);

    const server = await resolveServer(api, args._[2] || '', { allowPicker: true });
    out(dim(`在 ${server.name} 上执行片段「${snippet.name}」`));
    const result = await api.exec(server.id, snippet.command, {});
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode ?? 0);
  }

  throw new CliError('用法：cssh snippet ls [关键词] | cssh snippet run <名称> [服务器]');
}

async function cmdDb(args) {
  const { api } = makeContext(args.flags);
  const action = args._[0] || 'ls';
  const connections = await api.dbConnections();

  if (action === 'ls' || action === 'list') {
    if (connections.length === 0) {
      out(yellow('该令牌未授权任何数据库连接'));
      out(dim('到面板「MCP 令牌」里编辑令牌，勾选 db_connection_ids'));
      return;
    }
    if (args.flags.json) { out(JSON.stringify({ connections }, null, 2)); return; }
    for (const item of connections) {
      const lock = item.readOnly ? green('只读') : yellow('可写');
      out(`  ${String(item.id).padStart(3)}  ${bold(item.name)} ${dim(`[${item.engine}]`)} ${lock}`);
      out(dim(`       ${item.username}@${item.host}:${item.port}/${item.database || ''}`));
    }
    return;
  }

  const connection = await resolveDbConnection(connections, args._[1]);

  if (action === 'schema') {
    const table = args._[2];
    const result = await api.dbSchema(connection.id, { table });
    if (args.flags.json) { out(JSON.stringify(result, null, 2)); return; }
    if (result.kind === 'table') {
      out(bold(`${result.table} 的列`));
      for (const column of result.columns) {
        const nullable = column.nullable === false ? dim(' NOT NULL') : '';
        out(`  ${column.name.padEnd(28)} ${dim(String(column.type || ''))}${nullable}`);
      }
      return;
    }
    out(bold(`${connection.name} 的表（${result.engine}）`));
    for (const table_ of result.tables || []) {
      const name = typeof table_ === 'string' ? table_ : table_.name;
      const note = typeof table_ === 'string' ? '' : (table_.note || table_.type || '');
      out(`  ${name}${note ? dim(` ${note}`) : ''}`);
    }
    if (result.note) out(dim(result.note));
    return;
  }

  if (action === 'query') {
    const sql = remoteCommand({ _: args._.slice(2), rest: args.rest });
    if (!sql) throw new CliError('缺少 SQL，例如：cssh db query prod-db "select 1"');
    return runDbQuery(api, connection, sql, args.flags);
  }

  throw new CliError('用法：cssh db ls | cssh db schema <连接> [表] | cssh db query <连接> "<SQL>"');
}

async function resolveDbConnection(connections, query) {
  if (!query) throw new CliError('请指定数据库连接名称或 id');
  const exact = connections.find((item) => String(item.id) === query)
    || connections.find((item) => item.name === query)
    || connections.find((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  if (exact) return exact;
  const list = connections.map((item) => `  ${item.id}  ${item.name}`).join('\n');
  throw new CliError(`找不到数据库连接“${query}”。可选：\n${list}`);
}

async function runDbQuery(api, connection, sql, flags) {
  const result = await api.dbQuery(connection.id, sql, {
    timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
  });
  if (flags.json) { out(JSON.stringify(result, null, 2)); return; }

  const columns = result.columns || [];
  if (columns.length === 0) {
    out(`${green('✓')} 影响 ${result.rowCount} 行（${result.durationMs}ms）`);
    return;
  }
  printTable(columns, result.rows || []);
  out(dim(`${result.returnedRows} 行 · ${result.durationMs}ms`
    + (result.truncated ? ` · 已截断（共 ${result.rowCount} 行）` : '')));
  if (result.redactedCells) {
    // 必须提示：否则用户会以为库里存的就是 ***，甚至把它写回去。
    err(yellow(`⚠ ${result.redactedCells} 个单元格命中密钥特征已被遮蔽为 ***；数据库内仍是原值，不要把它写回`));
  }
}

/** 极简表格渲染：按显示宽度（CJK 双宽）对齐。 */
function printTable(columns, rows) {
  const names = columns.map((column) => (typeof column === 'string' ? column : column.name));
  const cells = rows.map((row) => names.map((name, index) => {
    const value = Array.isArray(row) ? row[index] : row[name];
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }));
  const widths = names.map((name, index) => Math.max(
    displayWidth(name),
    ...cells.map((row) => displayWidth(row[index])),
  ));
  const pad = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));
  out(bold(names.map((name, index) => pad(name, widths[index])).join('  ')));
  out(dim(widths.map((width) => '─'.repeat(width)).join('  ')));
  for (const row of cells) out(row.map((text, index) => pad(text, widths[index])).join('  '));
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const double = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += double ? 2 : 1;
  }
  return width;
}

async function cmdForget(args) {
  const { api } = makeContext(args.flags);
  const query = args._[0];
  if (!query) throw new CliError('用法：cssh forget <服务器>  （清除该服务器的已知主机指纹）');
  const server = await resolveServer(api, query, { allowPicker: false });

  err(yellow(`这会让下次连接重新走首次信任流程（TOFU）。`));
  err(`目标：${bold(server.name)}（${server.username}@${server.host}:${server.port}）`);
  if (!args.flags.yes) {
    const answer = await readLineFromStdin('确认清除指纹？[y/N] ');
    if (!/^y(es)?$/i.test(answer)) { out(dim('已取消')); return; }
  }
  await api.forgetKnownHost({ host: server.host, port: server.port });
  out(`${green('✓')} 已清除 ${server.name} 的主机指纹`);
}

async function cmdAliases(args) {
  const config = readConfig();
  const aliases = config.aliases || {};
  const action = args._[0] || 'ls';
  if (action === 'ls' || action === 'list') {
    const entries = Object.entries(aliases);
    if (entries.length === 0) {
      out(dim('还没有别名。用 cssh aliases set web prod-web-01 创建'));
      return;
    }
    for (const [alias, target] of entries) out(`  ${bold(alias)} → ${target}`);
    return;
  }
  if (action === 'set') {
    const [alias, target] = args._.slice(1);
    if (!alias || !target) throw new CliError('用法：cssh aliases set <别名> <服务器名或 @标签>');
    writeConfig({ ...config, aliases: { ...aliases, [alias]: target } });
    out(`${green('✓')} ${alias} → ${target}`);
    return;
  }
  if (action === 'rm' || action === 'remove') {
    const alias = args._[1];
    if (!alias) throw new CliError('用法：cssh aliases rm <别名>');
    const next = { ...aliases };
    delete next[alias];
    writeConfig({ ...config, aliases: next });
    out(`${green('✓')} 已删除别名 ${alias}`);
    return;
  }
  throw new CliError('用法：cssh aliases [ls|set <别名> <目标>|rm <别名>]');
}

function cmdHelp() {
  out(`${bold('CloudSSH CLI')} ${dim(`v${VERSION}`)}  —  从终端连接面板里保存的服务器`);
  out();
  out(bold('快捷用法'));
  out('  cssh                        交互选择服务器');
  out('  cssh <名称>                 唯一命中就直接连（名称/主机/标签/id 都行）');
  out(`  ${dim('cssh prod')}              按名称            ${dim('cssh @database')}   按标签`);
  out(`  ${dim('cssh 42')}                按 id              ${dim('cssh -')}           重连上一次`);
  out('  cssh <名称> -- <命令>       执行一条命令并退出（退出码透传）');
  out();
  out(bold('常用命令'));
  out('  cssh login [面板地址]       登录并保存令牌');
  out('  cssh logout                 清除本地令牌');
  out('  cssh whoami                 查看当前身份与授权');
  out('  cssh ls [关键词]            列出可用服务器');
  out('  cssh ssh <名称>             显式进交互终端');
  out('  cssh exec <名称> -- <命令>  一次性命令（--stream 流式输出）');
  out('  cssh cp up <本地> <服务器>:<远端路径>');
  out('  cssh cp down <服务器>:<远端路径> <本地>');
  out('  cssh snippet ls [关键词]    列出面板命令片段');
  out('  cssh snippet run <名称> [服务器]');
  out('  cssh db ls                  列出已授权的数据库连接');
  out('  cssh db schema <连接> [表]  查看表结构');
  out('  cssh db query <连接> "<SQL>"');
  out('  cssh forget <名称>          清除已知主机指纹（指纹变更后用）');
  out('  cssh aliases set <别名> <目标>   自定义快捷方式');
  out();
  out(bold('环境变量'));
  out('  CLOUDSSH_URL      面板地址（覆盖配置文件）');
  out('  CLOUDSSH_TOKEN    访问令牌（覆盖配置文件；CI 场景推荐）');
  out('  CLOUDSSH_CONFIG_HOME  配置目录（默认 ~/.config/cloudssh）');
  out('  CLOUDSSH_YES=1    跳过写操作的确认提示');
  out();
  out(bold('说明'));
  out('  凭据始终保存在面板，CLI 只持有访问令牌（权限、有效期、可撤销）。');
  out('  令牌可在面板「MCP 令牌」中管理，与 MCP 客户端共用同一套。');
}

// ==================== 入口 ====================

/** 「更新到本机」这个实例是 http://5.175.220.95:8788，但 CLI 默认不发请求。 */
async function main() {
  const args = parseArgv(process.argv.slice(2));

  if (args.flags.version) { out(VERSION); return; }
  if (args.flags.help || args.command === 'help' || args.command === '--help') { cmdHelp(); return; }

  // 无子命令：快捷路径。
  //   `cssh`               → 交互选择
  //   `cssh prod`          → 直接连
  //   `cssh prod -- uptime`→ 一次性命令
  // 判断依据：第一个位置参数是否是已知子命令。
  if (!args.command) {
    const { api } = makeContext(args.flags);
    const server = await resolveServer(api, '', { allowPicker: true });
    return connectAndServe(api, server, args);
  }

  if (!KNOWN_COMMANDS.has(args.command)) {
    // 不是子命令 → 当作服务器名快捷连接。
    // 注意：`cssh prod web` 这种多词查询也走这里（拼接后用空格归一化）。
    const query = [args.command, ...args._].join(' ');
    const { api } = makeContext(args.flags);
    if (args.rest.length) {
      // `cssh prod -- uptime`：一次性命令，退出码透传
      const server = await resolveServer(api, query, { allowPicker: false });
      return execOn(api, server, args);
    }
    const server = await resolveServer(api, query, { allowPicker: process.stdin.isTTY });
    return connectAndServe(api, server, args);
  }

  switch (args.command) {
    case 'login': return cmdLogin(args);
    case 'logout': return cmdLogout(args);
    case 'whoami': return cmdWhoami(args);
    case 'ls': case 'list': case 'l': return cmdLs(args);
    // `cssh ssh prod` 与 `cssh prod` 等价；显式形式让脚本可读性更好。
    case 'ssh': {
      const { api } = makeContext(args.flags);
      const server = await resolveServer(api, args._.join(' '), { allowPicker: process.stdin.isTTY });
      return connectAndServe(api, server, args);
    }
    case 'exec': case 'run': return cmdExec(args);
    case 'cp': return cmdCp(args);
    case 'snippet': case 'snip': return cmdSnippet(args);
    case 'db': return cmdDb(args);
    case 'forget': return cmdForget(args);
    case 'aliases': return cmdAliases(args);
    case 'version': out(VERSION); return;
    default: cmdHelp(); return;
  }
}

/** 已解析出服务器后的连接（供快捷路径复用）。 */
async function connectAndServe(api, server, args) {
  const settings = resolveSettings({ flags: args.flags });
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const wsBase = settings.baseUrl.replace(/^http/i, 'ws');
  const wsUrl = `${wsBase}/api/cli/ssh?server_id=${server.id}&cols=${cols}&rows=${rows}`;

  if (!process.stdin.isTTY) {
    throw new CliError('交互终端需要真实终端。管道场景请用：cssh <名称> -- <命令>');
  }

  out(dim(`正在连接 ${server.name}（${server.username}@${server.host}:${server.port}）…`));
  const session = await connectTerminal({
    wsUrl, token: settings.token, cols, rows, insecure: settings.insecure,
    onEvent: (event) => {
      if (event.type === 'status' && event.message && event.event !== 'shell_ready') {
        err(dim(`· ${event.message}`));
      }
      if (event.type === 'error' && event.message) err(red(`✗ ${event.message}`));
    },
    onOutput: (chunk) => process.stdout.write(chunk),
    onHostKeyVerified: async (payload) => {
      const saved = await recordKnownHost(api, server, payload);
      err(saved
        ? dim(`· 已记录主机指纹 ${payload.fingerprint}`)
        : yellow(`· 首次连接（指纹 ${payload.fingerprint}）未能自动记录`));
    },
  });
  rememberServer(server);
  const code = await runTerminal({ socket: session.socket });
  session.close();
  process.exit(code || 0);
}

/** 一次性命令（快捷路径 `cssh prod -- cmd`）。 */

main().catch((error) => {
  if (error instanceof PickerError) {
    if (error.exitCode === 130) { /* 用户主动取消，静默 */ } else { fail(error.message); }
    process.exit(error.exitCode || 1);
  }
  if (error instanceof ConfigError || error instanceof CliError || error instanceof TerminalError) {
    fail(error.message, error.exitCode || (error.status === 401 ? 77 : 1));
    process.exit(error.exitCode || (error.status === 401 ? 77 : 1));
  }
  fail(error?.message || String(error));
  if (process.env.CLOUDSSH_DEBUG) err(error.stack);
  process.exit(1);
});
