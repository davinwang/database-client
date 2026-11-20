/**
 * SQL Server driver (npm: mssql / tedious).
 *
 * SQL Server has no session-level read-only transaction: read mode relies only on statement guards + read-only SQL, with no lock hints by default;
 * write executes directly (each statement commits implicitly); dry-run uses an explicit transaction, then rolls back and reports affected rows.
 * Parameters are always bound through request.input, never concatenated into strings.
 */

import { result, elapsedMs, buildDdl, toSqlLike } from './shared.mjs';

export async function create(conn, options = {}) {
  const imported = await options.loadPackage('mssql');
  const mssql = imported.default ?? imported;
  if (typeof mssql.ConnectionPool !== 'function') throw new Error('Failed to load mssql: ConnectionPool not found');

  const config = {
    server: conn.host,
    port: conn.port ?? 1433,
    user: conn.user,
    password: conn.password,
    database: conn.database || undefined,
    connectionTimeout: options.timeoutMs ?? 10000,
    requestTimeout: options.timeoutMs ?? 60000,
    options: {
      encrypt: conn.ssl ?? false,
      trustServerCertificate: Boolean(options.insecureTls),
      enableArithAbort: true,
      useUTC: true,
      appName: 'dbcli',
    },
    pool: { min: 0, max: 2, idleTimeoutMillis: 5000 },
  };

  let pool = null;
  async function ensure() {
    if (pool) return pool;
    pool = new mssql.ConnectionPool(config);
    pool.on('error', () => {});
    await pool.connect();
    return pool;
  }

  function toOutcome(res, started) {
    const recordset = res.recordset ?? [];
    const columns = recordset.length ? Object.keys(recordset[0]) : [];
    const rows = recordset.map((row) => columns.map((name) => row[name]));
    const affected = Array.isArray(res.rowsAffected) ? res.rowsAffected.reduce((sum, value) => sum + value, 0) : res.rowsAffected;
    return { columns, rows, durationMs: elapsedMs(started), affectedRows: typeof affected === 'number' ? affected : undefined };
  }

  async function run(sql, inputs = {}, { mode = 'read' } = {}) {
    const instance = await ensure();
    const started = performance.now();
    if (mode === 'dry-run') {
      const transaction = new mssql.Transaction(instance);
      await transaction.begin();
      try {
        const request = new mssql.Request(transaction);
        for (const [name, value] of Object.entries(inputs)) request.input(name, value);
        return toOutcome(await request.query(sql), started);
      } finally {
        try {
          await transaction.rollback();
        } catch {
          /* already rolled back / disconnected */
        }
      }
    }
    const request = instance.request();
    for (const [name, value] of Object.entries(inputs)) request.input(name, value);
    return toOutcome(await request.query(sql), started);
  }

  const defaultSchema = () => conn.schema || 'dbo';

  return {
    type: 'sqlserver',

    async ping() {
      const started = performance.now();
      const { rows } = await run(
        `SELECT @@VERSION AS version, DB_NAME() AS db, SUSER_SNAME() AS usr, SERVERPROPERTY('ServerName') AS server_name, SERVERPROPERTY('Edition') AS edition`,
      );
      const row = rows?.[0] ?? [];
      const extra = { edition: row[4] };
      try {
        const sessions = await run(`SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1`);
        extra.userSessions = sessions.rows?.[0]?.[0];
      } catch {
        /* insufficient privileges */
      }
      try {
        const db = await run(`SELECT state_desc, recovery_model_desc FROM sys.databases WHERE database_id = DB_ID()`);
        extra.databaseState = db.rows?.[0]?.[0];
        extra.recoveryModel = db.rows?.[0]?.[1];
      } catch {
        /* insufficient privileges */
      }
      return {
        version: String(row[0] ?? 'unknown').split('\n')[0],
        database: row[1] ?? null,
        user: row[2] ?? null,
        latencyMs: elapsedMs(started),
        extra,
      };
    },

    async query(sql, { mode = 'read' } = {}) {
      const outcome = await run(sql, {}, { mode });
      return result(null, outcome.columns, outcome.rows, {
        durationMs: outcome.durationMs,
        affectedRows: outcome.affectedRows,
        notice:
          mode === 'dry-run'
            ? 'dry-run: executed and rolled back; no data changed'
            : outcome.rows.length === 0
              ? 'Result is empty; the SQL Server driver cannot get column names from an empty result set (expected)'
              : undefined,
      });
    },

    async tables({ schema, pattern } = {}) {
      const inputs = {
        schema: schema || null,
        pattern: pattern ? toSqlLike(pattern) : null,
      };
      const { columns, rows, durationMs } = await run(
        `SELECT s.name AS [schema], o.name AS [table],
                CASE o.type WHEN 'U' THEN 'table' ELSE 'view' END AS [type],
                SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) AS [rows],
                CONVERT(varchar(10), o.modify_date, 120) AS modified
           FROM sys.objects o
           JOIN sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN sys.partitions p ON p.object_id = o.object_id
          WHERE o.type IN ('U', 'V')
            AND (@schema IS NULL OR s.name = @schema)
            AND (@pattern IS NULL OR o.name LIKE @pattern)
          GROUP BY s.name, o.name, o.type, o.modify_date
          ORDER BY s.name, o.name`,
        inputs,
      );
      return result('Tables / views', columns, rows, { durationMs });
    },

    async describe(table, { schema } = {}) {
      const schemaName = schema || defaultSchema();
      const inputs = { schema: schemaName, table };
      const { columns, rows, durationMs } = await run(
        `SELECT c.ORDINAL_POSITION AS [#], c.COLUMN_NAME AS [column],
                c.DATA_TYPE +
                  CASE WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL AND c.CHARACTER_MAXIMUM_LENGTH > 0
                       THEN '(' + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN 'max' ELSE CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(10)) END + ')'
                       WHEN c.DATA_TYPE IN ('decimal','numeric') THEN '(' + CAST(c.NUMERIC_PRECISION AS varchar(10)) + ',' + CAST(c.NUMERIC_SCALE AS varchar(10)) + ')'
                       ELSE '' END AS [type],
                c.IS_NULLABLE AS [null], c.COLUMN_DEFAULT AS [default],
                CASE WHEN EXISTS (
                  SELECT 1 FROM sys.indexes i
                    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    JOIN sys.columns sc ON sc.object_id = ic.object_id AND sc.column_id = ic.column_id
                   WHERE i.is_primary_key = 1 AND sc.name = c.COLUMN_NAME
                     AND i.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME))
                ) THEN 'PRI' ELSE '' END AS [key]
           FROM INFORMATION_SCHEMA.COLUMNS c
          WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
          ORDER BY c.ORDINAL_POSITION`,
        inputs,
      );
      if (!rows.length) throw new Error(`Table not found or no permission: ${schemaName}.${table} (use dbcli tables to list tables)`);
      return result(`Table structure ${schemaName}.${table}`, columns, rows, { durationMs });
    },

    async ddl(table, { schema } = {}) {
      const schemaName = schema || defaultSchema();
      const described = await this.describe(table, { schema: schemaName });
      const columns = described.rows.map((row) => ({
        name: row[1],
        type: row[2],
        nullable: row[3] === 'YES',
        default: row[4],
      }));
      const indexResult = await this.indexes(table, { schema: schemaName }).catch(() => ({ rows: [] }));
      const ddl = buildDdl({
        engine: 'sqlserver',
        schema: schemaName,
        table,
        columns,
        primaryKey: described.rows.filter((row) => row[5] === 'PRI').map((row) => row[1]),
        indexes: indexResult.rows.map((row) => ({ text: `${row[1]} (${row[3]})` })),
      });
      return result(null, ['ddl'], [[ddl]], { notice: 'SQL Server has no SHOW CREATE TABLE: rebuilt from metadata (constraint names/default details may be simplified)' });
    },

    async indexes(table, { schema } = {}) {
      const schemaName = schema || defaultSchema();
      const inputs = { schema: schemaName, table: table || null };
      const { columns, rows, durationMs } = await run(
        `SELECT OBJECT_NAME(i.object_id) AS [table], i.name AS [index],
                CASE WHEN i.is_primary_key = 1 THEN 'PK' WHEN i.is_unique = 1 THEN 'UNIQUE' ELSE '' END AS [unique],
                STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS [columns],
                i.type_desc AS [type]
           FROM sys.indexes i
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           JOIN sys.objects o ON o.object_id = i.object_id
           JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE i.name IS NOT NULL AND s.name = @schema AND (@table IS NULL OR o.name = @table)
          GROUP BY i.object_id, i.name, i.is_primary_key, i.is_unique, i.type_desc
          ORDER BY [table], [index]`,
        inputs,
      );
      return result(`Indexes ${schemaName}`, columns, rows, { durationMs });
    },

    async locks() {
      const { columns, rows, durationMs } = await run(
        `SELECT r.session_id AS waiting_id, r.blocking_session_id AS blocking_id,
                r.wait_type, r.wait_time AS wait_ms, r.wait_resource,
                DB_NAME(r.database_id) AS [db], LEFT(COALESCE(st.text, ''), 200) AS [query]
           FROM sys.dm_exec_requests r
           OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st
          WHERE r.blocking_session_id <> 0
          ORDER BY r.wait_time DESC`,
      );
      return result('Lock waits', columns, rows, { durationMs, notice: rows.length ? undefined : 'No lock waits at the moment' });
    },

    async slow({ limit = 20 } = {}) {
      const count = Number(limit) || 20;
      const { columns, rows, durationMs } = await run(
        `SELECT TOP (${count}) LEFT(COALESCE(st.text, ''), 300) AS [query],
                qs.execution_count AS calls,
                CAST(qs.total_elapsed_time / 1000.0 AS decimal(18, 1)) AS total_ms,
                CAST(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000.0 AS decimal(18, 2)) AS avg_ms,
                qs.total_worker_time / 1000 AS cpu_ms, qs.total_logical_reads AS reads,
                CONVERT(varchar(19), qs.last_execution_time, 120) AS last_exec
           FROM sys.dm_exec_query_stats qs
           OUTER APPLY sys.dm_exec_sql_text(qs.sql_handle) st
          ORDER BY qs.total_elapsed_time DESC`,
      );
      return result('Top SQL (sys.dm_exec_query_stats)', columns, rows, { durationMs });
    },

    async close() {
      if (pool) {
        try {
          await pool.close();
        } catch {
          /* already closed */
        }
        pool = null;
      }
    },
  };
}
