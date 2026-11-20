/**
 * Error → next action.
 *
 * Database errors often say only "Access denied" or "connection refused", leaving an agent to guess.
 * This maps the most common errors to "most likely cause + what to check first", and **never echoes
 * passwords** (if a connection string leaks into an error message, it is masked).
 */

import { redactUrl, targetText } from './connections.mjs';

export class UnsupportedError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'UnsupportedError';
    this.exitCode = 1;
    this.hint = hint;
  }
}

export class ConnectionError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'ConnectionError';
    this.exitCode = 6;
    this.hint = hint;
  }
}

/** Replace any password that may appear in an error object */
export function scrub(text, conn) {
  let out = String(text ?? '');
  if (conn?.password) {
    const password = String(conn.password);
    if (password.length >= 3) out = out.split(password).join('***');
  }
  out = out.replace(/\/\/([^/@\s:]+):([^/@\s]*)@/g, '//$1:***@');
  return out;
}

function codeOf(error) {
  return String(error?.code ?? error?.errno ?? error?.sqlState ?? error?.number ?? error?.errorNum ?? '').trim();
}

/**
 * @returns {string|null} Multi-line hint (without the "Error:" prefix); null when unrecognised
 */
export function explainError(error, conn) {
  if (!error) return null;
  const code = codeOf(error);
  const message = String(error.message ?? error ?? '');
  const text = `${code} ${message}`;
  const type = conn?.type ?? '';
  const net = explainNetwork(text, conn);
  if (net) return net;

  if (type === 'mysql') return explainMysql(text, message);
  if (type === 'postgres') return explainPostgres(text, message);
  if (type === 'oracle') return explainOracle(text, message);
  if (type === 'sqlserver') return explainSqlServer(text, message);
  if (type === 'mongodb') return explainMongo(text, message);
  if (type === 'redis') return explainRedis(text, message);
  if (type === 'kafka') return explainKafka(text, message);
  if (type === 'clickhouse') return explainClickhouse(text, message);
  if (type === 'elasticsearch') return explainElastic(text, message);
  if (type === 'sqlite') return explainSqlite(text, message);
  return null;
}

function explainNetwork(text, conn) {
  const host = conn ? `${conn.host ?? ''}${conn.port ? `:${conn.port}` : ''}` : 'target';
  const isKafka = conn?.type === 'kafka';
  if (/ECONNREFUSED|Connection refused|connect ECONNREFUSED/i.test(text)) {
    if (isKafka) {
      return [
        `Cannot reach Kafka broker ${host} (connection refused).`,
        'Check: 1) broker address/port are correct (list every broker, comma separated); 2) this host can reach that address;',
        '3) if bootstrap connects but later connections fail, **advertised.listeners** usually advertises an address the client cannot reach (container/internal address).',
      ].join('\n');
    }
    return [
      `Cannot reach ${host} (connection refused): nothing is listening on that port.`,
      'Check: 1) the database/container is really running (docker ps); 2) the port is right (did compose publish it to the host?); 3) you are not connecting to a container-internal address.',
    ].join('\n');
  }
  if (/ETIMEDOUT|ETIMEOUT|timeout expired|Connection timed out|connect timeout|Query timeout|request timeout|Connection timeout/i.test(text)) {
    if (isKafka) {
      return [
        `Kafka ${host} connection timed out: the network is blocked, a security group is dropping traffic, or the broker's advertised.listeners points at an unreachable address.`,
        'Use `dbcli ping --db <name>` to verify bootstrap only; when cluster metadata cannot be fetched, suspect advertised.listeners first.',
      ].join('\n');
    }
    return [
      `Connecting to ${host} timed out: the network is unreachable or blocked by a firewall.`,
      'Check: 1) connectivity from this host (Test-NetConnection / telnet); 2) cloud security groups, K8s NetworkPolicy, bastion hosts; 3) connect to the VPN first when one is required.',
      'For long queries add --timeout <ms>.',
    ].join('\n');
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Name or service not known|nodename nor servname/i.test(text)) {
    return `Host name resolution failed (${host}): the name is missing from DNS or hosts, or the VPN is not connected.`;
  }
  if (/ECONNRESET|socket hang up|Connection lost|server closed the connection/i.test(text)) {
    return [
      'Connection reset: usually a TLS/SSL requirement mismatch, a proxy interfering, or the database dropping idle connections.',
      'Try: add --ssl (when encryption is required) or --no-ssl (when the server does not support TLS); for cloud databases also check the IP allowlist.',
    ].join('\n');
  }
  if (/self[- ]signed certificate|unable to verify the first certificate|CERT_HAS_EXPIRED|depth zero self-signed|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(text)) {
    return [
      'TLS certificate verification failed (self-signed/expired).',
      'Common on internal databases: once you have confirmed the certificate is fine, add --insecure-tls to skip verification (only on networks you trust).',
    ].join('\n');
  }
  if (/EHOSTUNREACH|ENETUNREACH|No route to host/i.test(text)) return `Route unreachable (${host}): traffic does not get through at the network layer; check VPN / routes / security groups first.`;
  return null;
}

