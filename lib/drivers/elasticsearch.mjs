/**
 * Elasticsearch / OpenSearch driver (zero-dependency: HTTP REST).
 *
 * ES has no SQL (unless the SQL plugin is installed), so `dbcli query` takes a "REST spec":
 *   dbcli query '/_cat/indices?format=json'
 *   dbcli query '{"method":"POST","path":"/logs-<pattern>/_search","body":{"size":5,"query":{"match_all":{}}}}'
 * Write control lives in guard.mjs (only GET/HEAD and a few POST query endpoints are allowed).
 */

import { UnsupportedError } from '../errors.mjs';
import { result, elapsedMs } from './shared.mjs';
import { httpRequest } from './http.mjs';

function esError(json, text) {
  const error = json?.error;
  if (typeof error === 'string') return error;
  if (error?.reason) return `${error.type ?? 'error'}: ${error.reason}`;
  return String(text ?? '').slice(0, 300);
}

function flattenMapping(properties, prefix = '', out = []) {
  for (const [name, definition] of Object.entries(properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (definition.properties) flattenMapping(definition.properties, path, out);
    else {
      out.push([path, definition.type ?? (definition.fields ? 'object' : 'unknown'), definition.index === false ? 'no' : 'yes']);
    }
  }
  return out;
}

export async function create(conn, options = {}) {
  const base = conn.url ? new URL(conn.url) : new URL(`${conn.ssl ? 'https' : 'http'}://${conn.host}:${conn.port ?? 9200}`);
  if (!/^https?:$/.test(base.protocol)) base.protocol = conn.ssl ? 'https:' : 'http:';
  const authorization = conn.user ? `Basic ${Buffer.from(`${conn.user}:${conn.password ?? ''}`).toString('base64')}` : null;

  async function request(path, { method = 'GET', body } = {}) {
    const suffix = String(path ?? '/').startsWith('/') ? String(path) : `/${path}`;
    const target = new URL(`${base.toString().replace(/\/$/, '')}${suffix}`);
    const headers = { Accept: 'application/json' };
    if (authorization) headers.Authorization = authorization;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const started = performance.now();
    const response = await httpRequest(target.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: options.timeoutMs ?? 30000,
      insecureTls: options.insecureTls,
    });
    let json = null;
    if (response.text) {
      try {
        json = JSON.parse(response.text);
      } catch {
        json = null;
      }
    }
    if (response.status >= 400) throw new Error(`Elasticsearch ${response.status}: ${esError(json, response.text)}`);
    return { data: json ?? response.text, durationMs: elapsedMs(started) };
  }

  return {
    type: 'elasticsearch',

    async ping() {
      const started = performance.now();
      const { data } = await request('/');
      const version = data?.version?.number ?? 'unknown';
      return {
        version: `Elasticsearch ${version}`,
        database: data?.cluster_name ?? null,
        user: conn.user ?? null,
        latencyMs: elapsedMs(started),
        extra: { tagline: data?.tagline, distribution: data?.version?.distribution, lucene: data?.version?.lucene_version },
      };
    },

    async query(spec, { mode = 'read' } = {}) {
      if (mode !== 'read') {
        throw new UnsupportedError('For Elasticsearch writes use a dedicated REST call (this CLI is read-only troubleshooting)', {
          hint: 'Endpoints sufficient for read-only troubleshooting: _search / _count / _cat/* / _mapping / _stats / _cluster/health.',
        });
      }
      let path = '/';
      let method = 'GET';
      let body;
      if (typeof spec === 'string') {
        path = spec;
      } else if (spec && typeof spec === 'object') {
        path = spec.path ?? spec.url ?? '/';
        method = (spec.method ?? 'GET').toUpperCase();
        body = spec.body ?? spec.query;
      }
      const { data, durationMs } = await request(path, { method, body });
      if (typeof data === 'string') return result(null, ['response'], [[data]], { durationMs });
      if (Array.isArray(data)) {
        const columns = Object.keys(data[0] ?? {});
        if (!columns.length) return { title: path, documents: data, durationMs };
        return result(path, columns, data.map((row) => columns.map((name) => row[name])), { durationMs });
      }
      if (Array.isArray(data?.hits?.hits)) {
        const total = data.hits.total?.value ?? data.hits.hits.length;
        return {
          title: `${path} matched ${total} hits (showing ${data.hits.hits.length})`,
          documents: data.hits.hits.map((hit) => ({ _id: hit._id, _score: hit._score, ...hit._source })),
          durationMs,
          truncated: data.hits.hits.length < total,
        };
      }
      return { title: path, json: data, durationMs };
    },

    async tables({ pattern } = {}) {
      const glob = pattern ? String(pattern).replace(/%/g, '*') : '';
      const indexPath = glob ? `/${glob.includes('*') ? glob : `${glob}*`}` : '';
      const path = `/_cat/indices${indexPath}?format=json&h=index,health,status,docs.count,store.size,pri,rep&expand_wildcards=all&s=index`;
      const { data, durationMs } = await request(path);
      const rows = (Array.isArray(data) ? data : []).map((row) => [
        row.index,
        row.health,
        row.status,
        row['docs.count'],
        row['store.size'],
        row.pri,
        row.rep,
      ]);
      return result('Indices', ['index', 'health', 'status', 'docs.count', 'store.size', 'pri', 'rep'], rows, { durationMs });
    },

    async describe(index) {
      const { data, durationMs } = await request(`/${index}/_mapping`);
      const rows = [];
      for (const [indexName, meta] of Object.entries(data ?? {})) {
        for (const field of flattenMapping(meta?.mappings?.properties)) rows.push([indexName, ...field]);
      }
      if (!rows.length) throw new Error(`Index does not exist or has no fields: ${index} (use dbcli tables to list indexes)`);
      return result(`Field mappings ${index}`, ['index', 'field', 'type', 'indexed'], rows, { durationMs });
    },

    async search(index, { query, size, sort } = {}) {
      const body = { size: Number(size) > 0 ? Number(size) : 10, query: query ?? { match_all: {} } };
      if (sort) body.sort = sort;
      const { data, durationMs } = await request(`/${index}/_search`, { method: 'POST', body });
      const hits = data?.hits?.hits ?? [];
      return {
        title: `${index} matched ${data?.hits?.total?.value ?? hits.length} hits (showing ${hits.length})`,
        documents: hits.map((hit) => ({ _id: hit._id, _score: hit._score, ...hit._source })),
        durationMs,
        truncated: hits.length < (data?.hits?.total?.value ?? hits.length),
      };
    },

    async indexes() {
      throw new UnsupportedError('Elasticsearch has no relational indexes', {
        hint: 'Field mappings: `dbcli desc <index>`; index-level stats: `dbcli query "/<index>/_stats"`.',
      });
    },

    async ddl() {
      throw new UnsupportedError('Elasticsearch has no DDL', {
        hint: 'Indexes are defined by mapping: `dbcli desc <index>` shows field types; use `dbcli query "/<index>/_settings"` for settings.',
      });
    },

    async locks() {
      throw new UnsupportedError('Elasticsearch has no lock waits', {
        hint: [
          'When the cluster is "stuck", usually check:',
          '  GET /_cluster/health?pretty            -- status and unassigned shards',
          '  GET /_cat/thread_pool?v&h=node_name,name,active,queue,rejected',
          '  GET /_tasks?actions=*search*           -- currently running tasks',
        ].join('\n'),
      });
    },

    async slow() {
      throw new UnsupportedError('Elasticsearch has no slow query list (unless slow logs are enabled)', {
        hint: 'Slow logs live in index settings: look for search.slowlog in `dbcli query "/<index>/_settings?include_defaults=true&flat_settings=true"`; or check /_nodes/stats/indices/search.',
      });
    },

    async close() {
      /* HTTP is stateless */
    },
  };
}
