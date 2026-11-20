---
name: database-client
version: 0.2.3
description: "Database and middleware troubleshooting client (dbcli) for coding agents. Connections come exclusively from the project's environment variables and .env files; the skill stores no URLs or credentials. Read-only by default. Runs SQL, inspects schema/indexes/DDL, finds lock waits and slow queries, and inspects Kafka topics/partitions/messages/consumer lag. Supports MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB, OceanBase (MySQL and Oracle modes), PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss, Oracle, DM8, SQL Server, SQLite, MongoDB, Redis, Kafka/Redpanda, ClickHouse and Elasticsearch. Use when the user asks to query a database, inspect a table or its indexes, run a SQL statement, investigate slow queries, lock waits or deadlocks, fix connection or authentication failures (Access denied, ORA-*, ECONNREFUSED), check OceanBase/DM8/Kingbase or other domestic databases, read EXPLAIN plans, verify production data, investigate Kafka topics with missing messages or consumer lag, Redis slow commands, or Elasticsearch indices. Not a SQL generator and not a data-modification tool: writes require explicit per-command user approval."
metadata:
  requires:
    bins: ["node"]
  cliHelp: "node bin/dbcli.mjs --help"
---

# database-client

English | [简体中文](SKILL.zh-CN.md)

`dbcli` is a **thin driver layer**: the agent writes the SQL, the CLI only connects, executes, and explains
results and errors clearly.

Three hard rules:

1. **No stored credentials.** No config file, no cache, no history. Every invocation re-reads the current
   project's environment variables and `.env` files; passwords live only in memory. `list`, `env`, error
   output and JSON output never contain a plaintext password.
2. **Read-only by default.** Write statements are rejected during parsing (exit code 4) and a second,
   session-level read-only transaction is applied where the engine supports it. Writing requires
   `--allow-write`, and the affected rows must be explained to the user first.
3. **Not a SQL generator.** There are no `sample`/`count`/`explain` wrapper commands — those are just
   `query` plus a statement.

Supported: MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB, OceanBase (both modes),
PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss, Oracle, DM8, SQL Server, SQLite, MongoDB, Redis,
Kafka/Redpanda, ClickHouse, Elasticsearch.

## Pre-flight checks

```bash
node <skill-dir>/bin/dbcli.mjs doctor     # Node, drivers, config discovery, connectivity
node <skill-dir>/bin/dbcli.mjs drivers    # driver status (install what you need, see "On-demand drivers")
node <skill-dir>/bin/dbcli.mjs list       # discovered connections (masked)
```

If `doctor` reports `FAILED`, do not guess: use the "Common errors" table. The `source` column in `list`
tells you which file and line a value came from — check that line first.

## When to use / when not to

**Use it for:**

- "Connect to the staging DB and show the latest rows in orders."
- "This API call fails — check whether the record/table is what we expect."
- "Production is slow — are there lock waits? Which SQL is the slowest?"
- "What does the schema/index look like? Send me the DDL."
- "Which database is this environment actually pointing at? Is the password wrong?"
- "This Kafka consumer is lagging / the topic looks empty."

**Do not use it for:**

- Writing application SQL for you (the agent writes it; the CLI only executes).
- Changing data or schema (read-only by default; writes need per-command approval and one statement at a time).
- Migrations, ETL, or performance-tuning design.

## Where configuration comes from (no credentials are stored)

Priority (highest first):

| Source | Notes |
| --- | --- |
| CLI options | `--db`, `--schema`, `--env-file` |
| Process environment | Typically injected per project by the agent host; highest priority |
| `--env-file <path>` | Explicit `.env` file(s), repeatable |
| `.env.<profile>.local` → `.env.<profile>` → `.env.local` → `.env` | profile from `SPRING_PROFILES_ACTIVE`/`APP_ENV`/`NODE_ENV`/`PROFILE`/`ENV` |
| `docker-compose.yml` / `compose.yml` | Fallback: derived from `services` image/ports/environment |
| Spring `application.yml` / `application-<profile>.yml` / `application.properties` | Fallback: `spring.datasource.*`, `spring.data.redis.*`, `spring.data.mongodb.uri`, `spring.elasticsearch.uris` |

