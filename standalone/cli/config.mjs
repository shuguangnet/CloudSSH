/**
 * CLI 本地配置：只存「面板地址 + 令牌」，绝不存任何服务器凭据。
 *
 * 令牌落盘位置与权限：
 *   $CLOUDSSH_CONFIG_HOME / $XDG_CONFIG_HOME / ~/.config 下的 cloudssh/config.json
 *   目录 0700、文件 0600。令牌是所有服务器访问的唯一凭证，等同于密码，
 *   所以必须比普通配置文件严格一档。
 *
 * 令牌来源优先级（后者覆盖前者）：
 *   1. 配置文件      `cssh login`
 *   2. 环境变量      CLOUDSSH_TOKEN / CLOUDSSH_URL
 *   3. 命令参数      --token（不推荐：会进 shell 历史与 ps 输出）
 * 环境变量优先级高于文件，方便 CI / 容器里不改盘上配置。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PORT = 8787;

export class ConfigError extends Error {}

/** 配置目录：遵循 XDG 规范，非 Windows 上不需要特殊处理。 */
export function configDir(env = process.env) {
  const base = env.CLOUDSSH_CONFIG_HOME
    || env.XDG_CONFIG_HOME
    || join(homedir(), '.config');
  return join(base, 'cloudssh');
}

export function configPath(env = process.env) {
  return join(configDir(env), 'config.json');
}

/** 读取配置；不存在或损坏都返回空对象（CLI 自己决定是否报错）。 */
export function readConfig(env = process.env) {
  let raw;
  try { raw = readFileSync(configPath(env), 'utf8'); } catch { return {}; }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // 损坏的配置不应静默覆盖用户原有内容——但也不该让 CLI 完全不可用。
    return {};
  }
}

/**
 * 写入配置。令牌写盘前先 umask 到 0600，再用显式 chmod 兜底，
 * 避免「先建文件后收紧权限」中间那一瞬的可读窗口。
 */
export function writeConfig(config, env = process.env) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* 已存在的目录可能属于别处 */ }
  const file = configPath(env);
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const previousUmask = process.umask(0o077);
  try {
    writeFileSync(file, payload, { mode: 0o600 });
  } finally {
    process.umask(previousUmask);
  }
  try { chmodSync(file, 0o600); } catch { /* 某些文件系统不支持 */ }
  return file;
}

export function clearConfig(env = process.env) {
  try { rmSync(configPath(env)); return true; } catch { return false; }
}

/** 权限检查：令牌文件被放宽到组/其他可读时必须警告（不阻断，安全交接仍允许）。 */
export function configFilePermissions(env = process.env) {
  try {
    const mode = statSync(configPath(env)).mode & 0o777;
    return { mode, tooOpen: (mode & 0o077) !== 0 };
  } catch {
    return null;
  }
}

/** 规范化面板地址：补协议、去尾斜杠，拒绝带路径的输入。 */
export function normalizeBaseUrl(input, { allowInsecure = false } = {}) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new ConfigError('面板地址不能为空');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try { url = new URL(withScheme); } catch { throw new ConfigError(`无法解析面板地址：${input}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ConfigError('面板地址必须以 http:// 或 https:// 开头');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('面板地址必须是纯域名（不要带路径、查询串）');
  }
  if (url.username || url.password) throw new ConfigError('面板地址不能包含用户名或密码');
  const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !isLocal && !allowInsecure) {
    // 明文 HTTP 会把 Bearer 令牌暴露给链路上任何一跳。自签证书的内网面板
    // 用 --insecure 显式接受，默认拒绝是因为「静默降级」才是真危险。
    throw new ConfigError(
      '面板未启用 HTTPS；远程明文 HTTP 会泄露访问令牌。请配置 TLS，或加 --insecure 显式承担风险'
    );
  }
  return url.origin;
}

/**
 * 解析最终生效的连接参数。返回值中 token 可能为空（表示未登录）。
 * 注意这里绝不校验令牌格式——格式由服务端判定，客户端过早拒绝只会
 * 让令牌轮换/长度调整变得脆弱。
 */
export function resolveSettings({ flags = {}, env = process.env } = {}) {
  const stored = readConfig(env);
  const url = flags.url || env.CLOUDSSH_URL || stored.baseUrl || '';
  const token = flags.token || env.CLOUDSSH_TOKEN || stored.token || '';
  const insecure = flags.insecure === true
    || env.CLOUDSSH_INSECURE === '1'
    || stored.insecure === true;
  return {
    baseUrl: url ? normalizeBaseUrl(url, { allowInsecure: insecure }) : '',
    token: String(token || ''),
    insecure,
    source: flags.token ? 'flag' : env.CLOUDSSH_TOKEN ? 'env' : stored.token ? 'file' : 'none',
    configFile: configPath(env),
  };
}

/** 面板 URL 的默认值提示，用于错误文案。 */
export function defaultBaseUrlHint(env = process.env) {
  return env.CLOUDSSH_URL || `http://localhost:${DEFAULT_PORT}`;
}
