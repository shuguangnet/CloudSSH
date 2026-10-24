/**
 * SQL 词法安全闸门。
 *
 * 只读连接（`db_connections.read_only`）的写语句拦截**不能**靠正则匹配整串文本：
 * 正则看不见引号与注释的边界，于是下面这些都会漏过去——
 *
 *   - `WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x`
 *     PostgreSQL 合法的数据修改型 CTE，第一条 token 是 WITH，正则放行，数据真的没了；
 *   - `SELECT * FROM users INTO OUTFILE '/tmp/x'`
 *     往服务器磁盘写文件，动词是 SELECT；
 *   - `/*!50000 DROP TABLE users *​/`
 *     MySQL 可执行版本注释，服务端会**执行**注释里的内容，而所有注释剥除逻辑都会把它当噪声删掉；
 *   - `DE/**​/LETE FROM users`、`UP--x\nDATE ...`
 *     用注释把关键字拆开，服务端拼回一个词，正则只看得到碎片。
 *
 * 所以这里做真正的词法扫描：按引号、注释、dollar-quote 逐个切出裸词 token，
 * 再按语句（顶层 `;`）取动词、并检查任意深度上的写关键字。
 *
 * **双方言一致性**：反斜杠在 MySQL 默认模式下转义下一个字符，在 PostgreSQL
 * 普通字符串与 SQLite 里只是普通字符。同一段 `'a\'; DROP TABLE x --'` 在两种
 * 读法下语句边界完全不同，藏得住的写语句取决于你按谁解析。因此凡是含反斜杠
 * 的输入都按两种语义各扫一遍，只要有一遍暴露出写操作就拒绝，并提示用户改用
 * `''` 转义——那种写法在所有方言里含义一致。
 */

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const IDENT_START = /[A-Za-z_]/;
// 含 Unicode 字母之外还要接受 `$`（PG 允许），首字符单独判。
const IDENT_PART = /[A-Za-z0-9_$]/;

/** 破坏性动词：不可回滚或会停库，只读连接一律拒绝。 */
const DESTRUCTIVE_VERBS = new Set(['DROP', 'TRUNCATE', 'SHUTDOWN']);

/** 只读查询允许的起始动词。 */
const READONLY_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'VALUES', 'TABLE']);

/**
 * 只读语句里任何深度都不许出现的裸词。
 *
 * 裸词匹配在这里是安全的：这些全是保留字，真的叫 `update` 的列必须加引号，
 * 而引号内的内容被扫描器跳过了。
 *
 * `INTO` 覆盖 `SELECT ... INTO OUTFILE` / `INTO @var` / `SELECT ... INTO new_table`；
 * `SHARE`/`LOCK`/`FOR` 覆盖加锁读；`BEGIN`/`COMMIT`/`ROLLBACK`/`SET`/`CALL`/`DO`
 * 覆盖会话与存储过程副作用。
 */
const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'REPLACE', 'UPSERT',
  'CREATE', 'ALTER', 'DROP', 'RENAME', 'GRANT', 'REVOKE',
  'CALL', 'EXEC', 'EXECUTE', 'DO', 'SET', 'LOAD', 'HANDLER', 'INTO',
  'LOCK', 'UNLOCK', 'SHARE', 'OPTIMIZE', 'PURGE', 'FLUSH', 'RESET', 'KILL', 'SHUTDOWN',
  'PREPARE', 'DEALLOCATE', 'START', 'STOP', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  'ANALYZE', 'VACUUM', 'REINDEX', 'CLUSTER', 'REFRESH', 'COPY', 'MOVE', 'SWAPDB',
  'FLUSHDB', 'FLUSHALL', 'DEL', 'EXPIRE', 'PERSIST', 'RESTORE', 'MIGRATE',
]);

/**
 * Redis 命令白名单（动词即命令名，大小写不敏感）。
 *
 * Redis 没有 SQL 解析器，命令本身就是动词，因此按「只读命令白名单」判断
 * 比按写命令黑名单更可靠——未知的、新版本新增的、模块提供的命令一律拒绝。
 */
