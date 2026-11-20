#!/usr/bin/env node
/**
 * Argument parsing and dispatch.
 *
 * Only three jobs: validate arguments, find the command, print results/errors in a uniform format.
 * Business logic lives in commands.mjs, safety in guard.mjs, connections in connections/discover.mjs.
 */

import { COMMANDS, OPTION_SPECS, VERSION } from './commands.mjs';
import { renderResult } from './output.mjs';
import { formatFailure, UnsupportedError } from './errors.mjs';
import { UsageError, WriteBlockedError } from './guard.mjs';
import { DriverMissingError } from './drivers/index.mjs';

const GLOBAL_OPTIONS = ['help', 'version', 'verbose'];

const HELP = `dbcli — let an agent connect to databases and diagnose issues (no connection details stored)

Connections
  list         List discovered connections (passwords never shown; includes source file:line)
  env          Show where config comes from (.env / env vars / docker-compose / Spring)
  doctor       Self-check: Node, drivers, config, connectivity
  drivers      Driver status; drivers install <name>|all installs npm drivers
  ping         Connectivity + version + latency

Query (you write the SQL; this just connects and runs it)
  query        Run SQL / Redis commands / Mongo JSON / ES REST / Kafka read-only operations
  tables       Tables / views (Mongo collections, ES indices, Kafka topics)
  desc         Table structure (for Kafka: partitions/ISR/offsets)
  ddl          CREATE TABLE statement
  indexes      Indexes
  locks        Lock waits (who blocks whom)
  slow         Slow SQL TOP N (for Kafka, use lag to see consumer lag)

Common options
  --db <name>              Pick a connection when there are several (optional for a single one)
  --schema <schema>        schema / database name / owner
  --limit <N>              Max rows returned (query defaults to 200, slow to 20)
  --format table|json|csv|md   Default auto (table on a terminal, JSON in a pipe)
  --timeout <ms>           Connect/query timeout (default 15000)
  --env-file <path>        Additional .env to read (repeatable)
  --allow-write            Allow writes (confirm with the user before running)
  --dry-run                Run a write then roll back (requires --allow-write)
  --insecure-tls           Skip TLS certificate verification (internal self-signed certs)

Read-write control
  Read-only by default: write statements are blocked during parsing, and the session adds a read-only transaction (MySQL/PG/Oracle/SQLite/ClickHouse).
  To write: tell the user which table, what changes, and how many rows; once approved, add --allow-write.
  Unsure of the blast radius: --allow-write --dry-run first, then decide based on affected rows.
  Redis / Mongo / ES / Kafka are read-only for diagnosis: Kafka publishes nothing, ES/Mongo write nothing, Redis uses a command allowlist.

Configuration priority (later overrides earlier)
  project root/current dir .env → --env-file → environment variables
  Lower-priority fallbacks: docker-compose.yml, Spring application.yml/properties

Examples
  DB_URL=mysql://user:pass@127.0.0.1:3306/app dbcli tables
  DB_URL=postgres://user:pass@10.0.0.5:5432/erp dbcli query "select * from orders limit 10"
  KAFKA_BROKERS=10.0.0.7:9092 dbcli query '{"op":"lag","group":"app-consumer"}'
  dbcli list --all
  dbcli locks
  dbcli slow -n 10

Exit codes
  0 success · 2 usage error · 3 connection selection/argument problem · 4 blocked by the read-only guard · 5 driver not installed · 6 connection failed · 1 other error
`;

function findOption(flag) {
  for (const [key, def] of Object.entries(OPTION_SPECS)) {
    if (def.flag.includes(flag)) return { key, def };
  }
  return null;
}

