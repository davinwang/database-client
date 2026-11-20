import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv } from '../lib/env.mjs';

test('parses key/value, quotes, comments and export', () => {
  const { vars, warnings } = parseDotenv(
    ['# 注释', 'A=1', 'B="x # y"', "C='z  z'", 'export D= 4   # 行尾注释', 'E=', ''].join('\n'),
    { processEnv: {} },
  );
  assert.equal(vars.get('A').value, '1');
  assert.equal(vars.get('B').value, 'x # y');
  assert.equal(vars.get('C').value, 'z  z');
  assert.equal(vars.get('D').value, '4');
  assert.equal(vars.get('E').value, '');
  assert.equal(vars.get('A').line, 2);
  assert.deepEqual(warnings, []);
});

test('double-quote escapes and ${VAR} expansion (process env fallback)', () => {
  const { vars } = parseDotenv('HOST=db1\nURL="mysql://${USER}:${PASS}@${HOST}:3306/app"\nPLAIN=$HOST/db', {
    processEnv: { USER: 'app', PASS: 's3cret' },
  });
  assert.equal(vars.get('URL').value, 'mysql://app:s3cret@db1:3306/app');
  assert.equal(vars.get('PLAIN').value, 'db1/db');
});

test('undefined variables are kept and reported', () => {
  const { vars, warnings } = parseDotenv('URL=${MISSING}/x', { processEnv: {} });
  assert.equal(vars.get('URL').value, '${MISSING}/x');
  assert.ok(warnings.some((item) => item.includes('MISSING')));
});

test('duplicate keys: the later value wins and a warning is emitted', () => {
  const { vars, warnings } = parseDotenv('A=1\nA=2', { processEnv: {} });
  assert.equal(vars.get('A').value, '2');
  assert.ok(warnings.some((item) => item.includes('more than once')));
});

test('single quotes are not expanded', () => {
  const { vars } = parseDotenv("A='${B}'\nB=x", { processEnv: {} });
  assert.equal(vars.get('A').value, '${B}');
});

test('invalid lines warn instead of throwing', () => {
  const { vars, warnings } = parseDotenv('不是键值\nKEY: value\nGOOD=1', { processEnv: {} });
  assert.equal(vars.get('GOOD').value, '1');
  assert.ok(warnings.length >= 1);
});

test('backslash line continuation', () => {
  const { vars } = parseDotenv('A=one\\\ntwo', { processEnv: {} });
  assert.equal(vars.get('A').value, 'onetwo');
});
