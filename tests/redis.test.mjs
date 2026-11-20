import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, runCli } from './helpers/util.mjs';
import { startRedisMock } from './helpers/mocks.mjs';
import { keySlot } from '../lib/drivers/redis.mjs';

const handler = (args) => {
  const command = String(args[0] ?? '').toUpperCase();
  if (command === 'PING') return 'PONG';
  if (command === 'INFO') return '# Server\r\nredis_version:7.2.0\r\nredis_mode:standalone\r\nuptime_in_seconds:100\r\n# Memory\r\nused_memory_human:1.2M\r\n# Clients\r\nconnected_clients:7\r\n';
  if (command === 'DBSIZE') return 3;
  if (command === 'GET') return `value-of-${args[1]}`;
  if (command === 'SCAN') return ['0', ['user:1', 'user:2']];
  if (command === 'SLOWLOG') return [[1, 1700000000, 1500, ['GET', 'x'], '127.0.0.1:1', '']];
  if (command === 'SET') return 'OK';
  return { __error: `ERR unknown command '${command}'` };
};

test('Redis: ping / query / slowlog / read-only guard / allow-write', async () => {
  const server = await startRedisMock(handler);
  const env = { REDIS_URL: `redis://127.0.0.1:${server.port}` };
  try {
    const ping = await runCli(['ping', '--format', 'json'], { env });
    assert.equal(ping.code, 0, ping.stderr);
    const pingPayload = parseJson(ping.stdout);
    assert.equal(pingPayload.rows.find((row) => row.metric === 'version').value, 'Redis 7.2.0');
    assert.ok(pingPayload.rows.some((row) => row.metric === 'dbsize' && row.value === '3'));

    const get = await runCli(['query', 'GET foo', '--format', 'json'], { env });
    assert.equal(get.code, 0, get.stderr);
    assert.deepEqual(parseJson(get.stdout).rows, [{ value: 'value-of-foo' }]);

    const scan = await runCli(['query', 'SCAN 0 MATCH user:* COUNT 100', '--format', 'json'], { env });
    assert.equal(scan.code, 0, scan.stderr);
    assert.equal(parseJson(scan.stdout).rowCount, 2);

    const slow = await runCli(['slow', '-n', '5', '--format', 'json'], { env });
    assert.equal(slow.code, 0, slow.stderr);
    const slowPayload = parseJson(slow.stdout);
    assert.equal(slowPayload.rows[0].duration_us, 1500);
    assert.match(slowPayload.rows[0].time, /^20\d\d-/);

    const blocked = await runCli(['query', 'SET k v'], { env });
    assert.equal(blocked.code, 4);
    assert.match(blocked.stderr, /Refusing Redis SET in read-only mode/);

    const written = await runCli(['query', 'SET k v', '--allow-write'], { env });
    assert.equal(written.code, 0, written.stderr);
    assert.equal(parseJson(written.stdout).mode, 'write');

    const locks = await runCli(['locks'], { env });
    assert.notEqual(locks.code, 0);
    assert.match(locks.stderr, /single-threaded/);
  } finally {
    await server.close();
  }
});

