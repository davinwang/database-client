/**
 * Driver for MySQL / MariaDB / TiDB / TDSQL / PolarDB / GoldenDB / OceanBase (MySQL protocol).
 *
 * Three modes (chosen by the command layer):
 * - read: `SET SESSION TRANSACTION READ ONLY` + each query wrapped in `START TRANSACTION READ ONLY ... ROLLBACK`;
 * - write: execute directly (no read-only session);
 * - dry-run: `START TRANSACTION` → execute → `ROLLBACK`, report affected rows only, leave no trace.
 *
 * OceanBase Oracle mode: the protocol is still MySQL, but the dialect is Oracle (uppercase identifiers, ROWNUM row limit,
 * ALL_TABLES/ALL_TAB_COLUMNS data dictionary); open it with `dialect=oracle` (DB_OB_MODE=oracle).
 */

import { result, elapsedMs, quoteIdent, buildDdl, toSqlLike } from './shared.mjs';
import { UnsupportedError } from '../errors.mjs';

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys', 'oceanbase'];

export async function create(conn, options = {}) {
  const imported = await options.loadPackage('mysql2/promise');
  const mysql = imported.default ?? imported;
  if (typeof mysql.createConnection !== 'function') throw new Error('Failed to load mysql2: createConnection not found (reinstall with `dbcli drivers install mysql`)');

  const oracleDialect = conn.type === 'oceanbase' && /oracle/i.test(String(conn.dialect ?? ''));
  const engine = oracleDialect ? 'oracle' : 'mysql';
  const isOceanBase = conn.type === 'oceanbase';

  const config = {
    host: conn.host,
    port: conn.port ?? (isOceanBase ? 2881 : 3306),
    user: conn.user,
    password: conn.password,
    database: conn.database || undefined,
    connectTimeout: options.timeoutMs ?? 10000,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    rowsAsArray: true,
    ssl: conn.ssl ? { rejectUnauthorized: !options.insecureTls } : undefined,
  };

  let connection = null;
  let sessionReadOnly = false;

  async function ensure() {
    if (connection) return connection;
    connection = await mysql.createConnection(config);
    if (!options.allowWrite) {
      try {
        await connection.query('SET SESSION TRANSACTION READ ONLY');
        sessionReadOnly = true;
      } catch {
        /* Proxy or old version does not support it; rely on statement guards */
      }
    }
    return connection;
  }

  async function run(sql, params = [], { mode = 'read' } = {}) {
    const client = await ensure();
    const started = performance.now();
    let payload;
    const transactional = mode === 'read' || mode === 'dry-run';
    if (transactional) {
      await client.query(mode === 'read' ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
      try {
        payload = await client.query(sql, params);
      } finally {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the connection may be gone */
        }
      }
    } else {
      payload = await client.query(sql, params);
    }
    const [rows, fields] = payload;
    const columns = (fields ?? []).map((field) => field.name);
    const rowList = Array.isArray(rows) ? rows : [];
    const affectedRows = Array.isArray(rows) ? undefined : Number(rows?.affectedRows ?? 0);
    return { columns, rows: rowList, durationMs: elapsedMs(started), affectedRows };
  }

  async function currentSchema() {
    if (conn.schema) return conn.schema;
    if (conn.database) return conn.database;
    const sql = oracleDialect ? "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS s FROM dual" : 'SELECT DATABASE() AS db';
    const { rows } = await run(sql, [], { mode: 'read' });
    return rows?.[0]?.[0] ?? null;
  }

  async function requireSchema(schema) {
    const name = schema || (await currentSchema());
    if (!name) throw new Error('No default database on this connection: pass --schema <name>, or include a database in the connection string');
    return oracleDialect ? String(name).toUpperCase() : String(name);
  }

  async function primaryKeys(schema, table) {
    if (!oracleDialect) {
      const { rows } = await run(
        `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
        [schema, table],
        { mode: 'read' },
      );
      return rows.map((row) => row[0]);
    }
    const { rows } = await run(
      `SELECT acc.column_name
         FROM all_constraints ac
         JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
        WHERE ac.constraint_type = 'P' AND ac.owner = ? AND ac.table_name = ?
        ORDER BY acc.position`,
      [schema, table],
      { mode: 'read' },
    );
    return rows.map((row) => row[0]);
  }

  return {
    type: conn.type,

    async ping() {
      const started = performance.now();
      const versionSql = oracleDialect ? 'SELECT banner FROM v$version WHERE ROWNUM = 1' : 'SELECT VERSION() AS version';
      const base = await run(oracleDialect ? versionSql : `SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS user`, [], { mode: 'read' });
      const version = String(base.rows?.[0]?.[0] ?? 'unknown');
      const extra = {};
      if (!oracleDialect) {
        extra.database = base.rows?.[0]?.[1] ?? null;
        extra.user = base.rows?.[0]?.[2] ?? null;
      }
      try {
        const variables = await run(
          `SHOW VARIABLES WHERE Variable_name IN ('max_connections','transaction_isolation','tx_isolation','hostname','version_comment','ob_compatibility_mode')`,
          [],
          { mode: 'read' },
        );
        for (const row of variables.rows) extra[row[0]] = row[1];
      } catch {
        /* ignore */
      }
      if (!oracleDialect) {
        try {
          const status = await run(`SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running')`, [], { mode: 'read' });
          for (const row of status.rows) extra[row[0]] = row[1];
        } catch {
          /* ignore */
        }
      }
      return {
        version,
        database: extra.database ?? conn.database ?? null,
        user: extra.user ?? conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra: { ...extra, dialect: oracleDialect ? 'oracle' : 'mysql', readOnlySession: sessionReadOnly },
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
      if (oracleDialect) {
        const owner = await requireSchema(schema);
        const params = [owner];
        let condition = '';
        if (pattern) {
          condition = 'AND table_name LIKE ?';
          params.push(toSqlLike(pattern).toUpperCase());
        }
        const { columns, rows, durationMs } = await run(
          `SELECT owner AS "schema", table_name AS "table", num_rows AS "rows",
                  ROUND(blocks * 8 / 1024, 1) AS size_mb, last_analyzed
             FROM all_tables WHERE owner = ? ${condition} ORDER BY table_name`,
          params,
          { mode: 'read' },
        );
        return result(`Tables (owner=${owner})`, columns, rows, { durationMs });
      }
      const conditions = [];
      const params = [];
      if (schema) {
        conditions.push('TABLE_SCHEMA = ?');
        params.push(schema);
      } else {
        conditions.push(`TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(',')})`);
        params.push(...SYSTEM_SCHEMAS);
      }
      if (pattern) {
        conditions.push('TABLE_NAME LIKE ?');
        params.push(toSqlLike(pattern));
      }
      const { columns, rows, durationMs } = await run(
        `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS \`table\`, TABLE_TYPE AS \`type\`,
                TABLE_ROWS AS \`rows\`, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS size_mb,
                TABLE_COMMENT AS comment
           FROM information_schema.TABLES
          WHERE ${conditions.join(' AND ')}
          ORDER BY TABLE_SCHEMA, TABLE_NAME`,
        params,
        { mode: 'read' },
      );
      return result('Tables / views', columns, rows, { durationMs });
    },

    async describe(table, { schema } = {}) {
      const database = await requireSchema(schema);
      const tableName = oracleDialect ? String(table).toUpperCase() : table;
      let columns;
      let rows;
      let durationMs;
      if (oracleDialect) {
        ({ columns, rows, durationMs } = await run(
          `SELECT c.column_id AS "#", c.column_name AS "column",
                  c.data_type AS "type", c.nullable AS "null", c.data_default AS "default",
                  cc.comments AS "comment"
             FROM all_tab_columns c
             LEFT JOIN all_col_comments cc
               ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
            WHERE c.owner = ? AND c.table_name = ?
            ORDER BY c.column_id`,
          [database, tableName],
          { mode: 'read' },
        ));
        const pk = await primaryKeys(database, tableName);
        rows = rows.map((row) => [...row, pk.includes(row[1]) ? 'PRI' : '']);
        columns = [...columns, 'key'];
      } else {
        ({ columns, rows, durationMs } = await run(
          `SELECT ORDINAL_POSITION AS \`#\`, COLUMN_NAME AS \`column\`, COLUMN_TYPE AS \`type\`,
                  IS_NULLABLE AS \`null\`, COLUMN_DEFAULT AS \`default\`, COLUMN_KEY AS \`key\`,
                  EXTRA AS extra, COLUMN_COMMENT AS comment
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION`,
          [database, table],
          { mode: 'read' },
        ));
      }
      if (!rows.length) throw new Error(`Table not found or no permission: ${database}.${tableName} (use dbcli tables to list tables)`);
      return result(`Table structure ${database}.${tableName}`, columns, rows, { durationMs });
    },

    async ddl(table, { schema } = {}) {
      const database = await requireSchema(schema);
      if (!oracleDialect) {
        const { rows, durationMs } = await run(`SHOW CREATE TABLE ${quoteIdent('mysql', database)}.${quoteIdent('mysql', table)}`, [], { mode: 'read' });
        if (!rows.length) throw new Error(`Table not found: ${database}.${table}`);
        return result(null, ['ddl'], [[rows[0][1] ?? rows[0][0]]], { durationMs });
      }
      const tableName = String(table).toUpperCase();
      const described = await this.describe(tableName, { schema: database });
      const cols = described.rows.map((row) => ({ name: row[1], type: row[2], nullable: row[3] === 'Y', default: row[4] }));
      const indexes = await this.indexes(tableName, { schema: database }).catch(() => ({ rows: [] }));
      const pk = await primaryKeys(database, tableName);
      const ddl = buildDdl({
        engine: 'oracle',
        schema: database,
        table: tableName,
        columns: cols,
        primaryKey: pk,
        indexes: indexes.rows.map((row) => ({ text: `${row[1]} (${row[5]})` })),
      });
      return result(null, ['ddl'], [[ddl]], { notice: 'OceanBase Oracle mode rebuilds DDL from the data dictionary (partition/storage parameters excluded)' });
    },

    async indexes(table, { schema } = {}) {
      const database = await requireSchema(schema);
      if (!oracleDialect) {
        const params = [database];
        let tableCondition = '';
        if (table) {
          tableCondition = 'AND TABLE_NAME = ?';
          params.push(table);
        }
        const { columns, rows, durationMs } = await run(
          `SELECT TABLE_NAME AS \`table\`, INDEX_NAME AS \`index\`, IF(NON_UNIQUE = 0, 'UNIQUE', '') AS \`unique\`,
                  INDEX_TYPE AS type, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS \`columns\`
             FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = ? ${tableCondition}
            GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE
            ORDER BY TABLE_NAME, INDEX_NAME`,
          params,
          { mode: 'read' },
        );
        return result(`Indexes ${database}${table ? `.${table}` : ''}`, columns, rows, { durationMs });
      }
      const tableName = table ? String(table).toUpperCase() : null;
      const indexParams = tableName ? [database, tableName] : [database];
      const indexRows = await run(
        `SELECT index_name, uniqueness, index_type, status, table_name
           FROM all_indexes WHERE owner = ? ${tableName ? 'AND table_name = ?' : ''} ORDER BY table_name, index_name`,
        indexParams,
        { mode: 'read' },
      );
      const columnRows = await run(
        `SELECT index_name, column_name FROM all_ind_columns
          WHERE index_owner = ? ${tableName ? 'AND table_name = ?' : ''} ORDER BY index_name, column_position`,
        indexParams,
        { mode: 'read' },
      );
      const byIndex = new Map();
      for (const row of columnRows.rows) {
        const list = byIndex.get(row[0]) ?? [];
        list.push(row[1]);
        byIndex.set(row[0], list);
      }
      const rows = indexRows.rows.map((row) => [row[0], row[1], row[2], row[3], row[4], (byIndex.get(row[1]) ?? []).join(', ')]);
      return result(`Indexes (owner=${database})`, ['table', 'index', 'unique', 'type', 'status', 'columns'], rows, {
        durationMs: indexRows.durationMs + columnRows.durationMs,
      });
    },

    async locks() {
      if (isOceanBase) {
        throw new UnsupportedError('OceanBase lock waits are not exposed in the MySQL-compatible views', {
          hint: [
            'Use OceanBase views according to the tenant mode:',
            '  MySQL mode: SELECT * FROM oceanbase.gv$lock_wait_stat; (OB 4.x, requires the sys tenant or equivalent privileges)',
            '  Oracle mode: SELECT * FROM v$lock_wait_stat;',
            'You can also run `dbcli query "SHOW PROCESSLIST"` first to see who is running.',
          ].join('\n'),
        });
      }
      const primary = `SELECT r.trx_id AS \`waiting_trx\`, r.trx_mysql_thread_id AS \`waiting_thread\`,
                              LEFT(COALESCE(r.trx_query, ''), 200) AS \`waiting_query\`,
                              b.trx_id AS \`blocking_trx\`, b.trx_mysql_thread_id AS \`blocking_thread\`,
                              LEFT(COALESCE(b.trx_query, ''), 200) AS \`blocking_query\`,
                              TIMESTAMPDIFF(SECOND, r.trx_started, NOW()) AS \`wait_seconds\`
                         FROM performance_schema.data_lock_waits w
                         JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_engine_transaction_id
                         JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_engine_transaction_id
                        ORDER BY wait_seconds DESC`;
      try {
        const { columns, rows, durationMs } = await run(primary, [], { mode: 'read' });
        return result('Lock waits', columns, rows, { durationMs, notice: rows.length ? undefined : 'No lock waits at the moment' });
      } catch {
        const { columns, rows, durationMs } = await run(
          `SELECT r.trx_id AS \`waiting_trx\`, r.trx_mysql_thread_id AS \`waiting_thread\`,
                  LEFT(COALESCE(r.trx_query, ''), 200) AS \`waiting_query\`,
                  b.trx_id AS \`blocking_trx\`, b.trx_mysql_thread_id AS \`blocking_thread\`,
                  LEFT(COALESCE(b.trx_query, ''), 200) AS \`blocking_query\`,
                  TIMESTAMPDIFF(SECOND, r.trx_started, NOW()) AS \`wait_seconds\`
             FROM information_schema.innodb_lock_waits w
             JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id
             JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id
            ORDER BY wait_seconds DESC`,
          [],
          { mode: 'read' },
        );
        return result('Lock waits (5.7-compatible views)', columns, rows, { durationMs, notice: rows.length ? undefined : 'No lock waits at the moment' });
      }
    },

    async slow({ limit = 20 } = {}) {
      if (isOceanBase) {
        throw new UnsupportedError('OceanBase has no performance_schema statement summary', {
          hint: [
            'OceanBase slow SQL goes through its own views/audit:',
            '  MySQL mode: SELECT * FROM oceanbase.gv$sql_audit ORDER BY elapsed_time DESC LIMIT 20;',
            '  Oracle mode: SELECT * FROM v$sql_audit ORDER BY elapsed_time DESC;',
            'Or query by trace_id: oceanbase.gv$ob_sql_audit (OB 4.x).',
          ].join('\n'),
        });
      }
      const count = Number(limit) || 20;
      const { columns, rows, durationMs } = await run(
        `SELECT LEFT(DIGEST_TEXT, 300) AS \`query\`, COUNT_STAR AS calls,
                ROUND(SUM_TIMER_WAIT / 1000000000000, 3) AS total_s,
                ROUND(AVG_TIMER_WAIT / 1000000000, 2) AS avg_ms,
                ROUND(MAX_TIMER_WAIT / 1000000000, 2) AS max_ms,
                SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent,
                FIRST_SEEN AS first_seen, LAST_SEEN AS last_seen
           FROM performance_schema.events_statements_summary_by_digest
          WHERE DIGEST_TEXT IS NOT NULL
          ORDER BY SUM_TIMER_WAIT DESC
          LIMIT ${count}`,
        [],
        { mode: 'read' },
      );
      return result('Top SQL (by total time)', columns, rows, {
        durationMs,
        notice: rows.length ? undefined : 'No statement statistics in performance_schema yet (just restarted or not enabled)',
      });
    },

    async close() {
      if (connection) {
        try {
          await connection.end();
        } catch {
          /* already disconnected */
        }
        connection = null;
      }
    },
  };
}
