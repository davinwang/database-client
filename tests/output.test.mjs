import test from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, maskSecret, renderResult, table, toCsv } from '../lib/output.mjs';

test('CJK width alignment', () => {
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('abc'), 3);
  const text = table(['名称', '值'], [['张三', '1'], ['李四四', '22']]);
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  // every line has the same visible width (separators included)
  const widths = lines.map((line) => displayWidth(line));
  assert.ok(new Set(widths).size <= 2, `inconsistent widths: ${widths.join(',')}`);
});

test('table: NULL / binary / multi-line values', () => {
  const text = table(['a', 'b'], [[null, 'line1\nline2']]);
  assert.ok(text.includes('NULL'));
  assert.ok(text.includes('line1 line2'));
});

test('CSV escaping', () => {
  const csv = toCsv(['a', 'b'], [['x,y', 'he said "hi"']]);
  assert.equal(csv.split('\n')[1], '"x,y","he said ""hi"""');
});

test('maskSecret does not reveal length details', () => {
  assert.equal(maskSecret('abc'), '***');
  assert.ok(maskSecret('a'.repeat(40)).length <= 8);
  assert.equal(maskSecret(''), '');
});

test('renderResult JSON: structured, includes truncated and row objects', () => {
  const text = renderResult({ columns: ['id', 'name'], rows: [[1, 'a']], truncated: true, durationMs: 3 }, { format: 'json' });
  const payload = JSON.parse(text);
  assert.deepEqual(payload.columns, ['id', 'name']);
  assert.equal(payload.rowCount, 1);
  assert.equal(payload.truncated, true);
  assert.deepEqual(payload.rows, [{ id: 1, name: 'a' }]);
});

test('renderResult: duplicate columns get suffixes', () => {
  const payload = JSON.parse(renderResult({ columns: ['id', 'id'], rows: [[1, 2]] }, { format: 'json' }));
  assert.deepEqual(Object.keys(payload.rows[0]), ['id', 'id#2']);
});

test('renderResult: write mode reports affected rows and rollback', () => {
  const write = JSON.parse(
    renderResult({ write: { mode: 'write', statement: 'update t set a=1', affectedRows: 3, durationMs: 5 } }, { format: 'json' }),
  );
  assert.equal(write.affectedRows, 3);
  assert.equal(write.rolledBack, false);
  const dry = JSON.parse(
    renderResult({ write: { mode: 'dry-run', statement: 'delete from t', affectedRows: 9 } }, { format: 'json' }),
  );
  assert.equal(dry.rolledBack, true);
});

test('renderResult: document results (Mongo/ES)', () => {
  const payload = JSON.parse(renderResult({ documents: [{ a: 1 }], rowCount: 1 }, { format: 'json' }));
  assert.equal(payload.documents[0].a, 1);
});

test('renderResult: dates, bigints and buffers serialize', () => {
  const payload = JSON.parse(
    renderResult(
      { columns: ['d', 'big', 'bin'], rows: [[new Date('2026-01-02T03:04:05Z'), 9007199254740993n, Buffer.from('ab')]] },
      { format: 'json' },
    ),
  );
  assert.equal(payload.rows[0].d, '2026-01-02T03:04:05.000Z');
  assert.equal(payload.rows[0].big, '9007199254740993');
  assert.match(payload.rows[0].bin, /binary/);
});
