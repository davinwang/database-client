import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '../lib/drivers/kafka.mjs';

const TOPICS = [
  {
    name: 'orders',
    partitions: [
      { partitionId: 0, leader: 1, replicas: [1, 2], isr: [1, 2] },
      { partitionId: 1, leader: 2, replicas: [1, 2], isr: [2] },
    ],
  },
  { name: '__consumer_offsets', partitions: [{ partitionId: 0, leader: 1, replicas: [1], isr: [1] }] },
];

const OFFSETS = {
  orders: [
    { partition: 0, low: 0, high: 100 },
    { partition: 1, low: 0, high: 50 },
  ],
  __consumer_offsets: [{ partition: 0, low: 0, high: 3 }],
};

function fakeKafkajs(calls = {}) {
  const admin = {
    connect: async () => {},
    disconnect: async () => {},
    describeCluster: async () => ({
      brokers: [
        { nodeId: 1, host: 'b1', port: 9092 },
        { nodeId: 2, host: 'b2', port: 9092 },
      ],
      controller: 1,
      clusterId: 'test-cluster',
    }),
    listTopics: async () => TOPICS.map((topic) => topic.name),
    fetchTopicMetadata: async ({ topics } = {}) => ({
      topics: topics ? TOPICS.filter((topic) => topics.includes(topic.name)) : TOPICS,
    }),
    fetchTopicOffsets: async (topic) => OFFSETS[topic] ?? [],
    listGroups: async () => ({ groups: [{ groupId: 'app-consumer', protocolType: 'consumer' }] }),
    describeGroups: async (ids) => ({
      groups: ids.map((id) => ({ groupId: id, state: 'Stable', protocolType: 'consumer', members: [{}, {}] })),
    }),
    fetchOffsets: async ({ groupId }) =>
      groupId === 'app-consumer'
        ? [{ topic: 'orders', partitions: [{ partition: 0, offset: 60 }, { partition: 1, offset: -1 }] }]
        : [],
    describeConfigs: async () => ({
      resources: [{ configEntries: [{ configName: 'retention.ms', configValue: '604800000', isDefault: 'false' }] }],
    }),
  };

  const consumer = {
    connect: async () => {},
    disconnect: async () => {
      calls.disconnected = true;
    },
    subscribe: async (options) => {
      calls.subscribed = options;
    },
    stop: async () => {},
    run: async ({ eachMessage, autoCommit }) => {
      calls.autoCommit = autoCommit;
      for (const offset of [42, 43]) {
        await eachMessage({
          partition: 0,
          message: {
            offset: String(offset),
            timestamp: '1700000000000',
            key: Buffer.from('k'),
            value: Buffer.from(`v${offset}`),
            headers: { trace: Buffer.from('t-1') },
          },
        });
      }
      return new Promise(() => {});
    },
  };

  return {
    Kafka: class {
      constructor(config) {
        calls.config = config;
      }
      admin() {
        return admin;
      }
      consumer(config) {
        calls.consumerConfig = config;
        return consumer;
      }
    },
  };
}

async function buildDriver(calls) {
  return create(
    { type: 'kafka', brokers: ['b1:9092', 'b2:9092'], user: 'app', password: 'pw', dialect: 'scram-sha-256', ssl: true },
    { loadPackage: async () => fakeKafkajs(calls), timeoutMs: 800 },
  );
}

test('Kafka: brokers/SASL/SSL are passed to kafkajs', async () => {
  const calls = {};
  const driver = await buildDriver(calls);
  await driver.ping();
  assert.deepEqual(calls.config.brokers, ['b1:9092', 'b2:9092']);
  assert.equal(calls.config.ssl, true);
  assert.deepEqual(calls.config.sasl, { mechanism: 'scram-sha-256', username: 'app', password: 'pw' });
  await driver.close();
});

test('Kafka: tables / describe / ping', async () => {
  const driver = await buildDriver({});
  const tables = await driver.tables();
  assert.deepEqual(tables.rows.map((row) => row[0]), ['__consumer_offsets', 'orders']);
  const orders = tables.rows.find((row) => row[0] === 'orders');
  assert.equal(orders[1], 2, 'partition count');
  assert.equal(orders[2], 2, 'replica count');

  const desc = await driver.describe('orders');
  assert.equal(desc.rows.length, 2);
  const partition1 = desc.rows.find((row) => row[0] === 1);
  assert.equal(partition1[6], 50, 'messages = high - low');
  assert.match(desc.title, /insufficient ISR/);
  assert.ok(desc.notice);

  const info = await driver.ping();
  assert.equal(info.database, 'test-cluster');
  assert.equal(info.extra.brokers, 2);
  assert.equal(info.extra.topics, 1, 'internal topics are excluded');
  await driver.close();
});

test('Kafka: consumer groups and lag (calculation, partitions without offsets)', async () => {
  const driver = await buildDriver({});
  const groups = await driver.groups();
  assert.deepEqual(groups.rows[0], ['app-consumer', 'Stable', 'consumer', 2]);

  const lag = await driver.lag('app-consumer');
  const partition0 = lag.rows.find((row) => row[1] === 0);
  assert.equal(partition0[4], 40, '100 - 60');
  const partition1 = lag.rows.find((row) => row[1] === 1);
  assert.equal(partition1[4], null, 'no lag when committed = -1');
  assert.match(lag.notice, /Total lag 40/);

  const empty = await driver.lag('unknown-group');
  assert.equal(empty.rows.length, 0);
  await driver.close();
});

test('Kafka: peek (temporary group, no commit, stops at limit)', async () => {
  const calls = {};
  const driver = await buildDriver(calls);
  const peek = await driver.peek({ topic: 'orders', limit: 2, from: 'earliest' });
  assert.equal(peek.documents.length, 2);
  assert.equal(peek.documents[0].value, 'v42');
  assert.equal(peek.documents[0].partition, 0);
  assert.equal(peek.documents[0].offset, 42);
  assert.match(peek.documents[0].timestamp, /^2023-/);
  assert.deepEqual(peek.documents[0].headers, { trace: 't-1' });
  assert.equal(calls.subscribed.fromBeginning, true);
  assert.match(calls.consumerConfig.groupId, /^dbcli-peek-/);
  assert.equal(calls.autoCommit, false, 'peek does not commit offsets');
  assert.equal(calls.disconnected, true);
  await driver.close();
});

test('Kafka: query dispatch and unsupported ops', async () => {
  const driver = await buildDriver({});
  const cluster = await driver.query({ op: 'cluster' });
  assert.equal(cluster.json.clusterId, 'test-cluster');
  assert.equal(cluster.json.brokers.length, 2);

  const configs = await driver.query({ op: 'configs', topic: 'orders' });
  assert.equal(configs.rows[0][0], 'retention.ms');

  const offsets = await driver.query({ op: 'offsets', topic: 'orders' });
  assert.equal(offsets.rows[0][3], 100);

  await assert.rejects(() => driver.query({ op: 'produce' }), /Unknown Kafka operation/);
  await assert.rejects(() => driver.locks(), /no lock waits/i);
  await assert.rejects(() => driver.slow(), /slow SQL/i);
  await driver.close();
});