Framework conventions work as-is, no renaming: `DATABASE_URL`, `MYSQL_*`, `PG*`/`POSTGRES_*`,
`REDIS_URL`/`REDIS_*`, `MONGO_URI`/`MONGODB_URI`, `KAFKA_*`, `CLICKHOUSE_*`, `ES_URL`/`ELASTICSEARCH_*`,
`SPRING_DATASOURCE_*`, `JDBC_URL`.

### Recommended naming

```bash
# Single database
DB_URL=mysql://app:<password>@127.0.0.1:3306/appdb

# Multiple databases (use --db <name>; a single connection is picked automatically)
DB_ERP_URL=mysql://app:<password>@10.0.0.5:3306/erp
DB_LOG_URL=postgres://log:<password>@10.0.0.6:5432/logdb
DB_DEFAULT=erp

# Split fields (when passwords contain special characters or config is generated piecemeal)
DB_REPORT_HOST=pg-report
DB_REPORT_PORT=5433
DB_REPORT_USER=report
DB_REPORT_PASSWORD=<password>
DB_REPORT_DATABASE=dw
DB_REPORT_TYPE=postgres

# Kafka (comma-separated brokers; SASL trio + SSL as needed)
KAFKA_BROKERS=10.0.0.7:9092,10.0.0.8:9092
KAFKA_SASL_USERNAME=app
KAFKA_SASL_PASSWORD=<password>
KAFKA_SASL_MECHANISM=scram-sha-256
KAFKA_SSL=true
```

Connection strings accepted: `mysql://`, `postgres://`, `oracle://`, `sqlserver://`, `mongodb://`,
`mongodb+srv://`, `redis://`/`rediss://`, `sqlite:path`, `clickhouse://`, `kafka://broker1:9092,broker2:9092`,
`http(s)://` (Elasticsearch/ClickHouse with `DB_<NAME>_TYPE`), `jdbc:mysql|postgresql|oracle:thin|sqlserver|sqlite:`,
Go's `user:pass@tcp(host:3306)/db`, and libpq's `host=... dbname=...`.

### Framework configuration files (any language)

Discovery is language-agnostic: the same adapters run for every project, and each file is only read, never modified.

| Source | Typical stack | Mapping |
| --- | --- | --- |
| `.env*` | any | variables, layered by profile |
| `docker-compose.yml` | any (local containers) | service image/ports/environment |
| `application*.yml` / `application*.properties` | Java / Spring Boot | `spring.datasource.*`, `dynamic.datasource.*`, `spring.data.redis.*` |
| `appsettings*.json` | .NET | `ConnectionStrings:<name>` (ADO.NET string or URL) → `dotnet-<name>` |
| `ormconfig.json`, `config/*.json` | Node (TypeORM/node-config) | connection-shaped objects → `config-<path>` |
| `database.yml` | Ruby / Rails | `adapter` + host/database/username → `rails-<env>` |
| `*.ini`, generic JSON/YAML/properties | Python (alembic), others | DB URLs in database-ish keys → `config-<key>` |

Spring specifics: `spring.datasource.dynamic.datasource.<name>.*` yields one connection per datasource
(`spring-<name>`, primary marked), `spring.redis.cluster.nodes` is parsed as a cluster connection, and values
are expanded against the project environment. If a datasource URL is still a placeholder after expansion
(`${DATASOURCE_URL}` / `<%= ENV['...'] %>`), the connection is skipped with a warning naming the variable;
define it in the environment or pass the file that defines it:

```bash
dbcli list --env-file src/main/resources/application-dev.properties
```

A dotenv-style `application-<profile>.properties` (`DATASOURCE_URL=jdbc:mysql://...`) is also used for
placeholder expansion automatically when `SPRING_PROFILES_ACTIVE=<profile>` is set. "Config files read" lists
files that were parsed — it does not by itself mean every placeholder was resolved.

### Credentials with special characters