const REDIS_READONLY_COMMANDS = new Set([
  'GET', 'MGET', 'STRLEN', 'SUBSTR', 'GETRANGE', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
  'EXPIRE_TIME', 'KEYS', 'SCAN', 'RANDOMKEY', 'DBSIZE', 'SELECT_',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSTRLEN', 'HSCAN', 'HRANDFIELD',
  'LINDEX', 'LLEN', 'LRANGE', 'LPOS',
  'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SMEMBERS', 'SRANDMEMBER', 'SSCAN', 'SDIFF', 'SINTER', 'SUNION',
  'ZCARD', 'ZCOUNT', 'ZSCORE', 'ZMSCORE', 'ZRANGE', 'ZRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGE',
  'ZREVRANGEBYSCORE', 'ZREVRANGEBYLEX', 'ZRANK', 'ZREVRANK', 'ZSCAN', 'ZLEXCOUNT', 'ZDIFF', 'ZINTER', 'ZUNION', 'ZRANDMEMBER',
  'PFCOUNT', 'BITCOUNT', 'BITPOS', 'GETBIT', 'BITFIELD_RO',
  'GEOHASH', 'GEOPOS', 'GEODIST', 'GEOSEARCH', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO',
  'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO', 'XPENDING',
  'PING', 'ECHO', 'INFO', 'TIME', 'COMMAND', 'LOLWUT', 'MEMORY', 'OBJECT',
  'ACL', 'CLIENT', 'CONFIG', 'SLOWLOG', 'LATENCY', 'DEBUG',
  'LPOS', 'SINTERCARD', 'ZINTERCARD', 'FCALL_RO', 'SORT_RO', 'BITFIELD_RO',
]);

/** 子命令会写数据的只读父命令：`CONFIG GET` 安全、`CONFIG SET` 不安全。 */
const REDIS_SENSITIVE_PARENTS = new Set(['ACL', 'CLIENT', 'CONFIG', 'MEMORY', 'OBJECT', 'COMMAND', 'XINFO', 'DEBUG', 'SLOWLOG', 'LATENCY']);
const REDIS_READONLY_SUBCOMMANDS = new Set(['GET', 'LIST', 'COUNT', 'HELP', 'INFO', 'USAGE', 'WHOAMI', 'ID', 'DOCTOR', 'STATS', 'LEN', 'ENCODING', 'REFCOUNT', 'IDLETIME', 'FREQ', 'GETKEYS', 'GETNAME', 'GETREDIR', 'RESET']);

/**
 * 同时是 Redis 只读命令与 SQL 只读动词的词。
 *
 * `TABLE`/`VALUES` 这类词在 Redis 里也存在，判定时优先当 SQL，
 * 避免把 `TABLE users` 当成未知 Redis 命令而误拦。
 */
export const SQL_READONLY_VERBS_FOR_DETECT = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'VALUES', 'TABLE']);

export { REDIS_READONLY_COMMANDS };

/**
 * PG 里的 `E'...'` 转义字符串：紧邻引号的**孤立** e/E token 才开启反斜杠转义。
 * 更长标识符结尾的 E（如 `freqE'...'`）在两种方言里都是普通字符串。
 */
function isEscapeStringPrefix(sql, quoteIndex) {
  const e = quoteIndex - 1;
  if (e < 0 || (sql[e] !== 'e' && sql[e] !== 'E')) return false;
  return e === 0 || !IDENT_PART.test(sql[e - 1]);
}

/**
 * 扫描 SQL，返回按顶层 `;` 切开的语句数组，每项含裸词 token。
 *
 * @param {string} sql
 * @param {{escapes?: boolean}} options escapes=true 按 MySQL 认反斜杠转义；false 按 PG/SQLite 字面量
 * @returns {Array<{tokens: Array<{word: string, raw: string, depth: number, isCall: boolean}>}>}
 */
