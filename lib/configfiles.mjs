/**
 * Language-agnostic configuration-file adapters.
 *
 * The skill is not tied to Java or Python: connections are discovered from the
 * formats projects actually use, and every adapter is independent so adding a new
 * ecosystem does not touch the others.
 *
 *   1. .NET        appsettings*.json  -> ConnectionStrings:<name> (ADO.NET or URL)
 *   2. Node        ormconfig.json / config/*.json -> connection-shaped objects
 *   3. Ruby/Rails  database.yml       -> adapter/host/database/username/password
 *   4. Any         *.ini (alembic.ini, config.ini) and generic JSON/YAML/properties
 *                  -> values that look like database URLs (mysql://, postgres://, ...)
 *
 * Nothing here writes files or resolves credentials beyond reading the project.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { baseConnection, normalizeType, parseConnectionUrl, TYPE_META } from './connections.mjs';
import { flattenPaths, parseProperties, parseYaml } from './yaml.mjs';

const SCHEME_RE = /^(mysql|mariadb|postgres|postgresql|oracle|sqlserver|mongodb|redis|rediss|clickhouse|kafka):\/\//i;
const DB_KEY_HINT = /(url|dsn|uri|connection|datasource|database|db_?host|redis|mongo|clickhouse|elasticsearch)/i;

/** Candidate config files, in a stable order. */
export async function listConfigFiles({ cwd, projectRoot }) {
  const dirs = [...new Set([path.resolve(projectRoot), path.resolve(cwd)])];
  const fixed = [
    'appsettings.json',
    'ormconfig.json',
    'config.json',
    'database.yml',
    'database.yaml',
    'alembic.ini',
    'settings.ini',
    'config.ini',
    path.join('config', 'database.yml'),
    path.join('config', 'default.json'),
    path.join('config', 'config.json'),
  ];
  const found = [];
  for (const dir of dirs) {
    for (const name of fixed) {
      const file = path.join(dir, name);
      if (await exists(file)) found.push(file);
    }
    // appsettings.<Environment>.json and config/*.json
    for (const [sub, pattern] of [
      ['', /^appsettings\..+\.json$/i],
      ['config', /\.json$/i],
    ]) {
      const target = path.join(dir, sub);
      let entries = [];
      try {
        entries = await fs.readdir(target);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!pattern.test(entry)) continue;
        const file = path.join(target, entry);
        found.push(file);
      }
    }
  }
  return [...new Set(found)];
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Expand ${VAR} and Rails' <%= ENV['VAR'] %> against the discovered variables. */
export function expandConfigValue(raw, varMap) {
  let text = String(raw ?? '');
  text = text.replace(/<%\s*=\s*ENV\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]\s*%>/g, (match, name) => {
    const value = varMap?.get(name)?.value;
    return value === undefined ? match : value;
  });
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::([^}]*))?\}/g, (match, name, fallback) => {
    const value = varMap?.get(name)?.value;
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    return match;
  });
  return text;
}

function parseIni(text) {
  const data = {};
  let section = '';
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const header = trimmed.match(/^\[(.+)]$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const at = trimmed.search(/[=:]/);
    if (at === -1) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (!key) continue;
    data[section ? `${section}.${key}` : key] = value;
  }
  return data;
}

function readFlattened(file, text) {
  if (file.endsWith('.json')) {
    const parsed = JSON.parse(text);
    return { flat: flattenPaths(parsed), json: parsed, kind: 'json' };
  }
  if (file.endsWith('.yml') || file.endsWith('.yaml')) {
    const parsed = parseYaml(text).data;
    return { flat: flattenPaths(parsed), json: parsed, kind: 'yaml' };
  }
  if (file.endsWith('.ini')) return { flat: parseIni(text), json: null, kind: 'ini' };
  return { flat: parseProperties(text).data, json: null, kind: 'properties' };
}

/** ADO.NET connection string (Server=...;Database=...;User Id=...;Password=...). */
export function parseAdoConnectionString(raw, varMap) {
  const text = expandConfigValue(raw, varMap);
  if (SCHEME_RE.test(text)) {
    try {
      return { ...parseConnectionUrl(text), notes: ['connection string with a URL scheme'] };
    } catch {
      return null;
    }
  }
  const parts = new Map();
  for (const chunk of text.split(';')) {
    const at = chunk.indexOf('=');
    if (at <= 0) continue;
    parts.set(chunk.slice(0, at).trim().toLowerCase(), chunk.slice(at + 1).trim());
  }
  const pick = (...keys) => {
    for (const key of keys) {
      const value = parts.get(key);
      if (value !== undefined && value !== '') return value;
    }
    return undefined;
  };
  const hostRaw = pick('host', 'server', 'data source', 'address');
  if (!hostRaw) return null;
  const [hostPart, portPart] = hostRaw.replace(/^tcp:/i, '').split(',');
  const type = parts.has('host') ? 'postgres' : 'sqlserver';
  return {
    type,
    host: hostPart.trim(),
    port: Number(portPart ?? pick('port')) || TYPE_META[type].defaultPort,
    database: pick('database', 'initial catalog') ?? '',
    user: pick('user id', 'uid', 'username', 'user'),
    password: pick('password', 'pwd'),
    notes: ['ADO.NET connection string'],
  };
}

function isConnectionObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = normalizeType(value.type ?? value.dialect ?? value.driver);
  return Boolean(type) && Boolean(value.host || value.database || value.file || value.filename);
}

