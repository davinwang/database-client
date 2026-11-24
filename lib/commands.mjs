/**
 * Command implementations. Design principles (consistent with SKILL.md):
 *
 * - The agent writes the SQL; this module **does not generate, analyse, or optimize SQL**;
 * - It only does "connect + execute + explain results and errors clearly";
 * - The only processing is for safety and readability: read-only guard, row limit, oversized-cell truncation, password masking, error translation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { discover, relevantVars } from './discover.mjs';
import {
  buildConnections,
  describeConnection,
  redactUrl,
  resolveConnection,
  targetText,
  sourceText,
  TYPE_META,
} from './connections.mjs';
import { createDriver, driverModes, driverStatus, driverRoots, driverInstallDir, cleanDrivers, installDrivers } from './drivers/index.mjs';
import {
  applySqlLimit,
  guardEsRequest,
  guardKafkaOperation,
  guardMongoOperation,
  guardRedis,
  guardSql,
  scanRisks,
  writeRisks,
  UsageError,
} from './guard.mjs';
import { UnsupportedError } from './errors.mjs';
import { maskSecret, table, truncate } from './output.mjs';
import { signGrant, storeFile } from './approval.mjs';
import { authorizeWrite, buildPlan as buildWritePlan } from './authorize.mjs';
import { hostName, hostSession, hostSummary } from './hosts.mjs';

const VERSION = '0.3.0';

export const OPTION_SPECS = {
  db: { flag: ['--db', '-d'], type: 'string', help: 'Connection name (required when several exist; see dbcli list)' },
  schema: { flag: ['--schema', '-s'], type: 'string', help: 'schema / database name / owner' },
  format: { flag: ['--format', '-f'], type: 'string', help: 'auto|table|json|csv|md (default auto: table on a terminal, JSON in a pipe)' },
  json: { flag: ['--json'], type: 'flag', help: 'Same as --format json' },
  csv: { flag: ['--csv'], type: 'flag', help: 'Same as --format csv' },
  md: { flag: ['--md'], type: 'flag', help: 'Same as --format md' },
  limit: { flag: ['--limit', '-n'], type: 'number', help: 'Max rows returned (query defaults to 200, slow to 20)' },
  'no-limit': { flag: ['--no-limit'], type: 'flag', help: 'Do not inject a row limit (use with care; may pull the whole table)' },
  'max-cell': { flag: ['--max-cell'], type: 'number', help: 'Max characters per cell (table defaults to 80, JSON to 4096)' },
  timeout: { flag: ['--timeout'], type: 'number', help: 'Connect/query timeout in ms (default 15000)' },
  'allow-write': { flag: ['--allow-write'], type: 'flag', help: 'Allow writes (still requires the approval dialog: see `dbcli approve`)' },
  'dry-run': { flag: ['--dry-run'], type: 'flag', help: 'Run a write then roll back, showing only affected rows (requires --allow-write and its own approval)' },
  approve: { flag: ['--approve'], type: 'string', help: 'One-time approval code for exactly this write (from the confirmation flow)' },
  agent: { flag: ['--agent'], type: 'flag', help: 'Mark the approval as signed by the host confirmation dialog (use with --approve)' },
  id: { flag: ['--id'], type: 'string', help: 'approve: requestId printed by the write command' },
  answer: { flag: ['--answer'], type: 'string', help: 'approve: the option the user picked, verbatim (e.g. "同意执行")' },
  'insecure-tls': { flag: ['--insecure-tls'], type: 'flag', help: 'Skip TLS certificate verification (for internal self-signed certs)' },
  'env-file': { flag: ['--env-file'], type: 'string', repeat: true, help: 'Additional .env file to read (repeatable)' },
  'no-auto': { flag: ['--no-auto'], type: 'flag', help: 'Do not auto-discover .env / compose / application.yml in the project' },
  cwd: { flag: ['--cwd'], type: 'string', help: 'Directory to treat as the project root (defaults to the current one)' },
  pattern: { flag: ['--pattern', '-p'], type: 'string', help: 'Table/index name filter (`*`/`%` wildcards for SQL; glob for Elasticsearch; substring for MongoDB)' },
  file: { flag: ['--file'], type: 'string', help: 'Read SQL from a file' },
  all: { flag: ['--all'], type: 'flag', help: 'Show everything (including shadowed variables/duplicate connections)' },
  registry: { flag: ['--registry'], type: 'string', help: 'npm registry (for drivers install)' },
  force: { flag: ['--force'], type: 'flag', help: 'drivers clean: also clean a custom DB_DRIVER_DIR (deletes node_modules there)' },
  filter: { flag: ['--filter'], type: 'string', help: 'Mongo filter (JSON)' },
  sort: { flag: ['--sort'], type: 'string', help: 'Mongo sort (JSON, e.g. {"_id":-1})' },
  projection: { flag: ['--projection'], type: 'string', help: 'Mongo projection (JSON, e.g. {"name":1})' },
  query: { flag: ['--query', '-q'], type: 'string', help: 'Elasticsearch query body (JSON)' },
  verbose: { flag: ['--verbose'], type: 'flag', help: 'Print more detail (including shadowed config)' },
  help: { flag: ['--help', '-h'], type: 'flag', help: 'Show help' },
  version: { flag: ['--version', '-v'], type: 'flag', help: 'Show version' },
};

const CONN_OPTS = ['db', 'timeout', 'insecure-tls', 'env-file', 'no-auto', 'cwd'];
const OUT_OPTS = ['format', 'json', 'csv', 'md', 'max-cell'];

export const COMMANDS = {
  list: {
    options: ['all', 'format', 'json', 'csv', 'md', 'env-file', 'no-auto', 'cwd'],
    summary: 'List discovered database connections (passwords are never shown)',
    aliases: ['ls'],
    run: cmdList,
  },
  env: {
    options: ['all', 'format', 'json', 'env-file', 'no-auto', 'cwd'],
    summary: 'Show which files/env vars the connection config comes from (masked)',
    run: cmdEnv,
  },
  doctor: {
    options: [...CONN_OPTS, 'format', 'json'],
    summary: 'Self-check: Node version, drivers, config discovery, connectivity',
    run: cmdDoctor,
  },
  drivers: {
    options: ['registry', 'force', 'format', 'json'],
    summary: 'Driver status / install / clean (drivers install mysql postgres ...)',
    run: cmdDrivers,
  },
  ping: {
    options: [...CONN_OPTS, 'format', 'json'],
    summary: 'Connectivity check: version, database, latency',
    run: cmdPing,
  },
  query: {
    options: [...CONN_OPTS, ...OUT_OPTS, 'limit', 'no-limit', 'allow-write', 'dry-run', 'approve', 'agent', 'file', 'filter', 'sort', 'projection', 'query'],
    summary: 'Run SQL / Redis commands / Mongo JSON / ES REST',
    run: cmdQuery,
  },
  approve: {
    options: ['id', 'answer', 'format', 'json'],
    summary: 'Sign a write approval after the user confirms in the host dialog (approve --id <requestId> --answer "同意执行")',
    run: cmdApprove,
  },
  tables: {
    options: [...CONN_OPTS, ...OUT_OPTS, 'schema', 'pattern', 'limit'],
    summary: 'Tables / views (Mongo collections and ES indices work the same way)',
    run: cmdTables,
  },
  desc: {
    options: [...CONN_OPTS, ...OUT_OPTS, 'schema'],
    summary: 'Table structure (columns/types/nullability/defaults/primary key)',
    aliases: ['describe'],
    run: cmdDescribe,
  },
  ddl: {
    options: [...CONN_OPTS, ...OUT_OPTS, 'schema'],
    summary: 'CREATE TABLE statement / field mapping',
    run: cmdDdl,
  },
  indexes: {
    options: [...CONN_OPTS, ...OUT_OPTS, 'schema'],
    summary: 'Indexes (a missing index is the top cause of slow queries)',
    run: cmdIndexes,
  },
  locks: {
    options: [...CONN_OPTS, ...OUT_OPTS],
    summary: 'Lock waits (who blocks whom)',
    run: cmdLocks,
  },
  slow: {
    options: [...CONN_OPTS, ...OUT_OPTS, 'limit'],
    summary: 'Slow SQL / slow command TOP N',
    run: cmdSlow,
  },
  version: { options: [], summary: 'Version', run: async () => ({ text: `database-client ${VERSION}\n` }) },
};

export { VERSION };

/* ------------------------------------------------------------------ Shared */

