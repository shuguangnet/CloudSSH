// MCP 数据库工具。
//
// 与 SSH 工具的区别在于授权维度：SSH 工具按 server_id 授权，数据库按
// connection_id 授权（token 的 db_connection_ids 字段）。两者共用同一套
// scope（read/write）与审计通道，避免再引入一套权限模型。
//
// 安全边界（与 AGENTS.md 一致）：
//   - 绝不返回数据库密码；连接信息里只回 hasPassword。
//   - 审计只记 sql_sha256，不记 SQL 正文与结果集。
//   - 只读连接在发送到数据库之前就拦下写语句。
//   - 结果集按行数/列数/单元格长度硬性截断，避免把上下文打爆。

import { z } from 'zod';
import { createHash } from 'node:crypto';

import {
  queryDatabase, describeSchema, describeTable, testConnection,
  MAX_ROWS, MAX_QUERY_TIMEOUT_MS,
} from './database-client.mjs';
import { DEFAULT_PORTS } from './database-store.mjs';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const connectionIdSchema = z.number().int().positive();

/**
 * 把 store 里的连接配置转成「可以安全回显」的摘要。
 * 注意这里刻意不含 password / hasPassword=false 也照实返回，方便调用方判断。
 */
function summarizeConnection(config, proxy) {
  return {
    id: config.id,
    name: config.name,
    engine: config.engine,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    readOnly: config.readOnly,
    proxy: proxy ? { id: proxy.id, name: proxy.name, kind: proxy.kind } : null,
  };
}

/**
 * 注册数据库相关工具。
 *
 * @param {object} server McpServer 实例
 * @param {object} options
 * @param {object} options.store DatabaseStore
 * @param {object} options.identity 当前 token 的 identity
 * @param {Function} options.authorize (connectionId, scope) => void
 * @param {Function} options.audit (tool, connectionId, status, details) => void
 * @param {object} options.descriptions 工具描述表
 */
