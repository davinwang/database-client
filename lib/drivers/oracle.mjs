/**
 * Oracle driver (npm: oracledb 6.x; thin mode needs no Instant Client).
 *
 * read: `SET TRANSACTION READ ONLY` after connecting; write: commit after executing;
 * dry-run: rollback after executing (to see affected rows).
 * 11g does not understand `FETCH FIRST`; guard.mjs enforces the row limit with a ROWNUM subquery.
 */

import { result, elapsedMs, buildDdl, toSqlLike } from './shared.mjs';

function connectStringOf(conn) {
  const port = conn.port ?? 1521;
  if (conn.service) return `${conn.host}:${port}/${conn.service}`;
  if (conn.sid) return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${conn.host})(PORT=${port}))(CONNECT_DATA=(SID=${conn.sid})))`;
  return `${conn.host}:${port}/${conn.database || 'ORCL'}`;
}

export async function create(conn, options = {}) {
  const imported = await options.loadPackage('oracledb');
  const oracledb = imported.default ?? imported;
  if (typeof oracledb.getConnection !== 'function') throw new Error('Failed to load oracledb: getConnection not found');

  oracledb.fetchAsString = [oracledb.CLOB];
  oracledb.autoCommit = false;
  if (options.timeoutMs) oracledb.callTimeout = options.timeoutMs;

  let connection = null;
  let readOnly = false;

  async function ensure() {
    if (connection) return connection;
    connection = await oracledb.getConnection({
      user: conn.user,
      password: conn.password,
      connectString: connectStringOf(conn),
    });
    if (!options.allowWrite) {
      try {
        await connection.execute('SET TRANSACTION READ ONLY');
        readOnly = true;
      } catch {
        /* ignore */
      }
    }
    return connection;
  }

  async function run(sql, binds = {}, { mode = 'read' } = {}) {
    const instance = await ensure();
    const started = performance.now();
    const res = await instance.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY, fetchArraySize: 200 });
    if (mode === 'write') {
      try {
        await instance.commit();
      } catch {
        /* ignore */
      }
    }
    if (mode === 'dry-run') {
      try {
        await instance.rollback();
      } catch {
        /* ignore */
      }
    }
    return {
      columns: (res.metaData ?? []).map((meta) => meta.name),
      rows: res.rows ?? [],
      durationMs: elapsedMs(started),
      affectedRows: typeof res.rowsAffected === 'number' ? res.rowsAffected : undefined,
    };
  }

  async function currentSchema() {
    const { rows } = await run("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS s FROM dual");
    return rows?.[0]?.[0] ?? (conn.user ? String(conn.user).toUpperCase() : null);
  }

  async function requireSchema(schema) {
    const name = schema || conn.schema || (await currentSchema());
    if (!name) throw new Error('Cannot determine the current schema: specify it with --schema <user>');
    return String(name).toUpperCase();
  }

  return {
    type: 'oracle',

    async ping() {
      const started = performance.now();
      const { rows } = await run(
        `SELECT banner, instance_name, host_name, version, status, database_status, startup_time FROM v$instance`,
      );
      const row = rows?.[0] ?? [];
      const extra = {};
      try {
        const params = await run(
          `SELECT name, value FROM v$parameter WHERE name IN ('processes','sessions','db_name','service_names','time_zone')`,
        );
        for (const item of params.rows) extra[item[0]] = item[1];
      } catch {
        /* ignore */
      }
      return {
        version: String(row[0] ?? 'unknown').split('\n')[0],
        database: row[1] ?? conn.database ?? null,
        user: conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra: { ...extra, host: row[2], status: row[4], databaseStatus: row[5], readOnlyTransaction: readOnly },
      };
    },

    async query(sql, { mode = 'read' } = {}) {
      const outcome = await run(sql, {}, { mode });
      return result(null, outcome.columns, outcome.rows, {
        durationMs: outcome.durationMs,
        affectedRows: outcome.affectedRows,
        notice: mode === 'dry-run' ? 'dry-run: executed and rolled back; no data changed' : undefined,
      });
    },

    async tables({ schema, pattern } = {}) {
      const owner = await requireSchema(schema);
      const binds = { owner };
      let condition = '';
      if (pattern) {
        binds.pattern = toSqlLike(pattern).toUpperCase();
        condition = 'AND table_name LIKE :pattern';
      }
      const { columns, rows, durationMs } = await run(
        `SELECT owner, table_name AS "table", num_rows, ROUND(blocks * 8 / 1024, 1) AS size_mb, last_analyzed
           FROM all_tables WHERE owner = :owner ${condition} ORDER BY table_name`,
        binds,
      );
      return result(`Tables (owner=${owner})`, columns, rows, { durationMs });
    },

    async describe(table, { schema } = {}) {
      const owner = await requireSchema(schema);
      const tableName = String(table).toUpperCase();
      const { columns, rows, durationMs } = await run(
        `SELECT c.column_id AS "#", c.column_name AS "column",
                c.data_type || CASE
                  WHEN c.data_type IN ('VARCHAR2','CHAR','NVARCHAR2','NCHAR') THEN '(' || c.data_length || ')'
                  WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN '(' || c.data_precision || ',' || NVL(c.data_scale, 0) || ')'
                  ELSE '' END AS "type",
                c.nullable AS "null", c.data_default AS "default", cc.comments AS "comment"
           FROM all_tab_columns c
           LEFT JOIN all_col_comments cc
             ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
          WHERE c.owner = :owner AND c.table_name = :table
          ORDER BY c.column_id`,
        { owner, table: tableName },
      );
      if (!rows.length) throw new Error(`Table not found or no permission: ${owner}.${tableName} (use dbcli tables to list tables)`);
      const pk = await run(
        `SELECT acc.column_name
           FROM all_constraints ac
           JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
          WHERE ac.constraint_type = 'P' AND ac.owner = :owner AND ac.table_name = :table
          ORDER BY acc.position`,
        { owner, table: tableName },
      );
      const pkColumns = pk.rows.map((row) => row[0]);
      const withKey = rows.map((row) => [...row, pkColumns.includes(row[1]) ? 'PRI' : '']);
      return result(`Table structure ${owner}.${tableName}`, [...columns, 'key'], withKey, { durationMs });
    },

    async ddl(table, { schema } = {}) {
      const owner = await requireSchema(schema);
      const tableName = String(table).toUpperCase();
      const described = await this.describe(tableName, { schema: owner });
      const columns = described.rows.map((row) => ({ name: row[1], type: row[2], nullable: row[3] === 'Y', default: row[4] }));
      const indexes = await this.indexes(tableName, { schema: owner }).catch(() => ({ rows: [] }));
      const ddl = buildDdl({
        engine: 'oracle',
        schema: owner,
        table: tableName,
        columns,
        primaryKey: described.rows.filter((row) => row[6] === 'PRI').map((row) => row[1]),
        indexes: indexes.rows.map((row) => ({ text: `${row[1]} (${row[5]})` })),
      });
      return result(null, ['ddl'], [[ddl]], { notice: 'Oracle has no SHOW CREATE TABLE: rebuilt from the data dictionary (partition/storage parameters and constraint names are not included)' });
    },

    async indexes(table, { schema } = {}) {
      const owner = await requireSchema(schema);
      const tableName = table ? String(table).toUpperCase() : null;
      const binds = { owner };
      let tableCondition = '';
      if (tableName) {
        binds.table = tableName;
        tableCondition = 'AND i.table_name = :table';
      }
      const indexRows = await run(
        `SELECT i.table_name, i.index_name, i.uniqueness, i.index_type, i.status
           FROM all_indexes i WHERE i.owner = :owner ${tableCondition}
          ORDER BY i.table_name, i.index_name`,
        binds,
      );
      const columnRows = await run(
        `SELECT index_name, column_name FROM all_ind_columns
          WHERE index_owner = :owner ${tableName ? 'AND table_name = :table' : ''}
          ORDER BY index_name, column_position`,
        binds,
      );
      const byIndex = new Map();
      for (const row of columnRows.rows) {
        const list = byIndex.get(row[0]) ?? [];
        list.push(row[1]);
        byIndex.set(row[0], list);
      }
      const rows = indexRows.rows.map((row) => [row[0], row[1], row[2], row[3], row[4], (byIndex.get(row[1]) ?? []).join(', ')]);
      return result(`Indexes (owner=${owner})`, ['table', 'index', 'unique', 'type', 'status', 'columns'], rows, {
        durationMs: indexRows.durationMs + columnRows.durationMs,
      });
    },

    async locks() {
      const { columns, rows, durationMs } = await run(
        `SELECT s.sid AS waiting_sid, s.serial# AS waiting_serial, s.username,
                s.blocking_session, s.event, s.wait_class, s.seconds_in_wait, s.sql_id
           FROM v$session s WHERE s.blocking_session IS NOT NULL ORDER BY s.seconds_in_wait DESC`,
      );
      return result('Lock waits', columns, rows, { durationMs, notice: rows.length ? undefined : 'No lock waits at the moment' });
    },

    async slow({ limit = 20 } = {}) {
      const count = Number(limit) || 20;
      const { columns, rows, durationMs } = await run(
        `SELECT * FROM (
           SELECT sql_id, executions, ROUND(elapsed_time / 1000000, 2) AS elapsed_s,
                  ROUND(elapsed_time / GREATEST(executions, 1) / 1000, 2) AS avg_ms,
                  ROUND(cpu_time / 1000000, 2) AS cpu_s, buffer_gets, disk_reads, rows_processed,
                  SUBSTR(sql_text, 1, 300) AS sql_text
             FROM v$sql WHERE executions > 0 ORDER BY elapsed_time DESC
         ) WHERE ROWNUM <= ${count}`,
      );
      return result('Top SQL (v$sql by total time)', columns, rows, { durationMs });
    },

    async close() {
      if (connection) {
        try {
          await connection.close();
        } catch {
          /* already closed */
        }
        connection = null;
      }
    },
  };
}