/** Discover connections on demand (done only once per process) */
async function loadConnections(ctx, options) {
  if (ctx.state.connections) return ctx.state.connections;
  const discovered = await discover({
    cwd: options.cwd ? path.resolve(ctx.cwd, options.cwd) : ctx.cwd,
    envFiles: options['env-file'] ?? [],
    noAuto: Boolean(options['no-auto']),
    processEnv: ctx.processEnv,
  });
  const built = buildConnections(discovered.varMap, {
    extra: discovered.extra,
    warnings: discovered.warnings,
    defaultName: ctx.processEnv.DB_DEFAULT ?? discovered.varMap.get('DB_DEFAULT')?.value,
  });
  ctx.state.discovered = discovered;
  ctx.state.connections = built.connections;
  ctx.state.warnings = built.warnings;
  return built.connections;
}

function engineFor(conn) {
  if (conn.type === 'oceanbase') return /oracle/i.test(String(conn.dialect ?? '')) ? 'oracle' : 'mysql';
  return conn.type;
}

async function withConnection(ctx, options, fn) {
  const connections = await loadConnections(ctx, options);
  const conn = resolveConnection(connections, options.db);
  if (!TYPE_META[conn.type] || TYPE_META[conn.type].kind === 'unsupported') {
    throw new UnsupportedError(`Not supported yet: ${conn.type} (${TYPE_META[conn.type]?.label ?? conn.type})`, {
      hint: 'Supported: MySQL/OceanBase/TiDB/TDSQL, PostgreSQL/Kingbase/GaussDB, Oracle, DM8, SQL Server, SQLite, MongoDB, Redis, ClickHouse, Elasticsearch.',
    });
  }
  const driver = await createDriver(conn, {
    timeoutMs: options.timeout ?? 15000,
    allowWrite: Boolean(options['allow-write']),
    insecureTls: Boolean(options['insecure-tls']),
    cwd: projectCwd(ctx, options),
    roots: driverRoots(),
  });
  try {
    return await fn(driver, conn);
  } catch (error) {
    // Attach the connection to the error: the top-level view can then show which database was used and where the credentials came from
    if (error && typeof error === 'object' && !error.conn) error.conn = conn;
    throw error;
  } finally {
    try {
      await driver.close?.();
    } catch {
      /* Ignore close errors: the primary error is more valuable */
    }
  }
}

