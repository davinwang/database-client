/**
 * Connection discovery on the project side.
 *
 * Answers one question: **which database should this call actually connect to?**
 * Order (later overrides earlier):
 *   1) the .env family in the project root / current directory
 *   2) explicit --env-file (repeatable, in the given order)
 *   3) process environment (the agent host usually injects per-project values here)
 * Below that (lower priority, fallback only): docker-compose.yml, Spring application.yml/properties.
 *
 * Read-only throughout: no file writes, no generated config, no cached passwords. Missing files are skipped, not errors.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readEnvFile } from './env.mjs';
import { getPath, parseProperties, parseYaml, flattenPaths } from './yaml.mjs';
import { baseConnection, normalizeType, parseConnectionUrl, TYPE_META } from './connections.mjs';
import { extractConfigConnections, listConfigFiles } from './configfiles.mjs';

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'composer.json',
  'settings.gradle',
];

const ENV_FILE_ORDER = ['.env', '.env.local'];

export function isDatabaseVar(name) {
  return /^(DB_|DATABASE_|MYSQL_|MARIADB_|PG[A-Z_]*|POSTGRES|POSTGRESQL_|ORACLE_|REDIS_|MONGO|MONGODB_|CLICKHOUSE_|ELASTIC|ES_|OPENSEARCH_|SQLSERVER|MSSQL_|SQLITE_|KAFKA_|SPRING_DATASOURCE|SPRING_DATA_|SPRING_REDIS|SPRING_ELASTICSEARCH|JDBC_)/i.test(
    name,
  );
}

/** Walk up from startDir to find the project root (a directory with .git/package.json/pom.xml and similar markers) */
export async function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  const home = path.resolve(os.homedir());
  for (let depth = 0; depth < 8; depth += 1) {
    for (const marker of PROJECT_MARKERS) {
      try {
        await fs.access(path.join(current, marker));
        return current;
      } catch {
        /* keep looking */
      }
    }
    // A .env also counts as a project root (some small projects have no package.json)
    try {
      await fs.access(path.join(current, '.env'));
      return current;
    } catch {
      /* keep looking */
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    if (current === home) break;
    current = parent;
  }
  return path.resolve(startDir);
}

export function currentProfile(env = process.env) {
  const raw = env.SPRING_PROFILES_ACTIVE || env.APP_ENV || env.NODE_ENV || env.PROFILE || env.ENV || '';
  const first = String(raw).split(',')[0].trim();
  return first && first !== 'undefined' ? first : '';
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Candidate .env file names (low → high priority) */
export function envFileNames(profile) {
  const names = [...ENV_FILE_ORDER];
  if (profile) names.push(`.env.${profile}`, `.env.${profile}.local`);
  return names;
}

/** Find the .env files that should be read (project root + current directory, ordered by priority) */
export async function listEnvFiles({ cwd, projectRoot, profile }) {
  const dirs = [...new Set([path.resolve(projectRoot), path.resolve(cwd)])];
  const found = [];
  for (const dir of dirs) {
    for (const name of envFileNames(profile)) {
      const file = path.join(dir, name);
      if (await exists(file)) found.push({ path: file, dir, name });
    }
  }
  return found;
}

export async function listComposeFiles({ cwd, projectRoot }) {
  const dirs = [...new Set([path.resolve(projectRoot), path.resolve(cwd)])];
  const names = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  const found = [];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (await exists(file)) found.push(file);
    }
  }
  return [...new Set(found)];
}

export async function listSpringFiles({ cwd, projectRoot, profile }) {
  const dirs = [...new Set([path.resolve(projectRoot), path.resolve(cwd)])];
  const subdirs = ['', 'config', path.join('src', 'main', 'resources')];
  const bases = ['application.properties', 'application.yml', 'application.yaml'];
  const found = [];
  for (const dir of dirs) {
    for (const sub of subdirs) {
      for (const base of bases) {
        const file = path.join(dir, sub, base);
        if (await exists(file)) found.push({ path: file, base: true });
        if (profile) {
          const profiled = path.join(dir, sub, base.replace(/^application/, `application-${profile}`));
          if (await exists(profiled)) found.push({ path: profiled, base: false });
        }
      }
    }
  }
  const unique = new Map();
  for (const item of found) unique.set(item.path, item);
  return [...unique.values()];
}

