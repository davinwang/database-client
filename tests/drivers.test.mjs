import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DRIVERS, DriverMissingError, SKILL_DIR, driverInstallDir, driverRoots, driverStatus, resolvePackage } from '../lib/drivers/index.mjs';
import { parseJson, runCli } from './helpers/util.mjs';

test('driver registry covers mainstream and domestic engines', () => {
  for (const key of ['mysql', 'oceanbase', 'postgres', 'oracle', 'dameng', 'sqlserver', 'mongodb', 'redis', 'sqlite', 'clickhouse', 'elasticsearch']) {
    assert.ok(DRIVERS[key], `missing ${key}`);
  }
  assert.equal(DRIVERS.sqlite.packageName, null, 'SQLite uses the Node builtin');
  assert.equal(DRIVERS.redis.packageName, null, 'Redis uses the built-in RESP client');
  assert.equal(DRIVERS.mysql.packageName, 'mysql2');
});

test('resolvePackage returns null instead of throwing', () => {
  assert.equal(resolvePackage('this-package-should-not-exist-xyz', driverRoots()), null);
});

test('drivers install into the skill dir; DB_DRIVER_DIR overrides', () => {
  assert.equal(driverInstallDir(), path.resolve(SKILL_DIR));
  const previous = process.env.DB_DRIVER_DIR;
  process.env.DB_DRIVER_DIR = path.join(SKILL_DIR, '.tmp-drivers');
  try {
    assert.equal(driverInstallDir(), path.resolve(SKILL_DIR, '.tmp-drivers'));
    assert.equal(driverRoots()[0], path.resolve(SKILL_DIR, '.tmp-drivers'));
  } finally {
    if (previous === undefined) delete process.env.DB_DRIVER_DIR;
    else process.env.DB_DRIVER_DIR = previous;
  }
});

test('DriverMissingError prints a copy-paste install command', () => {
  const error = new DriverMissingError(DRIVERS.mongodb);
  assert.equal(error.exitCode, 5);
  assert.match(error.hint, /drivers install mongodb/);
});

test('DM8 dmdb hints at the installation media tarball', () => {
  const error = new DriverMissingError(DRIVERS.dameng);
  assert.match(error.hint, /DB_DM_DRIVER_TGZ/);
  assert.match(error.hint, /DM_HOME|drivers\/nodejs/);
});

test('dbcli drivers prints driver status (JSON)', async () => {
  const result = await runCli(['drivers', '--format', 'json']);
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJson(result.stdout);
  const rows = payload.rows;
  assert.equal(rows.length, Object.keys(DRIVERS).length);
  const sqlite = rows.find((row) => row['driver'] === 'sqlite');
  assert.equal(sqlite['status'], 'ok');
});
