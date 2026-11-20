/**
 * ClickHouse driver (zero-dependency: HTTP interface, default port 8123).
 *
 * Read-only: requests carry `readonly=1` (CH server semantics), plus the statement guard as a second layer.
 * Results always use `default_format=JSON`; when SHOW/DESCRIBE does not return JSON, fall back to TSV parsing.
 * There are no transactions, so dry-run is simply not supported (no pretending otherwise).
 */

import { UnsupportedError } from '../errors.mjs';
import { result, elapsedMs, toSqlLike } from './shared.mjs';
import { httpRequest } from './http.mjs';

function parseException(text) {
  const match = String(text).match(/Code:\s*(\d+)\.?\s*(?:DB::Exception:\s*)?([^\n(]+)/);
  const code = match?.[1];
  const message = match?.[2]?.trim() || String(text).slice(0, 300);
  return `ClickHouse${code ? ` ${code}` : ''}: ${message}`;
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return { columns: [], rows: [] };
  if (!trimmed.startsWith('{')) return null;
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const meta = payload.meta ?? [];
  const names = meta.map((item) => item.name);
  const rows = (payload.data ?? []).map((row) => names.map((name) => row[name]));
  return { columns: names, rows, statistics: payload.statistics, readRows: payload.rows };
}

/** Non-JSON response (some SHOW/DESCRIBE): TSVWithNames */
function parseTsv(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter((line) => line.length > 0);
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split('\t');
  const rows = lines.slice(1).map((line) =>
    line.split('\t').map((cell) => (cell === '\\N' ? null : cell)),
  );
  return { columns, rows };
}

export async function create(conn, options = {}) {
  const base = conn.url ? new URL(conn.url) : new URL(`${conn.ssl ? 'https' : 'http'}://${conn.host}:${conn.port ?? 8123}`);
  if (!/^https?:$/.test(base.protocol)) base.protocol = conn.ssl ? 'https:' : 'http:';
  // ClickHouse's HTTP endpoint is fixed at the root path; the database name goes in the database parameter
  base.pathname = '/';
  base.search = '';

  async function request(sql, { mode = 'read' } = {}) {
    const url = new URL(base.toString());
    if (conn.database) url.searchParams.set('database', conn.database);
    url.searchParams.set('default_format', 'JSON');
    url.searchParams.set('max_execution_time', String(Math.ceil((options.timeoutMs ?? 30000) / 1000)));
    if (mode === 'read') url.searchParams.set('readonly', '1');

    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (conn.user) {
      headers['X-ClickHouse-User'] = conn.user;
      headers['X-ClickHouse-Key'] = conn.password ?? '';
    }

    const started = performance.now();
    const response = await httpRequest(url.toString(), {
      method: 'POST',
      headers,
      body: sql,
      timeoutMs: options.timeoutMs ?? 30000,
      insecureTls: options.insecureTls,
    });
    if (response.status >= 400) throw new Error(parseException(response.text));
    const parsed = parseJson(response.text) ?? parseTsv(response.text);
    return { ...parsed, durationMs: elapsedMs(started) };
  }

  return {
    type: 'clickhouse',

    async ping() {
      const started = performance.now();
      const { rows } = await request(
        `SELECT version() AS version, timezone() AS timezone, currentDatabase() AS db, uptime() AS uptime,
                hostName() AS host, formatReadableSize(value) AS memory
           FROM system.asynchronous_metrics WHERE metric = 'MemoryResident' LIMIT 1`,
      );
      const row = rows[0] ?? [];
      let extra = {};
      try {
        const metrics = await request(
          `SELECT metric, value FROM system.metrics WHERE metric IN ('Query','Merge','TCPConnection','HTTPConnection','DelayedInserts')`,
        );
        for (const item of metrics.rows) extra[item[0]] = item[1];
      } catch {
        /* Ignore */
      }
      return {
        version: `ClickHouse ${row[0] ?? 'unknown'}`,
        database: row[2] ?? conn.database ?? null,
        user: conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra: { timezone: row[1], uptimeSeconds: row[3], host: row[4], memory: row[5], ...extra },
      };
    },

    async query(sql, { mode = 'read' } = {}) {
      if (mode !== 'read') {
        throw new UnsupportedError('ClickHouse has no transactions, so dry-run cannot roll back', {
          hint: 'Run writes explicitly with --allow-write; CH INSERTs are atomic batches and UPDATE/DELETE are mutations (asynchronous), so confirm the impact with a SELECT first.',
        });
      }
      const outcome = await request(sql, { mode });
      return result(null, outcome.columns, outcome.rows, {
        durationMs: outcome.durationMs,
        notice: outcome.readRows === undefined ? undefined : `${outcome.readRows} rows`,
      });
    },

    async tables({ schema, pattern } = {}) {
      const conditions = [`database NOT IN ('system','INFORMATION_SCHEMA','information_schema')`];
      if (schema) conditions.push(`database = '${String(schema).replace(/'/g, "''")}'`);
      if (pattern) conditions.push(`name LIKE '${toSqlLike(pattern).replace(/'/g, "''")}'`);
      const sql = `SELECT database, name, engine, total_rows, formatReadableSize(total_bytes) AS size, comment
                     FROM system.tables WHERE ${conditions.join(' AND ')} ORDER BY database, name`;
      const { columns, rows, durationMs } = await request(sql);
      return result('Tables', columns, rows, { durationMs });
    },

    async describe(table, { schema } = {}) {
      const target = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``;
      const { columns, rows, durationMs } = await request(`DESCRIBE TABLE ${target}`);
      if (!rows.length) throw new Error(`Table does not exist: ${target} (use dbcli tables to list them)`);
      return result(`Table schema ${target}`, columns, rows, { durationMs });
    },

    async ddl(table, { schema } = {}) {
      const target = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``;
      const { columns, rows, durationMs } = await request(`SHOW CREATE TABLE ${target}`);
      const ddl = rows[0]?.[0] ?? '';
      return result(null, ['ddl'], [[ddl]], { durationMs });
    },

    async indexes(table, { schema } = {}) {
      const conditions = [];
      if (schema) conditions.push(`database = '${String(schema).replace(/'/g, "''")}'`);
      if (table) conditions.push(`name = '${String(table).replace(/'/g, "''")}'`);
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const { columns, rows, durationMs } = await request(
        `SELECT database, name, engine, primary_key, sorting_key, partition_key FROM system.tables ${where} ORDER BY database, name`,
      );
      return result('Primary key / sorting key (ClickHouse has no secondary indexes)', columns, rows, {
        durationMs,
        notice: 'ClickHouse uses primary_key + sorting_key as a sparse index; see system.data_skipping_indices for skip indexes',
      });
    },

    async locks() {
      throw new UnsupportedError('ClickHouse has no row/table locks (no lock waits beyond MVCC)', {
        hint: [
          'For "writes queueing up / queries slowing down", check:',
          '  SELECT * FROM system.processes                      -- currently running queries',
          '  SELECT * FROM system.merges                         -- parts being merged',
          '  SELECT * FROM system.mutations WHERE is_done = 0    -- stuck mutations',
        ].join('\n'),
      });
    },

    async slow({ limit = 20 } = {}) {
      const count = Math.max(1, Number(limit) || 20);
      const { columns, rows, durationMs } = await request(
        `SELECT event_time, query_duration_ms, read_rows, formatReadableSize(memory_usage) AS memory,
                user, substring(query, 1, 300) AS query
           FROM system.query_log
          WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 1 DAY
          ORDER BY query_duration_ms DESC LIMIT ${count}`,
      );
      return result('Top queries (system.query_log)', columns, rows, {
        durationMs,
        notice: rows.length ? undefined : 'query_log has no data: it may be disabled (log_queries=1) or was just cleared',
      });
    },

    async close() {
      /* HTTP has no persistent connection state */
    },
  };
}