function explainMysql(text, message) {
  if (/ER_ACCESS_DENIED_ERROR|Access denied for user/i.test(text)) {
    return [
      'MySQL authentication failed (wrong user or password, or this user is not allowed to log in from this IP).',
      'Check the password source: `dbcli list` shows which env var/file line was used; watch for stray quotes/newlines from the shell.',
      'Remote login restrictions: SELECT user,host FROM mysql.user; see whether only localhost is allowed.',
    ].join('\n');
  }
  if (/ER_DBACCESS_DENIED_ERROR|Access denied for user.*to database/i.test(text)) return 'The account connects but has no access to this database: use another account, or ask the DBA to grant access (the database name may also be wrong).';
  if (/ER_BAD_DB_ERROR|Unknown database/i.test(text)) return 'Database does not exist: `dbcli query "SHOW DATABASES"` lists available names; watch case and -/_ differences.';
  if (/ER_NO_SUCH_TABLE|Table .* doesn't exist/i.test(text)) return 'Table does not exist: `dbcli tables <keyword>` to confirm the database/table name; you may be on the wrong database (--db) or missing the schema prefix.';
  if (/ER_TABLEACCESS_DENIED_ERROR|command denied to user/i.test(text)) return 'The account has no SELECT privilege on this table: use a read-only account or ask the DBA for a grant.';
  if (/ER_MUST_CHANGE_PASSWORD|must be changed/i.test(text)) return 'The account password has expired and must be changed first (this CLI does not change passwords).';
  if (/ER_ACCESS_DENIED_NO_PASSWORD_ERROR/i.test(text)) return 'The account has no password but the server requires one: check whether PASSWORD in the env is empty/not injected.';
  if (/ER_NOT_SUPPORTED_YET|Unknown system variable/i.test(text)) {
    return 'The server version does not support this statement (e.g. performance_schema views do not exist before 5.6). Run `dbcli ping` to see the version first.';
  }
  if (/performance_schema|events_statements_summary_by_digest/i.test(text) && /doesn't exist|denied/i.test(text)) {
    return [
      'Slow queries depend on performance_schema (on by default in MySQL 5.7+, but it may be disabled or unprivileged).',
      'Run `dbcli query "SHOW VARIABLES LIKE \'performance_schema\'"` first; if it is off, a DBA must enable it and restart.',
      'Workaround meanwhile: `dbcli query "SHOW FULL PROCESSLIST"` shows what is running, `dbcli locks` shows lock waits.',
    ].join('\n');
  }
  return null;
}

function explainPostgres(text, message) {
  if (/28P01|password authentication failed/i.test(text)) return 'PostgreSQL password incorrect (28P01): check where the env var comes from, and note the auth method pg_hba.conf requires (md5/scram).';
  if (/28000|no pg_hba\.conf entry/i.test(text)) return 'pg_hba.conf does not allow this IP/user: ask the DBA to add an entry, or confirm you are connecting to the right instance.';
  if (/3D000|database .* does not exist/i.test(text)) return 'Database does not exist (3D000): `dbcli query "SELECT datname FROM pg_database"` lists names; the default database may not be the one you expect.';
  if (/42P01|relation .* does not exist/i.test(text)) return 'Table/view does not exist (42P01): confirm with `dbcli tables`; PG is case-sensitive, so quoted table names must be written exactly.';
  if (/42501|permission denied/i.test(text)) return 'Insufficient privilege (42501): the account lacks SELECT on that table/function.';
  if (/53300|too many clients|remaining connection slots/i.test(text)) {
    return [
      'Connections exhausted (53300): not your query\'s fault, the instance is saturated.',
      'See who is using them: `dbcli query "SELECT count(*) FROM pg_stat_activity"` and `dbcli query "SELECT state, count(*) FROM pg_stat_activity GROUP BY state"` (idle connections show up there).',
    ].join('\n');
  }
  if (/57P03|cannot connect now|starting up/i.test(text)) return 'The instance is starting up / recovering (57P03): retry in a moment.';
  if (/25006|read-only transaction|cannot execute .* in a read-only transaction/i.test(text)) {
    return 'The connection is a read-only transaction, so the write was rejected — that is this CLI\'s default behaviour. Writing requires explicit --allow-write and user approval first.';
  }
  if (/57014|canceling statement due to statement timeout/i.test(text)) return 'The query was cancelled by statement_timeout: narrow the scope (add WHERE/LIMIT) or adjust the CLI-side timeout with --timeout.';
  return null;
}

function explainOracle(text, message) {
  if (/ORA-01017/i.test(text)) return 'Oracle user/password incorrect (ORA-01017): some environments require an uppercase user name, or a service name/SID.';
  if (/ORA-12541|no listener/i.test(text)) return 'The Oracle listener is not running (ORA-12541): confirm the host, port 1521 and the service name.';
  if (/ORA-12514|listener does not currently know of service/i.test(text)) return 'Wrong service name (ORA-12514): ask the DBA for the service_name, or check tnsnames.ora.';
  if (/ORA-12505|listener does not currently know of SID/i.test(text)) return 'Wrong SID (ORA-12505): confirm whether to use the SID or the service_name.';
  if (/ORA-12170|TNS:Connect timeout/i.test(text)) return 'Oracle connect timeout (ORA-12170): blocked by a firewall/security group, or the instance is unreachable.';
  if (/ORA-00942|table or view does not exist/i.test(text)) return 'Table does not exist or is not accessible (ORA-00942): watch the schema prefix (the default is the current user\'s schema).';
  if (/ORA-01031|insufficient privileges/i.test(text)) return 'Insufficient privileges (ORA-01031): views such as v$session/v$sql need a DBA grant.';
  if (/ORA-00933|ORA-00921|SQL command not properly ended/i.test(text)) {
    return 'Syntax not supported on this version (common on 11g, which rejects FETCH FIRST). Drop --limit or rewrite it with ROWNUM and retry.';
  }
  return null;
}

function explainSqlServer(text, message) {
  if (/18456|Login failed for user/i.test(text)) return 'SQL Server login failed (18456): wrong account/password, or only Windows authentication is allowed.';
  if (/4060|Cannot open database/i.test(text)) return 'Cannot open the database (4060): wrong name, database offline, or the account lacks permission.';
  if (/229|The SELECT permission was denied/i.test(text)) return 'Insufficient permission (229): the account has no SELECT on that object.';
  if (/208|Invalid object name/i.test(text)) return 'Object does not exist (208): confirm the current database and schema (default dbo).';
  if (/xp_cmdshell|blocked by the security/i.test(text)) return 'Blocked by a security policy (possibly a sqlcmd-style extended procedure); for read-only diagnosis use sys.dm_* views.';
  return null;
}

function explainMongo(text, message) {
  if (/MongoServerSelectionError|Server selection timed out|connect ETIMEDOUT/i.test(text)) {
    return [
      'Cannot reach MongoDB (server selection timed out): are all replica-set/shard addresses listed? Is the IP allowlist open?',
      'With mongodb+srv:// the DNS SRV record must resolve; for a direct single-node connection add ?directConnection=true.',
    ].join('\n');
  }
  if (/Authentication failed|AuthenticationFailed|SCRAM/i.test(text)) return 'MongoDB authentication failed: check the user/password and authSource (users created in the admin database need authSource=admin).';
  if (/not authorized|Unauthorized/i.test(text)) return 'MongoDB permission denied: the account lacks read on the corresponding database.';
  if (/not master|not primary/i.test(text)) return 'Connected to a non-primary node: writes/strongly consistent reads need the primary; add ?replicaSet=<name> so the driver picks it.';
  return null;
}

function explainRedis(text, message) {
  if (/NOAUTH|Authentication required/i.test(text)) return 'Redis requires a password (NOAUTH): set REDIS_PASSWORD or DB_<name>_PASSWORD.';
  if (/WRONGPASS|invalid username-password pair/i.test(text)) return 'Redis password incorrect (WRONGPASS): with ACL users, both the username and password must match.';
  if (/NOPERM|no permissions/i.test(text)) return 'Redis ACL permission denied (NOPERM): this key/command is restricted.';
  if (/LOADING|Redis is loading/i.test(text)) return 'Redis is loading data from RDB/AOF (LOADING): retry after loading finishes.';
  if (/READONLY|You can't write against a read only replica/i.test(text)) return 'Connected to a read-only replica (READONLY): reads and writes must go to the primary.';
  if (/MOVED\s+\d+|ASK\s+\d+/.test(text)) {
    return [
      'This key lives on another cluster node (MOVED/ASK).',
      'dbcli talks to a single Redis node and does not follow cluster redirects; use `redis-cli -c` for full routing,',
      'or add a connection that points at the node handling this key.',
    ].join('\n');
  }
  if (/CLUSTERDOWN/i.test(text)) return 'The Redis cluster reports CLUSTERDOWN: check cluster health (redis-cli --cluster check) before retrying.';
  if (/ERR unknown command/i.test(text)) return 'Redis does not know this command: older versions may lack it (e.g. MEMORY USAGE needs 4.0+); run `dbcli query "INFO server"` to see the version.';
  return null;
}

function explainKafka(text, message) {
  if (/SASL|authentication|Authentication failed|Broker not available|SCRAM/i.test(text)) {
    return [
      'Kafka SASL authentication failed: username/password/mechanism must all line up.',
      'Set the mechanism with KAFKA_SASL_MECHANISM (plain / scram-sha-256 / scram-sha-512); cloud Kafka also requires SSL.',
    ].join('\n');
  }
  if (/TOPIC_AUTHORIZATION_FAILED|GROUP_AUTHORIZATION_FAILED|CLUSTER_AUTHORIZATION_FAILED|not authorized/i.test(text)) {
    return 'Kafka ACL permission denied: the account lacks Describe/Read on that topic/consumer group (ask the platform team for an ACL).';
  }
  if (/UNKNOWN_TOPIC_OR_PARTITION|UnknownTopicOrPartition/i.test(text)) {
    return 'Topic does not exist (or the broker has not synced it yet): confirm the name with `dbcli tables`; an ACL that hides it reports the same error.';
  }
  if (/COORDINATOR_NOT_AVAILABLE|NOT_COORDINATOR|CoordinatorNotAvailable/i.test(text)) {
    return 'The consumer group coordinator is temporarily unavailable (a __consumer_offsets partition is migrating/re-electing): retry in a few seconds; if it persists, the brokers are unstable.';
  }
  if (/INVALID_REPLICATION_FACTOR|INVALID_PARTITIONS|INVALID_TOPIC/i.test(text)) {
    return 'Invalid topic configuration parameters (replication factor/partitions); this CLI is read-only and will not change them.';
  }
  if (/The group is rebalancing|rebalance|MemberMetadata|UnknownMemberId/i.test(text)) {
    return 'The consumer group is rebalancing: the temporary consumer group used by peek triggers one too, so just retry shortly; for repeated long-term rebalances check `dbcli query \'{"op":"groups"}\'`.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout|Connection error|Broker not available|Failed to connect/i.test(text)) {
    return [
      'Cannot reach a Kafka broker. Besides network/port, the most common cause is a misconfigured **advertised.listeners**:',
      'the broker tells clients an internal/container address that they cannot resolve or reach.',
      '  1) Use `dbcli ping --db <name>` to confirm bootstrap reachability;',
      '  2) Ask the platform team whether advertised.listeners matches an address you can reach;',
      '  3) With multiple brokers, list every address in KAFKA_BROKERS (comma separated).',
    ].join('\n');
  }
  return null;
}

function explainClickhouse(text, message) {
  if (/Code: 516|Authentication failed/i.test(text)) return 'ClickHouse authentication failed (516): wrong username/password, or the user is only allowed from specific networks.';
  if (/Code: 81|Database .* does not exist/i.test(text)) return 'ClickHouse database does not exist (81): `dbcli query "SELECT name FROM system.databases"` shows the names.';
  if (/Code: 60|Table .* does not exist/i.test(text)) return 'ClickHouse table does not exist (60): confirm database/table with `dbcli tables`.';
  if (/Code: 62|Syntax error/i.test(text)) return 'ClickHouse syntax error (62): mind ClickHouse\'s dialect (some standard SQL forms are unsupported).';
  if (/Code: 159|Timeout exceeded/i.test(text)) return 'ClickHouse query timed out (159): add WHERE/a time range, or relax --timeout.';
  if (/readonly|Cannot execute query in readonly mode/i.test(text)) return 'The connection runs in readonly mode and the write was rejected — this is the default; writing requires --allow-write and prior approval.';
  return null;
}

function explainElastic(text, message) {
  if (/security_exception|missing authentication credentials|401/i.test(text)) return 'Elasticsearch authentication failed (401): set ELASTICSEARCH_USER/PASSWORD (security is on by default in ES 8).';
  if (/403|action \[indices:data\/read\/search\] is unauthorized/i.test(text)) return 'Elasticsearch permission denied (403): the account lacks read on that index.';
  if (/index_not_found_exception/i.test(text)) return "Index does not exist: `dbcli tables --pattern 'logs-*'` lists index names (wildcards are supported).";
  if (/certificate|SSL|self signed/i.test(text)) return 'ES is HTTPS with an untrusted certificate: use an https:// address and add --insecure-tls (internal self-signed certificate) or configure the correct CA.';
  return null;
}

function explainSqlite(text, message) {
  if (/SQLITE_CANTOPEN|unable to open database file/i.test(text)) return 'SQLite cannot open the file: check that the path exists and is readable (relative paths resolve against the current directory).';
  if (/SQLITE_NOTADB|file is not a database/i.test(text)) return 'The file is not a SQLite database (the path may point at something else).';
  if (/no such table/i.test(text)) return 'Table does not exist: `.tables` is equivalent to `dbcli tables`; SQLite table names are case-insensitive but match the actual name.';
  if (/readonly database|attempt to write a readonly database/i.test(text)) return 'The database is opened read-only (the default) and the write was rejected — this is expected.';
  return null;
}

/** Top-level display: error + hint + target (password already masked) */
export function formatFailure(error, conn) {
  const lines = [];
  const message = scrub(error?.message ?? error, conn);
  lines.push(`Error: ${message}`);
  const hint = error?.hint ?? explainError(error, conn);
  if (hint) {
    lines.push('');
    lines.push(`How to diagnose: ${hint}`);
  }
  if (conn) {
    lines.push('');
    lines.push(`Target: ${conn.name} (${targetText(conn)})`);
    if (conn.source) {
      lines.push(`Credentials from: ${conn.source.kind === 'process' ? `environment variable ${conn.source.var ?? ''}` : `${conn.source.path ?? ''}${conn.source.line ? `:${conn.source.line}` : ''}`}`);
    }
  }
  return lines.join('\n');
}

export { redactUrl };