function resolveMode(options) {
  if (options['dry-run']) {
    if (!options['allow-write']) {
      throw new UsageError('--dry-run must be used with --allow-write: the trial run really executes (takes locks, fires triggers) and only rolls back at the end.');
    }
    return 'dry-run';
  }
  return options['allow-write'] ? 'write' : 'read';
}

/** Split one command line into arguments (quotes supported), used for Redis commands */
export function splitCommand(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && index + 1 < text.length) {
        current += text[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function projectCwd(ctx, options) {
  return options.cwd ? path.resolve(ctx.cwd, options.cwd) : ctx.cwd;
}

function formatValueMasked(name, value) {
  if (/(PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)/i.test(name)) return maskSecret(value);
  if (/(URL|URI|DSN|CONNECTION_STRING)/i.test(name)) {
    return redactUrl(String(value));
  }
  if (/(PARAMS|OPTIONS)/i.test(name)) return maskInlineSecrets(String(value));
  return value;
}

/** Hide passwords/tokens embedded in a query string or option list. */
function maskInlineSecrets(text) {
  return String(text).replace(
    /((?:^|[?&;\s])(?:password|passwd|pwd|secret|token|api[_-]?key)\s*=\s*)([^&;\s]+)/gi,
    '$1***',
  );
}

/* ------------------------------------------------------------------ Commands */

async function cmdList(_args, options, ctx) {
  const connections = await loadConnections(ctx, options);
  const warnings = ctx.state.warnings ?? [];
  if (options.json || options.format === 'json') {
    return { json: { connections: connections.map(describeConnection), warnings } };
  }
  const rows = connections.map((conn) => [
    conn.name,
    conn.default ? '*' : '',
    conn.type,
    targetText(conn),
    sourceText(conn.source),
    (conn.notes ?? []).join('; '),
  ]);
  return {
    title: `Found ${connections.length} connection(s) (* = default, no --db needed)`,
    columns: ['name', 'default', 'type', 'target', 'source', 'notes'],
    rows,
    notice: connections.length
      ? warnings.length
        ? `Config warnings: ${warnings.join('; ')}`
        : undefined
      : 'No connections found: set DB_URL=mysql://user:pass@host:3306/db (or .env / DB_<name>_URL), then run `dbcli env` to see where the values come from.',
  };
}

async function cmdEnv(_args, options, ctx) {
  const connections = await loadConnections(ctx, options);
  const discovered = ctx.state.discovered;
  const vars = relevantVars(discovered.varMap).filter((item) => options.all || !/^PATH$/.test(item.name));
  const files = [
    ...discovered.files.env.map((file) => ['env', file]),
    ...(discovered.files.explicitEnv ?? []).map((file) => ['env(explicit)', file]),
    ...discovered.files.compose.map((file) => ['compose', file]),
    ...discovered.files.spring.map((file) => ['spring', file]),
    ...(discovered.files.config ?? []).map((file) => ['config', file]),
  ];
  if (options.json || options.format === 'json') {
    return {
      json: {
        cwd: discovered.cwd,
        projectRoot: discovered.projectRoot,
        profile: discovered.profile,
        files,
        vars: vars.map((item) => ({
          name: item.name,
          value: formatValueMasked(item.name, item.value),
          source: item.source,
        })),
        shadowed: options.all ? discovered.shadowed.map((item) => ({ name: item.name, replacedBy: item.replacedBy })) : undefined,
        connections: connections.map(describeConnection),
        warnings: discovered.warnings,
      },
    };
  }

  const lines = [`-- Project root: ${discovered.projectRoot}`, `-- profile: ${discovered.profile || '(not set)'}`];
  lines.push('');
  lines.push('-- Config files read');
  lines.push(files.length ? table(['kind', 'path'], files) : '  (no .env / docker-compose / application.yml found)');
  lines.push('');
  lines.push('-- Database-related variables (values masked)');
  lines.push(
    vars.length
      ? table(['variable', 'value', 'source'], vars.map((item) => [item.name, formatValueMasked(item.name, item.value), sourceText(item.source)]))
      : '  (no DB_* / DATABASE_URL / MYSQL_* variables found)',
  );
  if (options.all && discovered.shadowed.length) {
    lines.push('');
    lines.push('-- Shadowed variables (low priority → high priority)');
    lines.push(
      table(
        ['variable', 'replaced by'],
        discovered.shadowed.map((item) => [item.name, sourceText(item.replacedBy)]),
      ),
    );
  }
  if (discovered.warnings.length) {
    lines.push('');
    lines.push('-- Warnings');
    for (const warning of discovered.warnings) lines.push(`  ! ${warning}`);
  }
  return { text: `${lines.join('\n')}\n` };
}

async function cmdDoctor(_args, options, ctx) {
  const rows = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  rows.push(['Node version', process.version, nodeMajor >= 20 ? 'ok' : 'needs >= 20']);
  rows.push(['node:sqlite', nodeMajor >= 23 || (nodeMajor === 22 && Number(process.versions.node.split('.')[1]) >= 5) ? 'available' : 'unavailable', 'SQLite needs Node >= 22.5']);

  const status = driverStatus();
  const installed = status.filter((item) => item.installed).map((item) => item.key);
  const missing = status.filter((item) => !item.installed).map((item) => item.key);
  rows.push(['Installed drivers', installed.join(', ') || '(none)', missing.length ? `not installed: ${missing.join(', ')} (install on demand when used)` : 'ok']);

  // Write approval: which dialog the agent must use, and where the hand-off record lives
  const approval = hostSummary();
  rows.push(['Write approval', `${approval.name} → ${approval.tool}`, `session ${approval.session}; state ${storeFile()}`]);

  const connections = await loadConnections(ctx, options);
  const discovered = ctx.state.discovered;
  rows.push(['Config files', [...discovered.files.env, ...discovered.files.compose, ...discovered.files.spring].join(', ') || '(none)', 'use --env-file to add one']);
  rows.push(['Discovered connections', connections.map((conn) => `${conn.name}(${conn.type})`).join(', ') || '(none)', connections.length ? 'ok' : 'set DB_URL or DB_<name>_URL']);

  const targets = options.db ? [resolveConnection(connections, options.db)] : connections;
  for (const conn of targets) {
    if (!TYPE_META[conn.type] || TYPE_META[conn.type].kind === 'unsupported') {
      rows.push([`Connection ${conn.name}`, 'skipped', `unsupported engine ${conn.type}`]);
      continue;
    }
    try {
      const driver = await createDriver(conn, {
        timeoutMs: options.timeout ?? 8000,
        allowWrite: false,
        insecureTls: Boolean(options['insecure-tls']),
        cwd: projectCwd(ctx, options),
        roots: driverRoots(),
      });
      const started = performance.now();
      const info = await driver.ping();
      await driver.close?.();
      rows.push([`Connection ${conn.name}`, 'ok', `${info.version} · ${Math.round(performance.now() - started)}ms · ${info.database ?? ''}`]);
    } catch (error) {
      rows.push([`Connection ${conn.name}`, 'FAILED', truncate(String(error.message ?? error), 120)]);
    }
  }

  return { title: 'dbcli self-check', columns: ['check', 'status', 'details'], rows };
}

async function cmdDrivers(args, options) {
  if (args[0] === 'install') {
    const keys = args.slice(1);
    if (!keys.length) throw new UsageError('Usage: dbcli drivers install mysql postgres mongodb ... or all');
    const code = await installDrivers(keys, { registry: options.registry });
    if (code !== 0) throw new Error(`Driver install failed (npm exit code ${code}). Retry with a mirror: --registry https://registry.npmmirror.com`);
    return { text: `Install complete (${driverInstallDir()}). Run \`dbcli drivers\` to confirm status and \`dbcli doctor\` to verify connectivity.\n` };
  }
  if (args[0] === 'clean') {
    const { dir, removed, refused } = await cleanDrivers({ force: Boolean(options.force) });
    if (refused) {
      return {
        text: [
          `Refusing to clean ${dir}: it is not the skill directory.`,
          'That path may be a project whose node_modules you want to keep.',
          'Pass --force to delete node_modules and the npm cache there (package-lock files are never touched outside the skill).',
          '',
        ].join('\n'),
      };
    }
    return {
      text: removed.length
        ? `Removed on-demand drivers from ${dir}:\n${removed.map((item) => `  ${item}`).join('\n')}\nYou will be prompted to install them again when needed.\n`
        : `No on-demand drivers to clean in ${dir} (the skill itself has no dependencies).\n`,
    };
  }
  const status = driverStatus();
  const rows = status.map((item) => [
    item.key,
    item.label,
    item.packageName ?? (item.builtin ?? 'builtin'),
    item.installed ? 'ok' : 'not installed',
    item.entry ?? (item.builtin ?? ''),
  ]);
  const missing = status.filter((item) => !item.installed).map((item) => item.key);
  return {
    title: 'Driver status (the skill has zero dependencies; MySQL/PG/Oracle/DM/SQLServer/Mongo install on demand)',
    columns: ['driver', 'databases', 'dependency', 'status', 'location'],
    rows,
    notice: missing.length ? `Missing drivers: dbcli drivers install ${missing.join(' ')}; clean up: dbcli drivers clean` : 'all ready',
  };
}

async function cmdPing(_args, options, ctx) {
  return withConnection(ctx, options, async (driver, conn) => {
    const info = await driver.ping();
    const rows = [
      ['version', info.version],
      ['database', info.database ?? ''],
      ['user', info.user ?? ''],
      ['latency', `${Math.round(info.latencyMs)}ms`],
    ];
    for (const [key, value] of Object.entries(info.extra ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      rows.push([key, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
    }
    return {
      title: `Connection OK: ${conn.name} (${targetText(conn)})`,
      columns: ['metric', 'value'],
      rows,
    };
  });
}

/**
 * `query` is the only command that can change data, so it is the only one with an approval gate.
 *
 * Order matters and is deliberate:
 *   1) connect/parse/guard first — a wrong password, a missing driver, or an engine that cannot do this
 *      mode fails here, **before** the user is asked to approve something that would not work anyway;
 *   2) then the approval gate — nothing has run yet, and an unconfirmed write returns the confirmation card;
 *   3) only then execute, with the mode the user approved.
 */
async function cmdQuery(args, options, ctx) {
  return withConnection(ctx, options, async (driver, conn) => {
    const mode = resolveMode(options);
    const job = await prepareQuery({ args, options, ctx, conn, mode });

    let authorizedBy;
    if (mode !== 'read' && driverModes(conn.type).includes(mode)) {
      const gate = await authorizeWrite({ plan: job.plan, options, isTty: Boolean(ctx.isTty), argv: ctx.argv ?? [] });
      if (!gate.ok) return gate.result;
      authorizedBy = gate.authorizedBy;
    }

    return executeQuery(driver, job, { mode, authorizedBy });
  });
}

/** Parse + guard into a job description; never executes anything */
async function prepareQuery({ args, options, ctx, conn, mode }) {
  // Only writes need a plan (it is what the approval gate fingerprints); reads skip it entirely
  const planFor = (text, verb, risks) => (mode === 'read' ? undefined : buildWritePlan({ conn, mode, statement: text, verb, risks }));

  if (conn.kind === 'mq' && conn.type === 'kafka') {
    const text = args.join(' ').trim();
    let spec;
    if (!text) spec = { op: 'cluster' };
    else if (text.startsWith('{')) {
      try {
        spec = JSON.parse(text);
      } catch {
        throw new UsageError('Kafka needs a JSON spec, e.g. {"op":"topics"}, {"op":"lag","group":"g1"}, {"op":"peek","topic":"orders","limit":5}');
      }
    } else {
      spec = { op: text };
    }
    guardKafkaOperation(spec.op ?? 'cluster', { allowWrite: Boolean(options['allow-write']) });
    if (spec.op === 'peek' && spec.limit === undefined && Number.isFinite(options.limit)) spec.limit = options.limit;
    return { kind: 'kafka', spec, mode };
  }

  if (conn.kind === 'redis') {
    const text = args.join(' ').trim();
    if (!text) throw new UsageError('Missing Redis command, e.g. dbcli query "INFO server", dbcli query "SCAN 0 MATCH user:* COUNT 100"');
    const tokens = splitCommand(text);
    guardRedis(tokens, { allowWrite: mode !== 'read' });
    const command = tokens.join(' ');
    return {
      kind: 'redis',
      tokens,
      mode,
      plan: planFor(command, tokens[0], ['Redis 没有事务回滚：执行后只能靠备份或反向命令恢复']),
    };
  }

  if (conn.kind === 'mongo') {
    let spec;
    if (args.length && !args[0].trim().startsWith('{')) {
      spec = {
        collection: args[0],
        filter: options.filter ? JSON.parse(options.filter) : {},
        sort: options.sort ? JSON.parse(options.sort) : undefined,
        projection: options.projection ? JSON.parse(options.projection) : undefined,
        limit: options.limit ?? 20,
      };
    } else {
      try {
        spec = JSON.parse(args.join(' '));
      } catch {
        throw new UsageError('Mongo query needs a JSON spec, e.g. dbcli query \'{"collection":"users","filter":{"a":1},"limit":5}\'');
      }
    }
    const op = spec.op ?? (spec.aggregate ? 'aggregate' : 'find');
    guardMongoOperation(op, { pipeline: spec.aggregate ?? spec.pipeline, allowWrite: mode !== 'read' });
    return { kind: 'mongo', spec, op, mode, plan: planFor(JSON.stringify(spec), op, ['Mongo 写入没有回滚：执行后只能靠备份恢复']) };
  }

  if (conn.kind === 'es') {
    let spec;
    const text = args.join(' ').trim();
    if (text.startsWith('{')) {
      try {
        spec = JSON.parse(text);
      } catch {
        throw new UsageError('Failed to parse the Elasticsearch query JSON; example: {"method":"POST","path":"/logs-*/_search","body":{"size":5}}');
      }
    } else {
      spec = text || '/_cluster/health';
    }
    const method = typeof spec === 'string' ? 'GET' : (spec.method ?? 'GET');
    const target = typeof spec === 'string' ? spec : (spec.path ?? '/');
    guardEsRequest(method, target, { allowWrite: mode !== 'read' });
    return { kind: 'es', spec, mode, plan: planFor(`${method} ${target}`, method, ['Elasticsearch 写入没有回滚：执行后只能靠快照恢复']) };
  }

  // SQL engines
  let sql = options.file ? await fs.readFile(path.resolve(projectCwd(ctx, options), options.file), 'utf8') : args.join(' ').trim();
  if (!sql) throw new UsageError('Missing SQL: dbcli query "SELECT 1" or dbcli query --file query.sql');
  const guarded = guardSql(sql, { allowWrite: mode !== 'read' });
  sql = guarded.sql;

  if (options.limit !== undefined && !options['no-limit'] && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new UsageError('--limit must be a positive integer; use --no-limit to disable the row limit explicitly');
  }
  const limit = options['no-limit'] ? 0 : Number.isFinite(options.limit) ? options.limit : 200;
  const risks = mode === 'read' ? scanRisks(sql) : [];
  let injected = false;
  let limitNotice;
  if (mode === 'read' && limit > 0) {
    const applied = applySqlLimit(sql, { limit: limit + 1, engine: engineFor(conn) });
    sql = applied.sql;
    injected = applied.injected;
    limitNotice = applied.notice;
  }

  return {
    kind: 'sql',
    sql,
    mode,
    limit,
    injected,
    limitNotice,
    risks,
    plan: planFor(sql, guarded.keyword, writeRisks(sql, { mode, engine: engineFor(conn) })),
  };
}

/** Run the prepared job; the approval (if any) already happened */
async function executeQuery(driver, job, { mode, authorizedBy }) {
  const driverMode = mode === 'read' ? 'read' : mode === 'dry-run' ? 'dry-run' : 'write';
  const written = (statement, affectedRows, durationMs) => ({
    write: { mode, statement, affectedRows, durationMs, authorizedBy },
  });

  if (job.kind === 'kafka') return driver.query(job.spec);

  if (job.kind === 'redis') {
    const outcome = await driver.query(job.tokens, { mode: driverMode });
    if (mode !== 'read') return written(job.tokens.join(' '), undefined, outcome.durationMs);
    return outcome;
  }

  if (job.kind === 'mongo') {
    const outcome = await driver.query(job.spec, { mode: driverMode });
    if (mode !== 'read') return written(JSON.stringify(job.spec), undefined, outcome.durationMs);
    return outcome;
  }

  if (job.kind === 'es') {
    const outcome = await driver.query(job.spec, { mode: driverMode });
    if (mode !== 'read') return written(JSON.stringify(job.spec), undefined, outcome.durationMs);
    return outcome;
  }

  const outcome = await driver.query(job.sql, { mode: driverMode });
  if (mode !== 'read') return written(job.sql, outcome.affectedRows, outcome.durationMs);

  let rows = outcome.rows ?? [];
  let truncated = false;
  if (job.injected && rows.length > job.limit) {
    rows = rows.slice(0, job.limit);
    truncated = true;
  }
  const notices = [outcome.notice, job.limitNotice, ...job.risks].filter(Boolean);
  return {
    columns: outcome.columns,
    rows,
    truncated,
    durationMs: outcome.durationMs,
    notice: notices.length ? notices.join('; ') : undefined,
  };
}

/**
 * Sign a write approval after the user confirmed in the host dialog.
 *
 * The CLI cannot open the dialog, and the agent cannot approve on the user's behalf: this command only
 * accepts the option label the user actually picked, and the resulting credential is bound to this host
 * session, to the exact statement, and is single-use.
 */
async function cmdApprove(args, options) {
  const requestId = String(options.id ?? args[0] ?? '').trim();
  const answer = options.answer ?? args[1];
  if (!requestId) throw new UsageError('Usage: dbcli approve --id <requestId> --answer "同意执行"\n(the requestId is printed by the write command that needs approval)');
  if (answer === undefined) throw new UsageError('Missing --answer: pass the option the user picked in the dialog, verbatim (e.g. "同意执行")');

  const result = signGrant(requestId, { answer: String(answer), session: hostSession(), host: hostName() });
  if (!result.approved) {
    const payload = { status: result.declined ? 'declined' : 'not_approved', requestId, reason: result.reason };
    if (options.json || options.format === 'json') return { json: payload, exitCode: 7 };
    return {
      text: [
        result.declined ? 'The user declined: nothing was signed, so nothing can run.' : 'Approval was not signed.',
        `  ${result.reason}`,
        result.declined
          ? '  Do not retry the write; ask the user what they want instead.'
          : '  Rerun the write command without --approve to print a fresh confirmation card.',
        '',
      ].join('\n'),
      exitCode: 7,
    };
  }

  const payload = {
    status: 'approved',
    channel: 'agent',
    host: result.grant.host,
    requestId,
    approvalCode: result.grant.code,
    session: result.grant.session,
    expiresAt: new Date(result.grant.expiresAt).toISOString(),
    plan: result.grant.plan,
    next: {
      note: 'Run the same write command again with these flags; the code is valid for this statement and connection only, and is consumed by the run.',
      args: ['--approve', result.grant.code, '--agent'],
    },
  };
  if (options.json || options.format === 'json') return { json: payload };
  return {
    text: [
      `Approved (request ${requestId}, host ${result.grant.host}).`,
      `  code    : ${result.grant.code}   (valid until ${payload.expiresAt})`,
      `  next    : rerun the write command with --approve ${result.grant.code} --agent`,
      '  note    : the same approval also covers --dry-run for this statement, and the trial run does not spend it.',
      '',
    ].join('\n'),
  };
}

async function cmdTables(args, options, ctx) {
  return withConnection(ctx, options, async (driver) => {
    if (typeof driver.tables !== 'function') throw unsupported('tables');
    return driver.tables({ schema: options.schema, pattern: options.pattern ?? args[0] });
  });
}

async function cmdDescribe(args, options, ctx) {
  const name = args[0];
  if (!name) throw new UsageError('Usage: dbcli desc <table/collection/index> [--db <name>] [--schema <schema>]');
  return withConnection(ctx, options, async (driver) => {
    if (typeof driver.describe !== 'function') throw unsupported('desc');
    return driver.describe(name, { schema: options.schema });
  });
}

async function cmdDdl(args, options, ctx) {
  const name = args[0];
  if (!name) throw new UsageError('Usage: dbcli ddl <table> [--db <name>] [--schema <schema>]');
  return withConnection(ctx, options, async (driver) => {
    if (typeof driver.ddl !== 'function') throw unsupported('ddl');
    const outcome = await driver.ddl(name, { schema: options.schema });
    const ddl = outcome.rows?.[0]?.[0] ?? '';
    // DDL is multi-line text; table mode flattens newlines and truncates long lines, so print it verbatim
    if (options.json || options.format === 'json') return { json: { table: name, ddl, notice: outcome.notice } };
    return { text: `${ddl}\n${outcome.notice ? `\n-- ${outcome.notice}\n` : ''}` };
  });
}

async function cmdIndexes(args, options, ctx) {
  return withConnection(ctx, options, async (driver) => {
    if (typeof driver.indexes !== 'function') throw unsupported('indexes');
    return driver.indexes(args[0], { schema: options.schema });
  });
}

async function cmdLocks(_args, options, ctx) {
  return withConnection(ctx, options, async (driver) => {
    if (typeof driver.locks !== 'function') throw unsupported('locks');
    return driver.locks();
  });
}

async function cmdSlow(_args, options, ctx) {
  return withConnection(ctx, options, async (driver) => {
    if (typeof driver.slow !== 'function') throw unsupported('slow');
    return driver.slow({ limit: options.limit ?? 20 });
  });
}

function unsupported(name) {
  return new UnsupportedError(`The current engine does not support ${name}`, {
    hint: 'Query the relevant views yourself with `dbcli query`; see the "engine capability matrix" in SKILL.md for what each engine supports.',
  });
}
