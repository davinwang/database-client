import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { guardSql } from '../lib/guard.mjs';
import { cleanDrivers } from '../lib/drivers/index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { parseJson, runCli, tempDir, writeFile } from './helpers/util.mjs';

test('read-only guard rejects MySQL executable comments, but not literals', () => {
  assert.throws(() => guardSql("select 1 /*!50000 into outfile '/tmp/x' */"), /executable comments/i);
  assert.throws(() => guardSql('select 1 /*!50000 ; drop table t */'), /executable comments/i);
  assert.doesNotThrow(() => guardSql("select '/*! not a comment */' as s"));
  assert.doesNotThrow(() => guardSql('select 1 /* ordinary comment */'));
  // --allow-write remains the explicit escape hatch
  assert.doesNotThrow(() => guardSql("select 1 /*!50000 */", { allowWrite: true }));
});

test('env never prints secrets (PASS variables, passwordless-user URLs, PARAMS)', async () => {
  const dir = tempDir('dbcli-secrets-');
  writeFile(dir, 'package.json', '{}');
  writeFile(
    dir,
    '.env',
    [
      'REDIS_URL=redis://:SuperSecret1@redis.local:6379/0',
      'DB_X_PASS=SuperSecret2',
      'DB_X_PARAMS=password=SuperSecret3&timeout=5',
      'MYSQL_PASSWORD=SuperSecret4',
      '',
    ].join('\n'),
  );
  const result = await runCli(['env', '--format', 'json'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!result.stdout.includes('SuperSecret'), 'a secret leaked into env output');
  assert.match(result.stdout, /\*\*\*/);

  const list = await runCli(['list', '--format', 'json'], { cwd: dir });
  assert.ok(!list.stdout.includes('SuperSecret'));
  assert.ok(!/"passwordLength"/.test(list.stdout), 'passwordLength must not be exposed');
});

test('--cwd applies to SQLite paths and --file', async () => {
  const dir = tempDir('dbcli-cwd-');
  const file = path.join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec('create table t(id integer)');
  db.close();
  writeFile(dir, 'query.sql', 'select 1 as ok');

  const tables = await runCli(['tables', '--cwd', dir, '--format', 'json'], { env: { DB_URL: 'sqlite:./app.db' } });
  assert.equal(tables.code, 0, tables.stderr);
  assert.equal(parseJson(tables.stdout).rows[0].name, 't');

  const fromFile = await runCli(['query', '--file', 'query.sql', '--cwd', dir, '--format', 'json'], {
    env: { DB_URL: 'sqlite:./app.db' },
  });
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.equal(parseJson(fromFile.stdout).rows[0].ok, 1);
});

test('--limit rejects zero/negative values instead of disabling the limit', async () => {
  const dir = tempDir('dbcli-limit-');
  const db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('create table t(id integer)');
  db.close();
  for (const value of ['0', '-1']) {
    const result = await runCli(['query', 'select 1', '--limit', value], { env: { DB_URL: `sqlite:${path.join(dir, 'app.db')}` } });
    assert.equal(result.code, 3, `--limit ${value}`);
    assert.match(result.stderr, /positive integer/);
  }
});

test('drivers clean refuses custom DB_DRIVER_DIR without --force and keeps lockfiles', async () => {
  const dir = tempDir('dbcli-clean-');
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  const previous = process.env.DB_DRIVER_DIR;
  process.env.DB_DRIVER_DIR = dir;
  try {
    const refused = await cleanDrivers();
    assert.equal(refused.refused, true);
    assert.ok(fs.existsSync(path.join(dir, 'node_modules')), 'must not delete without force');

    const forced = await cleanDrivers({ force: true });
    assert.equal(forced.refused, false);
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
    assert.ok(fs.existsSync(path.join(dir, 'package-lock.json')), 'lockfiles outside the skill are never deleted');
  } finally {
    if (previous === undefined) delete process.env.DB_DRIVER_DIR;
    else process.env.DB_DRIVER_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