export function registerDatabaseTools(server, { store, identity, authorize, audit, descriptions }) {
  if (!store) return;
  const hasScope = (scope) => identity.scopes.includes(scope);

  /** 读取连接配置；连接不存在或未授权时不泄漏「存在但无权」这个信息差。 */
  const loadConnection = (id) => {
    authorize(id, null);
    try {
      return store.resolveConnection(id);
    } catch (error) {
      if (error.code === 'notFound') throw new Error(`Database connection ${id} not found`);
      throw error;
    }
  };

  const publicConnections = () => {
    const allowed = new Set(identity.db_connection_ids ?? []);
    return store.listConnections()
      .filter((connection) => allowed.has(connection.id))
      .map((connection) => {
        const proxy = connection.proxyId ? store.listProxies().find((item) => item.id === connection.proxyId) : null;
        return summarizeConnection(connection, proxy);
      });
  };

  /** 统一的工具包装：授权 → 前置校验 → 执行 → 审计。 */
  const tool = (name, scope, inputSchema, handler) => {
    if (scope && !hasScope(scope)) return;
    server.registerTool(name, {
      description: descriptions[name],
      inputSchema,
      annotations: {
        readOnlyHint: scope === 'read' || !scope,
        destructiveHint: scope === 'write',
        openWorldHint: false,
      },
    }, async (args) => {
      const connectionId = args.connection_id;
      let started = false;
      try {
        authorize(connectionId, scope);
        // 不需要连接的元工具（如 db_list_connections）没有 connection_id，
        // 这时不做解析；一旦解析失败就不能继续，否则会拿 undefined 去查库。
        const config = connectionId === undefined ? null : store.resolveConnection(connectionId);
        // 审计先写 started：与 SSH 工具一致，保证「有执行就有记录」。
        audit(name, connectionId, 'started', {
          ...(config ? { engine: config.engine, connection_name: config.name } : {}),
          ...(args.sql ? { sql_sha256: sha256(args.sql) } : {}),
          ...(args.table ? { table: args.table } : {}),
        });
        started = true;
        const data = await handler({ ...args, config });
        audit(name, connectionId, 'succeeded', {
          ...(config ? { engine: config.engine, connection_name: config.name } : {}),
          row_count: data?.rowCount ?? data?.rows?.length ?? null,
          duration_ms: data?.durationMs ?? null,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Operation failed';
        audit(name, connectionId, started ? 'failed' : 'denied', { error: message });
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    });
  };

  // ==================== 工具定义 ====================

  tool('db_list_connections', null, {}, async () => ({
    connections: publicConnections(),
    instruction: 'These are the database connections this token may use. Use db_query with connection_id.',
  }));

  tool('db_schema', 'read', {
    connection_id: connectionIdSchema,
    table: z.string().min(1).max(128).optional(),
    schema: z.string().max(128).optional(),
  }, async ({ config, table, schema }) => {
    if (table) {
      const columns = await describeTable(config, schema ?? '', table);
      return {
        connection: summarizeConnection(config, null),
        table,
        schema: schema ?? '',
        columns,
        instruction: 'Column list only; no row data was read.',
      };
    }
    const overview = await describeSchema(config);
    return {
      connection: summarizeConnection(config, null),
      engine: overview.engine,
      tables: overview.tables,
      note: overview.note,
      ...(overview.raw ? { raw: overview.raw } : {}),
      instruction: 'Use db_schema with table to inspect columns before writing SQL.',
    };
  });

  tool('db_query', 'read', {
    connection_id: connectionIdSchema,
    sql: z.string().min(1).max(100000),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(200).optional(),
    timeout_ms: z.number().int().min(1000).max(MAX_QUERY_TIMEOUT_MS).optional(),
  }, async ({ config, sql, params, timeout_ms }) => {
    const result = await queryDatabase(config, sql, params ?? [], { timeoutMs: timeout_ms });
    return {
      connection: summarizeConnection(config, null),
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      returnedRows: result.rows.length,
      durationMs: result.durationMs,
      truncated: result.rowCount > result.rows.length,
      // 脱敏是展示层兜底：告诉模型「你看到的不是全部原文」，避免它把
      // *** 当成真实值回写数据库。
      ...(result.redactedCells ? { redactedCells: result.redactedCells } : {}),
      instruction: [
        result.rowCount > result.rows.length
          ? `Only the first ${MAX_ROWS} rows were returned. Refine the query (WHERE/LIMIT) to read the rest.`
          : 'Values are already truncated per cell; large text shows a truncation marker.',
        result.redactedCells
          ? `${result.redactedCells} cell(s) matched a secret pattern (private key / token / password / connection string) and were masked as ***. The database still holds the original value — never write the masked text back.`
          : '',
      ].filter(Boolean).join(' '),
    };
  });

  tool('db_exec', 'write', {
    connection_id: connectionIdSchema,
    sql: z.string().min(1).max(100000),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(200).optional(),
    timeout_ms: z.number().int().min(1000).max(MAX_QUERY_TIMEOUT_MS).optional(),
  }, async ({ config, sql, params, timeout_ms }) => {
    // 即使连接本身是只读的，db_exec 也必须显式拒绝——否则「db_exec 能写」
    // 就成了一个绕过只读开关的后门。
    if (config.readOnly) {
      throw new Error(
        'This connection is marked read-only. Turn off its read-only flag in the panel to allow writes.',
      );
    }
    const result = await queryDatabase(config, sql, params ?? [], { timeoutMs: timeout_ms });
    return {
      connection: summarizeConnection(config, null),
      rowCount: result.rowCount,
      affectedRows: result.affectedRows ?? result.rowCount,
      durationMs: result.durationMs,
      instruction: 'Statement executed. Verify the effect with db_query before retrying.',
    };
  });

  tool('db_test', 'read', {
    connection_id: connectionIdSchema,
  }, async ({ config }) => {
    const result = await testConnection(config);
    return {
      connection: summarizeConnection(config, null),
      ok: result.ok,
      durationMs: result.durationMs,
      probe: result.rows,
      instruction: 'A successful probe means TCP, proxy and authentication all work.',
    };
  });

  return { defaultPorts: DEFAULT_PORTS };
}

export const databaseDescriptions = {
  db_list_connections: 'List the database connections authorized for this token (no passwords). Requires no scope.',
  db_schema: 'Inspect a database schema: table list, or column definitions for one table. Requires read scope.',
  db_query: 'Run a read-only SQL statement (or Redis command) on an authorized connection. Results are truncated by row/column/cell limits. Requires read scope.',
  db_exec: 'Run a write statement on an authorized connection that is NOT marked read-only. Requires write scope. Do not blindly retry after an uncertain failure.',
  db_test: 'Probe an authorized connection (TCP + proxy + authentication) without running business SQL. Requires read scope.',
};
