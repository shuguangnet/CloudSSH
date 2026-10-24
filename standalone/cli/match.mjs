/**
 * 快捷匹配：把 `cssh prod` 变成「连到那台 prod 服务器」。
 *
 * 设计要点（决定「快捷」是否成立）：
 *   - 匹配置信度分级，而不是「有交集就算命中」。唯一命中直接连，
 *     多命中给预筛过的选择器，零命中给最近似的候选。**永不猜测。**
 *   - 分级顺序：id 全等 > 名称全等 > 别名 > 名称前缀 > 主机前缀 >
 *     标签全等 > 名称子串 > 主机子串 > os。
 *   - 大小写不敏感；下划线/空格视作等价的单词分隔，这样 `prod_web`
 *     和 `prod web` 都能命中 `prod-web-01`。
 */

/** 归一化：小写、下划线/空白变连字符，便于跨命名习惯匹配。 */
export function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    // 首尾连字符必须剪掉：否则 `"  prod  "` 会变成 `-prod-`，
    // 与任何名称都不等，唯一命中判定永远不会成立。
    .replace(/^-+|-+$/g, '');
}

function haystack(server) {
  return {
    id: String(server.id),
    name: normalize(server.name),
    host: normalize(server.host),
    tags: (Array.isArray(server.tags) ? server.tags : []).map(normalize),
    os: normalize(server.os || ''),
    username: normalize(server.username || ''),
  };
}

/**
 * 对一个服务器算匹配等级。0 = 不匹配，数字越大越精确。
 * 返回 0 的条目根本不会进结果集，避免「搜索 prod 却列出全部」。
 */
function score(server, query, aliases) {
  const fields = haystack(server);
  if (fields.id === query) return 100;

  const aliasTargets = Object.entries(aliases)
    .filter(([alias]) => normalize(alias) === query)
    .map(([, target]) => normalize(target));
  if (aliasTargets.includes(fields.name) || aliasTargets.includes(fields.id)) return 95;

  if (fields.name === query) return 90;
  if (fields.name.startsWith(query)) return 80;
  if (fields.host.startsWith(query)) return 70;
  if (fields.tags.some((tag) => tag === query)) return 65;
  // `@tag` 写法：显式按标签查，避免与名字前缀歧义。
  if (query.startsWith('@') && fields.tags.includes(query.slice(1))) return 66;
  if (fields.name.includes(query)) return 50;
  if (fields.host.includes(query)) return 45;
  if (fields.username === query) return 40;
  if (fields.os && fields.os.includes(query)) return 30;
  if (fields.tags.some((tag) => tag.includes(query))) return 25;
  return 0;
}

/**
 * 匹配服务器。
 * @returns {{ exact: object|null, matches: object[], bestScore: number }}
 *   exact    —— 唯一最高分命中（可直接连接）
 *   matches  —— 按分数降序的候选（含 exact）
 */
export function matchServers(servers, query, { aliases = {} } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const raw = String(query ?? '').trim();
  if (!raw) return { exact: null, matches: list, bestScore: 0 };

  const normalized = normalize(raw);
  const scored = list
    .map((server) => ({ server, value: score(server, normalized, aliases) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value || String(a.server.name).localeCompare(String(b.server.name)));

  const bestScore = scored[0]?.value ?? 0;
  // 只有「唯一且足够精确」的命中才算 exact。两种独占：
  //   1. 只有一个候选；
  //   2. 只有一个候选拿到最高分（例如两台名字前缀相同但一台全等）。
  const top = scored.filter((entry) => entry.value === bestScore);
  const exact = top.length === 1 && bestScore >= 50 ? top[0].server : null;

  return { exact, matches: scored.map((entry) => entry.server), bestScore };
}

/**
 * 零命中时的近似建议：按编辑距离找最近的几个，用于「你是不是想连…」。
 * 不做模糊自动连接——猜错的代价是连错生产服务器。
 */
export function nearestServers(servers, query, limit = 3) {
  const normalized = normalize(query);
  if (!normalized) return [];
  const candidates = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    const fields = haystack(server);
    const distances = [
      editDistance(normalized, fields.name),
      editDistance(normalized, fields.host),
      ...fields.tags.map((tag) => editDistance(normalized, tag)),
    ];
    candidates.push({ server, distance: Math.min(...distances) });
  }
  return candidates
    .filter((entry) => entry.distance <= Math.max(2, Math.ceil(normalized.length / 2)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.server);
}

/** Levenshtein 距离（两行滚动数组，足够小）。 */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}
