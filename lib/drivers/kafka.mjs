/**
 * Kafka / Redpanda driver (npm: kafkajs, pure JS).
 *
 * Four Kafka questions: which topics exist, whether partitions/ISR are healthy, what messages look like, how much lag a consumer group has.
 * This driver is **read-only**: it does not produce messages, change configs or reset offsets; `peek` reads messages with a temporary consumer group and does not commit offsets
 * (that leaves an empty consumer group in the broker's __consumer_offsets, expiring per offsets.retention).
 */

import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { result, elapsedMs } from './shared.mjs';
import { UnsupportedError } from '../errors.mjs';

const SASL_MECHANISMS = {
  plain: 'plain',
  'scram-sha-256': 'scram-sha-256',
  'scram-sha-512': 'scram-sha-512',
  scram256: 'scram-sha-256',
  scram512: 'scram-sha-512',
  aws: 'aws',
};

function decode(buffer) {
  if (buffer === null || buffer === undefined) return null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!buf.length) return '';
  if (isUtf8(buf)) return buf.toString('utf8');
  return `<binary ${buf.length} B>`;
}

function decodeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = Array.isArray(value) ? decode(value[0]) : decode(value);
  }
  return out;
}

function formatMessage(partition, message) {
  return {
    partition,
    offset: Number(message.offset),
    timestamp: message.timestamp ? new Date(Number(message.timestamp)).toISOString() : null,
    key: decode(message.key),
    value: decode(message.value),
    headers: decodeHeaders(message.headers),
  };
}

