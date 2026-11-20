/** Test mocks: Redis (RESP2) and ClickHouse/Elasticsearch (HTTP), implementing only the subset used by tests. */

import net from 'node:net';
import http from 'node:http';

function encode(value) {
  if (value && typeof value === 'object' && value.__error) return `-${value.__error}\r\n`;
  if (value === null || value === undefined) return '$-1\r\n';
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(encode).join('')}`;
  if (typeof value === 'number') return `:${value}\r\n`;
  const text = String(value);
  return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
}

function parseCommand(buffer) {
  if (!buffer.length || buffer[0] !== 0x2a) return null;
  let offset = buffer.indexOf('\r\n');
  if (offset === -1) return null;
  const count = Number(buffer.toString('utf8', 1, offset));
  offset += 2;
  const args = [];
  for (let index = 0; index < count; index += 1) {
    if (offset >= buffer.length) return null;
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;
    const length = Number(buffer.toString('utf8', offset + 1, lineEnd));
    const start = lineEnd + 2;
    if (buffer.length < start + length + 2) return null;
    args.push(buffer.toString('utf8', start, start + length));
    offset = start + length + 2;
  }
  return { args, next: offset };
}

/** Start a mock Redis; handler(args) returns a value, an {__error} object, or a raw string. */
export async function startRedisMock(handler) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.next);
        socket.write(encode(handler(parsed.args)));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function sendText(response, status, text) {
  response.writeHead(status, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

export async function startClickhouseMock() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (/system\.tables/i.test(body)) {
      return sendJson(response, 200, {
        meta: [
          { name: 'database', type: 'String' },
          { name: 'name', type: 'String' },
          { name: 'engine', type: 'String' },
          { name: 'total_rows', type: 'Nullable(UInt64)' },
          { name: 'size', type: 'String' },
          { name: 'comment', type: 'String' },
        ],
        data: [{ database: 'app', name: 'orders', engine: 'MergeTree', total_rows: 42, size: '1.00 KB', comment: '' }],
        rows: 1,
      });
    }
    if (/^\s*DESCRIBE/i.test(body)) {
      return sendText(response, 200, 'name\ttype\tdefault_type\nid\tUInt64\t\namount\tDecimal(18, 2)\t\n');
    }
    if (/system\.processes/i.test(body)) {
      return sendJson(response, 200, { meta: [{ name: 'query' }], data: [{ query: 'SELECT 1' }], rows: 1 });
    }
    return sendJson(response, 200, {
      meta: [{ name: 'value', type: 'UInt8' }],
      data: [{ value: 1 }],
      rows: 1,
      statistics: { elapsed: 0.001, rows_read: 1 },
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startElasticMock() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method, url: request.url, body });
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/' || path === '') {
      return sendJson(response, 200, { version: { number: '8.11.0', lucene_version: '9.8.0', distribution: 'elasticsearch' }, cluster_name: 'mock-cluster', tagline: 'You Know, for Search' });
    }
    if (path.startsWith('/_cat/indices')) {
      return sendJson(response, 200, [
        { index: 'logs-2026', health: 'green', status: 'open', 'docs.count': '10', 'store.size': '1kb', pri: '1', rep: '0' },
      ]);
    }
    if (path.endsWith('/_mapping')) {
      return sendJson(response, 200, {
        'logs-2026': {
          mappings: {
            properties: {
              '@timestamp': { type: 'date' },
              message: { type: 'text' },
              user: { properties: { id: { type: 'keyword' } } },
            },
          },
        },
      });
    }
    if (path.endsWith('/_search')) {
      return sendJson(response, 200, {
        hits: { total: { value: 1 }, hits: [{ _id: 'abc', _score: 1.0, _source: { message: 'hello' } }] },
      });
    }
    return sendJson(response, 404, { error: { type: 'index_not_found_exception', reason: 'no such index' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