export function parseArgv(argv) {
  const options = {};
  const positional = [];
  let command = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    const looksLikeOption = token.startsWith('--') || (token.startsWith('-') && token.length === 2);
    if (looksLikeOption && token !== '-') {
      const eq = token.indexOf('=');
      const flag = eq === -1 ? token : token.slice(0, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const found = findOption(flag);
      if (!found) throw new UsageError(`Unknown option ${flag}\nRun dbcli --help to see the supported options.`);
      if (found.def.type === 'flag') {
        options[found.key] = true;
        continue;
      }
      const value = inline !== undefined ? inline : argv[++index];
      if (value === undefined) throw new UsageError(`${flag} requires a value`);
      if (found.def.type === 'number') {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new UsageError(`${flag} requires a number, got ${value}`);
        options[found.key] = number;
      } else if (found.def.repeat) {
        options[found.key] = [...(options[found.key] ?? []), value];
      } else {
        options[found.key] = value;
      }
      continue;
    }
    if (command === null) command = token;
    else positional.push(token);
  }
  return { command, positional, options };
}

function resolveCommand(name) {
  if (!name) return null;
  if (COMMANDS[name]) return { name, spec: COMMANDS[name] };
  for (const [key, spec] of Object.entries(COMMANDS)) {
    if ((spec.aliases ?? []).includes(name)) return { name: key, spec };
  }
  return null;
}

function commandHelp(name, spec) {
  const lines = [`dbcli ${name} — ${spec.summary}`, '', 'Available options:'];
  for (const key of spec.options) {
    const def = OPTION_SPECS[key];
    if (!def) continue;
    lines.push(`  ${def.flag.join(' / ').padEnd(26)} ${def.help}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2), { processEnv = process.env, cwd = process.cwd(), isTty = Boolean(process.stdout.isTTY) } = {}) {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const { command, positional, options } = parsed;

  if (options.version || command === 'version') {
    process.stdout.write(`database-client ${VERSION}\n`);
    return 0;
  }
  if (options.help || command === 'help' || !command) {
    const topic = command === 'help' ? positional[0] : command;
    const found = topic ? resolveCommand(topic) : null;
    process.stdout.write(found ? commandHelp(found.name, found.spec) : HELP);
    return 0;
  }

  const found = resolveCommand(command);
  if (!found) {
    process.stderr.write(`Unknown command ${command}\n\n${HELP}`);
    return 2;
  }

  for (const key of Object.keys(options)) {
    if (GLOBAL_OPTIONS.includes(key)) continue;
    if (!found.spec.options.includes(key)) {
      process.stderr.write(`Command ${found.name} does not support --${key}\nRun dbcli ${found.name} --help to see the available options.\n`);
      return 2;
    }
  }

  const format = options.json ? 'json' : options.csv ? 'csv' : options.md ? 'md' : options.format ?? 'auto';
  if (format !== 'auto' && !['table', 'json', 'csv', 'md'].includes(format)) {
    process.stderr.write(`--format supports only auto|table|json|csv|md, got ${format}\n`);
    return 2;
  }

  const ctx = { cwd, processEnv, state: {} };
  try {
    const result = await found.spec.run(positional, options, ctx);
    if (result && typeof result.text === 'string') {
      process.stdout.write(result.text);
      return 0;
    }
    process.stdout.write(renderResult(result, { format, maxCell: options['max-cell'], isTty }));
    return 0;
  } catch (error) {
    return reportError(error, options);
  }
}

function reportError(error, options) {
  const exitCode = error?.exitCode ?? 1;
  if (error instanceof WriteBlockedError) {
    process.stderr.write(`\n${error.message}\n`);
    return exitCode;
  }
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    return exitCode;
  }
  if (error instanceof DriverMissingError) {
    process.stderr.write(`\n${error.message}\n\n${error.hint}\n`);
    return exitCode;
  }
  if (error instanceof UnsupportedError) {
    process.stderr.write(`\n${error.message}\n${error.hint ? `\n${error.hint}\n` : ''}`);
    return exitCode;
  }
  process.stderr.write(`\n${formatFailure(error, error?.conn)}\n`);
  if (options.verbose && error?.stack) process.stderr.write(`\n${error.stack}\n`);
  return exitCode;
}
