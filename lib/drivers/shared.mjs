/**
 * Shared driver utilities: result wrapping, identifier quoting, DDL rebuild, timing.
 *
 * All drivers return the same Result shape (see the Result comment in output.mjs),
 * so the command layer does not care which database is underneath.
 */

export function result(title, columns, rows, extra = {}) {
  return { title, columns, rows, ...extra };
}

/** Normalize to [[...], ...]; if a driver returns an array of objects, take values in columns order */
export function toMatrix(columns, rows) {
  const names = columns.map((column) => (typeof column === 'string' ? column : column?.name ?? ''));
  return rows.map((row) => (Array.isArray(row) ? row : names.map((name) => row?.[name])));
}

export function quoteIdent(engine, name) {
  const text = String(name ?? '');
  if (!text) return text;
  if (engine === 'mysql' || engine === 'clickhouse') return `\`${text.replace(/`/g, '``')}\``;
  if (engine === 'sqlserver') {
    const escaped = text.replace(/]/g, ']]');
    return '[' + escaped + ']';
  }
  if (engine === 'oracle') {
    return /^[A-Za-z][A-Za-z0-9_$#]*$/.test(text) ? text.toUpperCase() : `"${text.replace(/"/g, '""')}"`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function qualifiedName(engine, schema, table) {
  if (!schema) return quoteIdent(engine, table);
  return `${quoteIdent(engine, schema)}.${quoteIdent(engine, table)}`;
}

/** Engines without SHOW CREATE TABLE: rebuild a readable DDL from column info */
export function buildDdl({ engine, schema, table, columns, primaryKey = [], indexes = [], comment }) {
  const name = qualifiedName(engine, schema, table);
  const lines = columns.map((column) => {
    const parts = [`  ${quoteIdent(engine, column.name)} ${column.type ?? 'unknown'}`];
    if (column.identity) parts.push(column.identity);
    if (!column.nullable) parts.push('NOT NULL');
    if (column.default !== undefined && column.default !== null && column.default !== '') parts.push(`DEFAULT ${column.default}`);
    if (column.extra) parts.push(column.extra);
    if (column.comment) parts.push(`COMMENT '${String(column.comment).replace(/'/g, "''")}'`);
    return parts.join(' ');
  });
  if (primaryKey.length) lines.push(`  PRIMARY KEY (${primaryKey.map((column) => quoteIdent(engine, column)).join(', ')})`);
  const ddl = [`CREATE TABLE ${name} (`, lines.join(',\n'), ');'];
  if (comment) ddl.push('', `-- ${comment}`);
  if (indexes.length) {
    ddl.push('');
    for (const index of indexes) ddl.push(`-- ${index.text}`);
  }
  return ddl.join('\n');
}

export function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

export function splitList(text) {
  return String(text ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Convert a user-facing filter into a SQL LIKE pattern.
 *
 * `*` is accepted as a synonym of `%` (the `--pattern` help promises both), and a
 * pattern without any wildcard is wrapped in `%...%` so plain text keeps behaving
 * as a substring search.
 */
export function toSqlLike(pattern) {
  const text = String(pattern ?? '').trim();
  if (!text) return text;
  const converted = text.replace(/\*/g, '%');
  return converted.includes('%') ? converted : `%${converted}%`;
}

/** redis return value → printable string (no binary junk) */
export function printable(value) {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<binary ${value.length} B>`;
  if (Array.isArray(value)) return value.map((item) => printable(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
