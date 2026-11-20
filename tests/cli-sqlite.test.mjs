import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseJson, runCli, tempDir } from './helpers/util.mjs';

function makeDatabase() {
  const dir = tempDir('dbcli-sqlite-');
  const file = path.join(dir, 'demo.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, balance REAL DEFAULT 0);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount REAL, status TEXT);
    CREATE INDEX idx_orders_user ON orders(user_id);
  `);
  const user = db.prepare('INSERT INTO users(name, email, balance) VALUES(?, ?, ?)');
  for (let index = 1; index <= 30; index += 1) user.run(`用户${index}`, `u${index}@example.com`, index * 1.5);
  const order = db.prepare('INSERT INTO orders(user_id, amount, status) VALUES(?, ?, ?)');
  for (let index = 1; index <= 60; index += 1) order.run((index % 30) + 1, index * 2.5, index % 2 ? 'NEW' : 'PAID');
  db.close();
  return file;
}

function scalar(file, sql) {
  const db = new DatabaseSync(file);
  const row = db.prepare(sql).get();
  db.close();
  return row;
}

const envFor = (file) => ({ DB_URL: `sqlite:${file}` });

test('list / tables / desc / ddl / indexes end-to-end', async () => {
  const file = makeDatabase();
  const env = envFor(file);

  const list = await runCli(['list', '--format', 'json'], { env });
  assert.equal(list.code, 0, list.stderr);
  const connections = parseJson(list.stdout).connections;
  assert.equal(connections.length, 1);
  assert.equal(connections[0].type, 'sqlite');
  assert.equal(connections[0].default, true);
  assert.equal(connections[0].passwordSet, false);
  assert.match(connections[0].sourceText, /DB_URL/);

  const tables = await runCli(['tables', '--format', 'json'], { env });
  assert.equal(tables.code, 0, tables.stderr);
  assert.deepEqual(parseJson(tables.stdout).rows.map((row) => row.name).sort(), ['orders', 'users']);

  const desc = await runCli(['desc', 'users', '--format', 'json'], { env });
  assert.equal(desc.code, 0, desc.stderr);
  const descPayload = parseJson(desc.stdout);
  assert.deepEqual(descPayload.columns, ['#', 'column', 'type', 'null', 'default', 'key']);
  assert.ok(descPayload.rows.some((row) => row.column === 'id' && row.key === 'PRI'));

  const ddl = await runCli(['ddl', 'orders'], { env });
  assert.equal(ddl.code, 0, ddl.stderr);
  assert.match(ddl.stdout, /CREATE TABLE orders/);
  assert.match(ddl.stdout, /user_id/);

  const indexes = await runCli(['indexes', 'orders', '--format', 'json'], { env });
  assert.equal(indexes.code, 0, indexes.stderr);
  assert.ok(parseJson(indexes.stdout).rows.some((row) => row.index === 'idx_orders_user'));
});

test('query: injects a row limit and marks truncated results', async () => {
  const file = makeDatabase();
  const env = envFor(file);
  const limited = await runCli(['query', 'select * from users order by id', '--limit', '5', '--format', 'json'], { env });
  assert.equal(limited.code, 0, limited.stderr);
  const payload = parseJson(limited.stdout);
  assert.equal(payload.rowCount, 5);
  assert.equal(payload.truncated, true);
  assert.equal(payload.rows[0].id, 1);

  const aggregate = await runCli(['query', 'select count(*) as n from users', '--format', 'json'], { env });
  assert.equal(parseJson(aggregate.stdout).rows[0].n, 30);
});

test('query: --no-limit disables injection', async () => {
  const file = makeDatabase();
  const result = await runCli(['query', 'select id from users', '--no-limit', '--format', 'json'], { env: envFor(file) });
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.rowCount, 30);
  assert.equal(payload.truncated, false);
});

test('read-only guard: write statements exit 4, multiple statements exit 3', async () => {
  const file = makeDatabase();
  const env = envFor(file);
  const blocked = await runCli(['query', 'update users set balance = 0'], { env });
  assert.equal(blocked.code, 4);
  assert.match(blocked.stderr, /Refusing to run/);

  const multi = await runCli(['query', 'select 1; select 2'], { env });
  assert.equal(multi.code, 3);

  assert.equal(scalar(file, 'select sum(balance) as s from users').s, (30 * 31) / 2 * 1.5);
});

test('--allow-write commits and --dry-run rolls back', async () => {
  const file = makeDatabase();
  const env = envFor(file);

  const written = await runCli(['query', 'update users set balance = 1 where id <= 3', '--allow-write'], { env });
  assert.equal(written.code, 0, written.stderr);
  const payload = JSON.parse(written.stdout);
  assert.equal(payload.mode, 'write');
  assert.equal(payload.affectedRows, 3);
  assert.equal(scalar(file, 'select count(*) as c from users where balance = 1').c, 3);

  const dry = await runCli(['query', 'update users set balance = 999', '--allow-write', '--dry-run'], { env });
  assert.equal(dry.code, 0, dry.stderr);
  const dryPayload = JSON.parse(dry.stdout);
  assert.equal(dryPayload.mode, 'dry-run');
  assert.equal(dryPayload.rolledBack, true);
  assert.equal(dryPayload.affectedRows, 30);
  assert.equal(scalar(file, 'select count(*) as c from users where balance = 999').c, 0);
});

test('--dry-run alone is rejected (it still executes)', async () => {
  const file = makeDatabase();
  const result = await runCli(['query', 'update users set balance = 2', '--dry-run'], { env: envFor(file) });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /--allow-write/);
});

test('unsupported diagnostics for SQLite suggest alternatives', async () => {
  const file = makeDatabase();
  const env = envFor(file);
  const locks = await runCli(['locks'], { env });
  assert.notEqual(locks.code, 0);
  assert.match(locks.stderr, /SQLite/);
  const slow = await runCli(['slow'], { env });
  assert.match(slow.stderr, /EXPLAIN QUERY PLAN/);
});

test('argument and command errors exit 2', async () => {
  const unknownCommand = await runCli(['nonsense']);
  assert.equal(unknownCommand.code, 2);
  const unknownOption = await runCli(['tables', '--nope']);
  assert.equal(unknownOption.code, 2);
  const badFormat = await runCli(['tables', '--format', 'xml']);
  assert.equal(badFormat.code, 2);
});

test('missing configuration prints actionable next steps', async () => {
  const result = await runCli(['query', 'select 1']);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /DB_URL/);
});

test('table and csv output', async () => {
  const file = makeDatabase();
  const env = envFor(file);
  const tableOut = await runCli(['query', 'select id, name from users where id <= 2', '--format', 'table'], { env });
  assert.match(tableOut.stdout, /用户1/);
  assert.match(tableOut.stdout, /--.*2 rows/);
  const csv = await runCli(['query', 'select id, name from users where id <= 2', '--format', 'csv'], { env });
  assert.equal(csv.stdout.trim().split('\n')[0], 'id,name');
});
