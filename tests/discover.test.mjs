import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { discover } from '../lib/discover.mjs';
import { buildConnections } from '../lib/connections.mjs';
import { tempDir, writeFile } from './helpers/util.mjs';

function projectFixture() {
  const dir = tempDir('dbcli-proj-');
  writeFile(dir, 'package.json', '{"name":"demo"}');
  writeFile(
    dir,
    '.env',
    ['DB_ERP_URL=mysql://app:pw@10.0.0.5:3306/erp', 'DB_LOG_URL=postgres://log:pw@10.0.0.6:5432/logdb', 'MYSQL_HOST=127.0.0.1', 'MYSQL_USER=root', 'MYSQL_PASSWORD=rootpw', 'MYSQL_DATABASE=app', 'SPRING_PROFILES_ACTIVE=dev'].join('\n'),
  );
  writeFile(
    dir,
    'docker-compose.yml',
    `services:
  mysql:
    image: mysql:8.0
    ports:
      - "13306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: shop
  redis:
    image: redis:7
    ports:
      - 6379:6379
`,
  );
  writeFile(
    dir,
    path.join('src', 'main', 'resources', 'application.yml'),
    `spring:
  datasource:
    url: jdbc:mysql://db.internal:3306/core
    username: core
    password: corepw
  data:
    redis:
      host: redis.internal
      port: 6380
`,
  );
  return dir;
}

test('discovers .env / docker-compose / Spring configuration', async () => {
  const dir = projectFixture();
  const discovered = await discover({ cwd: dir, processEnv: {} });
  assert.equal(discovered.projectRoot, path.resolve(dir));
  assert.equal(discovered.files.env.length, 1);
  assert.equal(discovered.files.compose.length, 1);
  assert.ok(discovered.files.spring.some((file) => file.endsWith('application.yml')));

  const { connections } = buildConnections(discovered.varMap, {
    extra: discovered.extra,
    warnings: discovered.warnings,
  });
  const byName = new Map(connections.map((conn) => [conn.name, conn]));

  assert.equal(byName.get('erp').type, 'mysql');
  assert.equal(byName.get('erp').host, '10.0.0.5');
  assert.equal(byName.get('log').type, 'postgres');
  assert.equal(byName.get('mysql').database, 'app');
  assert.equal(byName.get('compose-mysql').port, 13306, 'compose should use the published host port');
  assert.equal(byName.get('compose-mysql').database, 'shop');
  assert.equal(byName.get('compose-redis').type, 'redis');
  assert.equal(byName.get('spring').host, 'db.internal');
  assert.equal(byName.get('spring').user, 'core');
  assert.equal(byName.get('spring-redis').port, 6380);
});

test('process environment overrides .env', async () => {
  const dir = projectFixture();
  const discovered = await discover({
    cwd: dir,
    processEnv: { DB_ERP_URL: 'mysql://app:pw@env-host:3307/erp' },
  });
  const { connections } = buildConnections(discovered.varMap, { extra: discovered.extra });
  const erp = connections.find((conn) => conn.name === 'erp');
  assert.equal(erp.host, 'env-host');
  assert.equal(erp.port, 3307);
  assert.equal(erp.source.kind, 'process');
});

test('--env-file wins over auto discovery; noAuto reads only explicit files', async () => {
  const dir = projectFixture();
  const other = path.join(dir, 'other.env');
  writeFile(dir, 'other.env', 'DB_ERP_URL=mysql://app:pw@explicit-host:3308/erp');
  const discovered = await discover({ cwd: dir, envFiles: [other], processEnv: {} });
  const { connections } = buildConnections(discovered.varMap, { extra: discovered.extra });
  assert.equal(connections.find((conn) => conn.name === 'erp').host, 'explicit-host');

  const onlyExplicit = await discover({ cwd: dir, envFiles: [other], noAuto: true, processEnv: {} });
  const built = buildConnections(onlyExplicit.varMap, { extra: onlyExplicit.extra }).connections;
  assert.deepEqual(built.map((conn) => conn.name), ['erp']);
});

test('profile files override (.env.dev wins over .env)', async () => {
  const dir = tempDir('dbcli-profile-');
  writeFile(dir, 'package.json', '{}');
  writeFile(dir, '.env', 'DB_URL=mysql://u:p@base:3306/app');
  writeFile(dir, '.env.dev', 'DB_URL=mysql://u:p@dev:3306/app');
  const discovered = await discover({ cwd: dir, processEnv: { NODE_ENV: 'dev' } });
  assert.equal(discovered.varMap.get('DB_URL').value, 'mysql://u:p@dev:3306/app');
  assert.equal(discovered.profile, 'dev');
});