test('Redis cluster: slot routing, MOVED follow, fan-out for SCAN/DBSIZE/INFO/SLOWLOG', async () => {
  let portA = 0;
  let portB = 0;
  const slots = () => [
    [0, 8191, ['127.0.0.1', portA, 'node-a']],
    [8192, 16383, ['127.0.0.1', portB, 'node-b']],
  ];
  const handlerA = (args) => {
    const command = String(args[0] ?? '').toUpperCase();
    if (command === 'CLUSTER') return slots();
    if (command === 'GET') {
      if (args[1] === 'key-b') return { __error: `MOVED 16383 127.0.0.1:${portB}` };
      return `A:${args[1]}`;
    }
    if (command === 'SCAN') return ['0', ['a:1', 'a:2']];
    if (command === 'DBSIZE') return 2;
    if (command === 'INFO') return '# Server\r\nredis_version:7.2.0\r\nredis_mode:cluster\r\n';
    if (command === 'SLOWLOG') return [[1, 1700000000, 100, ['GET', 'a:1'], 'c', '']];
    return 'OK';
  };
  const handlerB = (args) => {
    const command = String(args[0] ?? '').toUpperCase();
    if (command === 'CLUSTER') return slots();
    if (command === 'GET') return `B:${args[1]}`;
    if (command === 'SCAN') return ['0', ['b:1']];
    if (command === 'DBSIZE') return 3;
    if (command === 'INFO') return '# Server\r\nredis_version:7.2.0\r\nredis_mode:cluster\r\n';
    if (command === 'SLOWLOG') return [[2, 1700000000, 200, ['GET', 'b:1'], 'c', '']];
    return 'OK';
  };
  const nodeA = await startRedisMock(handlerA);
  portA = nodeA.port;
  const nodeB = await startRedisMock(handlerB);
  portB = nodeB.port;
  const env = { REDIS_CLUSTER_NODES: `127.0.0.1:${portA},127.0.0.1:${portB}` };

  try {
    // key routed by slot; a MOVED reply is followed to the owning master
    const get = await runCli(['query', 'GET key-b', '--format', 'json'], { env });
    assert.equal(get.code, 0, get.stderr);
    assert.deepEqual(parseJson(get.stdout).rows, [{ value: 'B:key-b' }]);

    // DBSIZE sums every master
    const dbsize = await runCli(['query', 'DBSIZE', '--format', 'json'], { env });
    assert.equal(Number(parseJson(dbsize.stdout).rows[0].value), 5);

    // SCAN fans out and merges keys from all masters
    const scan = await runCli(['query', 'SCAN 0 MATCH * COUNT 100', '--format', 'json'], { env });
    assert.equal(scan.code, 0, scan.stderr);
    const scanText = JSON.stringify(parseJson(scan.stdout));
    assert.match(scanText, /a:1/);
    assert.match(scanText, /b:1/);

    // ping reports the cluster master count
    const ping = await runCli(['ping', '--format', 'json'], { env });
    const pingRows = parseJson(ping.stdout).rows;
    assert.equal(pingRows.find((row) => row.metric === 'masters')?.value, '2');

    // SLOWLOG is merged with a node column
    const slow = await runCli(['slow', '-n', '5', '--format', 'json'], { env });
    const slowRows = parseJson(slow.stdout).rows;
    assert.equal(slowRows.length, 2);
    assert.ok(slowRows.every((row) => typeof row.node === 'string' && row.node.includes('127.0.0.1')));
  } finally {
    await nodeA.close();
    await nodeB.close();
  }
});

test('Redis cluster: CRC16 slots honour hash tags', () => {
  assert.equal(keySlot('foo'), 12182);
  assert.equal(keySlot('{user}:1'), keySlot('user'));
  assert.notEqual(keySlot('user:1'), keySlot('user:2'));
});

test('Redis: AUTH first when a password is set', async () => {
  const calls = [];
  const server = await startRedisMock((args) => {
    calls.push(args);
    const command = String(args[0]).toUpperCase();
    if (command === 'AUTH') return args[1] === 'good-pw' ? 'OK' : { __error: 'WRONGPASS invalid username-password pair' };
    if (command === 'PING') return 'PONG';
    if (command === 'INFO') return '# Server\r\nredis_version:7.2.0\r\n';
    if (command === 'DBSIZE') return 0;
    return 'OK';
  });
  try {
    const ok = await runCli(['ping', '--format', 'json'], { env: { REDIS_URL: `redis://:good-pw@127.0.0.1:${server.port}` } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(calls.some((args) => args[0].toUpperCase() === 'AUTH' && args[1] === 'good-pw'));

    const bad = await runCli(['ping'], { env: { REDIS_URL: `redis://:bad-pw@127.0.0.1:${server.port}` } });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /WRONGPASS|password incorrect/i);
  } finally {
    await server.close();
  }
});