function scanTokens(sql, { escapes = true } = {}) {
  const statements = [];
  let current = null;
  const n = sql.length;
  let i = 0;
  let depth = 0;

  const closeStatement = () => {
    if (current && current.tokens.length > 0) statements.push(current);
    current = null;
    depth = 0;
  };
  const push = (word, raw, isCall = false) => {
    if (!current) current = { tokens: [] };
    current.tokens.push({ word, raw, depth, isCall });
  };

  while (i < n) {
    const ch = sql[i];
    if (WHITESPACE.has(ch)) { i++; continue; }

    // -- 行注释（MySQL 还要求 -- 后跟空白，但更严格地一律当注释只会让我们多跳过、
    // 不构成漏判风险，因为跳过的内容不会被执行）
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // # 行注释（MySQL）
    if (ch === '#') {
      i += 1;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      // MySQL 可执行注释 /*!50000 ... */ 会被服务端**执行**，必须当 SQL 解析；
      // 普通注释与优化器提示 /*+ ... */ 才是真正可以跳过的。
      if (sql[i + 2] === '!') {
        i += 3;
        while (i < n && sql[i] >= '0' && sql[i] <= '9') i++;
        continue;
      }
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // PG dollar-quoting：$$...$$ 或 $tag$...$tag$ 内容是字面量。
    // tag 必须为空或标识符形态（不能以数字开头），因此 $1 占位符不会误匹配。
    if (ch === '$') {
      const opener = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 128));
      if (opener !== null) {
        const close = sql.indexOf(opener[0], i + opener[0].length);
        i = close === -1 ? n : close + opener[0].length;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      // PG E'' 在两种读法下都保留反斜杠转义。
      const stringEscapes = escapes || (quote === "'" && isEscapeStringPrefix(sql, i));
      i++;
      while (i < n) {
        const c = sql[i];
        if (stringEscapes && c === '\\') { i += 2; continue; }
        if (c === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ';') { closeStatement(); i++; continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    // 点与逗号对关键字闸门是空操作，但保留它们能让 destruct 目标解析与
    // 限定标识符判断拿到真实结构。
    if (ch === '.' || ch === ',') { push(ch, ch); i++; continue; }

    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < n && IDENT_PART.test(sql[j])) j++;
      let k = j;
      while (k < n && WHITESPACE.has(sql[k])) k++;
      const isCall = sql[k] === '(';
      push(sql.slice(i, j).toUpperCase(), sql.slice(i, j), isCall);
      i = j;
      continue;
    }
    i++;
  }
  closeStatement();
  return statements;
}

/**
 * 按两种字符串语义各扫一遍，报告是否分歧。
 * 不含反斜杠时两种读法不可能不同，直接复用第一遍结果。
 */
function scanTokensBoth(sql) {
  const primary = scanTokens(sql);
  if (!sql.includes('\\')) return { primary, literal: primary, diverges: false };
  const literal = scanTokens(sql, { escapes: false });
  return { primary, literal, diverges: JSON.stringify(primary) !== JSON.stringify(literal) };
}

/** 收集所有顶层语句的第一个动词。 */
function statementVerbs(sql) {
  return scanTokens(sql)
    .map((stmt) => (stmt.tokens[0] && stmt.tokens[0].depth === 0 ? stmt.tokens[0].word : null))
    .filter((verb) => verb !== null);
}

/**
 * 写语句识别：给只读连接用的闸门。
 *
 * 判定顺序：多语句 → 破坏性动词 → 双方言分歧 → 首动词非只读 → 任意深度写关键字。
 *
 * @param {string} sql
 * @param {{engine?: string}} options engine='redis' 时按 Redis 命令白名单判断
 * @returns {boolean}
 */
export function isWriteStatement(sql, { engine } = {}) {
  if (typeof sql !== 'string' || sql.trim() === '') return false;
  if (engine === 'redis') return isWriteCommand(sql);
  // 未指定引擎时的兼容路径：调用方可能直接传 Redis 命令（历史上就是这么用的）。
  // 首词命中 Redis 只读命令、又不是 SQL 只读动词时，按 Redis 白名单判。
  // 写命令（SET/DEL/...）两种判法都返回 true，所以这里只影响「只读命令被误拦」。
  if (engine === undefined && looksLikeRedisCommand(sql)) return isWriteCommand(sql);
  return assessSql(sql) !== null;
}

/** 是否像一个 Redis 命令（首词命中 Redis 只读命令且非 SQL 只读动词）。 */
function looksLikeRedisCommand(sql) {
  const text = String(sql).trim();
  if (text.includes(';')) return false;
  const first = text.split(/\s+/, 1)[0]?.toUpperCase() ?? '';
  return REDIS_READONLY_COMMANDS.has(first) && !SQL_READONLY_VERBS_FOR_DETECT.has(first);
}

/**
 * Redis 命令判定。
 *
 * 参数既可以是命令数组（`['SET','k','v']`），也可以是字符串命令。由于
 * `queryDatabase` 允许数组直接作为 params，这里只看命令名本身。
 *
 * @param {string|string[]} command
 * @returns {boolean} true = 写命令
 */
export function isWriteCommand(command) {
  const parts = Array.isArray(command)
    ? command.map((part) => String(part))
    : String(command).trim().split(/\s+/);
  const name = (parts[0] || '').toUpperCase();
  if (name === '') return false;
  if (!REDIS_READONLY_COMMANDS.has(name)) return true;
  // 只读父命令 + 写子命令（CONFIG SET / CLIENT KILL / ACL SETUSER …）
  if (REDIS_SENSITIVE_PARENTS.has(name)) {
    const sub = (parts[1] || '').toUpperCase();
    if (sub !== '' && !REDIS_READONLY_SUBCOMMANDS.has(sub)) return true;
  }
  return false;
}

/**
 * 返回拒绝原因；允许执行时返回 null。
 *
 * 之所以返回原因而不是布尔值，是因为被拦下来的用户需要知道**为什么**——
 * 尤其反斜杠引号那一条，用户看不出自己的 SQL 在另一种方言下有不同含义。
 *
 * @param {string} sql
 * @returns {string|null}
 */
export function assessSql(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return null;

  const { primary, diverges } = scanTokensBoth(sql);

  // 多语句：只读连接一律拒绝。哪怕每句都是 SELECT，多语句也意味着
  // 可能夹带会话状态修改，而协议层对多语句的返回形状也不一致。
  if (primary.length > 1) {
    return '只读连接不允许一次执行多条语句（检测到 {count} 条），请分开执行。'.replace('{count}', String(primary.length));
  }

  // 双方言分歧：不猜哪种语义生效，要求改成所有方言含义一致的写法。
  if (diverges) {
    const literal = scanTokens(sql, { escapes: false });
    for (const stmt of [...primary, ...literal]) {
      const first = stmt.tokens[0];
      if (!first || first.depth !== 0) continue;
      if (WRITE_KEYWORDS.has(first.word) || !READONLY_VERBS.has(first.word)) {
        return '语句中的反斜杠引号（\\\' 等）使边界在 MySQL 与 PostgreSQL/SQLite 间存在歧义，'
          + '且其中一种读法下是写操作。请改用 \'\' 双写引号转义后重试。';
      }
    }
    // 分歧但两种读法都只读到只读语句：保守起见仍然拒绝，因为无法确知
    // 服务端会怎么切分。
    return '语句中的反斜杠引号（\\\' 等）使边界在 MySQL 与 PostgreSQL/SQLite 间存在歧义。'
      + '请改用 \'\' 双写引号转义后重试。';
  }

  const stmt = primary[0];
  if (!stmt) return null;
  const verb = stmt.tokens[0].word;

  if (DESTRUCTIVE_VERBS.has(verb)) {
    return `只读连接拒绝执行 ${verb}（不可回滚或会停库）。如确需执行，请关闭该连接的「只读」开关。`;
  }
  if (!READONLY_VERBS.has(verb)) {
    return `只读连接只允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 开头的查询，收到的是 ${verb}。`
      + '如确需写入，请关闭该连接的「只读」开关。';
  }

  // 任意深度的写关键字——这一条挡住 WITH 数据修改型 CTE
  // （`WITH x AS (DELETE ...) SELECT * FROM x`）与 SELECT INTO OUTFILE。
  for (const token of stmt.tokens) {
    if (token.word === 'CREATE' && verb === 'SHOW') continue; // SHOW CREATE TABLE
    if (token.word === 'REPLACE' && token.isCall) continue;   // REPLACE(str, a, b) 字符串函数
    if (token.word === 'ANALYZE' && verb === 'EXPLAIN') continue; // EXPLAIN ANALYZE
    if (token.word === 'TABLE' && verb === 'SHOW') continue;   // SHOW TABLES
    if (WRITE_KEYWORDS.has(token.word)) {
      return `只读连接拒绝执行：查询中出现 ${token.word}`
        + '（常见于数据修改型 CTE 或 SELECT ... INTO）。如确需写入，请关闭该连接的「只读」开关。';
    }
  }
  return null;
}

/** 供测试与文档使用：解析出的顶层动词序列。 */
export function sqlStatementVerbs(sql) {
  return statementVerbs(sql);
}