function lookupVar(varMap, name) {
  const entry = varMap.get(name);
  return entry ? entry.value : undefined;
}

function expandPlaceholders(text, varMap) {
  if (typeof text !== 'string') return text;
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::([^}]*))?\}/g, (match, name, fallback) => {
    const value = lookupVar(varMap, name) ?? process.env[name];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    return match;
  });
}

/** docker-compose → connection candidates */
export async function extractComposeConnections({ files, varMap, warnings }) {
  const connections = [];
  for (const file of files) {
    let data;
    try {
      const text = await fs.readFile(file, 'utf8');
      const parsed = parseYaml(text);
      for (const warning of parsed.warnings) warnings.push(`${file}: ${warning}`);
      data = parsed.data;
    } catch (error) {
      warnings.push(`${file}: read failed ${error.message}`);
      continue;
    }
    const services = data?.services;
    if (!services || typeof services !== 'object') continue;

    for (const [serviceName, service] of Object.entries(services)) {
      if (!service || typeof service !== 'object') continue;
      const image = String(service.image ?? '');
      const type = detectServiceType(image, service);
      if (!type) continue;
      const meta = TYPE_META[type];
      if (!meta) continue;

      const env = normalizeComposeEnv(service.environment, varMap);
      const portInfo = pickComposePort(service.ports, meta.defaultPort);
      if (!portInfo) {
        warnings.push(`${file}: service ${serviceName} has no usable port mapping, skipped (compose-internal addresses are unreachable from the host)`);
        continue;
      }
      const notes = [];
      const host = portInfo.host ?? '127.0.0.1';
      if (portInfo.fromServiceName) notes.push('no ports mapping in compose, trying the host default port (likely unreachable; publish the port in compose)');

      const credentials = composeCredentials(type, env, service, varMap);
      const conn = {
        ...baseConnection(type, `compose-${serviceName}`, 40),
        host,
        port: portInfo.port,
        user: credentials.user,
        password: credentials.password,
        database: credentials.database ?? '',
        params: {},
        notes: [...notes, `service ${serviceName} from ${path.basename(file)} (${image || 'no image'})`],
        source: { kind: 'compose', path: file, var: serviceName },
      };
      connections.push(conn);
    }
  }
  return connections;
}

function detectServiceType(image, service) {
  const text = `${image} ${service?.container_name ?? ''}`.toLowerCase();
  if (/mariadb|mysql|percona/.test(text)) return 'mysql';
  if (/postgres|postgis|timescale/.test(text)) return 'postgres';
  if (/redis|valkey|keydb/.test(text)) return 'redis';
  if (/mongo/.test(text)) return 'mongodb';
  if (/clickhouse/.test(text)) return 'clickhouse';
  if (/elasticsearch|opensearch/.test(text)) return 'elasticsearch';
  if (/oracle/.test(text)) return 'oracle';
  if (/mssql|sqlserver/.test(text)) return 'sqlserver';
  return null;
}

function normalizeComposeEnv(raw, varMap) {
  const env = {};
  if (!raw) return env;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const at = item.indexOf('=');
      if (at === -1) continue;
      env[item.slice(0, at).trim()] = expandPlaceholders(item.slice(at + 1).trim(), varMap);
    }
    return env;
  }
  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      env[key] = value === null || value === undefined ? '' : expandPlaceholders(String(value), varMap);
    }
  }
  return env;
}

