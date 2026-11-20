/**
 * MongoDB driver (npm: mongodb).
 *
 * Mongo has no SQL: `dbcli query` takes a JSON spec:
 *   {"collection":"users","filter":{"status":"A"},"projection":{"name":1},"sort":{"_id":-1},"limit":5}
 *   {"collection":"users","aggregate":[{"$match":{}}],"limit":5}
 *   {"op":"count","collection":"users","filter":{}} / {"op":"listCollections"} / {"op":"dbStats"}
 * The read-only operation allowlist lives in guard.mjs (aggregate $out/$merge are blocked).
 */

import { result, elapsedMs } from './shared.mjs';
import { UnsupportedError } from '../errors.mjs';

export async function create(conn, options = {}) {
  const imported = await options.loadPackage('mongodb');
  const mongodb = imported.default ?? imported;
  const MongoClient = mongodb.MongoClient ?? imported.MongoClient;
  if (typeof MongoClient !== 'function') throw new Error('Failed to load mongodb: MongoClient not found');

  const database = conn.database || (conn.url ? '' : 'admin');
  const uri =
    conn.url ??
    `mongodb://${conn.user ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password ?? '')}@` : ''}${conn.host}:${conn.port ?? 27017}/${database || ''}`;

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: Math.min(options.timeoutMs ?? 10000, 15000),
    connectTimeoutMS: options.timeoutMs ?? 10000,
    appName: 'dbcli',
    ...(options.insecureTls ? { tlsAllowInvalidCertificates: true } : {}),
  });

  let connected = false;
  async function ensure() {
    if (connected) return client;
    await client.connect();
    connected = true;
    return client;
  }

  async function db() {
    const instance = await ensure();
    const name = conn.database || instance.db().databaseName || 'admin';
    return instance.db(name);
  }

  function toDocuments(cursor) {
    return cursor.toArray();
  }

  return {
    type: 'mongodb',

    async ping() {
      const started = performance.now();
      const database = await db();
      await database.command({ ping: 1 });
      let version = 'unknown';
      let extra = {};
      try {
        const info = await database.admin().command({ buildInfo: 1 });
        version = info.version ?? 'unknown';
        extra = { gitVersion: info.gitVersion };
      } catch {
        /* Insufficient privileges */
      }
      try {
        const stats = await database.command({ dbStats: 1 });
        extra.collections = stats.collections;
        extra.objects = stats.objects;
        extra.dataSize = stats.dataSize;
      } catch {
        /* Insufficient privileges */
      }
      return {
        version: `MongoDB ${version}`,
        database: database.databaseName,
        user: conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra,
      };
    },

    async query(spec, { mode = 'read' } = {}) {
      if (mode !== 'read') {
        throw new UnsupportedError('For Mongo writes/dry runs use mongosh or application code', {
          hint: 'This CLI offers read-only Mongo queries only (find / aggregate / count / distinct / listCollections, etc.).',
        });
      }
      const database = await db();
      const op = spec.op ?? (spec.aggregate ? 'aggregate' : 'find');
      const collection = spec.collection;
      const started = performance.now();

      if (op === 'listCollections') {
        const list = await database.listCollections().toArray();
        return result('Collections', ['name', 'type'], list.map((item) => [item.name, item.type ?? 'collection']), {
          durationMs: elapsedMs(started),
        });
      }
      if (op === 'listDatabases') {
        const instance = await ensure();
        const list = await instance.db('admin').command({ listDatabases: 1 });
        return result('Databases', ['name', 'sizeBytes'], list.databases.map((item) => [item.name, item.sizeOnDisk ?? null]), {
          durationMs: elapsedMs(started),
        });
      }
      if (op === 'dbStats' || op === 'serverStatus') {
        const payload = await (op === 'dbStats' ? database.command({ dbStats: 1 }) : database.admin().command({ serverStatus: 1 }));
        return { title: op === 'dbStats' ? 'Database stats' : 'Instance status', json: payload };
      }
      if (!collection) throw new Error('Mongo queries need a collection: {"collection":"users","filter":{}}');

      if (op === 'count') {
        const total = await database.collection(collection).countDocuments(spec.filter ?? {});
        return result(`count ${collection}`, ['count'], [[total]], { durationMs: elapsedMs(started) });
      }
      if (op === 'distinct') {
        const values = await database.collection(collection).distinct(spec.field, spec.filter ?? {});
        return result(`distinct ${collection}.${spec.field}`, ['value'], values.map((value) => [value]), {
          durationMs: elapsedMs(started),
        });
      }
      if (op === 'aggregate') {
        const pipeline = spec.aggregate ?? spec.pipeline ?? [];
        const cursor = database
          .collection(collection)
          .aggregate(pipeline, { allowDiskUse: spec.allowDiskUse ?? true, maxTimeMS: options.timeoutMs ?? 60000 });
        const documents = await toDocuments(cursor);
        const limited = Number.isFinite(spec.limit) && spec.limit > 0 ? documents.slice(0, spec.limit) : documents;
        return {
          title: `aggregate ${collection}`,
          documents: limited,
          truncated: limited.length < documents.length,
          durationMs: elapsedMs(started),
        };
      }
      if (op === 'find') {
        const cursor = database.collection(collection).find(spec.filter ?? {}, {
          projection: spec.projection,
          sort: spec.sort,
          limit: spec.limit,
          skip: spec.skip,
          maxTimeMS: options.timeoutMs ?? 60000,
        });
        const documents = await toDocuments(cursor);
        return { title: `find ${collection}`, documents, durationMs: elapsedMs(started) };
      }
      throw new Error(`Unknown Mongo operation: ${op} (available: find / aggregate / count / distinct / listCollections / listDatabases / dbStats / serverStatus)`);
    },

    async tables({ pattern } = {}) {
      const database = await db();
      const list = await database.listCollections().toArray();
      const needle = pattern ? String(pattern).replace(/[%*]/g, '').toLowerCase() : null;
      const filtered = needle ? list.filter((item) => item.name.toLowerCase().includes(needle)) : list;
      const rows = [];
      for (const item of filtered.slice(0, 500)) {
        let count = null;
        try {
          count = await database.collection(item.name).estimatedDocumentCount();
        } catch {
          count = null;
        }
        rows.push([item.name, item.type ?? 'collection', count]);
      }
      return result('Collections', ['name', 'type', 'est_docs'], rows);
    },

    async describe(collection) {
      const database = await db();
      const started = performance.now();
      const pipeline = [
        { $sample: { size: 100 } },
        { $project: { _id: 0, kv: { $objectToArray: '$$ROOT' } } },
        { $unwind: '$kv' },
        { $group: { _id: { field: '$kv.k', type: { $type: '$kv.v' } }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 200 },
      ];
      const rows = await database
        .collection(collection)
        .aggregate(pipeline, { allowDiskUse: true })
        .toArray();
      if (!rows.length) throw new Error(`Collection is empty or does not exist: ${collection} (use dbcli tables to list them)`);
      const indexList = await database.collection(collection).listIndexes().toArray().catch(() => []);
      const indexNames = indexList.flatMap((index) => Object.keys(index.key ?? {}));
      return result(
        `Fields (inferred from a 100-doc sample) ${collection}`,
        ['field', 'type', 'seen'],
        rows.map((row) => [row._id.field, row._id.type, row.n]),
        {
          durationMs: elapsedMs(started),
          notice: indexNames.length ? `Indexed fields: ${[...new Set(indexNames)].join(', ')}` : 'This collection has no indexes (queries on large collections will be slow)',
        },
      );
    },

    async indexes(collection) {
      const database = await db();
      const list = await database.collection(collection).listIndexes().toArray();
      return result(
        `Indexes ${collection}`,
        ['name', 'keys', 'unique'],
        list.map((index) => [index.name, JSON.stringify(index.key), Boolean(index.unique)]),
      );
    },

    async locks() {
      const database = await db();
      const currentOp = await database.admin().command({ currentOp: 1, $all: true, active: true }).catch(() => null);
      if (!currentOp) {
        throw new UnsupportedError('Not authorized to read currentOp (requires admin database privileges)', {
          hint: 'Ask the DBA to run db.currentOp({"waitingForLock": true}); on the application side, check slow-operation logs.',
        });
      }
      const inprog = currentOp.inprog ?? [];
      const waiting = inprog.filter((op) => op.waitingForLock);
      return result(
        'Operations waiting for locks (currentOp.waitingForLock)',
        ['opid', 'ns', 'op', 'secs_running', 'waitingForLock', 'client'],
        waiting.map((op) => [op.opid, op.ns, op.op, op.secs_running, Boolean(op.waitingForLock), op.client]),
        { notice: waiting.length ? undefined : 'No operations are waiting for locks' },
      );
    },

    async slow() {
      const database = await db();
      const profile = database.collection('system.profile');
      const enabled = await database.command({ profile: -1 }).catch(() => null);
      const docs = await profile.find({}).sort({ ts: -1 }).limit(20).toArray().catch(() => null);
      if (!docs) {
        throw new UnsupportedError('Cannot read system.profile', {
          hint: 'Profiling must be enabled on this database: db.setProfilingLevel(1, {slowms: 100}) (this is a write; ask the DBA to assess it).',
        });
      }
      return result(
        'Slow operations (system.profile)',
        ['ts', 'op', 'ns', 'millis', 'planSummary'],
        docs.map((doc) => [doc.ts, doc.op, doc.ns, doc.millis, doc.planSummary]),
        { notice: docs.length ? undefined : `profiling level is ${enabled?.was ?? 'not enabled'} and there are no records` },
      );
    },

    async close() {
      if (connected) {
        try {
          await client.close();
        } catch {
          /* Already closed */
        }
        connected = false;
      }
    },
  };
}
