/**
 * Redis driver (zero-dependency: implements the RESP2 protocol itself over node:net / node:tls).
 *
 * Why hand-rolled: read-only troubleshooting only needs "send a command + read the reply", so pulling in a client
 * dependency is not worth it; and this way `dbcli query "INFO server"` also works on machines without network or npm.
 *
 * Write control: the command allowlist lives in guard.mjs (commands such as GET/SET are distinguished by name);
 * the driver layer only executes; write commands pass only with `--allow-write`.
 */

import net from 'node:net';
import tls from 'node:tls';
import { isUtf8 } from 'node:buffer';
import { UnsupportedError } from '../errors.mjs';
import { result, elapsedMs, printable } from './shared.mjs';

const CRLF = Buffer.from('\r\n');

function encode(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const buffer = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    parts.push(Buffer.from(`$${buffer.length}\r\n`), buffer, CRLF);
  }
  return Buffer.concat(parts);
}

function decodeBulk(buffer) {
  if (!buffer.length) return '';
  if (buffer.includes(0)) return buffer;
  return isUtf8(buffer) ? buffer.toString('utf8') : buffer;
}

/** Parse one RESP value; returns null when the data is incomplete (wait for more) */
function readValue(buffer, offset) {
  if (offset >= buffer.length) return null;
  const type = buffer[offset];
  const lineEnd = buffer.indexOf(CRLF, offset);
  if (lineEnd === -1) return null;
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;

  switch (type) {
    case 0x2b: // +
      return { value: line, next };
    case 0x2d: // -
      return { error: new Error(line || 'Redis error'), next };
    case 0x3a: // :
      return { value: Number(line), next };
    case 0x24: {
      // $
      const length = Number(line);
      if (length === -1) return { value: null, next };
      if (buffer.length < next + length + 2) return null;
      return { value: decodeBulk(buffer.subarray(next, next + length)), next: next + length + 2 };
    }
    case 0x2a: {
      // *
      const count = Number(line);
      if (count === -1) return { value: null, next };
      const items = [];
      let cursor = next;
      for (let index = 0; index < count; index += 1) {
        const item = readValue(buffer, cursor);
        if (!item) return null;
        if (item.error) return { error: item.error, next: item.next };
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    case 0x5f: // _
      return { value: null, next };
    case 0x23: // #
      return { value: line === 't', next };
    default:
      return { error: new Error(`Unparsable Redis response (first byte 0x${type.toString(16)})`), next };
  }
}

class RespClient {
  constructor(conn, options) {
    this.conn = conn;
    this.options = options;
    this.pending = [];
    this.buffer = Buffer.alloc(0);
    this.socket = null;
  }

  async connect() {
    const { host, port } = this.conn;
    const secure = Boolean(this.conn.ssl) || /^rediss:/i.test(String(this.conn.url ?? ''));
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: !this.options.insecureTls })
      : net.connect({ host, port });
    socket.setNoDelay(true);
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('error', (error) => this.failAll(error));
    socket.on('close', () => this.failAll(new Error('Redis connection closed')));
    await new Promise((resolve, reject) => {
      const event = secure ? 'secureConnect' : 'connect';
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to Redis ${host}:${port}`)), this.options.timeoutMs ?? 10000);
      socket.once(event, () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    try {
      if (this.conn.password) {
        const args = this.conn.user ? ['AUTH', this.conn.user, this.conn.password] : ['AUTH', this.conn.password];
        await this.command(args);
      }
      const database = Number(this.conn.database);
      if (!this.options.skipSelect && Number.isFinite(database) && database > 0) {
        await this.command(['SELECT', String(database)]);
      }
    } catch (error) {
      // Close the socket even when auth/database selection fails, otherwise the process hangs here instead of exiting
      this.close();
      throw error;
    }
  }

  pump() {
    while (this.pending.length) {
      const parsed = readValue(this.buffer, 0);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.next);
      const waiter = this.pending.shift();
      if (parsed.error) waiter.reject(parsed.error);
      else waiter.resolve(parsed.value);
    }
  }

  failAll(error) {
    for (const waiter of this.pending.splice(0)) waiter.reject(error);
  }

  command(args) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Redis connection unavailable'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error(`Redis command timed out (${args[0]})`));
        this.socket?.destroy();
      }, this.options.timeoutMs ?? 10000);
      this.pending.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(encode(args));
    });
  }

  close() {
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      /* Ignore */
    }
  }
}

function parseInfo(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    map.set(line.slice(0, at), line.slice(at + 1));
  }
  return map;
}

/* ---------------------------- Cluster support ---------------------------- */

/** Commands that take no key (routed to any master). */
const KEYLESS_COMMANDS = new Set([
  'PING',
  'INFO',
  'DBSIZE',
  'SCAN',
  'KEYS',
  'SLOWLOG',
  'CLIENT',
  'CONFIG',
  'COMMAND',
  'TIME',
  'ROLE',
  'LATENCY',
  'CLUSTER',
  'AUTH',
  'SELECT',
  'ECHO',
  'LASTSAVE',
  'RANDOMKEY',
  'FLUSHALL',
  'FLUSHDB',
  'SWAPDB',
]);

/** Subcommand-style commands where the key is not the first argument. */
const KEY_POSITIONS = { MEMORY: 2, OBJECT: 2 };

function keyOf(args) {
  const command = String(args[0] ?? '').toUpperCase();
  const position = KEY_POSITIONS[command] ?? (KEYLESS_COMMANDS.has(command) ? 0 : 1);
  if (!position || args.length <= position) return undefined;
  const key = args[position];
  if (key === undefined || key === null) return undefined;
  return Buffer.isBuffer(key) ? key.toString('utf8') : String(key);
}

function crc16(buffer) {
  let crc = 0;
  for (const byte of buffer) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Redis Cluster slot for a key, honouring {hash tags}. */
export function keySlot(key) {
  const text = String(key);
  const tag = text.match(/\{([^}]*)\}/);
  const target = tag && tag[1] !== undefined ? tag[1] : text;
  return crc16(Buffer.from(target, 'utf8')) % 16384;
}

function normalizeNode(node) {
  const text = String(node ?? '').trim();
  if (!text) return text;
  const [host, port] = text.split(':');
  return port ? `${host}:${port}` : `${host}:6379`;
}

function splitNode(node) {
  const [host, port] = normalizeNode(node).split(':');
  return { host, port: Number(port) || 6379 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal Redis Cluster client.
 *
 * - Routes keyed commands by CRC16 slot, using `CLUSTER SLOTS` for the map.
 * - Follows MOVED (and updates the slot) and ASK (sends ASKING, no slot update).
 * - Fan-out helpers for SCAN / KEYS / DBSIZE / INFO / CLIENT LIST / SLOWLOG.
 *
 * It is deliberately not a full cluster client: no slot cache persistence across
 * processes, no replicas, no multi-key cross-slot transactions.
 */
class RespCluster {
  constructor(conn, options) {
    this.conn = conn;
    this.options = options;
    this.isCluster = true;
    this.seeds = (Array.isArray(conn.nodes) && conn.nodes.length ? conn.nodes : [`${conn.host}:${conn.port}`]).map(normalizeNode);
    this.clients = new Map();
    this.slots = new Map();
    this.masterSet = new Set();
  }

  async connect() {
    let lastError;
    let first = null;
    for (const seed of this.seeds) {
      try {
        first = await this.open(seed);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!first) throw lastError ?? new Error('Redis cluster: no reachable seed node');
    await this.refreshSlots(first);
  }

  async open(node) {
    const key = normalizeNode(node);
    if (this.clients.has(key)) return this.clients.get(key);
    const { host, port } = splitNode(key);
    const client = new RespClient({ ...this.conn, host, port, database: '', nodes: undefined }, { ...this.options, skipSelect: true });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      throw error;
    }
    this.clients.set(key, client);
    return client;
  }

  async refreshSlots(client) {
    const reply = await client.command(['CLUSTER', 'SLOTS']);
    if (!Array.isArray(reply)) throw new Error('Redis cluster: CLUSTER SLOTS returned an unexpected reply');
    this.slots.clear();
    this.masterSet.clear();
    for (const range of reply) {
      if (!Array.isArray(range) || !Array.isArray(range[2])) continue;
      const [start, end, master] = range;
      const node = normalizeNode(`${master[0]}:${master[1]}`);
      this.masterSet.add(node);
      for (let slot = Number(start); slot <= Number(end); slot += 1) this.slots.set(slot, node);
    }
    if (!this.masterSet.size) throw new Error('Redis cluster: CLUSTER SLOTS returned no masters');
  }

  masters() {
    const list = [...this.masterSet];
    return list.length ? list.sort() : [this.seeds[0]];
  }

  anyMaster() {
    return this.masters()[0];
  }

  nodeForSlot(slot) {
    return this.slots.get(slot) ?? this.anyMaster();
  }

  async primaryClient() {
    return this.open(this.anyMaster());
  }

  async command(args) {
    const key = keyOf(args);
    let node = key === undefined ? this.anyMaster() : this.nodeForSlot(keySlot(key));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const client = await this.open(node);
      try {
        return await client.command(args);
      } catch (error) {
        const message = String(error?.message ?? '');
        const moved = /^MOVED\s+(\d+)\s+(\S+)/.exec(message);
        if (moved) {
          const target = normalizeNode(moved[2].startsWith(':') ? `${splitNode(node).host}${moved[2]}` : moved[2]);
          this.slots.set(Number(moved[1]), target);
          node = target;
          continue;
        }
        const ask = /^ASK\s+(\d+)\s+(\S+)/.exec(message);
        if (ask) {
          const target = normalizeNode(ask[2].startsWith(':') ? `${splitNode(node).host}${ask[2]}` : ask[2]);
          const targetClient = await this.open(target);
          await targetClient.command(['ASKING']);
          return await targetClient.command(args);
        }
        if (/CLUSTERDOWN|TRYAGAIN|LOADING/i.test(message)) {
          await sleep(100);
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Redis cluster: too many redirects while running ${String(args[0]).toUpperCase()}`);
  }

  /** Run a command on every master and collect {node, value} (errors are returned too). */
  async eachMaster(run) {
    const results = [];
    for (const node of this.masters()) {
      try {
        const client = await this.open(node);
        results.push({ node, value: await run(client, node) });
      } catch (error) {
        results.push({ node, error });
      }
    }
    return results;
  }

  /**
   * Cluster-wide SCAN. The cursor returned to the caller is an opaque per-node
   * cursor map, so repeated calls keep advancing every master.
   */
  async scanAggregate(args) {
    const token = args[1] === undefined ? '0' : String(args[1]);
    let cursors = {};
    if (token && token !== '0') {
      try {
        cursors = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      } catch {
        cursors = {};
      }
    }
    const rest = args.slice(2);
    const keys = [];
    const next = {};
    for (const node of this.masters()) {
      const client = await this.open(node);
      const reply = await client.command(['SCAN', String(cursors[node] ?? '0'), ...rest]);
      if (!Array.isArray(reply)) continue;
      next[node] = String(reply[0]);
      if (Array.isArray(reply[1])) keys.push(...reply[1]);
    }
    const done = Object.values(next).every((cursor) => cursor === '0');
    const nextToken = done ? '0' : Buffer.from(JSON.stringify(next)).toString('base64url');
    return [nextToken, keys];
  }

  async keysAggregate(args) {
    const keys = [];
    for (const node of this.masters()) {
      const client = await this.open(node);
      const reply = await client.command(args);
      if (Array.isArray(reply)) keys.push(...reply);
    }
    return keys;
  }

  async dbsizeAggregate() {
    let total = 0;
    for (const node of this.masters()) {
      const client = await this.open(node);
      const size = await client.command(['DBSIZE']);
      if (Number.isFinite(Number(size))) total += Number(size);
    }
    return total;
  }

  async infoAggregate(args) {
    const sections = [];
    for (const node of this.masters()) {
      const client = await this.open(node);
      const text = await client.command(args);
      sections.push(`# node ${node}\n${String(text ?? '').trim()}`);
    }
    return sections.join('\n\n');
  }

  async clientListAggregate() {
    const lines = [];
    for (const node of this.masters()) {
      const client = await this.open(node);
      const text = await client.command(['CLIENT', 'LIST']);
      lines.push(`# node ${node}`);
      lines.push(String(text ?? '').trim());
    }
    return lines.join('\n');
  }

  close() {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

export async function create(conn, options = {}) {
  const isCluster = Boolean(conn.cluster) && Array.isArray(conn.nodes) && conn.nodes.length > 1;
  const client = isCluster ? new RespCluster(conn, options) : new RespClient(conn, options);
  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw error;
  }

  const valueRows = (value) => {
    if (value === null || value === undefined) return { columns: ['value'], rows: [[null]] };
    if (Array.isArray(value)) {
      return { columns: ['#', 'value'], rows: value.map((item, index) => [index, printable(item)]) };
    }
    return { columns: ['value'], rows: [[printable(value)]] };
  };

  return {
    type: 'redis',

    async ping() {
      const started = performance.now();
      const primary = client.isCluster ? await client.primaryClient() : client;
      const info = parseInfo(await primary.command(['INFO', 'server']));
      const memory = parseInfo(await primary.command(['INFO', 'memory']).catch(() => ''));
      const clients = parseInfo(await primary.command(['INFO', 'clients']).catch(() => ''));
      const size = client.isCluster ? await client.dbsizeAggregate().catch(() => null) : await primary.command(['DBSIZE']).catch(() => null);
      return {
        version: `Redis ${info.get('redis_version') ?? 'unknown'}`,
        database: conn.database ? `db${conn.database}` : 'db0',
        user: conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra: {
          mode: info.get('redis_mode') ?? (client.isCluster ? 'cluster' : undefined),
          cluster: client.isCluster,
          masters: client.isCluster ? client.masters().length : 1,
          os: info.get('os'),
          uptimeInSeconds: Number(info.get('uptime_in_seconds') ?? 0),
          dbsize: size,
          usedMemoryHuman: memory.get('used_memory_human'),
          connectedClients: clients.get('connected_clients'),
        },
      };
    },

    async query(args, { mode = 'read' } = {}) {
      if (mode === 'dry-run') {
        throw new UnsupportedError('Redis does not support dry-run (no multi-command transaction rollback)', {
          hint: 'To write, run directly with --allow-write; first confirm the key contents and TTL with read-only commands, then change it.',
        });
      }
      const started = performance.now();
      const command = String(args[0] ?? '').toUpperCase();
      const subcommand = String(args[1] ?? '').toUpperCase();
      let value;
      if (client.isCluster) {
        if (command === 'SCAN') value = await client.scanAggregate(args);
        else if (command === 'KEYS') value = await client.keysAggregate(args);
        else if (command === 'DBSIZE') value = await client.dbsizeAggregate();
        else if (command === 'INFO') value = await client.infoAggregate(args);
        else if (command === 'CLIENT' && subcommand === 'LIST') value = await client.clientListAggregate();
        else value = await client.command(args);
      } else {
        value = await client.command(args);
      }
      if (mode === 'write') {
        return result(null, ['result'], [[printable(value)]], { durationMs: elapsedMs(started) });
      }
      const shaped = valueRows(value);
      return result(null, shaped.columns, shaped.rows, {
        durationMs: elapsedMs(started),
        notice: client.isCluster && command === 'SCAN' ? 'cluster mode: SCAN fans out across masters; the returned cursor is an opaque per-node token' : undefined,
      });
    },

    async tables() {
      throw new UnsupportedError('Redis has no table schema', {
        hint: 'List keys: `dbcli query "SCAN 0 MATCH user:* COUNT 100"`; key counts per database: `dbcli query "INFO keyspace"`.',
      });
    },

    async describe(key) {
      throw new UnsupportedError('Redis has no table schema (keys are flat)', {
        hint: `Inspect a single key: \`dbcli query "TYPE ${key}"\`, \`dbcli query "OBJECT ENCODING ${key}"\`, \`dbcli query "MEMORY USAGE ${key}"\`, \`dbcli query "TTL ${key}"\`.`,
      });
    },

    async ddl() {
      throw new UnsupportedError('Redis has no DDL');
    },

    async indexes() {
      throw new UnsupportedError('Redis has no indexes (each data structure carries its own encoding)', {
        hint: '`dbcli query "OBJECT ENCODING <key>"` shows the underlying encoding (ziplist/hashtable/skiplist…).',
      });
    },

    async locks() {
      throw new UnsupportedError('Redis is single-threaded; there are no row/table locks', {
        hint: [
          'For "stuck" troubleshooting, check:',
          '  CLIENT LIST -- clients flagged with b are blocked',
          '  INFO clients -- blocked_clients',
          '  SLOWLOG GET 20 -- slow commands (KEYS/HGETALL on large keys are common)',
          '  Large keys: MEMORY USAGE <key>',
        ].join('\n'),
      });
    },

    async slow({ limit = 20 } = {}) {
      const started = performance.now();
      const count = Math.max(1, Math.min(128, Number(limit) || 20));
      const rows = [];
      if (client.isCluster) {
        const results = await client.eachMaster(async (nodeClient) => {
          const entries = await nodeClient.command(['SLOWLOG', 'GET', String(count)]);
          return (entries ?? []).map((entry) => {
            const [id, timestamp, duration, command, clientAddress, clientName] = entry;
            return [
              id,
              Number(timestamp) ? new Date(Number(timestamp) * 1000).toISOString() : '',
              duration,
              Array.isArray(command) ? printable(command) : String(command ?? ''),
              clientAddress ?? '',
              clientName ?? '',
            ];
          });
        });
        for (const item of results) {
          if (item.error) continue;
          for (const row of item.value) rows.push([item.node, ...row]);
        }
        return result('Slow commands (SLOWLOG, all masters)', ['node', 'id', 'time', 'duration_us', 'command', 'client', 'client_name'], rows, {
          durationMs: elapsedMs(started),
          notice: rows.length ? undefined : 'SLOWLOG is empty on every master: slowlog-log-slower-than may be unset, or it was just cleared',
        });
      }
      const entries = await client.command(['SLOWLOG', 'GET', String(count)]);
      for (const entry of entries ?? []) {
        const [id, timestamp, duration, command, clientAddress, clientName] = entry;
        rows.push([
          id,
          Number(timestamp) ? new Date(Number(timestamp) * 1000).toISOString() : '',
          duration,
          Array.isArray(command) ? printable(command) : String(command ?? ''),
          clientAddress ?? '',
          clientName ?? '',
        ]);
      }
      return result('Slow commands (SLOWLOG)', ['id', 'time', 'duration_us', 'command', 'client', 'client_name'], rows, {
        durationMs: elapsedMs(started),
        notice: rows.length ? undefined : 'SLOWLOG is empty: slowlog-log-slower-than may be unset, or it was just cleared',
      });
    },

    async close() {
      client.close();
    },
  };
}
