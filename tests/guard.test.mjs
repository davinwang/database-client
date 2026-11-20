import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySqlLimit,
  guardEsRequest,
  guardKafkaOperation,
  guardMongoOperation,
  guardRedis,
  guardSql,
  scanRisks,
  splitStatements,
  stripLiterals,
} from '../lib/guard.mjs';

test('read-only: allows queries', () => {
  for (const sql of [
    'select 1',
    'SELECT * FROM users WHERE id = 1',
    'with x as (select 1) select * from x',
    'show create table t',
    'desc users',
    'explain select * from users',
    'pragma table_info(users)',
    'values (1)',
  ]) {
    assert.doesNotThrow(() => guardSql(sql), sql);
  }
});

test('read-only: blocks writes and dangerous constructs', () => {
  const blocked = [
    'update users set name = 1',
    'delete from users',
    'insert into users values (1)',
    'drop table users',
    'truncate table users',
    'create table t (a int)',
    'grant select on t to u',
    'call proc()',
    "select * from users into outfile '/tmp/x'",
    'select * from users for update',
    'select nextval(\'seq\')',
    'pragma journal_mode = wal',
    'explain analyze update users set a = 1',
    'with x as (delete from users returning *) select * from x',
  ];
  for (const sql of blocked) {
    assert.throws(() => guardSql(sql), /Refusing|read-only|write statement|not allowed/i, sql);
  }
});

test('read-only: keywords inside strings/comments are not writes', () => {
  assert.doesNotThrow(() => guardSql("select 'update delete drop' as s"));
  assert.doesNotThrow(() => guardSql('select 1 /* delete from t */'));
  assert.doesNotThrow(() => guardSql('select update_flag, delete_time from t'));
});

test('only one statement per call', () => {
  assert.throws(() => guardSql('select 1; select 2'), /Only one statement per run/);
  assert.deepEqual(splitStatements("select ';' as a; select 2"), ["select ';' as a", 'select 2']);
});

test('allowWrite permits write statements', () => {
  assert.doesNotThrow(() => guardSql('update users set a = 1', { allowWrite: true }));
  assert.doesNotThrow(() => guardSql('delete from users where id = 1', { allowWrite: true }));
});

test('stripLiterals blanks literals and comments', () => {
  const naked = stripLiterals("select 'a''b', \"c\" -- comment\nfrom t");
  assert.ok(!naked.includes('comment'));
  assert.ok(naked.includes('select'));
});

test('row limit: per-engine injection', () => {
  assert.equal(applySqlLimit('select * from t', { limit: 11, engine: 'mysql' }).sql, 'select * from t\nLIMIT 11');
  assert.match(applySqlLimit('select * from t', { limit: 11, engine: 'sqlserver' }).sql, /SELECT TOP \(11\) \* FROM \(\nselect \* from t\n\)/);
  assert.match(applySqlLimit('select * from t', { limit: 11, engine: 'oracle' }).sql, /ROWNUM <= 11/);
  // do not inject when a limit already exists
  assert.equal(applySqlLimit('select * from t limit 5', { limit: 11, engine: 'mysql' }).injected, false);
  // SQL Server with ORDER BY is not wrapped
  assert.equal(applySqlLimit('select * from t order by id', { limit: 11, engine: 'sqlserver' }).injected, false);
  // trailing semicolons are stripped and the limit is still injected
  assert.equal(applySqlLimit('select 1;', { limit: 11, engine: 'mysql' }).injected, true);
  assert.equal(applySqlLimit('select 1;', { limit: 11, engine: 'mysql' }).sql, 'select 1\nLIMIT 11');
  // a trailing line comment must not swallow the injected limit
  const commented = applySqlLimit('select * from t -- trailing', { limit: 11, engine: 'mysql' });
  assert.match(commented.sql, /\nLIMIT 11$/);
});

test('Redis read-only allow-list', () => {
  assert.doesNotThrow(() => guardRedis(['GET', 'k']));
  assert.doesNotThrow(() => guardRedis(['SCAN', '0', 'MATCH', 'user:*', 'COUNT', '100']));
  assert.doesNotThrow(() => guardRedis(['CONFIG', 'GET', 'maxmemory']));
  assert.doesNotThrow(() => guardRedis(['SLOWLOG', 'GET', '10']));
  assert.throws(() => guardRedis(['SET', 'k', 'v']), /read-only/);
  assert.throws(() => guardRedis(['DEL', 'k']), /read-only/);
  assert.throws(() => guardRedis(['FLUSHALL']), /read-only/);
  assert.throws(() => guardRedis(['GETDEL', 'k']), /read-only/);
  assert.throws(() => guardRedis(['CONFIG', 'SET', 'maxmemory', '1gb']), /read-only/i);
});

test('Mongo read-only check blocks $out / $merge', () => {
  assert.doesNotThrow(() => guardMongoOperation('find'));
  assert.doesNotThrow(() => guardMongoOperation('aggregate', { pipeline: [{ $match: {} }] }));
  assert.throws(() => guardMongoOperation('insertOne'), /read-only/);
  assert.throws(() => guardMongoOperation('aggregate', { pipeline: [{ $out: 'x' }] }), /read-only/);
});

test('Elasticsearch read-only check', () => {
  assert.doesNotThrow(() => guardEsRequest('GET', '/_cat/indices?format=json'));
  assert.doesNotThrow(() => guardEsRequest('POST', '/logs-2026/_search'));
  assert.throws(() => guardEsRequest('PUT', '/logs/_doc/1'), /read-only/);
  assert.throws(() => guardEsRequest('POST', '/_bulk'), /read-only/);
  assert.throws(() => guardEsRequest('DELETE', '/logs-2026'), /read-only/);
});

test('Kafka read-only check rejects writes', () => {
  for (const op of ['topics', 'describe', 'peek', 'groups', 'lag', 'offsets', 'cluster', 'configs']) {
    assert.doesNotThrow(() => guardKafkaOperation(op), op);
  }
  assert.throws(() => guardKafkaOperation('produce'), /read-only/);
  assert.throws(() => guardKafkaOperation('resetOffsets'), /read-only/);
  assert.throws(() => guardKafkaOperation('topics', { allowWrite: true }), /read-only/);
  assert.throws(() => guardKafkaOperation(''), /Missing Kafka operation/);
});

test('scanRisks: full scans warn, aggregates do not', () => {
  assert.ok(scanRisks('select * from big').length > 0);
  assert.equal(scanRisks('select count(*) from big').length, 0);
  assert.equal(scanRisks('select * from big where id = 1').length, 0);
});
