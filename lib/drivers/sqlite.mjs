/**
 * SQLite driver (zero dependencies; uses Node's built-in node:sqlite, requires Node >= 22.13).
 *
 * Three modes:
 * - read: opened readOnly (writes are rejected at the kernel level), the most reliable;
 * - write: opened read-write, committed by SQLite's own transaction after execution;
 * - dry-run: BEGIN → execute → ROLLBACK, report affected rows only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { UnsupportedError } from '../errors.mjs';
import { result, elapsedMs, quoteIdent, toSqlLike } from './shared.mjs';

export async function create(conn, options = {}) {
  let module;
  try {
    module = await import('node:sqlite');
  } catch {
    throw new UnsupportedError('The SQLite driver requires Node >= 22.13 (built-in node:sqlite)', {
      hint: `Current Node is ${process.version}. Upgrade Node, or use the sqlite3 command instead.`,
    });
  }
  const { DatabaseSync } = module;

  const rawFile = conn.path || conn.database;
  if (!rawFile) throw new Error('SQLite connection is missing a file path: DB_SQLITE_PATH=/path/app.db or DB_URL=sqlite:/path/app.db');
  const file = rawFile === ':memory:' ? ':memory:' : path.resolve(options.cwd ?? process.cwd(), rawFile);
  if (file !== ':memory:' && !fs.existsSync(file)) throw new Error(`SQLite file not found: ${file} (relative paths resolve against the current directory)`);

  const db = new DatabaseSync(file, { readOnly: !options.allowWrite });
  try {
    db.exec('PRAGMA busy_timeout = 3000');
  } catch {
    /* ignore */
  }

  function execute(sql, mode) {
    const started = performance.now();
    const statement = db.prepare(sql);
    let columns = [];
    try {
      columns = statement.columns().map((column) => column.name);
    } catch {
      columns = [];
    }
    if (mode === 'read' || columns.length) {
      const raw = statement.all();
      return { columns, rows: raw.map((row) => columns.map((name) => row[name])), durationMs: elapsedMs(started) };
    }
    const info = statement.run();
    return { columns: [], rows: [], affectedRows: Number(info.changes ?? 0), durationMs: elapsedMs(started) };
  }

  return {
    type: 'sqlite',

    async ping() {
      const started = performance.now();
      const version = db.prepare('SELECT sqlite_version() AS v').get()?.v ?? 'unknown';
      const tableCount = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get()?.c ?? 0;
      const journal = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? 'unknown';
      return {
        version: `SQLite ${version}`,
        database: file,
        user: null,
        latencyMs: elapsedMs(started),
        extra: {
          tables: Number(tableCount),
          journalMode: journal,
          sizeBytes: file === ':memory:' ? 0 : fs.statSync(file).size,
          openMode: options.allowWrite ? 'read-write' : 'read-only',
        },
      };
    },

    async query(sql, { mode = 'read' } = {}) {
      if (mode === 'dry-run') {
        db.exec('BEGIN');
        try {
          const outcome = execute(sql, 'write');
          return result(null, outcome.columns, outcome.rows, {
            durationMs: outcome.durationMs,
            affectedRows: outcome.affectedRows,
            notice: 'dry-run: executed and rolled back; no data changed',
          });
        } finally {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
        }
      }
      const outcome = execute(sql, mode);
      return result(null, outcome.columns, outcome.rows, {
        durationMs: outcome.durationMs,
        affectedRows: outcome.affectedRows,
      });
    },

    async tables({ pattern } = {}) {
      let sql = `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`;
      const params = [];
      if (pattern) {
        sql += ' AND name LIKE ?';
        params.push(toSqlLike(pattern));
      }
      sql += ' ORDER BY type, name';
      const started = performance.now();
      const rows = db.prepare(sql).all(...params).map((row) => [row.name, row.type]);
      return result('Tables / views', ['name', 'type'], rows, { durationMs: elapsedMs(started) });
    },

    async describe(table) {
      const started = performance.now();
      const info = db.prepare(`PRAGMA table_info('${String(table).replace(/'/g, "''")}')`).all();
      if (!info.length) throw new Error(`Table not found: ${table} (use dbcli tables to list tables)`);
      const rows = info.map((column) => [
        column.cid,
        column.name,
        column.type || '(no type)',
        column.notnull ? 'NO' : 'YES',
        column.dflt_value ?? null,
        column.pk ? 'PRI' : '',
      ]);
      const fk = db.prepare(`PRAGMA foreign_key_list('${String(table).replace(/'/g, "''")}')`).all();
      return result(`Table structure ${table}`, ['#', 'column', 'type', 'null', 'default', 'key'], rows, {
        durationMs: elapsedMs(started),
        notice: fk.length ? `Foreign keys: ${fk.map((item) => `${item.from}→${item.table}.${item.to}`).join(', ')}` : undefined,
      });
    },

    async ddl(table) {
      const row = db.prepare(`SELECT name, type, sql FROM sqlite_master WHERE name = ?`).get(table);
      if (!row) throw new Error(`Object not found: ${table} (use dbcli tables to list tables)`);
      return result(null, ['ddl'], [[row.sql ?? `-- no DDL saved for ${row.type} ${row.name}`]]);
    },

    async indexes(table) {
      const started = performance.now();
      const list = db.prepare(`PRAGMA index_list('${String(table).replace(/'/g, "''")}')`).all();
      const rows = list.map((index) => {
        const info = db.prepare(`PRAGMA index_info('${String(index.name).replace(/'/g, "''")}')`).all();
        return [index.name, index.unique ? 'UNIQUE' : '', info.map((item) => item.name).join(', '), index.origin ?? ''];
      });
      return result(`Indexes ${table}`, ['index', 'unique', 'columns', 'origin'], rows, { durationMs: elapsedMs(started) });
    },

    async locks() {
      throw new UnsupportedError('SQLite is a single-file database and has no server-side lock-wait views', {
        hint: 'On SQLITE_BUSY: check whether another process holds a write transaction; run `dbcli query "PRAGMA journal_mode"` to see the journal mode, and raise busy_timeout if needed.',
      });
    },

    async slow() {
      throw new UnsupportedError('SQLite has no slow query log', {
        hint: 'Use `dbcli query "EXPLAIN QUERY PLAN <your SQL>"` to see the query plan.',
      });
    },

    async close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