function connectionFromObject(value, name, source) {
  const type = normalizeType(value.type ?? value.dialect ?? value.driver);
  if (!type) return null;
  return {
    ...baseConnection(type, name, 25),
    host: value.host ?? value.hostname,
    port: value.port ? Number(value.port) : null,
    user: value.username ?? value.user,
    password: value.password,
    database: value.database ?? value.db ?? '',
    schema: value.schema,
    path: value.file ?? value.filename,
    ssl: value.ssl === true ? true : undefined,
    notes: ['connection object from a config file'],
    source: { kind: 'config', path: source.path, var: source.key },
  };
}

function walkObjects(value, visit, keyPath = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObjects(item, visit, keyPath ? `${keyPath}[${index}]` : `[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (isConnectionObject(value)) visit(value, keyPath);
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') walkObjects(child, visit, keyPath ? `${keyPath}.${key}` : key);
  }
}

/**
 * Turn config files into connection candidates.
 * @returns {Promise<{connections: any[], warnings: string[]}>}
 */
export async function extractConfigConnections({ files, varMap, warnings = [] }) {
  const connections = [];
  const seen = new Set();
  const add = (conn, { replace = false } = {}) => {
    if (!conn || !conn.type || !TYPE_META[conn.type]) return;
    if (replace) {
      const index = connections.findIndex((item) => item.name === conn.name);
      if (index !== -1) {
        const old = connections[index];
        const oldFingerprint = `${old.name}|${old.host ?? old.path ?? ''}|${old.port ?? ''}|${old.database ?? ''}`;
        seen.delete(oldFingerprint);
        connections[index] = conn;
        seen.add(`${conn.name}|${conn.host ?? conn.path ?? ''}|${conn.port ?? ''}|${conn.database ?? ''}`);
        return;
      }
    }
    const fingerprint = `${conn.name}|${conn.host ?? conn.path ?? ''}|${conn.port ?? ''}|${conn.database ?? ''}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    connections.push(conn);
  };

  // Process the generic appsettings.json before appsettings.<Environment>.json so the
  // environment-specific file can override it (that is how .NET resolves them).
  const ordered = [...files].sort((a, b) => {
    const rank = (file) => {
      const base = path.basename(file).toLowerCase();
      if (base === 'appsettings.json') return 0;
      if (/^appsettings\..+\.json$/.test(base)) return 2;
      return 1;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  for (const file of ordered) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      warnings.push(`${file}: read failed ${error.message}`);
      continue;
    }
    // Windows editors (Visual Studio) may write a UTF-8 BOM; JSON.parse rejects it.
    text = String(text).replace(/^\uFEFF/, '');
    const base = path.basename(file).toLowerCase();

    // Ruby/Rails database.yml
    if (base === 'database.yml' || base === 'database.yaml') {
      const data = parseYaml(text).data ?? {};
      for (const [environment, config] of Object.entries(data)) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
        const adapter = String(config.adapter ?? '');
        const type = /postgres/i.test(adapter)
          ? 'postgres'
          : /mysql|trilogy/i.test(adapter)
            ? 'mysql'
            : /sqlite/i.test(adapter)
              ? 'sqlite'
              : null;
        if (!type) continue;
        add({
          ...baseConnection(type, `rails-${environment}`, 25),
          host: config.host ? expandConfigValue(config.host, varMap) : undefined,
          port: config.port ? Number(expandConfigValue(config.port, varMap)) : null,
          user: config.username ? expandConfigValue(config.username, varMap) : undefined,
          password: config.password ? expandConfigValue(config.password, varMap) : undefined,
          database: config.database ? expandConfigValue(config.database, varMap) : '',
          path: config.database && type === 'sqlite' ? expandConfigValue(config.database, varMap) : undefined,
          notes: [`Rails database.yml (${environment})`],
          source: { kind: 'config', path: file, var: environment },
        });
      }
      continue;
    }

    let parsed;
    try {
      parsed = readFlattened(file, text);
    } catch (error) {
      warnings.push(`${file}: parse failed ${error.message}`);
      continue;
    }

    // .NET appsettings*.json -> ConnectionStrings
    if (/^appsettings.*\.json$/i.test(base)) {
      for (const [key, value] of Object.entries(parsed.flat)) {
        const match = key.match(/^ConnectionStrings\.(.+)$/i);
        if (!match || typeof value !== 'string') continue;
        const ado = parseAdoConnectionString(value, varMap);
        if (!ado) continue;
        add(
          {
            ...baseConnection(ado.type, `dotnet-${match[1].toLowerCase()}`, 25),
            ...ado,
            source: { kind: 'config', path: file, var: key },
          },
          { replace: true },
        );
      }
    }

    // Connection-shaped objects (TypeORM ormconfig.json, node-config, ...)
    if (parsed.json) {
      walkObjects(parsed.json, (object, keyPath) => {
        const name = `config-${sanitizeName(keyPath) || 'object'}`;
        add(connectionFromObject(object, name, { path: file, key: keyPath }));
      });
    }

    // Generic URL / DSN values in database-ish keys
    for (const [key, value] of Object.entries(parsed.flat)) {
      if (typeof value !== 'string' || value.length > 2048) continue;
      if (!DB_KEY_HINT.test(key)) continue;
      const expanded = expandConfigValue(value, varMap);
      if (!SCHEME_RE.test(expanded)) continue;
      if (/\$\{|\{\{|<%/.test(expanded)) continue;
      try {
        const parsedUrl = parseConnectionUrl(expanded);
        if (!parsedUrl.type) continue;
        add({
          ...baseConnection(parsedUrl.type, `config-${sanitizeName(key)}`, 25),
          ...parsedUrl,
          notes: [`URL value from ${path.basename(file)}`],
          source: { kind: 'config', path: file, var: key },
        });
      } catch {
        /* Not a usable URL, ignore */
      }
    }
  }

  return { connections, warnings };
}

function sanitizeName(key) {
  return String(key)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'connection';
}