function pickComposePort(ports, defaultPort) {
  if (!Array.isArray(ports) || !ports.length) {
    return defaultPort ? { port: defaultPort, host: '127.0.0.1', fromServiceName: true } : null;
  }
  for (const item of ports) {
    let published = null;
    let target = null;
    if (typeof item === 'object' && item) {
      published = item.published ?? item.host_port ?? null;
      target = item.target ?? null;
    } else if (typeof item === 'string' || typeof item === 'number') {
      const text = String(item);
      const parts = text.split(':');
      if (parts.length === 1) published = parts[0];
      else if (parts.length === 2) {
        published = parts[0];
        target = parts[1];
      } else {
        published = parts[1];
        target = parts[2];
      }
    }
    const publishedNum = Number.parseInt(String(published ?? ''), 10);
    if (Number.isFinite(publishedNum) && publishedNum > 0) {
      const targetNum = Number.parseInt(String(target ?? ''), 10);
      return { port: publishedNum, host: '127.0.0.1', target: Number.isFinite(targetNum) ? targetNum : null };
    }
  }
  if (!defaultPort) return null;
  return { port: defaultPort, host: '127.0.0.1', fromServiceName: true };
}

function composeCredentials(type, env, service, varMap) {
  const pick = (...names) => {
    for (const name of names) {
      if (env[name] !== undefined && env[name] !== '') return env[name];
    }
    return undefined;
  };
  const commandText = Array.isArray(service?.command) ? service.command.join(' ') : String(service?.command ?? '');
  switch (type) {
    case 'mysql':
      return {
        user: pick('MYSQL_USER') ?? (pick('MYSQL_ROOT_PASSWORD') ? 'root' : undefined),
        password: pick('MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD'),
        database: pick('MYSQL_DATABASE', 'MYSQL_DB'),
      };
    case 'postgres':
      return {
        user: pick('POSTGRES_USER') ?? (pick('POSTGRES_PASSWORD') ? 'postgres' : undefined),
        password: pick('POSTGRES_PASSWORD'),
        database: pick('POSTGRES_DB', 'POSTGRES_DATABASE'),
      };
    case 'mongodb':
      return {
        user: pick('MONGO_INITDB_ROOT_USERNAME', 'MONGO_USERNAME'),
        password: pick('MONGO_INITDB_ROOT_PASSWORD', 'MONGO_PASSWORD'),
        database: pick('MONGO_INITDB_DATABASE', 'MONGO_DATABASE'),
      };
    case 'redis': {
      const requirepass = commandText.match(/--requirepass\s+(\S+)/)?.[1];
      return { user: pick('REDIS_USER'), password: pick('REDIS_PASSWORD') ?? requirepass, database: '' };
    }
    case 'clickhouse':
      return { user: pick('CLICKHOUSE_USER') ?? 'default', password: pick('CLICKHOUSE_PASSWORD'), database: pick('CLICKHOUSE_DB', 'CLICKHOUSE_DATABASE') };
    case 'elasticsearch':
      return { user: pick('ELASTIC_USERNAME') ?? (pick('ELASTIC_PASSWORD') ? 'elastic' : undefined), password: pick('ELASTIC_PASSWORD') };
    case 'oracle':
      return {
        user: pick('APP_USER') ?? 'system',
        password: pick('APP_USER_PASSWORD', 'ORACLE_PWD', 'ORACLE_PASSWORD'),
        database: pick('ORACLE_DATABASE', 'APP_USER'),
      };
    case 'sqlserver':
      return { user: 'sa', password: pick('MSSQL_SA_PASSWORD', 'SA_PASSWORD', 'MSSQL_PASSWORD'), database: pick('MSSQL_DATABASE') };
    default:
      return {};
  }
}

