import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenPaths, getPath, parseProperties, parseYaml } from '../lib/yaml.mjs';

test('docker-compose subset parsing', () => {
  const { data, warnings } = parseYaml(`
services:
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
    command: ["redis-server", "--requirepass", "redispass"]
`);
  assert.deepEqual(warnings, []);
  assert.equal(data.services.mysql.image, 'mysql:8.0');
  assert.deepEqual(data.services.mysql.ports, ['13306:3306']);
  assert.equal(data.services.mysql.environment.MYSQL_DATABASE, 'shop');
  assert.deepEqual(data.services.redis.ports, ['6379:6379']);
  assert.deepEqual(data.services.redis.command, ['redis-server', '--requirepass', 'redispass']);
});

test('Spring nested config and quoted placeholders', () => {
  const { data } = parseYaml(`
spring:
  datasource:
    url: jdbc:mysql://db.internal:3306/core?useUnicode=true
    username: core
    password: "\${DB_PW:corepw}"
  data:
    redis:
      host: redis.internal
      port: 6379
      database: 2
`);
  assert.equal(getPath(data, 'spring.datasource.url'), 'jdbc:mysql://db.internal:3306/core?useUnicode=true');
  assert.equal(getPath(data, 'spring.datasource.password'), '${DB_PW:corepw}');
  assert.equal(getPath(data, 'spring.data.redis.port'), 6379);
  assert.equal(getPath(data, 'spring.data.redis.database'), 2);
});

test('list items containing maps (`- K=V` and `- K: V`)', () => {
  const { data } = parseYaml(`
services:
  pg:
    image: postgres:16
    environment:
      - POSTGRES_USER=app
      - POSTGRES_PASSWORD=secret
    ports:
      - target: 5432
        published: 15432
`);
  assert.deepEqual(data.services.pg.environment, ['POSTGRES_USER=app', 'POSTGRES_PASSWORD=secret']);
  assert.deepEqual(data.services.pg.ports, [{ target: 5432, published: 15432 }]);
});

test('block scalars and comments', () => {
  const { data } = parseYaml(`
script: |
  line1
  line2
note: "a # b" # 真注释
`);
  assert.equal(data.script, 'line1\nline2');
  assert.equal(data.note, 'a # b');
});

test('properties parsing and flat keys', () => {
  const { data } = parseProperties(`
# 注释
spring.datasource.url=jdbc:postgresql://pg:5432/app
spring.datasource.username=app
spring.datasource.password=app_pw
`);
  assert.equal(getPath(data, 'spring.datasource.url'), 'jdbc:postgresql://pg:5432/app');
  assert.equal(getPath(data, 'spring.datasource.password'), 'app_pw');
  assert.equal(getPath(data, 'spring.datasource.missing'), undefined);
});

test('flattenPaths keeps arrays as leaves', () => {
  const flat = flattenPaths({ a: { b: [1, 2] }, c: 'x' });
  assert.deepEqual(flat, { 'a.b': [1, 2], c: 'x' });
});
