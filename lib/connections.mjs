/**
 * Connection model: normalizes "environment variables / .env / compose / Spring config" into one Connection object.
 *
 * Hard constraints (the foundation of this whole skill):
 * - **Store no connection info**: no config file, no cache, no history; only the current process environment and project files are read;
 * - passwords live in memory only; every output (list, errors, logs, JSON) exposes just `passwordSet / passwordLength`;
 * - name conflicts and duplicate connections are never silently overwritten: they are recorded in notes and visible in `dbcli list`.
 */

import { UsageError } from './guard.mjs';

export const TYPE_ALIASES = {
  mysql: 'mysql',
  mariadb: 'mysql',
  percona: 'mysql',
  tidb: 'mysql',
  polardb: 'mysql',
  tdsql: 'mysql',
  goldendb: 'mysql',
  gbase: 'mysql',
  'gbase8a': 'mysql',
  oceanbase: 'oceanbase',
  ob: 'oceanbase',
  obmysql: 'oceanbase',
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  psql: 'postgres',
  kingbase: 'postgres',
  kingbasees: 'postgres',
  gaussdb: 'postgres',
  opengauss: 'postgres',
  vastbase: 'postgres',
  highgo: 'postgres',
  redshift: 'postgres',
  oracle: 'oracle',
  ora: 'oracle',
  dameng: 'dameng',
  dm: 'dameng',
  dm8: 'dameng',
  sqlserver: 'sqlserver',
  mssql: 'sqlserver',
  'sql-server': 'sqlserver',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  mongodb: 'mongodb',
  mongo: 'mongodb',
  redis: 'redis',
  rediss: 'redis',
  valkey: 'redis',
  keydb: 'redis',
  kafka: 'kafka',
  'kafka-cluster': 'kafka',
  redpanda: 'kafka',
  clickhouse: 'clickhouse',
  ch: 'clickhouse',
  elasticsearch: 'elasticsearch',
  es: 'elasticsearch',
  opensearch: 'elasticsearch',
  db2: 'db2',
};

export const TYPE_META = {
  mysql: { label: 'MySQL/MariaDB', kind: 'sql', driver: 'mysql', defaultPort: 3306 },
  oceanbase: { label: 'OceanBase', kind: 'sql', driver: 'oceanbase', defaultPort: 2881 },
  postgres: { label: 'PostgreSQL/Kingbase/GaussDB', kind: 'sql', driver: 'postgres', defaultPort: 5432 },
  oracle: { label: 'Oracle', kind: 'sql', driver: 'oracle', defaultPort: 1521 },
  dameng: { label: 'DM8', kind: 'sql', driver: 'dameng', defaultPort: 5236 },
  sqlserver: { label: 'SQL Server', kind: 'sql', driver: 'sqlserver', defaultPort: 1433 },
  sqlite: { label: 'SQLite', kind: 'sql', driver: 'sqlite', defaultPort: null },
  mongodb: { label: 'MongoDB', kind: 'mongo', driver: 'mongodb', defaultPort: 27017 },
  redis: { label: 'Redis', kind: 'redis', driver: 'redis', defaultPort: 6379 },
  kafka: { label: 'Kafka / Redpanda', kind: 'mq', driver: 'kafka', defaultPort: 9092 },
  clickhouse: { label: 'ClickHouse', kind: 'sql', driver: 'clickhouse', defaultPort: 8123 },
  elasticsearch: { label: 'Elasticsearch/OpenSearch', kind: 'es', driver: 'elasticsearch', defaultPort: 9200 },
  db2: { label: 'DB2', kind: 'unsupported', driver: 'db2', defaultPort: 50000 },
};

export function normalizeType(raw) {
  const key = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return TYPE_ALIASES[key] ?? null;
}

export function connectionKind(type) {
  return TYPE_META[type]?.kind ?? 'unsupported';
}

