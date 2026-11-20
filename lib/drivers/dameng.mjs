/**
 * Dameng DM8 driver (official dmdb Node driver; API follows oracledb).
 *
 * The driver is not on public npm: install it from the DM installation directory's `drivers/nodejs/dmdb-*.tgz`
 * (`DB_DM_DRIVER_TGZ=<tgz path> dbcli drivers install dameng`, or npm i that tgz).
 * DM is highly Oracle-compatible: the data dictionary uses ALL_* / USER_* views and identifiers are uppercase by default.
 *
 * Note: dmdb is a native extension; cross-platform / cross-Node-version use may need a matching binary.
 * If loading fails, run `dbcli doctor` first to see the actual error. Lock/slow-query views differ a lot between DM versions,
 * so this is best-effort; when a lookup fails it tells you which view to use.
 */

import { result, elapsedMs, quoteIdent, buildDdl, toSqlLike } from './shared.mjs';
import { UnsupportedError } from '../errors.mjs';

export async function create(conn, options = {}) {
  const imported = await options.loadPackage('dmdb');
  const dmdb = imported.default ?? imported;
  const getConnection = dmdb.getConnection ?? dmdb.default?.getConnection;
  if (typeof getConnection !== 'function') {
    throw new Error('Failed to load dmdb: getConnection not found (make sure the official Dameng Node driver is installed)');
  }
  const OUT_FORMAT_ARRAY = dmdb.OUT_FORMAT_ARRAY ?? dmdb.default?.OUT_FORMAT_ARRAY;

  const connectString = conn.service
    ? `${conn.host}:${conn.port ?? 5236}`
    : `${conn.host}:${conn.port ?? 5236}`;
  let connection = null;

  async function ensure() {
    if (connection) return connection;
    connection = await getConnection({
      user: conn.user,
      password: conn.password,
      connectString,
    });
    if (conn.database || conn.schema) {
      const schema = String(conn.schema || conn.database).toUpperCase();
      try {
        await connection.execute(`SET SCHEMA "${schema}"`);
      } catch {
        /* ignore: with no privilege or a wrong schema name, later queries will report the error themselves */
      }
    }
    return connection;
  }

  async function run(sql, binds = [], { mode = 'read' } = {}) {
    const client = await ensure();
    const started = performance.now();
    const executeOptions = { fetchArraySize: 200 };
    if (OUT_FORMAT_ARRAY !== undefined) executeOptions.outFormat = OUT_FORMAT_ARRAY;
    let payload;
    if (mode === 'dry-run') {
      payload = await client.execute(sql, binds, executeOptions);
      try {
        await client.rollback();
      } catch {
        /* ignore */
      }
    } else {
      payload = await client.execute(sql, binds, executeOptions);
      if (mode === 'write') {
        try {
          await client.commit();
        } catch {
          /* ignore */
        }
      }
    }
    const meta = payload.metaData ?? payload.meta ?? [];
    const columns = meta.map((item) => item.name ?? item.NAME ?? '');
    let rows = payload.rows ?? [];
    if (rows.length && !Array.isArray(rows[0]) && columns.length) {
      rows = rows.map((row) => columns.map((name) => row[name]));
    }
    return {
      columns,
      rows,
      durationMs: elapsedMs(started),
      affectedRows: payload.rowsAffected ?? payload.affectedRows ?? undefined,
    };
  }

  async function currentSchema() {
    const { rows } = await run("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS s FROM DUAL");
    return rows?.[0]?.[0] ?? (conn.user ? String(conn.user).toUpperCase() : null);
  }

  async function requireSchema(schema) {
    const name = schema || conn.schema || (await currentSchema());
    if (!name) throw new Error('Cannot determine the current schema: specify it with --schema <user>');
    return String(name).toUpperCase();
  }

  async function primaryKeys(schema, table) {
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
    type: 'dameng',

    async ping() {
      const started = performance.now();
      const base = await run('SELECT 1 AS ok FROM DUAL');
      let version = 'DM';
      let extra = {};
      try {
        const instance = await run('SELECT INSTANCE_NAME, STATUS, STARTUP_TIME FROM V$INSTANCE');
        extra = { instance: instance.rows?.[0]?.[0], status: instance.rows?.[0]?.[1] };
      } catch {
        /* ignore */
      }
      try {
        const banner = await run('SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1');
        version = String(banner.rows?.[0]?.[0] ?? 'DM');
      } catch {
        /* ignore */
      }
      try {
        const schema = await run("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS s FROM DUAL");
        extra.schema = schema.rows?.[0]?.[0];
      } catch {
        /* ignore */
      }
      return {
        version,
        database: extra.schema ?? conn.database ?? null,
        user: conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra: { ...extra, connected: base.rows?.length ? 'yes' : 'no' },
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
    },

    async describe(table, { schema } = {}) {
      const owner = await requireSchema(schema);
      const tableName = String(table).toUpperCase();
      const { columns, rows, durationMs } = await run(
        `SELECT c.column_id AS "#", c.column_name AS "column",
                c.data_type AS "type", c.nullable AS "null", c.data_default AS "default",
                cc.comments AS "comment"
           FROM all_tab_columns c
           LEFT JOIN all_col_comments cc
             ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
          WHERE c.owner = ? AND c.table_name = ?
          ORDER BY c.column_id`,
        [owner, tableName],
        { mode: 'read' },
      );
      if (!rows.length) throw new Error(`Table not found or no permission: ${owner}.${tableName} (use dbcli tables to list tables)`);
      const pk = await primaryKeys(owner, tableName);
      const withKey = rows.map((row) => [...row, pk.includes(row[1]) ? 'PRI' : '']);
      return result(`Table structure ${owner}.${tableName}`, [...columns, 'key'], withKey, { durationMs });
    },

    async ddl(table, { schema } = {}) {
      const owner = await requireSchema(schema);
      const tableName = String(table).toUpperCase();
      const described = await this.describe(tableName, { schema: owner });
      const cols = described.rows.map((row) => ({ name: row[1], type: row[2], nullable: row[3] === 'Y', default: row[4] }));
      const indexes = await this.indexes(tableName, { schema: owner }).catch(() => ({ rows: [] }));
      const pk = await primaryKeys(owner, tableName);
      const ddl = buildDdl({
        engine: 'oracle',
        schema: owner,
        table: tableName,
        columns: cols,
        primaryKey: pk,
        indexes: indexes.rows.map((row) => ({ text: `${row[1]} (${row[5]})` })),
      });
      return result(null, ['ddl'], [[ddl]], { notice: 'DM rebuilds DDL from the data dictionary (partition/storage parameters excluded)' });
    },

    async indexes(table, { schema } = {}) {
      const owner = await requireSchema(schema);
      const tableName = table ? String(table).toUpperCase() : null;
      const params = tableName ? [owner, tableName] : [owner];
      const indexRows = await run(
        `SELECT table_name, index_name, uniqueness, index_type, status
           FROM all_indexes WHERE owner = ? ${tableName ? 'AND table_name = ?' : ''}
          ORDER BY table_name, index_name`,
        params,
        { mode: 'read' },
      );
      const columnRows = await run(
        `SELECT index_name, column_name FROM all_ind_columns
          WHERE index_owner = ? ${tableName ? 'AND table_name = ?' : ''}
          ORDER BY index_name, column_position`,
        params,
        { mode: 'read' },
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
      const candidates = [
        {
          sql: `SELECT * FROM V$TRXWAIT`,
          title: 'Transaction waits (V$TRXWAIT)',
        },
        {
          sql: `SELECT * FROM V$LOCK WHERE BLOCKED = 1`,
          title: 'Blocking locks (V$LOCK)',
        },
      ];
      for (const candidate of candidates) {
        try {
          const { columns, rows, durationMs } = await run(candidate.sql, [], { mode: 'read' });
          return result(candidate.title, columns, rows, {
            durationMs,
            notice: rows.length ? undefined : 'No lock waits at the moment',
          });
        } catch {
          /* try the next view */
        }
      }
      throw new UnsupportedError('V$TRXWAIT / V$LOCK not found on this DM version', {
        hint: 'Run `dbcli query "SELECT * FROM V$SESSIONS"` to inspect sessions and blocking columns, or query the lock view your DBA provides.',
      });
    },

    async slow({ limit = 20 } = {}) {
      const count = Number(limit) || 20;
      const candidates = [
        `SELECT * FROM V$LONG_EXEC_SQLS ORDER BY EXEC_TIME DESC LIMIT ${count}`,
        `SELECT * FROM V$SQL_HISTORY ORDER BY EXEC_TIME DESC LIMIT ${count}`,
      ];
      for (const sql of candidates) {
        try {
          const { columns, rows, durationMs } = await run(sql, [], { mode: 'read' });
          return result('Long-running SQL', columns, rows, { durationMs, notice: rows.length ? undefined : 'No records' });
        } catch {
          /* try the next one */
        }
      }
      throw new UnsupportedError('V$LONG_EXEC_SQLS / V$SQL_HISTORY not found on this DM version', {
        hint: 'Make sure SQL logging is enabled (DBA parameters ENABLE_MONITOR / SQL log), or run `dbcli query "SELECT * FROM V$SESSIONS"` to see executing statements.',
      });
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

export { quoteIdent };