/** Spring application.yml/properties → connection candidates */
export async function extractSpringConnections({ files, varMap, warnings }) {
  const merged = new Map(); // flat key → {value, path}
  for (const item of files) {
    let text;
    try {
      text = await fs.readFile(item.path, 'utf8');
    } catch (error) {
      warnings.push(`${item.path}: read failed ${error.message}`);
      continue;
    }
    let flat;
    if (item.path.endsWith('.properties')) {
      const parsed = parseProperties(text);
      for (const warning of parsed.warnings) warnings.push(`${item.path}: ${warning}`);
      flat = parsed.data;
    } else {
      const parsed = parseYaml(text);
      for (const warning of parsed.warnings) warnings.push(`${item.path}: ${warning}`);
      flat = flattenPaths(parsed.data);
    }
    for (const [key, value] of Object.entries(flat)) {
      if (value === null || value === undefined) continue;
      merged.set(key, { value, path: item.path });
      // Some projects keep real credentials in a dotenv-style
      // `application-<profile>.properties` (DATASOURCE_URL=...). Feed those into
      // the variable map so `spring.datasource.url: ${DATASOURCE_URL}` resolves
      // without requiring --env-file.
      if (/^[A-Z][A-Z0-9_]*$/.test(key) && !varMap.has(key) && !/\$\{[^}]+\}/.test(String(value))) {
        varMap.set(key, { value: String(value), source: { kind: 'spring', path: item.path, var: key } });
      }
    }
  }

  const connections = [];
  const read = (...keys) => {
    for (const key of keys) {
      const entry = merged.get(key);
      if (entry !== undefined) return { value: entry.value, key, path: entry.path };
    }
    return undefined;
  };

  const datasourceUrl = read('spring.datasource.url', 'spring.datasource.druid.url', 'spring.datasource.hikari.jdbc-url', 'spring.r2dbc.url');
  if (datasourceUrl) {
    const raw = expandPlaceholders(String(datasourceUrl.value), varMap);
    const unresolved = [...new Set([...raw.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)].map((match) => match[1]))];
    if (unresolved.length) {
      warnings.push(
        `spring.datasource.url (${datasourceUrl.path}) still contains unresolved placeholder(s) ${unresolved.map((name) => `\${${name}}`).join(', ')}; ` +
          'define them in the environment or pass --env-file <file> that defines them - datasource skipped',
      );
    } else {
      try {
        const normalized = raw.replace(/^r2dbc:/i, '');
        const parsed = parseConnectionUrl(normalized);
        const user = expandPlaceholders(String(read('spring.datasource.username')?.value ?? ''), varMap);
        const password = expandPlaceholders(String(read('spring.datasource.password')?.value ?? ''), varMap);
        connections.push({
          ...baseConnection(parsed.type, 'spring', 30),
          ...parsed,
          user: parsed.user ?? (user || undefined),
          password: parsed.password ?? (password || undefined),
          notes: [`${datasourceUrl.key} from ${datasourceUrl.path}`],
          source: { kind: 'spring', path: datasourceUrl.path, var: datasourceUrl.key },
        });
      } catch (error) {
        warnings.push(`failed to parse the Spring datasource (${datasourceUrl.key}): ${error.message}`);
      }
    }
  }

  // dynamic-datasource (com.baomidou): spring.datasource.dynamic.datasource.<name>.*
  const dynamicPrefix = 'spring.datasource.dynamic.datasource.';
  const dynamicNames = new Set();
  for (const key of merged.keys()) {
    if (key.startsWith(dynamicPrefix)) dynamicNames.add(key.slice(dynamicPrefix.length).split('.')[0]);
  }
  const dynamicPrimary = String(read('spring.datasource.dynamic.primary')?.value ?? '');
  for (const name of dynamicNames) {
    const entry = read(`${dynamicPrefix}${name}.url`, `${dynamicPrefix}${name}.jdbc-url`);
    if (!entry) continue;
    const raw = expandPlaceholders(String(entry.value), varMap);
    const unresolved = [...new Set([...raw.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)].map((match) => match[1]))];
    if (unresolved.length) {
      warnings.push(
        `${entry.key} still contains unresolved placeholder(s) ${unresolved.map((item) => `\${${item}}`).join(', ')}; datasource "${name}" skipped`,
      );
      continue;
    }
    try {
      const parsed = parseConnectionUrl(raw.replace(/^r2dbc:/i, ''));
      const user = expandPlaceholders(String(read(`${dynamicPrefix}${name}.username`)?.value ?? ''), varMap);
      const password = expandPlaceholders(String(read(`${dynamicPrefix}${name}.password`)?.value ?? ''), varMap);
      connections.push({
        ...baseConnection(parsed.type, `spring-${name}`, 30),
        ...parsed,
        user: parsed.user ?? (user || undefined),
        password: parsed.password ?? (password || undefined),
        notes: [`dynamic-datasource "${name}"${dynamicPrimary === name ? ' (primary)' : ''} from ${entry.path}`],
        source: { kind: 'spring', path: entry.path, var: entry.key },
      });
    } catch (error) {
      warnings.push(`failed to parse dynamic datasource "${name}": ${error.message}`);
    }
  }

  const redisCluster = read('spring.redis.cluster.nodes', 'spring.data.redis.cluster.nodes');
  const redisHost = read('spring.data.redis.host', 'spring.redis.host');
  if (redisCluster) {
    const rawNodes = Array.isArray(redisCluster.value) ? redisCluster.value : String(redisCluster.value).split(',');
    const nodes = rawNodes
      .map((item) => String(item).trim())
      .filter(Boolean)
      .map((item) => (item.includes(':') ? item : `${item}:6379`));
    if (nodes.length) {
      connections.push({
        ...baseConnection('redis', 'spring-redis', 30),
        host: nodes[0].split(':')[0],
        port: Number.parseInt(nodes[0].split(':')[1], 10) || 6379,
        nodes,
        cluster: nodes.length > 1,
        password: expandPlaceholders(String(read('spring.data.redis.password', 'spring.redis.password')?.value ?? ''), varMap) || undefined,
        database: String(read('spring.data.redis.database', 'spring.redis.database')?.value ?? ''),
        notes: [`${redisCluster.key} from ${redisCluster.path}`, `cluster with ${nodes.length} nodes; single-node view (MOVED is not followed)`],
        source: { kind: 'spring', path: redisCluster.path, var: redisCluster.key },
      });
    }
  } else if (redisHost) {
    const host = expandPlaceholders(String(redisHost.value), varMap);
    if (/\$\{[^}]+\}/.test(host)) {
      warnings.push(
        `${redisHost.key} still contains an unresolved placeholder ${host}; define it in the environment or pass --env-file - Redis skipped`,
      );
    } else {
      connections.push({
        ...baseConnection('redis', 'spring-redis', 30),
        host,
        port: Number.parseInt(String(read('spring.data.redis.port', 'spring.redis.port')?.value ?? ''), 10) || null,
        password: expandPlaceholders(String(read('spring.data.redis.password', 'spring.redis.password')?.value ?? ''), varMap) || undefined,
        database: String(read('spring.data.redis.database', 'spring.redis.database')?.value ?? ''),
        notes: [`${redisHost.key} from ${redisHost.path}`],
        source: { kind: 'spring', path: redisHost.path, var: redisHost.key },
      });
    }
  }

  const mongoUri = read('spring.data.mongodb.uri');
  if (mongoUri) {
    const raw = expandPlaceholders(String(mongoUri.value), varMap);
    try {
      const parsed = parseConnectionUrl(raw);
      connections.push({
        ...baseConnection('mongodb', 'spring-mongo', 30),
        ...parsed,
        notes: [`${mongoUri.key} from ${mongoUri.path}`],
        source: { kind: 'spring', path: mongoUri.path, var: mongoUri.key },
      });
    } catch (error) {
      warnings.push(`failed to parse Spring MongoDB config: ${error.message}`);
    }
  }

  const esUris = read('spring.elasticsearch.uris', 'spring.data.elasticsearch.uris');
  if (esUris) {
    const raw = Array.isArray(esUris.value) ? esUris.value[0] : String(esUris.value).split(',')[0];
    if (raw) {
      try {
        const parsed = parseConnectionUrl(expandPlaceholders(String(raw).trim(), varMap), { hintType: 'elasticsearch' });
        connections.push({
          ...baseConnection('elasticsearch', 'spring-es', 30),
          ...parsed,
          notes: [`${esUris.key} from ${esUris.path}`],
          source: { kind: 'spring', path: esUris.path, var: esUris.key },
        });
      } catch (error) {
        warnings.push(`failed to parse Spring Elasticsearch config: ${error.message}`);
      }
    }
  }

  return connections;
}