export async function create(conn, options = {}) {
  const imported = await options.loadPackage('kafkajs');
  const kafkajs = imported.default ?? imported;
  const Kafka = kafkajs.Kafka ?? imported.Kafka;
  if (typeof Kafka !== 'function') throw new Error('Failed to load kafkajs: Kafka constructor not found (reinstall with `dbcli drivers install kafka`)');

  const brokers = Array.isArray(conn.brokers) && conn.brokers.length ? conn.brokers : [`${conn.host}:${conn.port ?? 9092}`];
  const mechanismRaw = String(conn.dialect ?? conn.params?.saslMechanism ?? 'plain').toLowerCase();
  const mechanism = SASL_MECHANISMS[mechanismRaw];
  if (conn.user && !mechanism) {
    throw new Error(`Unsupported SASL mechanism "${conn.dialect ?? ''}"; available: plain / scram-sha-256 / scram-sha-512`);
  }

  const timeoutMs = options.timeoutMs ?? 10000;
  const kafka = new Kafka({
    clientId: conn.params?.clientId ?? 'dbcli',
    brokers,
    ssl: Boolean(conn.ssl),
    ...(conn.user ? { sasl: { mechanism, username: conn.user, password: conn.password ?? '' } } : {}),
    connectionTimeout: timeoutMs,
    requestTimeout: timeoutMs * 3,
    retry: { retries: 2, initialRetryTime: 200 },
    // kafkajs logs retries as JSON by default and floods the output; dbcli emits troubleshooting info itself
    logLevel: kafkajs.logLevel?.NOTHING ?? 0,
  });

  let adminClient = null;
  async function admin() {
    if (!adminClient) {
      adminClient = kafka.admin();
      await adminClient.connect();
    }
    return adminClient;
  }

  async function topicOffsets(topic) {
    const client = await admin();
    const offsets = await client.fetchTopicOffsets(topic);
    return offsets.map((item) => ({
      partition: item.partition,
      low: Number(item.low ?? 0),
      high: Number(item.high ?? item.offset ?? 0),
    }));
  }

  return {
    type: 'kafka',

    async ping() {
      const started = performance.now();
      const client = await admin();
      const cluster = await client.describeCluster();
      const topics = await client.listTopics().catch(() => []);
      return {
        version: 'Kafka (version negotiated by protocol)',
        database: cluster.clusterId ?? null,
        user: conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra: {
          brokers: Array.isArray(cluster.brokers) ? cluster.brokers.length : 0,
          controller: cluster.controller ?? null,
          topics: topics.filter((name) => !String(name).startsWith('__')).length,
          bootstrap: brokers.join(','),
        },
      };
    },

    async tables() {
      const client = await admin();
      const started = performance.now();
      const metadata = await client.fetchTopicMetadata();
      const rows = (metadata.topics ?? [])
        .map((topic) => [
          topic.name,
          topic.partitions?.length ?? 0,
          topic.partitions?.[0]?.replicas?.length ?? 0,
          String(topic.name).startsWith('__') ? 'yes' : 'no',
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return result('Topic', ['topic', 'partitions', 'replication', 'internal'], rows, { durationMs: elapsedMs(started) });
    },

    async describe(topic) {
      const client = await admin();
      const started = performance.now();
      const metadata = await client.fetchTopicMetadata({ topics: [topic] });
      const found = (metadata.topics ?? []).find((item) => item.name === topic) ?? metadata.topics?.[0];
      if (!found || !found.partitions?.length) throw new Error(`topic does not exist: ${topic} (use dbcli tables to list them)`);
      const offsets = await topicOffsets(topic);
      const byPartition = new Map(offsets.map((item) => [item.partition, item]));
      const rows = found.partitions.map((partition) => {
        const offset = byPartition.get(partition.partitionId) ?? { low: null, high: null };
        return [
          partition.partitionId,
          partition.leader,
          (partition.replicas ?? []).join(','),
          (partition.isr ?? []).join(','),
          offset.low,
          offset.high,
          offset.low === null || offset.high === null ? null : offset.high - offset.low,
        ];
      });
      const underReplicated = found.partitions.filter(
        (partition) => (partition.isr ?? []).length < (partition.replicas ?? []).length,
      ).length;
      return result(
        `Topic ${topic} (${found.partitions.length} partition(s)${underReplicated ? `, ${underReplicated} with insufficient ISR` : ''})`,
        ['partition', 'leader', 'replicas', 'isr', 'low', 'high', 'messages'],
        rows,
        {
          durationMs: elapsedMs(started),
          notice: underReplicated ? 'Some partitions have fewer ISR than replicas: check broker liveness/replication first' : undefined,
        },
      );
    },

    async offsets(topic) {
      const started = performance.now();
      const offsets = await topicOffsets(topic);
      return result(
        `Offsets ${topic}`,
        ['partition', 'low', 'high', 'messages'],
        offsets.map((item) => [item.partition, item.low, item.high, item.high - item.low]),
        { durationMs: elapsedMs(started) },
      );
    },

    async groups({ limit = 100 } = {}) {
      const client = await admin();
      const started = performance.now();
      const { groups } = await client.listGroups();
      const ids = groups.map((group) => group.groupId).slice(0, limit);
      let described = [];
      if (ids.length) {
        const payload = await client.describeGroups(ids);
        described = payload.groups ?? [];
      }
      const rows = described.map((group) => [
        group.groupId,
        group.state ?? '',
        group.protocolType ?? '',
        group.members?.length ?? 0,
      ]);
      return result(`Consumer groups (${rows.length}/${groups.length})`, ['group', 'state', 'protocol', 'members'], rows, {
        durationMs: elapsedMs(started),
        notice: groups.length > rows.length ? `Showing only the first ${rows.length} consumer groups (adjust with --limit)` : undefined,
      });
    },

    async lag(group, { topic } = {}) {
      if (!group) throw new Error('lag needs a consumer group: dbcli query \'{"op":"lag","group":"app-consumer"}\'');
      const client = await admin();
      const started = performance.now();
      const committed = await client.fetchOffsets({ groupId: group, ...(topic ? { topics: [topic] } : {}) });
      const rows = [];
      let total = 0;
      let missing = 0;
      for (const item of committed) {
        const highs = await topicOffsets(item.topic);
        const highByPartition = new Map(highs.map((entry) => [entry.partition, entry.high]));
        for (const partition of item.partitions ?? []) {
          const high = highByPartition.get(partition.partition);
          const committedOffset = Number(partition.offset);
          if (committedOffset < 0 || high === undefined) {
            missing += 1;
            rows.push([item.topic, partition.partition, committedOffset, high ?? null, null]);
            continue;
          }
          const backlog = Math.max(0, high - committedOffset);
          total += backlog;
          rows.push([item.topic, partition.partition, committedOffset, high, backlog]);
        }
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1] - b[1]);
      return result(`Consumer lag ${group}`, ['topic', 'partition', 'committed', 'high', 'lag'], rows, {
        durationMs: elapsedMs(started),
        notice:
          rows.length === 0
            ? 'This consumer group has no committed offsets (it may never have consumed, or the offsets expired)'
            : `Total lag ${total}${missing ? `; ${missing} partition(s) without committed offsets` : ''}`,
      });
    },

    async configs(topic) {
      const client = await admin();
      const started = performance.now();
      const payload = await client.describeConfigs({ resources: [{ type: 2, name: topic }], includeSynonyms: false });
      const rows = (payload.resources?.[0]?.configEntries ?? [])
        .map((entry) => [entry.configName, entry.configValue, entry.isDefault ? 'yes' : 'no'])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return result(`Topic config ${topic}`, ['config', 'value', 'default'], rows, { durationMs: elapsedMs(started) });
    },

    async peek({ topic, limit = 10, from = 'latest', partition, timeoutMs: peekTimeoutMs } = {}) {
      if (!topic) throw new Error('peek needs a topic: dbcli query \'{"op":"peek","topic":"orders","limit":5}\'');
      const count = Math.max(1, Math.min(200, Number(limit) || 10));
      const waitMs = Number(peekTimeoutMs) > 0 ? Number(peekTimeoutMs) : Math.min(5000, options.timeoutMs ?? 5000);
      const started = performance.now();
      const groupId = `dbcli-peek-${randomUUID()}`;
      const consumer = kafka.consumer({
        groupId,
        sessionTimeout: 8000,
        heartbeatInterval: 2000,
        allowAutoTopicCreation: false,
      });
      const messages = [];
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => finish('timeout'), Math.max(1000, waitMs));
      await consumer.connect();
      let running;
      try {
        await consumer.subscribe({ topic, fromBeginning: from === 'earliest' });
        running = consumer.run({
          autoCommit: false,
          partitionsConsumedConcurrently: 1,
          eachMessage: async ({ partition: currentPartition, message }) => {
            if (partition !== undefined && partition !== null && Number(partition) !== currentPartition) return;
            messages.push(formatMessage(currentPartition, message));
            if (messages.length >= count) finish('limit');
          },
        });
        running.catch(() => {});
        const reason = await done;
        await consumer.stop().catch(() => {});
        return {
          title: `${topic} messages (${from === 'earliest' ? 'from earliest' : 'from latest'}${partition !== undefined && partition !== null ? `, partition ${partition}` : ''}, ${reason === 'limit' ? `fetched ${count}` : 'timed out before reaching the count'})`,
          documents: messages,
          truncated: reason === 'timeout' && messages.length > 0,
          durationMs: elapsedMs(started),
          notice: 'peek uses a temporary consumer group and does not commit offsets; an empty consumer group is left on the broker (expiring per offsets.retention)',
        };
      } finally {
        clearTimeout(timer);
        await consumer.disconnect().catch(() => {});
      }
    },

    async query(spec) {
      const operation = String(spec?.op ?? (spec?.topic ? 'describe' : 'cluster'));
      if (operation === 'cluster' || operation === 'describeCluster') {
        const client = await admin();
        const started = performance.now();
        const cluster = await client.describeCluster();
        return {
          title: 'Kafka cluster',
          json: {
            clusterId: cluster.clusterId ?? null,
            controller: cluster.controller ?? null,
            brokers: (cluster.brokers ?? []).map((broker) => ({ nodeId: broker.nodeId, host: broker.host, port: broker.port })),
          },
          durationMs: elapsedMs(started),
        };
      }
      if (operation === 'peek') return this.peek(spec);
      if (operation === 'groups' || operation === 'listGroups') return this.groups({ limit: spec.limit });
      if (operation === 'lag') return this.lag(spec.group ?? spec.groupId, { topic: spec.topic });
      if (operation === 'configs' || operation === 'describeConfigs') return this.configs(spec.topic);
      if (operation === 'describe' || operation === 'describeTopic' || operation === 'metadata') {
        if (!spec.topic) throw new Error('describe needs a topic');
        return this.describe(spec.topic);
      }
      if (operation === 'offsets' || operation === 'fetchTopicOffsets') {
        if (!spec.topic) throw new Error('offsets needs a topic');
        return this.offsets(spec.topic);
      }
      if (operation === 'topics' || operation === 'listTopics') return this.tables();
      throw new Error(`Unknown Kafka operation: ${operation} (available: topics/describe/offsets/groups/lag/peek/configs/cluster)`);
    },

    async locks() {
      throw new UnsupportedError('Kafka has no lock waits (ordering is guaranteed by the controller and partition leaders)', {
        hint: [
          'Kafka "stuck" usually falls into these categories; check them in order:',
          '  1) Consumer lag: dbcli query \'{"op":"lag","group":"<consumer-group>"}\'',
          '  2) Insufficient ISR / offlined replicas: dbcli desc <topic> (compare isr with replicas)',
          '  3) Consumer group rebalancing repeatedly: dbcli query \'{"op":"groups"}\' and check state / members',
          '  4) Broker side: describeCluster for the broker count and whether the controller is stable',
        ].join('\n'),
      });
    },

    async slow() {
      throw new UnsupportedError('Kafka has no concept of "slow SQL"', {
        hint: [
          'Equivalents: lag for consumer backlog, peek for message contents, desc and groups for broker/partition health.',
          '  Example: dbcli query \'{"op":"peek","topic":"orders","limit":5,"from":"latest"}\'',
        ].join('\n'),
      });
    },

    async close() {
      if (adminClient) {
        const client = adminClient;
        adminClient = null;
        try {
          await client.disconnect();
        } catch {
          /* Already disconnected */
        }
      }
    },
  };
}
