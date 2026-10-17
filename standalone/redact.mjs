/**
 * 秘密脱敏：进模型上下文 / 浏览器之前的最后一道兜底。
 *
 * 这里的定位是**兜底**，不是主防线——密码本身没有理由出现在查询结果里。
 * 但运维经常查的是配置表、连接表、日志表，`SELECT * FROM app_config` 里
 * 坐着明文 `API_KEY=` 是常态，而查询结果会被 MCP 原样交给模型。
 *
 * 所以对**结果值**做模式脱敏，而不是对整段文本：命中就替换成固定标记，
 * 并在结果元信息里报告脱敏次数，让调用方知道「你看到的不是全部原文」，
 * 而不是静默改数据让人误判。
 *
 * 误伤是可接受的：这里只影响展示，数据库里的真实值不变。
 */

const RULES = [
  // PEM 私钥块（含 OpenSSH / RSA / EC / PGP 各类变体）
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    '*** 私钥已脱敏 ***'],
  // Authorization: Bearer xxx / token=xxx
  [/(authorization\s*[:=]\s*bearer\s+)\S+/gi, '$1***'],
  // KEY=VALUE 形态的口令与密钥。
  // 前缀允许标识符字符（DB_PASSWORD / MYSQL_PASSWORD 这类最常见），
  // 因此不能用 \b：下划线也是词字符，\bPASSWORD 不会在 DB_PASSWORD 里匹配。
  [/(?:^|[^A-Za-z0-9])((?:[A-Za-z0-9_]*(?:AWS_SECRET_ACCESS_KEY|API_KEY|APIKEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|SECRET|PASSWORD|PASSWD|PWD|PRIVATE_KEY)))\s*[=:]\s*[^\s'"]+/gi,
    '$1=***'],
  // 连接串里的口令：mysql://user:pass@host
  [/\b((?:mysql|mariadb|postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|amqp|clickhouse):\/\/[^\s:@/]+:)[^@\s/]+@/gi,
    '$1***@'],
  // OpenAI 风格密钥
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***'],
  // GitHub token
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh*_***'],
  // JWT（三段式 base64url）
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '*** JWT 已脱敏 ***'],
];

/**
 * 对单个值做脱敏。只处理字符串，其余类型原样返回。
 *
 * @param {unknown} value
 * @returns {{value: unknown, redacted: number}}
 */
export function redactValue(value) {
  if (typeof value !== 'string' || value === '') return { value, redacted: 0 };
  let text = value;
  let redacted = 0;
  for (const [pattern, replacement] of RULES) {
    pattern.lastIndex = 0;
    // 用 replace 的回调计数，避免 test() 的 lastIndex 状态问题。
    text = text.replace(pattern, (...args) => {
      redacted += 1;
      return typeof replacement === 'string'
        ? replacement.replace(/\$(\d)/g, (_, index) => args[Number(index)] ?? '')
        : replacement;
    });
  }
  return { value: text, redacted };
}

/**
 * 建一个带累计计数的脱敏器，供一次查询的多行结果复用。
 *
 * @returns {{redact: (value: unknown) => unknown, readonly count: number}}
 */
export function createRedaction() {
  let total = 0;
  return {
    redact(value) {
      const result = redactValue(value);
      total += result.redacted;
      return result.value;
    },
    get count() { return total; },
  };
}