/**
 * Run discovery in one pass: read env → merge → mine compose/spring for fallback connections.
 * @returns {Promise<{cwd:string, projectRoot:string, varMap:Map, layers:any[], shadowed:any[], extra:any[], files:any, warnings:string[]}>}
 */
export async function discover({ cwd = process.cwd(), envFiles = [], noAuto = false, processEnv = process.env } = {}) {
  const warnings = [];
  const layers = [];
  const projectRoot = await findProjectRoot(cwd);
  const profile = currentProfile(processEnv);

  let autoEnv = [];
  let composeFiles = [];
  let springFiles = [];
  let configFiles = [];
  if (!noAuto) {
    autoEnv = await listEnvFiles({ cwd, projectRoot, profile });
    composeFiles = await listComposeFiles({ cwd, projectRoot });
    springFiles = await listSpringFiles({ cwd, projectRoot, profile });
    configFiles = await listConfigFiles({ cwd, projectRoot });
  }

  // 1) Read .env files in order (project root first, then the current directory; generic before profile-specific)
  for (const item of autoEnv) {
    const parsed = await readEnvFile(item.path);
    if (!parsed) continue;
    for (const warning of parsed.warnings) warnings.push(`${item.path}: ${warning}`);
    layers.push({ kind: 'envfile', path: item.path, vars: parsed.vars, priority: layers.length });
  }

  // 2) Explicit --env-file
  for (const file of envFiles) {
    const resolved = path.resolve(cwd, file);
    const parsed = await readEnvFile(resolved);
    if (!parsed) {
      warnings.push(`the file given to --env-file does not exist: ${resolved}`);
      continue;
    }
    for (const warning of parsed.warnings) warnings.push(`${resolved}: ${warning}`);
    layers.push({ kind: 'envfile', path: resolved, vars: parsed.vars, priority: layers.length, explicit: true });
  }

  // 3) Merge: low-priority files → high-priority files → process environment (highest)
  const varMap = new Map();
  const shadowed = [];
  const apply = (name, value, source) => {
    if (varMap.has(name)) {
      shadowed.push({ name, previous: varMap.get(name), replacedBy: source });
    }
    varMap.set(name, { value, source });
  };
  for (const layer of layers) {
    for (const [name, entry] of layer.vars) {
      apply(name, entry.value, { kind: layer.kind, path: layer.path, line: entry.line, var: name });
    }
  }
  for (const [name, value] of Object.entries(processEnv ?? {})) {
    if (value === undefined) continue;
    apply(name, String(value), { kind: 'process', var: name });
  }

  // 4) compose / spring / other config formats fallback
  let extra = [];
  if (!noAuto) {
    const configResult = await extractConfigConnections({ files: configFiles, varMap, warnings });
    extra = [
      ...(await extractComposeConnections({ files: composeFiles, varMap, warnings })),
      ...(await extractSpringConnections({ files: springFiles, varMap, warnings })),
      ...configResult.connections,
    ];
  }

  return {
    cwd: path.resolve(cwd),
    projectRoot,
    profile,
    varMap,
    layers,
    shadowed,
    extra,
    files: {
      env: autoEnv.map((item) => item.path),
      explicitEnv: envFiles.map((file) => path.resolve(cwd, file)),
      compose: composeFiles,
      spring: springFiles.map((item) => item.path),
      config: configFiles,
    },
    warnings,
  };
}

/** For list/env display: keep only variables that look like database settings */
export function relevantVars(varMap) {
  const out = [];
  for (const [name, entry] of varMap) {
    if (isDatabaseVar(name)) out.push({ name, ...entry });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export { normalizeType };