Usernames such as `user@tenant#instance` and passwords containing `% # &` must not be pasted into a
`scheme://user:pass@host` URL: `@` and `#` are delimiters and the connection silently targets the wrong host.
Either percent-encode them (`@`→`%40`, `#`→`%23`, `%`→`%25`) or, preferably, use split fields:

```bash
DB_OB_TYPE=oceanbase
DB_OB_HOST=10.0.0.9
DB_OB_PORT=2881
DB_OB_USER=user@tenant#instance
DB_OB_PASSWORD=p%a#ss&word
DB_OB_DATABASE=app
```

### Look before you connect

```bash
dbcli list           # connection list: name/type/target/source/notes
dbcli env            # every variable, its value (masked) and where it came from
dbcli env --all      # include overridden variables (debug "why is it connecting to the wrong DB?")
```

## Read/write control

Exactly three modes:

| Mode | Trigger | Behaviour |
| --- | --- | --- |
| `read` (default) | nothing | statement allow-list + session-level read-only + automatic row limit |
| `write` | `--allow-write` | one write statement, reports affected rows |
| `dry-run` | `--allow-write --dry-run` | executes inside a transaction, then `ROLLBACK`; reports affected rows |

**Ask the user before writing** (hard requirement, not a suggestion):

> "This will run `UPDATE orders SET status='X' WHERE ...`, affecting N rows (verified with `--dry-run`),
> on `erp` (mysql://…@10.0.0.5:3306/erp). Proceed?"

Only add `--allow-write` after an explicit yes. `--dry-run` alone is rejected — a dry-run still takes
locks and fires triggers, so it must not be used to "try it quietly".

Blocked in read-only mode: `insert/update/delete/merge/truncate/drop/alter/create/grant/revoke/call`,
`select ... into outfile`, `for update`, `nextval()/setval()`, server-side file reads, `pragma` assignment,
multiple statements, and non-read-only `explain`. Redis is command-allow-listed, MongoDB blocks
`$out/$merge`, Elasticsearch only allows GET/HEAD and query-style POST, and Kafka only allows its read ops.

## Commands

| Command | Purpose | Example |
| --- | --- | --- |
| `list` / `ls` | Discovered connections (masked) | `dbcli list --all` |
| `env` | Where configuration comes from and what overrides what | `dbcli env` |
| `doctor` | Self-check plus per-connection probe | `dbcli doctor` |
| `drivers` | Driver status / install / clean | `dbcli drivers install mysql postgres` |
| `ping` | Version, database, user, latency | `dbcli ping --db erp` |
| `query` | Execute SQL (also Redis commands, Mongo JSON, ES REST, Kafka read ops) | `dbcli query "select * from orders where id=1"` |
| `tables` | Tables/views (Mongo collections, ES indices, Kafka topics) | `dbcli tables --db erp --pattern 'order%'` |
| `desc` | Columns/types/nullability/defaults/keys (Kafka: partitions/ISR/offsets) | `dbcli desc orders --db erp` |
| `ddl` | CREATE statement / field mapping | `dbcli ddl orders` |
| `indexes` | Indexes and column order (first suspect for slow queries) | `dbcli indexes orders` |
| `locks` | Lock waits (who blocks whom) | `dbcli locks` |
| `slow` | Slow SQL / slow commands, top N | `dbcli slow -n 10` |

Common options: `--db <name>`, `--schema <schema>`, `--limit <N>` (query default 200, slow default 20),
`--no-limit`, `--format table|json|csv|md`, `--timeout <ms>`, `--env-file`, `--insecure-tls`.

`--pattern` accepts `*` or `%` as wildcards for SQL engines (a pattern without a wildcard is treated as a
substring); Elasticsearch uses index globs (`logs-*`) and MongoDB uses a substring match.

### Non-SQL engines

```bash
# Redis: commands are passed through, allow-listed
dbcli query "INFO server"
dbcli query "SCAN 0 MATCH user:* COUNT 100"
dbcli query "MEMORY USAGE user:1"
dbcli slow -n 10                       # SLOWLOG GET

# MongoDB: JSON spec
dbcli query '{"collection":"users","filter":{"status":"A"},"projection":{"name":1},"limit":5}'
dbcli query '{"collection":"orders","aggregate":[{"$match":{}}],"limit":5}'
dbcli query '{"op":"count","collection":"users","filter":{}}'
dbcli tables                           # collections

# Elasticsearch: REST path or JSON spec
dbcli query "/_cat/indices?format=json"
dbcli query '{"method":"POST","path":"/logs-2026/_search","body":{"size":5,"query":{"match_all":{}}}}'
dbcli tables --pattern 'logs-*'
dbcli desc logs-2026

# Kafka: read-only operations (topics / partitions / message peek / consumer lag)
dbcli tables                                     # topics with partition and replica counts
dbcli desc orders                                # per-partition leader / ISR / low / high / messages
dbcli query topics                               # same, as a JSON-friendly op
dbcli query '{"op":"peek","topic":"orders","limit":5,"from":"latest"}'
dbcli query '{"op":"peek","topic":"orders","limit":5,"from":"earliest","partition":0}'
dbcli query '{"op":"groups"}'                    # consumer groups (state / members)
dbcli query '{"op":"lag","group":"app-consumer"}'
dbcli query '{"op":"configs","topic":"orders"}'
dbcli query '{"op":"cluster"}'
```

Kafka `peek` uses a **temporary consumer group** and does not commit offsets (the broker keeps an empty
group until `offsets.retention` expires). The CLI never produces messages, changes configs, or resets offsets.

## Troubleshooting SOP

**1. Cannot connect** — run `dbcli ping --db <name>`, match the error against "Common errors", then check
`dbcli list` (target and credential source). Most failures are a wrong environment/port or a compose
service without a published port.

**2. Slow / stuck**:

```bash
dbcli slow -n 10        # MySQL: performance_schema; PG: pg_stat_statements; Oracle: v$sql; DM8: V$LONG_EXEC_SQLS; SQL Server: dm_exec_query_stats
dbcli locks             # then check for lock waits (waiting/blocking, wait_seconds)
dbcli desc <table>      # is the filter column indexed?
dbcli indexes <table>   # look before rewriting the SQL
dbcli query "EXPLAIN <original SQL>"
```

**3. Data does not match** — query the exact row with a `WHERE`, then `desc` the table to check types,
defaults and time zone. This CLI shows raw stored values (MySQL `dateStrings`, PostgreSQL text parsing),
so timestamps are not shifted into local time.

**4. Schema / indexes** — `dbcli ddl` returns the full definition. Oracle/PostgreSQL/SQL Server/DM8 have no
`SHOW CREATE TABLE`; those are reconstructed from the data dictionary and labelled as such.

**5. Kafka** — `lag` for consumer backlog, `desc` for ISR/leader health, `groups` for rebalance loops,
`peek` for actual message content.

**6. Output looks garbled** — on Windows, PowerShell may mangle UTF-8 when stdout is piped or redirected
(`node bin/dbcli.mjs ... | Select-Object`). The database value is usually fine: redirect to a file
(`--format json > out.json`) or read the file as UTF-8 instead of judging the console. This is a
terminal-encoding issue, not a data-encoding issue.

## Engine capability matrix

| Engine | query | tables/desc | ddl | indexes | locks | slow | write | dry-run | Driver |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MySQL/MariaDB/TiDB/TDSQL | ✅ | ✅ | ✅ `SHOW CREATE TABLE` | ✅ | ✅ | ✅ performance_schema | ✅ | ✅ | mysql2 |
| OceanBase (MySQL mode) | ✅ | ✅ | ✅ | ✅ | ⚠️ OB views | ⚠️ OB views | ✅ | ✅ | mysql2 |
| OceanBase (Oracle mode) | ✅ | ✅ | ✅ rebuilt | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | mysql2 |
| PostgreSQL/Kingbase/Vastbase/GaussDB | ✅ | ✅ | ✅ rebuilt | ✅ | ✅ | ✅ pg_stat_statements | ✅ | ✅ | pg |
| Oracle | ✅ | ✅ | ✅ rebuilt | ✅ | ✅ v$session | ✅ v$sql | ✅ | ✅ | oracledb |
| DM8 | ✅ | ✅ | ✅ rebuilt | ✅ | ⚠️ V$TRXWAIT/V$LOCK | ⚠️ V$LONG_EXEC_SQLS | ✅ | ✅ | dmdb (official) |
| SQL Server | ✅ | ✅ | ✅ rebuilt | ✅ | ✅ dm_exec_requests | ✅ dm_exec_query_stats | ✅ | ✅ | mssql |
| SQLite | ✅ | ✅ | ✅ | ✅ | ❌ (single file, no server locks) | ❌ (use EXPLAIN QUERY PLAN) | ✅ | ✅ | node:sqlite |
| MongoDB | ✅ find/aggregate | ✅ sampled fields | ⚠️ no DDL | ✅ | ✅ currentOp | ✅ system.profile | ❌ | ❌ | mongodb |
| Redis | ✅ commands | ❌ | ❌ | ❌ | ❌ (single-threaded) | ✅ SLOWLOG | ✅ allow-listed | ❌ | built-in RESP |
| Kafka / Redpanda | ✅ read ops | ✅ topics | ❌ | ❌ | ❌ (check ISR/leader) | ❌ (check lag) | ❌ | ❌ | kafkajs |
| ClickHouse | ✅ | ✅ | ✅ SHOW CREATE | ✅ primary/sorting key | ❌ (no row locks) | ✅ system.query_log | ✅ | ❌ (no transactions) | HTTP |
| Elasticsearch | ✅ REST | ✅ indices/mapping | ⚠️ no DDL | ❌ | ❌ | ❌ | ❌ | ❌ | HTTP |

`⚠️` means the result depends on the exact version/privileges; when unsupported, the command says so and
suggests the equivalent view instead of returning an empty result.

## Output contract

- Default `--format auto`: a table on a TTY, JSON when piped/captured by an agent (`--format` overrides).
- JSON shape: `{columns, rowCount, truncated, durationMs, rows:[{...}]}`; document results
  (Mongo/ES/Kafka peek) are `{rowCount, documents:[...]}`; writes/dry-runs are
  `{mode, statement, affectedRows, rolledBack}`.
- **`truncated: true` means the row limit cut the result**, not that this is all the data. Use `--no-limit`
  (carefully) or add a `WHERE`.
- Cells are truncated by default: 80 chars for tables, 4096 for JSON (`--max-cell`); binary is shown as
  `<binary N B>`; bigints are strings to avoid precision loss; `NULL` is `NULL` in tables and `null` in JSON.

Exit codes: `0` success · `1` other error · `2` usage · `3` connection selection · `4` read-only guard ·
`5` driver missing · `6` connection failed.

## Common errors → next step

| Error | Likely cause | Next step |
| --- | --- | --- |
| `ECONNREFUSED` | nothing listening / compose port not published | check `dbcli list`, `docker ps`, ports |
| `ETIMEDOUT` / timeout | network, security group, VPN | test connectivity, raise `--timeout` |
| `ENOTFOUND` / `getaddrinfo` | DNS failure | check hosts/VPN, try the IP |
| `Access denied for user` (MySQL) | wrong password / host not allowed | `dbcli env`, check `mysql.user` host |
| `28P01` / `password authentication failed` (PG) | wrong password / pg_hba method | check source; note scram/md5 |
| `ORA-01017` | wrong user/password (case!) | confirm service_name and user case |
| `ORA-12514` / `ORA-12505` | wrong service_name / SID | ask the DBA for the service name |
| `18456` (SQL Server) | login failed / Windows-only auth | confirm SQL authentication is enabled |
| `ER_BAD_DB_ERROR` / `3D000` | database does not exist | `query "SHOW DATABASES"` / `SELECT datname FROM pg_database` |
| `too many clients` / `53300` | connections exhausted | check the application pool; find long transactions with `dbcli slow` |
| Kafka `advertised.listeners` | bootstrap connects but broker metadata is unreachable | ask the platform to fix advertised.listeners |
| Kafka `SASL` / `Authentication failed` | wrong user/password/mechanism | set `KAFKA_SASL_MECHANISM` (plain/scram-sha-256/scram-sha-512) and SSL |
| Kafka `COORDINATOR_NOT_AVAILABLE` | group coordinator moving | retry in a few seconds; persistent errors mean broker instability |
| Kafka `UNKNOWN_TOPIC_OR_PARTITION` | wrong topic / ACL hides it | confirm with `dbcli tables` |
| Read-only rejection (exit 4) | statement is a write | confirm with the user, then `--allow-write`; try `--dry-run` first |
| Driver missing (exit 5) | engine driver not installed | `dbcli drivers install <name>` (next section) |
| Certificate / `self-signed certificate` | internal TLS | add `--insecure-tls` on trusted networks |

Error output includes "How to diagnose" plus the target and credential source. Do not bypass it by
hand-building connection strings.

## Security rules

1. **Never print passwords.** `list`/`env`/errors/JSON expose only `passwordSet` and the source line.
2. **Never write config.** No `.env` generation, no token storage, no connection cache.
3. **Never bypass read-only.** Do not write your own mysql/redis scripts around the guard.
4. Prefer read-only accounts for production; when only a privileged account exists, still query read-only
   first and get explicit approval before any write.
5. Always bound large queries with `WHERE`/`LIMIT`; `--no-limit` only for known-small tables.
6. Do not dump whole tables containing personal data (ID numbers, phone numbers, password hashes) into the
   conversation.

## On-demand drivers

**The skill itself has zero dependencies.** These four work out of the box:

- SQLite (`node:sqlite`, requires Node ≥ 22.13)
- Redis (built-in RESP client over `node:net`/`node:tls`)
- ClickHouse (HTTP)
- Elasticsearch (HTTP)

Everything else is installed on first use, into the skill directory or `DB_DRIVER_DIR`:

```bash
dbcli drivers install mysql postgres mongodb     # mysql2 / pg / mongodb
dbcli drivers install oracle sqlserver kafka     # oracledb / mssql / kafkajs
dbcli drivers                                      # status
dbcli drivers clean                                # remove node_modules and the npm cache
```

- If the project already has `mysql2`/`pg`/`mongodb`/`kafkajs`, the CLI **reuses it** (resolved from the
  current project directory) and does not install anything.
- Restricted network: `dbcli drivers install mysql --registry https://registry.npmmirror.com`.
- Read-only skill directory: `DB_DRIVER_DIR=D:\dbcli-drivers`.
- **DM8**: the official `dmdb` driver is not on public npm. Install the `drivers/nodejs/dmdb-*.tgz` from the
  DM8 installation: `DB_DM_DRIVER_TGZ=<tgz> dbcli drivers install dameng`. `dmdb` is a native addon and must
  match the Node ABI.

## Do not replace the CLI with scripts

| Need | Use this |
| --- | --- |
| Which database am I on? | `dbcli list` / `dbcli env` |
| Run a SQL statement | `dbcli query "..."` |
| Schema / DDL / indexes | `dbcli desc` / `dbcli ddl` / `dbcli indexes` |
| Lock waits / slow SQL | `dbcli locks` / `dbcli slow` |
| Kafka topic / lag / messages | `dbcli tables` / `dbcli query '{"op":"lag",...}'` / `{"op":"peek",...}` |
| Cannot connect | `dbcli ping` + "Common errors" |

Write scripts only for cross-database aggregation, batch comparison, or post-processing (consume the CLI's
`--format json` output rather than re-implementing connections).

## Development and tests

```bash
npm test                                                  # standard runner
npm run test:sandbox                                      # no child processes (sandboxed environments)
```

Coverage: `.env` parsing and expansion, compose/Spring discovery, connection strings (JDBC/Go DSN/libpq),
read-only guard and row-limit injection, output formats and masking, SQLite end-to-end, Redis (RESP mock),
ClickHouse/Elasticsearch (HTTP mock), Kafka (injected kafkajs double), driver registry.

## Version

`0.2.3` — keep in sync with `package.json`; update this file and README when behaviour changes.
