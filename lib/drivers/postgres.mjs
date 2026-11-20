/**
 * PostgreSQL protocol driver (npm: pg), shared by PostgreSQL / Kingbase / Vastbase /
 * openGauss / GaussDB / Redshift.
 *
 * read-only: `SET default_transaction_read_only = on` after connecting, each query wrapped in `BEGIN READ ONLY ... ROLLBACK`;
 * dry-run: `BEGIN ... ROLLBACK` to see affected rows; write: execute directly.
 * Time columns are fetched as text, so the driver does not turn timestamp into a local Date and then UTC and shift the instant.
 */

import { result, elapsedMs, toSqlLike } from './shared.mjs';

const TEXT_TIME_OIDS = new Set([1082, 1083, 1114, 1184, 1266]);

export async function create(conn, options = {}) {
  const imported = await options.loadPackage('pg');
  const pg = imported.default ?? imported;
  const Client = pg.Client ?? imported.Client;
  if (typeof Client !== 'function') throw new Error('Failed to load pg: Client not found (reinstall with `dbcli drivers install postgres`)');

  const types = {
    getTypeParser(oid, format) {
      if (format === 'text' && TEXT_TIME_OIDS.has(oid)) return (value) => value;
      return pg.types.getTypeParser(oid, format);
    },
  };

  const client = new Client({
    host: conn.host,
    port: conn.port ?? 5432,
    user: conn.user,
    password: conn.password,
    database: conn.database || undefined,
    ssl: conn.ssl ? { rejectUnauthorized: !options.insecureTls } : undefined,
    connectionTimeoutMillis: options.timeoutMs ?? 10000,
    statement_timeout: options.timeoutMs ?? 60000,
    application_name: 'dbcli',
    types,
  });

  let connected = false;
  let sessionReadOnly = false;

  async function ensure() {
    if (connected) return client;
    await client.connect();
    connected = true;
    if (!options.allowWrite) {
      try {
        await client.query('SET default_transaction_read_only = on');
        sessionReadOnly = true;
      } catch {
        /* ignore */
      }
    }
    return client;
  }

  async function run(sql, params = [], { mode = 'read' } = {}) {
    const instance = await ensure();
    const started = performance.now();
    const transactional = mode === 'read' || mode === 'dry-run';
    let res;
    if (transactional) {
      await instance.query(mode === 'read' ? 'BEGIN READ ONLY' : 'BEGIN');
      try {
        res = await instance.query(sql, params);
      } finally {
        try {
          await instance.query('ROLLBACK');
        } catch {
          /* the connection may be gone */
        }
      }
    } else {
      res = await instance.query(sql, params);
    }
    const fields = res.fields ?? [];
    const rows = (res.rows ?? []).map((row) => fields.map((field) => row[field.name]));
    return {
      columns: fields.map((field) => field.name),
      rows,
      durationMs: elapsedMs(started),
      affectedRows: typeof res.rowCount === 'number' ? res.rowCount : undefined,
      command: res.command,
    };
  }

  async function currentSchema() {
    const { rows } = await run('SELECT current_schema()', [], { mode: 'read' });
    return conn.schema || rows?.[0]?.[0] || 'public';
  }

  return {
    type: 'postgres',

    async ping() {
      const started = performance.now();
      const { rows } = await run(
        `SELECT version(), current_database(), current_user,
                inet_server_addr()::text, current_setting('server_version_num'), pg_is_in_recovery()`,
      );
      const row = rows?.[0] ?? [];
      const extra = {};
      try {
        const settings = await run(
          `SELECT name, setting FROM pg_settings WHERE name IN
             ('max_connections','shared_buffers','work_mem','effective_cache_size','default_transaction_read_only','TimeZone')`,
        );
        for (const item of settings.rows) extra[item[0]] = item[1];
      } catch {
        /* ignore */
      }
      try {
        extra.databaseSize = (await run('SELECT pg_size_pretty(pg_database_size(current_database()))')).rows?.[0]?.[0];
      } catch {
        /* ignore */
      }
      return {
        version: String(row[0] ?? 'unknown').split(',')[0],
        database: row[1] ?? null,
        user: row[2] ?? null,
        latencyMs: elapsedMs(started),
        extra: { ...extra, inRecovery: Boolean(row[5]), readOnlySession: sessionReadOnly },
      };
    },

    async query(sql, { mode = 'read' } = {}) {
      const outcome = await run(sql, [], { mode });
      return result(null, outcome.columns, outcome.rows, {
        durationMs: outcome.durationMs,
        affectedRows: outcome.affectedRows,
        notice: mode === 'dry-run' ? 'dry-run: executed and rolled back; no data changed' : undefined,
      });
    },

    async tables({ schema, pattern } = {}) {
      const conditions = [
        `c.relkind IN ('r','p','v','m','f')`,
        `n.nspname NOT IN ('pg_catalog','information_schema')`,
        `n.nspname NOT LIKE 'pg_toast%'`,
        `n.nspname NOT LIKE 'pg_temp%'`,
      ];
      const params = [];
      if (schema) {
        params.push(schema);
        conditions.push(`n.nspname = $${params.length}`);
      }
      if (pattern) {
        params.push(toSqlLike(pattern));
        conditions.push(`c.relname ILIKE $${params.length}`);
      }
      const { columns, rows, durationMs } = await run(
        `SELECT n.nspname AS schema, c.relname AS table,
                CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned'
                               WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview'
                               WHEN 'f' THEN 'foreign' ELSE c.relkind::text END AS type,
                c.reltuples::bigint AS est_rows,
                pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
                obj_description(c.oid, 'pg_class') AS comment
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE ${conditions.join(' AND ')}
          ORDER BY n.nspname, c.relname`,
        params,
        { mode: 'read' },
      );
      return result('Tables / views', columns, rows, { durationMs });
    },

    async describe(table, { schema } = {}) {
      const schemaName = schema || (await currentSchema());
      const { columns, rows, durationMs } = await run(
        `SELECT a.attnum AS "#", a.attname AS column,
                format_type(a.atttypid, a.atttypmod) AS type,
                CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS null,
                pg_get_expr(d.adbin, d.adrelid) AS default,
                CASE WHEN EXISTS (
                       SELECT 1 FROM pg_index i
                        WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
                     ) THEN 'PRI' ELSE '' END AS key,
                col_description(a.attrelid, a.attnum) AS comment
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [schemaName, table],
        { mode: 'read' },
      );
      if (!rows.length) throw new Error(`Table not found or no permission: ${schemaName}.${table} (use dbcli tables to list tables)`);
      return result(`Table structure ${schemaName}.${table}`, columns, rows, { durationMs });
    },

    async ddl(table, { schema } = {}) {
      const schemaName = schema || (await currentSchema());
      const columnsResult = await run(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum)
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [schemaName, table],
        { mode: 'read' },
      );
      if (!columnsResult.rows.length) throw new Error(`Table not found: ${schemaName}.${table}`);
      const indexResult = await run(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        [schemaName, table],
        { mode: 'read' },
      );
      const lines = columnsResult.rows.map((row) => {
        const parts = [`  "${row[0]}" ${row[1]}`];
        if (row[2]) parts.push('NOT NULL');
        if (row[3]) parts.push(`DEFAULT ${row[3]}`);
        if (row[4]) parts.push(`/* ${String(row[4]).replace(/\*\//g, '* /')} */`);
        return parts.join(' ');
      });
      const ddl = [`CREATE TABLE "${schemaName}"."${table}" (`, lines.join(',\n'), ');'];
      if (indexResult.rows.length) {
        ddl.push('');
        for (const row of indexResult.rows) ddl.push(`${row[1]};`);
      }
      return result(null, ['ddl'], [[ddl.join('\n')]], {
        notice: 'PostgreSQL has no SHOW CREATE TABLE: rebuilt here from metadata, indexes listed separately (the PK constraint is included among the indexes)',
      });
    },

    async indexes(table, { schema } = {}) {
      const schemaName = schema || (await currentSchema());
      const params = [schemaName];
      let condition = '';
      if (table) {
        params.push(table);
        condition = 'AND tablename = $2';
      }
      const { columns, rows, durationMs } = await run(
        `SELECT tablename AS "table", indexname AS index, indexdef AS definition
           FROM pg_indexes WHERE schemaname = $1 ${condition} ORDER BY tablename, indexname`,
        params,
        { mode: 'read' },
      );
      return result(`Indexes ${schemaName}`, columns, rows, { durationMs });
    },

    async locks() {
      const { columns, rows, durationMs } = await run(
        `SELECT a.pid, a.usename AS "user", a.datname AS database, a.state,
                a.wait_event_type, a.wait_event,
                array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by,
                ROUND(EXTRACT(EPOCH FROM (now() - a.query_start))::numeric, 1) AS seconds,
                LEFT(COALESCE(a.query, ''), 200) AS query
           FROM pg_stat_activity a
          WHERE cardinality(pg_blocking_pids(a.pid)) > 0
          ORDER BY seconds DESC NULLS LAST`,
        [],
        { mode: 'read' },
      );
      return result('Lock waits', columns, rows, { durationMs, notice: rows.length ? undefined : 'No lock waits at the moment' });
    },

    async slow({ limit = 20 } = {}) {
      const count = Number(limit) || 20;
      const modern = `SELECT LEFT(query, 300) AS query, calls,
                             ROUND(total_exec_time::numeric, 1) AS total_ms,
                             ROUND(mean_exec_time::numeric, 2) AS mean_ms, rows,
                             ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 2) AS cache_hit_pct
                        FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT ${count}`;
      const legacy = `SELECT LEFT(query, 300) AS query, calls,
                             ROUND(total_time::numeric, 1) AS total_ms,
                             ROUND(mean_time::numeric, 2) AS mean_ms, rows,
                             ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 2) AS cache_hit_pct
                        FROM pg_stat_statements ORDER BY total_time DESC LIMIT ${count}`;
      for (const sql of [modern, legacy]) {
        try {
          const { columns, rows, durationMs } = await run(sql, [], { mode: 'read' });
          return result('Top SQL (pg_stat_statements)', columns, rows, { durationMs });
        } catch (error) {
          if (!/pg_stat_statements|column .* does not exist/i.test(String(error.message))) throw error;
        }
      }
      throw new Error(
        'The pg_stat_statements extension is missing. A DBA must load it in shared_preload_libraries and run CREATE EXTENSION; ' +
          'as a stopgap, run `dbcli query "SELECT pid,state,LEFT(query,200) FROM pg_stat_activity ORDER BY query_start"` to see what is running.',
      );
    },

    async close() {
      if (connected) {
        try {
          await client.end();
        } catch {
          /* already disconnected */
        }
        connected = false;
      }
    },
  };
}
