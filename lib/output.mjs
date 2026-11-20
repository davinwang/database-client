/**
 * Output layer: CJK-width-aware monospace tables, JSON, CSV, Markdown, cell formatting and masking.
 *
 * Conventions (readable by both agents and humans):
 * - Every result is described by `Result` (see the typedef below); renderResult decides how to render it.
 * - JSON output is always a **structured object** (with columns / rowCount / truncated); never print a bare
 *   array, otherwise an agent cannot tell whether the result was truncated.
 * - Table mode flattens multi-line text into one line and truncates oversized cells to avoid flooding the screen.
 * - No path ever prints a plaintext password; passwords only ever exist in memory.
 */

/** Terminal display width of a cell/text (CJK characters count as 2 columns) */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code === 0x1b) continue;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function padEnd(text, width) {
  const str = String(text ?? '');
  const gap = Math.max(0, width - displayWidth(str));
  return str + ' '.repeat(gap);
}

function padStart(text, width) {
  const str = String(text ?? '');
  const gap = Math.max(0, width - displayWidth(str));
  return ' '.repeat(gap) + str;
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return '*'.repeat(Math.min(8, Math.max(3, Math.floor(text.length / 2))));
}

export function truncate(text, limit) {
  const str = String(text);
  if (!Number.isFinite(limit) || limit <= 0 || displayWidth(str) <= limit) return str;
  let out = '';
  for (const char of str) {
    if (displayWidth(out + char) > limit - 1) break;
    out += char;
  }
  return `${out}…`;
}

const BINARY_HINT = (value) =>
  (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) || value instanceof Uint8Array || value instanceof ArrayBuffer;

/** Flatten any driver return value into a displayable string */
export function formatCell(value, { maxCell = 80, singleLine = true } = {}) {
  if (value === null || value === undefined) return 'NULL';
  if (BINARY_HINT(value)) {
    const size = value.byteLength ?? value.length ?? 0;
    return `<binary ${size} B>`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === 'object') {
    let json;
    try {
      json = JSON.stringify(value);
    } catch {
      json = String(value);
    }
    if (json === undefined) json = String(value);
    return truncate(json, maxCell);
  }
  let text = String(value);
  if (singleLine) text = text.replace(/\s+/g, ' ').trim();
  return truncate(text, maxCell);
}

/** String matrix where every column aligns safely in table mode */
export function toMatrix(columns, rows, { maxCell = 80 } = {}) {
  const names = columns.map((column) => (typeof column === 'string' ? column : column?.name ?? ''));
  const body = rows.map((row) =>
    names.map((_, index) => {
      const value = Array.isArray(row) ? row[index] : row?.[names[index]];
      return formatCell(value, { maxCell, singleLine: true });
    }),
  );
  return { names, body };
}

export function table(columns, rows, { maxCell = 80, maxWidth = 0 } = {}) {
  const { names, body } = toMatrix(columns, rows, { maxCell });
  if (!names.length) return '(no columns)';
  const widths = names.map((name, index) => {
    const cells = body.map((row) => row[index] ?? '');
    return Math.max(displayWidth(name), ...cells.map((cell) => displayWidth(cell)));
  });
  if (maxWidth > 0) {
    for (let index = 0; index < widths.length; index += 1) {
      if (widths[index] > maxWidth) widths[index] = maxWidth;
    }
  }
  const renderRow = (row) =>
    row
      .map((cell, index) => padEnd(truncate(cell ?? '', widths[index] + 1), widths[index]))
      .join('  ')
      .replace(/\s+$/, '');
  const lines = [renderRow(names), widths.map((width) => '-'.repeat(Math.max(1, width))).join('  ')];
  for (const row of body) lines.push(renderRow(row));
  return lines.join('\n');
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(columns, rows, { maxCell = 4096 } = {}) {
  const { names, body } = toMatrix(columns, rows, { maxCell });
  const lines = [names.map(csvEscape).join(',')];
  for (const row of body) lines.push(row.map(csvEscape).join(','));
  return lines.join('\n');
}

export function toMarkdown(columns, rows, { maxCell = 120 } = {}) {
  const { names, body } = toMatrix(columns, rows, { maxCell });
  const escape = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = [
    `| ${names.map(escape).join(' | ')} |`,
    `| ${names.map(() => '---').join(' | ')} |`,
  ];
  for (const row of body) lines.push(`| ${row.map(escape).join(' | ')} |`);
  return lines.join('\n');
}

export function toObjects(columns, rows, { maxCell = 4096 } = {}) {
  const names = columns.map((column) => (typeof column === 'string' ? column : column?.name ?? ''));
  const unique = [];
  const seen = new Map();
  for (const name of names) {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    unique.push(count === 0 ? name : `${name}#${count + 1}`);
  }
  return rows.map((row) => {
    const object = {};
    unique.forEach((name, index) => {
      const value = Array.isArray(row) ? row[index] : row?.[names[index]];
      object[name] = normalizeJsonValue(value, maxCell);
    });
    return object;
  });
}

function normalizeJsonValue(value, maxCell) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (BINARY_HINT(value)) {
    const size = value.byteLength ?? value.length ?? 0;
    return `<binary ${size} B>`;
  }
  if (typeof value === 'string') return truncate(value, maxCell);
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json.length > maxCell ? `${json.slice(0, maxCell)}…` : JSON.parse(json);
    } catch {
      return String(value);
    }
  }
  return value;
}