/** Strip the password out of a URL for redacted error messages */
export function redactUrl(raw) {
  const text = String(raw ?? '');
  // The username may be empty (redis://:password@host), so do not require one
  return text.replace(/\/\/([^/@\s]*):([^/@\s]*)@/g, (match, user) => `//${user}:***@`);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function truthy(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'required', 'require', 'verify-full', 'verify-ca', 'prefer'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disable', 'disabled', 'allow', 'none'].includes(text)) return false;
  return undefined;
}

function parseKeyValueList(text, separators = [';', '&']) {
  const out = {};
  const pattern = new RegExp(`[${separators.join('')}]`);
  for (const part of String(text ?? '').split(pattern)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) {
      out[trimmed.toLowerCase()] = true;
      continue;
    }
    out[trimmed.slice(0, at).trim().toLowerCase()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

/**
 * Parse a connection string. Supports:
 * - scheme://user:pass@host:port/db?k=v (mysql/postgres/oracle/sqlserver/mongodb/redis/clickhouse/es)
 * - mongodb+srv://, rediss://
 * - sqlite:path / sqlite:///abs/path / bare file path (with TYPE=sqlite)
 * - jdbc:mysql://... / jdbc:postgresql://... / jdbc:oracle:thin:@... / jdbc:sqlserver://...;databaseName=x
 * - Go-style DSN: user:pass@tcp(host:3306)/db
 * - libpq style: host=... port=... user=... password=... dbname=...
 */
export function parseConnectionUrl(raw, { hintType } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('connection string is empty');
  const hint = hintType ? normalizeType(hintType) : null;

  if (/^jdbc:/i.test(text)) return parseJdbc(text);

  if (/^kafka:/i.test(text)) return parseKafkaUrl(text);

  if (/^sqlite:/i.test(text) || /^file:/i.test(text)) {
    let path = text.replace(/^(sqlite|file):/i, '');
    if (path.startsWith('//')) path = path.slice(2);
    if (path.startsWith('/') && /^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
    path = decode(path);
    if (!path) throw new Error(`SQLite connection string is missing a file path: ${redactUrl(text)}`);
    return { type: 'sqlite', path, url: path, notes: [] };
  }

  // Go sql driver DSN: user:pass@tcp(host:3306)/db?charset=utf8mb4
  const goDsn = text.match(/^(?:([^:@\s]+):([^@\s]*)@)?tcp\(([^)]+)\)\/([^?\s]*)(?:\?(.*))?$/);
  if (goDsn) {
    const [, user, password, hostPort, database, query] = goDsn;
    const [host, port] = hostPort.split(':');
    return {
      type: hint ?? 'mysql',
      host,
      port: numberOrNull(port),
      user: user ? decode(user) : undefined,
      password: password !== undefined ? decode(password) : undefined,
      database: decode(database || ''),
      params: parseKeyValueList(query ?? '', ['&']),
      notes: [],
    };
  }

  // libpq style: host=x port=5432 user=y password=z dbname=w
  if (/^[A-Za-z_]+=\S+(\s+[A-Za-z_]+=\S+)+$/.test(text) && !/:\/\//.test(text)) {
    const kv = {};
    for (const part of text.split(/\s+/)) {
      const at = part.indexOf('=');
      if (at > 0) kv[part.slice(0, at).toLowerCase()] = part.slice(at + 1);
    }
    return {
      type: hint ?? 'postgres',
      host: kv.host,
      port: numberOrNull(kv.port),
      user: kv.user,
      password: kv.password,
      database: kv.dbname ?? kv.database,
      params: kv,
      ssl: truthy(kv.sslmode),
      notes: [],
    };
  }

  if (/^sqlserver:/i.test(text)) return parseSqlServerUrl(text);

  const schemeMatch = text.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (!schemeMatch) {
    if (hint === 'sqlite') return { type: 'sqlite', path: text, url: text, notes: [] };
    throw new Error(`unrecognized connection string (missing scheme://): ${redactUrl(text)}`);
  }
  const scheme = schemeMatch[1].toLowerCase();

  if (scheme === 'mongodb' || scheme === 'mongodb+srv') {
    let url;
    try {
      url = new URL(text);
    } catch (error) {
      throw new Error(`failed to parse MongoDB connection string: ${error.message}`);
    }
    return {
      type: 'mongodb',
      host: url.hostname || undefined,
      port: numberOrNull(url.port),
      user: url.username ? decode(url.username) : undefined,
      password: url.password ? decode(url.password) : undefined,
      database: decode((url.pathname || '').replace(/^\//, '')),
      params: Object.fromEntries(url.searchParams),
      url: text,
      notes: scheme === 'mongodb+srv' ? ['mongodb+srv: hosts are resolved via DNS SRV records'] : [],
    };
  }

  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error(`failed to parse connection string (${error.message}): ${redactUrl(text)}`);
  }
  const type = normalizeType(scheme) ?? hint;
  if (!type) throw new Error(`unknown scheme "${scheme}": set DB_<NAME>_TYPE to name the database type explicitly`);
  const params = Object.fromEntries(url.searchParams);
  const pathName = decode(url.pathname.replace(/^\//, ''));
  const notes = [];
  if (normalizeType(scheme) && normalizeType(scheme) !== scheme) {
    notes.push(`connecting with the ${TYPE_META[normalizeType(scheme)]?.label ?? scheme} protocol (original scheme: ${scheme})`);
  }
  const dialect = params.dialect ?? params.mode ?? params.compat ?? undefined;

  return {
    type,
    host: url.hostname || undefined,
    port: numberOrNull(url.port),
    user: url.username ? decode(url.username) : undefined,
    password: url.password ? decode(url.password) : undefined,
    database: pathName,
    schema: params.schema ?? params.currentSchema,
    ssl: truthy(params.ssl ?? params.sslmode ?? params.tls ?? params.secure),
    dialect,
    params,
    url: type === 'elasticsearch' || type === 'clickhouse' ? text : undefined,
    notes,
  };
}

/**
 * Kafka connection string: kafka://broker1:9092,broker2:9092?ssl=true&saslMechanism=scram-sha-256
 * Also accepts the user:pass@ SASL PLAIN form. new URL() cannot handle comma-separated broker lists, so parse it separately.
 */
function parseKafkaUrl(text) {
  const body = String(text).replace(/^kafka:\/\//i, '').replace(/^kafka:/i, '');
  const [authority, query] = body.split('?');
  let user;
  let password;
  let hosts = authority;
  const at = hosts.lastIndexOf('@');
  if (at !== -1) {
    const credentials = hosts.slice(0, at);
    hosts = hosts.slice(at + 1);
    const colon = credentials.indexOf(':');
    user = colon === -1 ? credentials : credentials.slice(0, colon);
    password = colon === -1 ? undefined : credentials.slice(colon + 1);
  }
  const brokers = hosts
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.includes(':') ? item : `${item}:9092`));
  if (!brokers.length) throw new Error('Kafka connection string is missing broker addresses, e.g. kafka://10.0.0.1:9092,10.0.0.2:9092');
  const params = query ? Object.fromEntries(new URLSearchParams(query)) : {};
  const [firstHost, firstPort] = brokers[0].split(':');
  return {
    type: 'kafka',
    brokers,
    host: firstHost,
    port: numberOrNull(firstPort) ?? 9092,
    user: user ? decode(user) : undefined,
    password: password !== undefined ? decode(password) : undefined,
    ssl: truthy(params.ssl ?? params.tls),
    dialect: params.saslMechanism ?? params.mechanism,
    params,
    notes: brokers.length > 1 ? [`${brokers.length} brokers listed; connecting to any one is enough`] : [],
  };
}

function parseSqlServerUrl(text) {
  const body = text.replace(/^sqlserver:\/\//i, '');
  const [authorityPart, ...propParts] = body.split(';');
  const props = parseKeyValueList(propParts.join(';'), [';']);
  let user;
  let password;
  let hostPort = authorityPart;
  const at = authorityPart.lastIndexOf('@');
  if (at !== -1) {
    hostPort = authorityPart.slice(at + 1);
    const credentials = authorityPart.slice(0, at);
    const colon = credentials.indexOf(':');
    user = colon === -1 ? credentials : credentials.slice(0, colon);
    password = colon === -1 ? undefined : credentials.slice(colon + 1);
  }
  if (props.user && !user) user = props.user;
  if (props.password && !password) password = props.password;
  const [host, port, instance] = hostPort.split(/[:,]/);
  return {
    type: 'sqlserver',
    host: host || undefined,
    port: numberOrNull(port),
    instance: instance || props.instancename || undefined,
    user,
    password,
    database: props.databasename ?? props.database ?? '',
    ssl: truthy(props.encrypt),
    params: props,
    notes: [],
  };
}

function parseJdbc(text) {
  const rest = text.replace(/^jdbc:/i, '');
  if (/^(mysql|mariadb):\/\//i.test(rest)) return { ...parseConnectionUrl(rest, { hintType: 'mysql' }), notes: ['from JDBC URL'] };
  if (/^postgresql:\/\//i.test(rest)) return { ...parseConnectionUrl(rest, { hintType: 'postgres' }), notes: ['from JDBC URL'] };
  if (/^clickhouse:\/\//i.test(rest)) return { ...parseConnectionUrl(rest, { hintType: 'clickhouse' }), notes: ['from JDBC URL'] };
  if (/^sqlite:/i.test(rest)) return { ...parseConnectionUrl(rest, { hintType: 'sqlite' }), notes: ['from JDBC URL'] };
  if (/^sqlserver:/i.test(rest)) return { ...parseSqlServerUrl(rest), notes: ['from JDBC URL'] };
  if (/^dm:\/\//i.test(rest)) {
    const parsed = parseConnectionUrl(rest.replace(/^dm:\/\//i, 'dm://'), { hintType: 'dameng' });
    return { ...parsed, notes: ['DM8 does not support direct queries yet; see "Unsupported engines" in SKILL.md'] };
  }
  if (/^(oracle|db2):/i.test(rest)) {
    const body = rest.replace(/^(oracle|db2):/i, '');
    const notes = ['from JDBC URL'];
    // oracle:thin:@//host:1521/service
    const thin = body.match(/(?:thin|oci):?@\/\/([^/:]+)(?::(\d+))?\/(.+)$/i);
    if (thin) {
      return {
        type: 'oracle',
        host: thin[1],
        port: numberOrNull(thin[2]),
        service: decode(thin[3]),
        database: decode(thin[3]),
        notes,
      };
    }
    // oracle:thin:@host:1521:SID
    const sid = body.match(/(?:thin|oci):?@([^:]+):(\d+):(\w+)$/i);
    if (sid) {
      return { type: 'oracle', host: sid[1], port: numberOrNull(sid[2]), sid: sid[3], database: sid[3], notes };
    }
    // descriptor: (HOST=x)(PORT=1521)(SERVICE_NAME=y)
    const host = body.match(/HOST\s*=\s*([^)\s]+)/i)?.[1];
    const port = body.match(/PORT\s*=\s*(\d+)/i)?.[1];
    const service = body.match(/(SERVICE_NAME|SID)\s*=\s*([^)\s]+)/i)?.[2];
    if (host) {
      return { type: 'oracle', host, port: numberOrNull(port), service, database: service, notes };
    }
    throw new Error(`failed to parse Oracle JDBC URL: ${redactUrl(text)}`);
  }
  throw new Error(`unsupported JDBC URL: ${redactUrl(text)}`);
}

const FIELD_ALIASES = {
  url: ['URL', 'DSN', 'URI'],
  type: ['TYPE', 'DRIVER', 'DIALECT', 'KIND'],
  host: ['HOST', 'HOSTNAME', 'SERVER', 'ADDR', 'ADDRESS'],
  port: ['PORT'],
  user: ['USER', 'USERNAME'],
  password: ['PASSWORD', 'PASS', 'PWD'],
  database: ['DATABASE', 'DBNAME', 'DB', 'NAME'],
  schema: ['SCHEMA'],
  ssl: ['SSL', 'SSLMODE', 'TLS'],
  params: ['PARAMS', 'OPTIONS'],
  service: ['SERVICE', 'SID', 'SERVICENAME', 'SIDNAME'],
  file: ['FILE', 'PATH', 'DBFILE', 'PATHNAME'],
  dialect: ['MODE', 'COMPAT', 'COMPATIBILITY', 'COMPATIBLE'],
  nodes: ['NODES', 'CLUSTER_NODES'],
};

/** `DB_<NAME>_<FIELD>` grouping; returns name → {fieldKey: value, source} */
function collectNamedGroups(varMap) {
  const groups = new Map();
  for (const [key, entry] of varMap) {
    const match = key.match(/^DB_([A-Za-z][A-Za-z0-9]*)_([A-Za-z][A-Za-z0-9]*)$/);
    if (!match) continue;
    const [, rawName, rawField] = match;
    const fieldKey = Object.entries(FIELD_ALIASES).find(([, aliases]) => aliases.includes(rawField.toUpperCase()))?.[0];
    if (!fieldKey) continue;
    const name = rawName.toLowerCase();
    if (!groups.has(name)) groups.set(name, { name, fields: {}, sources: {} });
    const group = groups.get(name);
    group.fields[fieldKey] = entry.value;
    group.sources[fieldKey] = { ...entry.source, var: key };
  }
  return groups;
}

function buildFromGroup(group, { typeHint, name, priority, label }) {
  const { fields, sources } = group;
  const notes = [];
  if (fields.url) {
    const parsed = parseConnectionUrl(fields.url, { hintType: fields.type ?? typeHint });
    return {
      ...baseConnection(parsed.type ?? typeHint, name, priority),
      ...parsed,
      notes: [...notes, ...(parsed.notes ?? [])],
      source: sources.url,
    };
  }
  const type = normalizeType(fields.type) ?? typeHint;
  if (!type) {
    return null;
  }
  if (type !== 'sqlite' && !fields.host && !fields.nodes) {
    const error = new Error(`set DB_${name.toUpperCase()}_HOST or DB_${name.toUpperCase()}_URL`);
    error.code = 'MISSING_HOST';
    throw error;
  }
  const nodes = parseNodeList(fields.nodes);
  const ssl = fields.ssl === undefined ? undefined : truthy(fields.ssl);
  return {
    ...baseConnection(type, name, priority),
    host: nodes.length ? nodes[0].split(':')[0] : fields.host,
    port: numberOrNull(fields.port) ?? (nodes.length ? numberOrNull(nodes[0].split(':')[1]) : null),
    nodes,
    cluster: nodes.length > 1,
    user: fields.user,
    password: fields.password,
    database: fields.database ?? '',
    schema: fields.schema,
    ssl,
    dialect: fields.dialect,
    service: fields.service,
    path: fields.file,
    params: parseKeyValueList(fields.params ?? '', ['&', ';']),
    notes: nodes.length > 1 ? [`cluster with ${nodes.length} nodes; single-node view (MOVED is not followed)`] : notes,
    source: sources.host ?? sources.url ?? sources.file ?? sources.user ?? Object.values(sources)[0],
  };
}

/** "a:6379,b:6379" → ['a:6379','b:6379'] */
function parseNodeList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.includes(':') ? item : `${item}:6379`));
}

export function baseConnection(type, name, priority) {
  const meta = TYPE_META[type];
  return {
    name,
    type,
    priority,
    host: undefined,
    port: null,
    user: undefined,
    password: undefined,
    database: '',
    schema: undefined,
    ssl: undefined,
    dialect: undefined,
    service: undefined,
    path: undefined,
    url: undefined,
    params: {},
    notes: [],
    source: undefined,
    meta: meta ?? { label: type, kind: 'unsupported' },
  };
}

const ECOSYSTEM_GROUPS = [
  {
    name: 'mysql',
    type: 'mysql',
    priority: 60,
    url: ['MYSQL_URL', 'MYSQL_DSN', 'MYSQL_URI'],
    fields: {
      host: ['MYSQL_HOST'],
      port: ['MYSQL_PORT'],
      user: ['MYSQL_USER', 'MYSQL_USERNAME'],
      password: ['MYSQL_PASSWORD', 'MYSQL_PWD', 'MYSQL_ROOT_PASSWORD'],
      database: ['MYSQL_DATABASE', 'MYSQL_DB', 'MYSQL_DBNAME'],
      ssl: ['MYSQL_SSL'],
      params: ['MYSQL_PARAMS', 'MYSQL_OPTIONS'],
    },
  },
  {
    name: 'postgres',
    type: 'postgres',
    priority: 60,
    url: ['POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'PG_DSN'],
    fields: {
      host: ['PGHOST', 'POSTGRES_HOST', 'PG_HOST'],
      port: ['PGPORT', 'POSTGRES_PORT', 'PG_PORT'],
      user: ['PGUSER', 'POSTGRES_USER', 'PG_USER'],
      password: ['PGPASSWORD', 'POSTGRES_PASSWORD', 'PG_PASSWORD'],
      database: ['PGDATABASE', 'POSTGRES_DB', 'POSTGRES_DATABASE', 'PG_DATABASE'],
      ssl: ['PGSSLMODE', 'POSTGRES_SSL'],
      params: ['PG_OPTIONS'],
      schema: ['PGSCHEMA'],
    },
  },
  {
    name: 'oracle',
    type: 'oracle',
    priority: 60,
    url: ['ORACLE_URL', 'ORACLE_DSN'],
    fields: {
      host: ['ORACLE_HOST'],
      port: ['ORACLE_PORT'],
      user: ['ORACLE_USER', 'ORACLE_USERNAME'],
      password: ['ORACLE_PASSWORD', 'ORACLE_PWD'],
      database: ['ORACLE_SERVICE', 'ORACLE_DATABASE', 'ORACLE_SID'],
      service: ['ORACLE_SERVICE_NAME', 'ORACLE_SERVICE', 'ORACLE_SID'],
      schema: ['ORACLE_SCHEMA'],
    },
  },
  {
    name: 'sqlserver',
    type: 'sqlserver',
    priority: 60,
    url: ['SQLSERVER_URL', 'MSSQL_URL', 'SQLSERVER_DSN'],
    fields: {
      host: ['SQLSERVER_HOST', 'MSSQL_HOST'],
      port: ['SQLSERVER_PORT', 'MSSQL_PORT'],
      user: ['SQLSERVER_USER', 'MSSQL_USER', 'MSSQL_SA_USER'],
      password: ['SQLSERVER_PASSWORD', 'MSSQL_PASSWORD', 'MSSQL_SA_PASSWORD'],
      database: ['SQLSERVER_DATABASE', 'MSSQL_DATABASE', 'MSSQL_DB'],
      ssl: ['SQLSERVER_ENCRYPT', 'MSSQL_ENCRYPT'],
    },
  },
  {
    name: 'redis',
    type: 'redis',
    priority: 60,
    url: ['REDIS_URL', 'REDIS_DSN'],
    fields: {
      host: ['REDIS_HOST'],
      port: ['REDIS_PORT'],
      user: ['REDIS_USER', 'REDIS_USERNAME'],
      password: ['REDIS_PASSWORD', 'REDIS_PWD'],
      database: ['REDIS_DB', 'REDIS_DATABASE'],
      ssl: ['REDIS_SSL', 'REDIS_TLS'],
      nodes: ['REDIS_CLUSTER_NODES', 'SPRING_REDIS_CLUSTER_NODES'],
    },
  },
  {
    name: 'mongodb',
    type: 'mongodb',
    priority: 60,
    url: ['MONGO_URL', 'MONGO_URI', 'MONGODB_URI', 'MONGODB_URL'],
    fields: {
      host: ['MONGO_HOST', 'MONGODB_HOST'],
      port: ['MONGO_PORT', 'MONGODB_PORT'],
      user: ['MONGO_USER', 'MONGO_USERNAME', 'MONGODB_USER'],
      password: ['MONGO_PASSWORD', 'MONGO_PWD', 'MONGODB_PASSWORD'],
      database: ['MONGO_DATABASE', 'MONGO_DB', 'MONGODB_DATABASE'],
    },
  },
  {
    name: 'clickhouse',
    type: 'clickhouse',
    priority: 60,
    url: ['CLICKHOUSE_URL', 'CLICKHOUSE_DSN'],
    fields: {
      host: ['CLICKHOUSE_HOST'],
      port: ['CLICKHOUSE_PORT'],
      user: ['CLICKHOUSE_USER', 'CLICKHOUSE_USERNAME'],
      password: ['CLICKHOUSE_PASSWORD', 'CLICKHOUSE_PWD'],
      database: ['CLICKHOUSE_DATABASE', 'CLICKHOUSE_DB'],
      ssl: ['CLICKHOUSE_SECURE', 'CLICKHOUSE_SSL'],
    },
  },
  {
    name: 'elasticsearch',
    type: 'elasticsearch',
    priority: 60,
    url: ['ELASTICSEARCH_URL', 'ELASTIC_URL', 'ES_URL', 'OPENSEARCH_URL'],
    fields: {
      host: ['ELASTICSEARCH_HOST', 'ES_HOST'],
      port: ['ELASTICSEARCH_PORT', 'ES_PORT'],
      user: ['ELASTICSEARCH_USER', 'ES_USER', 'ELASTIC_USER'],
      password: ['ELASTICSEARCH_PASSWORD', 'ES_PASSWORD', 'ELASTIC_PASSWORD'],
      database: ['ELASTICSEARCH_INDEX', 'ES_INDEX'],
      ssl: ['ELASTICSEARCH_SSL', 'ES_SSL'],
    },
  },
  {
    name: 'kafka',
    type: 'kafka',
    priority: 60,
    url: ['KAFKA_URL', 'KAFKA_DSN', 'KAFKA_CONNECT'],
    fields: {
      host: ['KAFKA_BROKERS', 'KAFKA_BOOTSTRAP_SERVERS', 'KAFKA_BROKER'],
      user: ['KAFKA_SASL_USERNAME', 'KAFKA_USERNAME', 'KAFKA_USER'],
      password: ['KAFKA_SASL_PASSWORD', 'KAFKA_PASSWORD'],
      ssl: ['KAFKA_SSL'],
      params: ['KAFKA_PARAMS'],
      dialect: ['KAFKA_SASL_MECHANISM', 'KAFKA_MECHANISM'],
    },
  },
  {
    name: 'sqlite',
    type: 'sqlite',
    priority: 60,
    url: ['SQLITE_URL', 'SQLITE_DSN'],
    fields: {
      file: ['SQLITE_PATH', 'SQLITE_FILE', 'SQLITE_DB', 'SQLITE_DATABASE'],
    },
  },
  {
    name: 'database',
    type: null,
    priority: 55,
    url: [],
    fields: {
      type: ['DATABASE_TYPE', 'DATABASE_DRIVER', 'DATABASE_DIALECT'],
      host: ['DATABASE_HOST'],
      port: ['DATABASE_PORT'],
      user: ['DATABASE_USER', 'DATABASE_USERNAME'],
      password: ['DATABASE_PASSWORD', 'DATABASE_PWD'],
      database: ['DATABASE_NAME', 'DATABASE_DB'],
      ssl: ['DATABASE_SSL'],
    },
  },
];

function collectEcosystemGroups(varMap) {
  const out = [];
  for (const group of ECOSYSTEM_GROUPS) {
    const fields = {};
    const sources = {};
    for (const [fieldKey, candidates] of Object.entries(group.fields)) {
      for (const candidate of candidates) {
        if (varMap.has(candidate)) {
          fields[fieldKey] = varMap.get(candidate).value;
          sources[fieldKey] = { ...varMap.get(candidate).source, var: candidate };
          break;
        }
      }
    }
    let urlEntry = null;
    for (const candidate of group.url) {
      if (varMap.has(candidate)) {
        urlEntry = { name: candidate, ...varMap.get(candidate) };
        break;
      }
    }
    if (!urlEntry && !Object.keys(fields).length) continue;
    out.push({ group, fields, sources, urlEntry });
  }
  return out;
}

/**
 * Environment variable table → connection list.
 * @param {Map<string,{value:string,source:object}>} varMap merged variables (later values already override earlier ones)
 */
export function buildConnections(varMap, { extra = [], warnings = [], defaultName } = {}) {
  const connections = [];
  const localWarnings = [...warnings];

  // 1) DB_<NAME>_* named groups (highest priority)
  for (const group of collectNamedGroups(varMap).values()) {
    const typeHint = group.fields.type ? normalizeType(group.fields.type) : null;
    const nameIsType = normalizeType(group.name);
    let conn;
    try {
      conn = buildFromGroup(group, {
        typeHint: typeHint ?? nameIsType,
        name: group.name,
        priority: 100,
        label: 'DB_*',
      });
    } catch (error) {
      localWarnings.push(
        error.code === 'MISSING_HOST'
          ? `variable group DB_${group.name.toUpperCase()}_* has no host: ${error.message}`
          : `variable group DB_${group.name.toUpperCase()}_* failed to parse: ${error.message}`,
      );
      continue;
    }
    if (!conn) {
      localWarnings.push(
        `variable group DB_${group.name.toUpperCase()}_* has no type: add DB_${group.name.toUpperCase()}_TYPE=mysql|postgres|... or put the type in the name`,
      );
      continue;
    }
    connections.push(conn);
  }

  // 2) Generic DB_URL (most common in single-database projects)
  if (varMap.has('DB_URL') || varMap.has('DB_DSN')) {
    const key = varMap.has('DB_URL') ? 'DB_URL' : 'DB_DSN';
    const entry = varMap.get(key);
    try {
      const parsed = parseConnectionUrl(entry.value, { hintType: varMap.get('DB_TYPE')?.value });
      connections.push({
        ...baseConnection(parsed.type, defaultName ?? 'default', 95),
        ...parsed,
        notes: parsed.notes ?? [],
        source: { ...entry.source, var: key },
      });
    } catch (error) {
      localWarnings.push(`failed to parse DB_URL: ${error.message}`);
    }
  }

  // 3) DATABASE_URL (common across Heroku/Rails/Node)
  if (varMap.has('DATABASE_URL')) {
    const entry = varMap.get('DATABASE_URL');
    try {
      const parsed = parseConnectionUrl(entry.value, { hintType: varMap.get('DATABASE_TYPE')?.value });
      connections.push({
        ...baseConnection(parsed.type, defaultName ?? 'default', 90),
        ...parsed,
        notes: parsed.notes ?? [],
        source: { ...entry.source, var: 'DATABASE_URL' },
      });
    } catch (error) {
      localWarnings.push(`failed to parse DATABASE_URL: ${error.message}`);
    }
  }

  // 4) JDBC_URL + SPRING_DATASOURCE_*
  if (varMap.has('JDBC_URL')) {
    const entry = varMap.get('JDBC_URL');
    try {
      const parsed = parseConnectionUrl(entry.value);
      connections.push({
        ...baseConnection(parsed.type, 'jdbc', 85),
        ...parsed,
        user: parsed.user ?? varMap.get('JDBC_USER')?.value,
        password: parsed.password ?? varMap.get('JDBC_PASSWORD')?.value,
        notes: parsed.notes ?? [],
        source: { ...entry.source, var: 'JDBC_URL' },
      });
    } catch (error) {
      localWarnings.push(`failed to parse JDBC_URL: ${error.message}`);
    }
  }

  if (varMap.has('SPRING_DATASOURCE_URL')) {
    const entry = varMap.get('SPRING_DATASOURCE_URL');
    try {
      const parsed = parseConnectionUrl(entry.value);
      connections.push({
        ...baseConnection(parsed.type, 'spring', 80),
        ...parsed,
        user: parsed.user ?? varMap.get('SPRING_DATASOURCE_USERNAME')?.value,
        password: parsed.password ?? varMap.get('SPRING_DATASOURCE_PASSWORD')?.value,
        notes: ['from Spring Boot config'],
        source: { ...entry.source, var: 'SPRING_DATASOURCE_URL' },
      });
    } catch (error) {
      localWarnings.push(`failed to parse SPRING_DATASOURCE_URL: ${error.message}`);
    }
  }

  if (varMap.has('SPRING_DATA_REDIS_HOST')) {
    const source = { ...varMap.get('SPRING_DATA_REDIS_HOST').source, var: 'SPRING_DATA_REDIS_HOST' };
    connections.push({
      ...baseConnection('redis', 'spring-redis', 80),
      host: varMap.get('SPRING_DATA_REDIS_HOST').value,
      port: numberOrNull(varMap.get('SPRING_DATA_REDIS_PORT')?.value),
      password: varMap.get('SPRING_DATA_REDIS_PASSWORD')?.value,
      database: varMap.get('SPRING_DATA_REDIS_DATABASE')?.value ?? '',
      notes: ['from Spring Boot config'],
      source,
    });
  }

  if (varMap.has('SPRING_DATA_MONGODB_URI')) {
    const entry = varMap.get('SPRING_DATA_MONGODB_URI');
    try {
      const parsed = parseConnectionUrl(entry.value);
      connections.push({
        ...baseConnection('mongodb', 'spring-mongo', 80),
        ...parsed,
        notes: ['from Spring Boot config', ...(parsed.notes ?? [])],
        source: { ...entry.source, var: 'SPRING_DATA_MONGODB_URI' },
      });
    } catch (error) {
      localWarnings.push(`failed to parse SPRING_DATA_MONGODB_URI: ${error.message}`);
    }
  }

  // 5) Ecosystem convention variables (MYSQL_* / PGHOST / REDIS_* / MONGO_URI ...)
  for (const item of collectEcosystemGroups(varMap)) {
    const { group, fields, sources, urlEntry } = item;
    if (urlEntry) {
      try {
        const parsed = parseConnectionUrl(urlEntry.value, { hintType: group.type });
        connections.push({
          ...baseConnection(parsed.type ?? group.type, group.name, group.priority),
          ...parsed,
          notes: parsed.notes ?? [],
          source: { ...urlEntry.source, var: urlEntry.name },
        });
        continue;
      } catch (error) {
        localWarnings.push(`${urlEntry.name} failed to parse: ${error.message}`);
      }
    }
    const type = normalizeType(fields.type) ?? group.type;
    if (!type) {
      localWarnings.push(`DATABASE_* / bare variable group has no type: add DATABASE_TYPE=mysql|postgres|...`);
      continue;
    }
    if (type !== 'sqlite' && !fields.host && !fields.nodes) {
      const hint = group.fields?.host?.join(' or ') ?? 'a host variable';
      localWarnings.push(`${group.name}: no host configured (set ${hint} or a URL); connection skipped`);
      continue;
    }
    const nodes = parseNodeList(fields.nodes);
    connections.push({
      ...baseConnection(type, group.name, group.priority),
      host: nodes.length ? nodes[0].split(':')[0] : fields.host,
      port: numberOrNull(fields.port) ?? (nodes.length ? numberOrNull(nodes[0].split(':')[1]) : null),
      nodes,
      cluster: nodes.length > 1,
      user: fields.user,
      password: fields.password,
      database: fields.database ?? '',
      schema: fields.schema,
      ssl: fields.ssl === undefined ? undefined : truthy(fields.ssl),
      dialect: fields.dialect,
      path: fields.file,
      params: parseKeyValueList(fields.params ?? '', ['&', ';']),
      notes: nodes.length > 1 ? [`cluster with ${nodes.length} nodes; single-node view (MOVED is not followed)`] : [],
      source: sources.host ?? sources.file ?? sources.user ?? Object.values(sources)[0],
    });
  }

  // 6) Mined from project files (compose / application.yml), lowest priority
  for (const conn of extra) connections.push(conn);

  return { connections: finalizeConnections(connections, localWarnings, defaultName), warnings: localWarnings };
}

function finalizeConnections(connections, warnings, defaultName) {
  const byFingerprint = new Map();
  const kept = [];
  for (const conn of connections) {
    if (!conn.type) continue;
    if (!TYPE_META[conn.type]) {
      warnings.push(`connection ${conn.name} has unsupported type ${conn.type}, skipped`);
      continue;
    }
    // Defaults and normalisation must run before de-duplication, otherwise the
    // same target can appear twice (one with an explicit port, one without).
    conn.port = conn.port ?? TYPE_META[conn.type]?.defaultPort ?? null;
    conn.kind = connectionKind(conn.type);
    if (conn.type === 'kafka') normalizeKafka(conn);

    // Never connect to a value that is still a Spring placeholder: the user
    // needs to know why the datasource was skipped.
    const unresolved = [conn.url, conn.host, conn.database, conn.path]
      .filter((value) => typeof value === 'string')
      .find((value) => /\$\{[^}]+\}/.test(value));
    if (unresolved) {
      const names = [...new Set([...String(unresolved).matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)].map((match) => match[1]))];
      warnings.push(
        `connection ${conn.name} skipped: it still contains an unresolved placeholder ${names.map((name) => `\${${name}}`).join(', ')}; define it in the environment or pass --env-file <file> that defines it`,
      );
      continue;
    }

    if (conn.type !== 'sqlite' && conn.type !== 'unsupported' && !conn.host && !conn.url) {
      warnings.push(`connection ${conn.name} has no host, skipped`);
      continue;
    }
    const fingerprint = connectionFingerprint(conn);
    if (byFingerprint.has(fingerprint)) {
      const existing = byFingerprint.get(fingerprint);
      existing.aliases = [...(existing.aliases ?? []), conn.name];
      existing.notes = [...(existing.notes ?? []), `points at the same target as ${conn.name} (merged; source ${sourceText(conn.source)})`];
      continue;
    }
    byFingerprint.set(fingerprint, conn);
    kept.push(conn);
  }

  // Same name, different target: add a suffix so --db stays unambiguous
  const names = new Map();
  for (const conn of kept) {
    const count = names.get(conn.name) ?? 0;
    names.set(conn.name, count + 1);
    if (count > 0) {
      const renamed = `${conn.name}-${count + 1}`;
      conn.notes = [...(conn.notes ?? []), `original name ${conn.name} was already taken (different target), renamed to ${renamed}`];
      conn.name = renamed;
    }
  }

  for (const conn of kept) {
    conn.default = false;
  }

  const explicitDefault =
    (defaultName && kept.find((conn) => conn.name.toLowerCase() === String(defaultName).toLowerCase())) ||
    (kept.length === 1 ? kept[0] : null);
  if (explicitDefault) explicitDefault.default = true;

  kept.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name));
  return kept;
}

function normalizeKafka(conn) {
  if (conn.url && /^kafka:/i.test(conn.url)) {
    try {
      Object.assign(conn, parseKafkaUrl(conn.url));
    } catch {
      /* keep it as-is and let the driver layer report the error */
    }
  }
  if (!Array.isArray(conn.brokers) || !conn.brokers.length) {
    const list = String(conn.host ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    conn.brokers = list.map((item) => (item.includes(':') ? item : `${item}:${conn.port ?? 9092}`));
  }
  if (conn.brokers.length) {
    const [host, port] = conn.brokers[0].split(':');
    conn.host = host;
    conn.port = Number.parseInt(port, 10) || 9092;
  }
}

export function connectionFingerprint(conn) {
  const file = conn.path ? String(conn.path).replace(/\\/g, '/').replace(/^\.\//, '') : '';
  const brokers = Array.isArray(conn.brokers) ? conn.brokers.join(',') : '';
  return [conn.type, conn.host ?? '', conn.port ?? '', conn.database || '', file, brokers, conn.user ?? '', conn.schema ?? '']
    .join('|')
    .toLowerCase();
}

export function sourceText(source) {
  if (!source) return 'unknown source';
  if (source.kind === 'process') return `process environment ${source.var ?? ''}`.trim();
  if (source.kind === 'envfile') return `${source.path}${source.line ? `:${source.line}` : ''}${source.var ? ` (${source.var})` : ''}`;
  if (source.kind === 'compose') return `${source.path}${source.line ? `:${source.line}` : ''} (compose ${source.var ?? ''})`.trim();
  if (source.kind === 'spring') return `${source.path}${source.var ? ` (${source.var})` : ''}`;
  if (source.kind === 'cli') return 'command line argument';
  return [source.path, source.var].filter(Boolean).join(' ') || 'unknown source';
}

/** Safe view for output: never carries the password */
export function describeConnection(conn) {
  return {
    name: conn.name,
    default: Boolean(conn.default),
    type: conn.type,
    label: TYPE_META[conn.type]?.label ?? conn.type,
    kind: conn.kind,
    host: conn.host ?? null,
    port: conn.port ?? null,
    database: conn.database || null,
    schema: conn.schema ?? null,
    user: conn.user ?? null,
    path: conn.path ?? null,
    brokers: conn.brokers ?? null,
    nodes: conn.nodes ?? null,
    cluster: Boolean(conn.cluster),
    passwordSet: Boolean(conn.password),
    ssl: conn.ssl ?? null,
    source: conn.source ? { kind: conn.source.kind, path: conn.source.path ?? null, line: conn.source.line ?? null, var: conn.source.var ?? null } : null,
    sourceText: sourceText(conn.source),
    notes: conn.notes ?? [],
    aliases: conn.aliases ?? [],
  };
}

/** One-line target description, e.g. mysql://app@10.0.0.1:3306/erp */
export function targetText(conn) {
  if (conn.type === 'sqlite') return `sqlite:${conn.path ?? '(no file specified)'}`;
  if (conn.type === 'kafka') {
    const brokers = Array.isArray(conn.brokers) && conn.brokers.length ? conn.brokers : [`${conn.host}:${conn.port ?? 9092}`];
    return `kafka://${brokers.join(',')}`;
  }
  if (conn.type === 'redis' && Array.isArray(conn.nodes) && conn.nodes.length > 1) {
    return `redis://${conn.host}:${conn.port} (+${conn.nodes.length - 1} cluster nodes)`;
  }
  if (conn.type === 'mongodb' && conn.url) return redactUrl(conn.url);
  const auth = conn.user ? `${conn.user}@` : '';
  const db = conn.database ? `/${conn.database}` : '';
  return `${conn.type}://${auth}${conn.host ?? 'localhost'}${conn.port ? `:${conn.port}` : ''}${db}`;
}

/** Pick a connection by name/type/substring; never guess: with multiple candidates, error out and list them */
export function resolveConnection(connections, ref, { purpose = 'running' } = {}) {
  if (!connections.length) {
    throw new UsageError(
      [
        'No usable database connection found.',
        'Configure environment variables in the project (re-read on every call; the skill itself stores no connection info):',
        '  DB_URL=mysql://user:pass@127.0.0.1:3306/app          # single-database project',
        '  DB_ERP_URL=postgres://user:pass@10.0.0.5:5432/erp    # multi-database project, select with --db erp',
        'You can also put them in the project root .env (discovered automatically), or pass dbcli --env-file <path>.',
        'Run `dbcli list` to see what was discovered, and `dbcli env` to see where each variable came from.',
      ].join('\n'),
    );
  }

  const target = String(ref ?? '').trim();
  if (!target) {
    const preset = connections.find((conn) => conn.default);
    if (preset) return preset;
    throw new UsageError(
      [
        `Found ${connections.length} connections; pick one with --db before ${purpose}:`,
        ...connections.map((conn) => `  --db ${conn.name}  ${targetText(conn)}`),
        '(a single connection is selected automatically; you can also set DB_DEFAULT=<name> to choose a default)',
      ].join('\n'),
    );
  }

  const lower = target.toLowerCase();
  const exact = connections.filter((conn) => conn.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const byType = connections.filter((conn) => conn.type === normalizeType(target));
  if (byType.length === 1) return byType[0];
  const partial = connections.filter(
    (conn) => conn.name.toLowerCase().includes(lower) || String(conn.database ?? '').toLowerCase() === lower,
  );
  if (partial.length === 1) return partial[0];
  const pool = exact.length ? exact : byType.length ? byType : partial;
  if (pool.length > 1) {
    throw new UsageError(
      [`--db ${target} is ambiguous, candidates:`, ...pool.map((conn) => `  ${conn.name}  ${targetText(conn)}`)].join('\n'),
    );
  }
  throw new UsageError(
    [`no connection named "${target}". Available:`, ...connections.map((conn) => `  ${conn.name}  ${targetText(conn)}`)].join('\n'),
  );
}
