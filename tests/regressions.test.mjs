import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildConnections, describeConnection, targetText } from '../lib/connections.mjs';
import { discover } from '../lib/discover.mjs';
import { parseDotenv } from '../lib/env.mjs';
import { toSqlLike } from '../lib/drivers/shared.mjs';
import { explainError } from '../lib/errors.mjs';
import { parseJson, runCli, tempDir, writeFile } from './helpers/util.mjs';
import { startElasticMock } from './helpers/mocks.mjs';

const envMap = (pairs) => new Map(Object.entries(pairs).map(([key, value]) => [key, { value, source: { kind: 'process', var: key } }]));

async function buildFromProject(dir, processEnv = {}) {
  const discovered = await discover({ cwd: dir, processEnv });
  const built = buildConnections(discovered.varMap, {
    extra: discovered.extra,
    warnings: discovered.warnings,
  });
  return { ...built, discovered };
}

test('toSqlLike: * is a synonym for %, plain text stays a substring search', () => {
  assert.equal(toSqlLike('user'), '%user%');
  assert.equal(toSqlLike('*user*'), '%user%');
  assert.equal(toSqlLike('%user%'), '%user%');
  assert.equal(toSqlLike('user*'), 'user%');
  assert.equal(toSqlLike(''), '');
});

test("tables --pattern accepts '*' as a wildcard", async () => {
  const dir = tempDir('dbcli-pattern-');
  const file = path.join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec('create table member_profile(id integer primary key)');
  db.close();

  const env = { DB_URL: `sqlite:${file}` };
  for (const pattern of ['*member*', '%member%', 'member']) {
    const result = await runCli(['tables', '--pattern', pattern, '--format', 'json'], { env, cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseJson(result.stdout).rows.length, 1, `pattern ${pattern}`);
  }
});

test('a partial connection never invents localhost', () => {
  const { connections, warnings } = buildConnections(envMap({ REDIS_PASSWORD: 'pw' }));
  assert.equal(connections.length, 0);
  assert.ok(warnings.some((item) => /no host configured/i.test(item)), warnings.join('\n'));
});

test('Redis cluster nodes are parsed and marked as a single-node view', () => {
  const { connections } = buildConnections(
    envMap({ REDIS_CLUSTER_NODES: 'r1:6379,r2:6380', REDIS_PASSWORD: 'pw' }),
  );
  assert.equal(connections.length, 1);
  const conn = connections[0];
  assert.deepEqual(conn.nodes, ['r1:6379', 'r2:6380']);
  assert.equal(conn.host, 'r1');
  assert.equal(conn.port, 6379);
  assert.equal(conn.cluster, true);
  assert.match(targetText(conn), /\+1 cluster nodes/);
  assert.equal(describeConnection(conn).cluster, true);
});

test('the same target is de-duplicated even when only one side has an explicit port', () => {
  const { connections } = buildConnections(
    envMap({
      DB_URL: 'mysql://app:pw@127.0.0.1:3306/app',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3306',
      MYSQL_USER: 'app',
      MYSQL_PASSWORD: 'pw',
      MYSQL_DATABASE: 'app',
    }),
  );
  assert.equal(connections.length, 1);
});

test('dotenv-style application-<profile>.properties resolves Spring placeholders', async () => {
  const dir = tempDir('dbcli-spring-');
  writeFile(dir, 'package.json', '{}');
  writeFile(
    dir,
    path.join('src', 'main', 'resources', 'application.yml'),
    ['spring:', '  datasource:', '    url: ${DATASOURCE_URL}', '    username: ${DATASOURCE_USER}', '    password: ${DATASOURCE_PASSWORD}', ''].join('\n'),
  );
  writeFile(
    dir,
    path.join('src', 'main', 'resources', 'application-dev.properties'),
    ['DATASOURCE_URL=jdbc:mysql://10.0.0.9:3306/app', 'DATASOURCE_USER=app', 'DATASOURCE_PASSWORD=secret', ''].join('\n'),
  );

  const { connections } = await buildFromProject(dir, { SPRING_PROFILES_ACTIVE: 'dev' });
  const spring = connections.find((conn) => conn.name === 'spring');
  assert.ok(spring, 'the spring datasource should be discovered without --env-file');
  assert.equal(spring.host, '10.0.0.9');
  assert.equal(spring.database, 'app');
  assert.equal(spring.user, 'app');
});

test('an undefined Spring placeholder is skipped with an actionable warning', async () => {
  const dir = tempDir('dbcli-spring-missing-');
  writeFile(dir, 'package.json', '{}');
  writeFile(
    dir,
    'application.yml',
    ['spring:', '  datasource:', '    url: ${NOPE_URL}', ''].join('\n'),
  );
  const { connections, warnings } = await buildFromProject(dir);
  assert.equal(connections.length, 0);
  assert.ok(
    warnings.some((item) => /unresolved placeholder/i.test(item) && item.includes('NOPE_URL')),
    warnings.join('\n'),
  );
});

test('dynamic-datasource yields one connection per datasource', async () => {
  const dir = tempDir('dbcli-dynamic-');
  writeFile(dir, 'package.json', '{}');
  writeFile(
    dir,
    'application.yml',
    [
      'spring:',
      '  datasource:',
      '    dynamic:',
      '      primary: master',
      '      datasource:',
      '        master:',
      '          url: jdbc:mysql://10.0.0.11:3306/master',
      '          username: m',
      '          password: mp',
      '        slave:',
      '          url: jdbc:mysql://10.0.0.12:3306/slave',
      '          username: s',
      '          password: sp',
      '',
    ].join('\n'),
  );
  const { connections } = await buildFromProject(dir);
  const names = connections.map((conn) => conn.name).sort();
  assert.deepEqual(names, ['spring-master', 'spring-slave']);
  const master = connections.find((conn) => conn.name === 'spring-master');
  assert.equal(master.host, '10.0.0.11');
  assert.match(master.notes.join(' '), /primary/);
});

test('Spring redis cluster nodes are parsed', async () => {
  const dir = tempDir('dbcli-redis-cluster-');
  writeFile(dir, 'package.json', '{}');
  writeFile(
    dir,
    'application.yml',
    ['spring:', '  redis:', '    cluster:', '      nodes: r1:6379,r2:6379', ''].join('\n'),
  );
  const { connections } = await buildFromProject(dir);
  const redis = connections.find((conn) => conn.type === 'redis');
  assert.ok(redis);
  assert.deepEqual(redis.nodes, ['r1:6379', 'r2:6379']);
  assert.equal(redis.cluster, true);
});

test('dotenv keys may contain dots and hyphens (properties files are not noise)', () => {
  const { vars, warnings } = parseDotenv('spring.kafka.bootstrap-servers=kafka:9092\ngtjaqh.health.url=http://x/health\n', {
    processEnv: {},
  });
  assert.equal(vars.get('spring.kafka.bootstrap-servers').value, 'kafka:9092');
  assert.equal(vars.get('gtjaqh.health.url').value, 'http://x/health');
  assert.deepEqual(warnings, []);
});

test('MOVED/ASK redirects produce a cluster hint', () => {
  const hint = explainError(new Error('MOVED 3999 10.0.0.2:6379'), { type: 'redis', host: 'h', port: 6379 });
  assert.match(hint, /another cluster node/);
  const ask = explainError(new Error('ASK 3999 10.0.0.2:6379'), { type: 'redis', host: 'h', port: 6379 });
  assert.match(ask, /another cluster node/);
});

test('Elasticsearch --pattern converts % to a glob', async () => {
  const server = await startElasticMock();
  try {
    const env = { ES_URL: `http://127.0.0.1:${server.port}` };
    const result = await runCli(['tables', '--pattern', 'logs%', '--format', 'json'], { env });
    assert.equal(result.code, 0, result.stderr);
    const request = server.requests.find((item) => item.url.includes('_cat/indices'));
    assert.match(request.url, /logs\*/);
  } finally {
    await server.close();
  }
});