/**
 * @typedef {Object} Result
 * @property {string} [title]
 * @property {(string|{name:string})[]} [columns]
 * @property {any[][]} [rows]
 * @property {any[]} [documents] Non-tabular results (Mongo documents etc.)
 * @property {any} [json]        Structured object to print directly
 * @property {boolean} [truncated]
 * @property {number} [durationMs]
 * @property {string} [notice]
 * @property {Record<string, any>} [meta]
 */

/** Render a result to a string; format = auto|table|json|csv|md */
export function renderResult(result, { format = 'auto', maxCell, isTty = false } = {}) {
  const mode = format === 'auto' ? (isTty ? 'table' : 'json') : format;
  const cellLimit = maxCell ?? (mode === 'table' ? 80 : 4096);

  if (result?.write) {
    const info = result.write;
    const rolledBack = info.mode === 'dry-run';
    if (mode === 'json') {
      return `${JSON.stringify(
        {
          mode: info.mode,
          statement: info.statement ?? null,
          affectedRows: info.affectedRows ?? null,
          rolledBack,
          ...(Number.isFinite(info.durationMs) ? { durationMs: info.durationMs } : {}),
        },
        null,
        2,
      )}\n`;
    }
    const lines = [rolledBack ? '-- dry-run: executed and rolled back in a transaction, no changes made' : '-- Write mode (--allow-write): committed'];
    if (info.statement) lines.push(`-- Statement: ${truncate(String(info.statement).replace(/\s+/g, ' ').trim(), 200)}`);
    lines.push(`-- Affected rows: ${info.affectedRows === undefined || info.affectedRows === null ? 'unknown (driver returned none)' : info.affectedRows}`);
    if (Number.isFinite(info.durationMs)) lines.push(`-- Duration: ${Math.round(info.durationMs)}ms`);
    return `${lines.join('\n')}\n`;
  }

  if (result?.json !== undefined) {
    return `${JSON.stringify(result.json, null, 2)}\n`;
  }

  if (Array.isArray(result?.documents)) {
    if (mode === 'table') {
      const blocks = result.documents.map((doc, index) => `-- [${index + 1}]\n${JSON.stringify(doc, null, 2)}`);
      const head = result.title ? `-- ${result.title}\n` : '';
      return `${head}${blocks.join('\n')}\n${summaryLine(result, result.documents.length)}`;
    }
    const payload = {
      ...(result.title ? { title: result.title } : {}),
      rowCount: result.documents.length,
      truncated: Boolean(result.truncated),
      ...(Number.isFinite(result.durationMs) ? { durationMs: result.durationMs } : {}),
      ...(result.notice ? { notice: result.notice } : {}),
      documents: result.documents.map((doc) => normalizeJsonValue(doc, cellLimit)),
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  const columns = result?.columns ?? [];
  const rows = result?.rows ?? [];

  if (mode === 'json') {
    const payload = {
      ...(result.title ? { title: result.title } : {}),
      columns: columns.map((column) => (typeof column === 'string' ? column : column?.name ?? '')),
      rowCount: rows.length,
      truncated: Boolean(result.truncated),
      ...(Number.isFinite(result.durationMs) ? { durationMs: result.durationMs } : {}),
      ...(result.notice ? { notice: result.notice } : {}),
      rows: toObjects(columns, rows, { maxCell: cellLimit }),
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  if (mode === 'csv') return `${toCsv(columns, rows, { maxCell: cellLimit })}\n`;
  if (mode === 'md') return `${toMarkdown(columns, rows, { maxCell: cellLimit })}\n`;

  const head = result.title ? `-- ${result.title}\n` : '';
  if (!rows.length) {
    const note = result.notice ? `-- ${result.notice}\n` : '';
    return `${head}(0 rows)\n${note}`;
  }
  return `${head}${table(columns, rows, { maxCell: cellLimit })}\n${summaryLine(result, rows.length)}`;
}

function summaryLine(result, count) {
  const parts = [`${count} row${count === 1 ? '' : 's'}`];
  if (Number.isFinite(result.durationMs)) parts.push(`${Math.round(result.durationMs)}ms`);
  if (result.truncated) parts.push('truncated (adjust --limit)');
  const notice = result.notice ? `\n-- ${result.notice}` : '';
  return `-- ${parts.join(' · ')}${notice}\n`;
}

export function print(text) {
  process.stdout.write(text);
}

export function printError(message) {
  process.stderr.write(`${message}\n`);
}
