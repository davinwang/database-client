import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, runCli } from './helpers/util.mjs';
import { startClickhouseMock, startElasticMock } from './helpers/mocks.mjs';

test('ClickHouse: ping / tables / query / desc; read requests carry readonly=1', async () => {
  const server = await startClickhouseMock();
  const env = { CLICKHOUSE_URL: `http://127.0.0.1:${server.port}` };
  try {
    const ping = await runCli(['ping', '--format', 'json'], { env });
    assert.equal(ping.code, 0, ping.stderr);
    assert.match(parseJson(ping.stdout).rows.find((row) => row.metric === 'version').value, /ClickHouse/);

    const tables = await runCli(['tables', '--format', 'json'], { env });
    assert.equal(tables.code, 0, tables.stderr);
    const rows = parseJson(tables.stdout).rows;
    assert.equal(rows[0].name, 'orders');
    assert.equal(rows[0].engine, 'MergeTree');

    const query = await runCli(['query', 'SELECT 1', '--format', 'json'], { env });
    assert.equal(query.code, 0, query.stderr);
    assert.deepEqual(parseJson(query.stdout).rows, [{ value: 1 }]);

    const desc = await runCli(['desc', 'orders', '--format', 'json'], { env });
    assert.equal(desc.code, 0, desc.stderr);
    assert.equal(parseJson(desc.stdout).rows[0].name, 'id');

    const readRequest = server.requests.find((request) => request.body.includes('system.tables'));
    assert.match(readRequest.url, /readonly=1/);
    assert.match(readRequest.url, /default_format=JSON/);
    assert.equal(readRequest.headers['x-clickhouse-user'], undefined, 'no auth header when no user is configured');
  } finally {
    await server.close();
  }
});

test('Elasticsearch: ping / tables / desc / search; writes are blocked', async () => {
  const server = await startElasticMock();
  const env = { ES_URL: `http://127.0.0.1:${server.port}` };
  try {
    const ping = await runCli(['ping', '--format', 'json'], { env });
    assert.equal(ping.code, 0, ping.stderr);
    assert.match(parseJson(ping.stdout).rows.find((row) => row.metric === 'version').value, /Elasticsearch 8\.11\.0/);

    const tables = await runCli(['tables', '--format', 'json'], { env });
    assert.equal(tables.code, 0, tables.stderr);
    assert.equal(parseJson(tables.stdout).rows[0].index, 'logs-2026');

    const desc = await runCli(['desc', 'logs-2026', '--format', 'json'], { env });
    assert.equal(desc.code, 0, desc.stderr);
    const fields = parseJson(desc.stdout).rows;
    assert.ok(fields.some((row) => row.field === '@timestamp' && row.type === 'date'));
    assert.ok(fields.some((row) => row.field === 'user.id' && row.type === 'keyword'));

    const searched = await runCli(['query', '{"method":"POST","path":"/logs-2026/_search","body":{"size":1}}', '--format', 'json'], { env });
    assert.equal(searched.code, 0, searched.stderr);
    assert.equal(parseJson(searched.stdout).documents[0].message, 'hello');

    const blocked = await runCli(['query', '{"method":"PUT","path":"/logs-2026/_doc/1"}'], { env });
    assert.equal(blocked.code, 4);
    assert.match(blocked.stderr, /Refusing PUT/);
  } finally {
    await server.close();
  }
});
