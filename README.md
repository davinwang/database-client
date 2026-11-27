# database-client (dbcli)

English | [简体中文](README.zh-CN.md)

`dbcli` is a database and middleware troubleshooting client for coding agents: **every connection comes from the project's environment variables / `.env`, and the skill itself stores no hosts, users or passwords.**
Read-only by default, it runs SQL, inspects schemas/indexes/DDL, and reports lock waits and the slowest SQL queries.

- Supports MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB, OceanBase (MySQL and Oracle modes),
  PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss, Oracle, DM8, SQL Server, SQLite,
  MongoDB, Redis, Kafka/Redpanda, ClickHouse, Elasticsearch.
- Works with zero dependencies for SQLite, Redis, ClickHouse and Elasticsearch (Node built-ins or plain HTTP).
- Every other engine installs an npm driver on demand (`dbcli drivers install ...`) — **drivers are never bundled with the skill source**.

The agent-facing guide is [SKILL.md](SKILL.md) — a deliberately small entrypoint (progressive disclosure) that points
at on-demand details in [references/](references): configuration discovery, write approval, non-SQL engines, engine
capabilities, troubleshooting. The license is [GPL-3.0](LICENSE).

## Why not just use a SQL client

For an agent, the cost is not in "running SQL". It is in these four questions:

1. **Which database does this project actually connect to right now?** Every project and environment uses different variable names — hardcoded config is guaranteed to be wrong.
2. **Why did the connection fail, or why is permission denied?** Drivers answer with a bare `Access denied`, leaving the agent to guess.
3. **Will a single `SELECT *` drag an entire table into the context window?** It needs a row limit, cell truncation and masking by default.
4. **Is this read-only or writable?** Troubleshooting should not have write access by default.

`dbcli` answers exactly those four, and leaves the SQL to the agent.

## Requirements

- Node.js **>= 22.13** (`node:sqlite` is unflagged from 22.13; older releases are not supported)
- No Java, no database client binaries, no pre-installed drivers

## Install

Drop the whole directory into your skills directory (for example `~/.agents/skills/database-client`), then:

```bash
node <skill-dir>/bin/dbcli.mjs --help
```

You can also put it on `PATH`: `bin/dbcli` (POSIX) / `bin/dbcli.cmd` (Windows).

## Quick start

```bash
# 1) If the project already defines DB_URL / DATABASE_URL / MYSQL_* etc., you are good to go
export DB_URL='mysql://app:<password>@127.0.0.1:3306/appdb'

node bin/dbcli.mjs list          # which connections were discovered (passwords never shown)
node bin/dbcli.mjs doctor        # self-check: Node / drivers / config / connectivity
node bin/dbcli.mjs tables        # list tables
node bin/dbcli.mjs desc orders   # table structure
node bin/dbcli.mjs query "select * from orders where status='NEW' order by id desc" --limit 20
node bin/dbcli.mjs locks         # who is waiting on a lock
node bin/dbcli.mjs slow -n 10    # slowest SQL
```

No environment variables configured? If the project root has a `.env`, a `docker-compose.yml` or a Spring `application.yml`,
the CLI discovers them automatically (see [Configuration discovery](#configuration-discovery)). Use `dbcli env` to see
which file and line every value came from.

## Configuration discovery

### Priority (high to low)

1. Command-line flags (`--db`, `--env-file`, `--schema`)
2. Process environment variables (agent hosts usually inject per-project values here)
3. Files passed via `--env-file` (repeatable; later files override earlier ones)
4. `.env.<profile>.local` -> `.env.<profile>` -> `.env.local` -> `.env`
   (the profile is the first value found in `SPRING_PROFILES_ACTIVE` / `APP_ENV` / `NODE_ENV` / `PROFILE` / `ENV`)
5. `services` in `docker-compose.yml` / `compose.yml`
6. Spring `application.yml` / `application-<profile>.yml` / `application.properties` / `config/` / `src/main/resources/`

Search scope: the current directory, plus the enclosing project root (the nearest directory containing markers such as
`.git`/`package.json`/`pom.xml`/`go.mod`).

### Variable naming

| Form | Example | Meaning |
| --- | --- | --- |
| Single database | `DB_URL` | Connection name is always `default`; no `--db` needed while it is the only one |
| Multiple databases | `DB_ERP_URL` | Connection name `erp`, selected with `--db erp` |
| Segmented | `DB_ERP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | A type in the name makes `_TYPE` optional |
| Type aliases | `DB_MYSQL_URL`, `DB_REDIS_HOST` | `mysql`/`redis` in the name are recognised as the type |
| Generic | `DATABASE_URL`, `JDBC_URL`, `SPRING_DATASOURCE_URL` | Detected automatically |
| Ecosystem | `MYSQL_*`, `PG*`/`POSTGRES_*`, `REDIS_*`, `MONGO_URI`, `KAFKA_*`, `CLICKHOUSE_*`, `ES_*`, `ELASTICSEARCH_*` | Use the project's existing names as-is |

Optional: `DB_DEFAULT=<name>` picks the default connection; `DB_<name>_SCHEMA` sets the default schema;
`DB_<name>_DIALECT`/`_MODE` (OceanBase: `oracle`); `DB_<name>_SSL=true`; `DB_<name>_FILE` (SQLite path);
`REDIS_CLUSTER_NODES=a:6379,b:6379` for a Redis cluster (single-node view).

### Framework configuration files (language-agnostic)

Discovery is not tied to one ecosystem; the same adapters run for every project:

| Source | Stack | Mapping |
| --- | --- | --- |
| `.env*` | any | variables, layered by profile |
| `docker-compose.yml` | any | service image/ports/environment |
| `application*.yml` / `application*.properties` | Java / Spring Boot | `spring.datasource.*`, `dynamic.datasource.*`, `spring.data.redis.*`, `spring.data.mongodb.uri`, `spring.elasticsearch.uris` |
| `appsettings*.json` | .NET | `ConnectionStrings:<name>` (ADO.NET string or URL) → `dotnet-<name>` |
| `ormconfig.json`, `config/*.json` | Node (TypeORM / node-config) | connection objects → `config-<path>` |
| `database.yml` | Ruby / Rails | `adapter` + host/database/username → `rails-<env>` |
| `*.ini`, generic JSON/YAML/properties | Python (alembic), others | DB URLs in database-ish keys → `config-<key>` |

Spring values are expanded against the project environment. A dotenv-style `application-<profile>.properties`
(`DATASOURCE_URL=...`) participates in that expansion when `SPRING_PROFILES_ACTIVE` is set. If a URL still
contains a placeholder after expansion, the connection is skipped with a warning naming the variable; define it
in the environment or pass `--env-file <file>`. "Config files read" only means the file was parsed, not that
every placeholder resolved.

Credentials containing `@`, `#`, `%` or `&` (for example `user@tenant#instance`) must not be pasted into a
`scheme://user:pass@host` URL — `@` and `#` are delimiters and the target silently becomes wrong. Use split
fields (`DB_<NAME>_USER`, `DB_<NAME>_PASSWORD`) or percent-encode them.

### Connection-string formats

```text
mysql://user:pass@host:3306/db?ssl=true
postgres://user:pass@host:5432/db?sslmode=require
oracle://user:pass@host:1521/SERVICE          # also accepts jdbc:oracle:thin:@//host:1521/SVC and @host:1521:SID
dameng://SYSDBA:pass@host:5236
sqlserver://user:pass@host:1433/db?encrypt=true
oceanbase://root:pass@host:2881/db?mode=oracle
sqlite:./data/app.db                          # relative paths resolve against the current directory
mongodb://user:pass@host:27017/db?authSource=admin
mongodb+srv://...
redis://:pass@host:6379/2                     # rediss:// uses TLS
kafka://user:pass@broker1:9092,broker2:9092?ssl=true&saslMechanism=scram-sha-256
clickhouse://user:pass@host:8123/db           # http(s):// works too
http://user:pass@host:9200                    # Elasticsearch; needs DB_<name>_TYPE=elasticsearch or ES_URL
jdbc:mysql://host:3306/db?useUnicode=true     # JDBC strings can be pasted as-is
user:pass@tcp(host:3306)/db                   # Go DSN
host=pg port=5432 user=app dbname=erp         # libpq DSN
```

## Commands

| Command | Description |
| --- | --- |
| `list` / `ls` | Connection inventory: name, default marker, type, target, source (file:line), notes |
| `env` | Every database variable with its value and source (masked); `--all` also shows shadowed variables |
| `doctor` | Node version / driver status / config discovery / ping per connection |
| `drivers` | Driver status; `drivers install <name>\|all`; `drivers clean` |
| `ping` | Version, database, user, latency, read-only session state |
| `query` | Execute SQL (Redis commands / Mongo JSON / ES REST also go through here) |
| `approve` | Sign a write approval after the user confirms in the host dialog (`approve --id <requestId> --answer "同意执行"`) |
| `tables` | Tables and views; `--pattern` filters; Mongo collections and ES indexes work the same way |
| `desc` | Column name/type/nullability/default/primary key/comment |
| `ddl` | `CREATE TABLE` statement (MySQL uses `SHOW CREATE TABLE`; other engines rebuild it from the data dictionary) |
| `indexes` | Indexes and column order (a missing index is the first suspect for a slow query) |
| `locks` | Lock waits: waiting/blocking sessions, wait duration, SQL excerpt |
| `slow` | Slow SQL / slow commands, top N (`-n` controls the count) |

Common options:

```text
--db <name>         Pick a connection when several exist
--schema <schema>   schema / database / owner
--limit <N>         Row cap (query defaults to 200, slow to 20)
--no-limit          Do not inject a row cap
--format auto|table|json|csv|md
--max-cell <N>      Characters per cell before truncation
--timeout <ms>      Connect/query timeout, default 15000
--env-file <path>   Additional .env file (repeatable)
--pattern <glob>    Table/index name filter (supports % or * wildcards)
--no-auto           Skip automatic discovery of .env / compose / application.yml
--insecure-tls      Skip certificate verification
--allow-write       Ask for a write (still needs the confirmation dialog)
--dry-run           Execute a write then roll back (needs --allow-write and its own approval)
--approve <code>    Run the write with the one-time approval code
--agent             Mark the approval as signed by the host dialog (with --approve)
```

### Query examples

```bash
# Plain SQL (wrapped in a read-only transaction with a LIMIT injected)
dbcli query "select id, name from users where created_at > '2026-01-01'"

# Read from a file
dbcli query --file ./sql/check.sql

# Non-SQL engines
dbcli query "INFO server"                                                # Redis
dbcli query '{"collection":"users","filter":{"status":"A"},"limit":5}'   # Mongo
dbcli query "/_cat/indices?format=json"                                  # Elasticsearch
dbcli query '{"op":"lag","group":"app-consumer"}'                        # Kafka consumer lag
```

### Querying Kafka

Kafka has no SQL, so `query` accepts a read-only operation (JSON or a bare operation name):

| Operation | Purpose |
| --- | --- |
| `{"op":"topics"}` / `dbcli tables` | Topic list (partition count, replication factor, internal topics) |
| `{"op":"describe","topic":"orders"}` / `dbcli desc orders` | Per-partition leader / replicas / ISR / start and end offsets / message volume |
| `{"op":"peek","topic":"orders","limit":5,"from":"latest"}` | Sample a few messages (`from`: latest/earliest, plus optional `partition` and `timeoutMs`) |
| `{"op":"groups"}` | Consumer groups (state / protocol / members) |
| `{"op":"lag","group":"app-consumer"}` | committed / high watermark / lag per partition, with total lag |
| `{"op":"offsets","topic":"orders"}` | low/high offsets per partition |
| `{"op":"configs","topic":"orders"}` | Topic configuration (retention and friends) |
| `{"op":"cluster"}` | clusterId, controller, broker list |

Notes:

- Strictly read-only: **no message production, no config changes, no offset resets**; `--allow-write` is rejected explicitly.
- `peek` reads through a temporary consumer group (`dbcli-peek-<uuid>`) with `autoCommit:false`, so an empty consumer group
  is left behind on the broker and expires according to `offsets.retention`; messages are awaited for at most 5 seconds by default
  (`timeoutMs` tunes it).
- Diagnosis order for lag: `lag` to see the backlog, then `desc` for ISR/leader, then `groups` to check for repeated rebalances.

## Read/write control

| Mode | Command | Behaviour |
| --- | --- | --- |
| Read (default) | `dbcli query "..."` | Statement allowlist + session-level read-only (MySQL/PG/Oracle/SQLite/ClickHouse) + automatic row cap |
| Write | `dbcli query "update ..." --allow-write` + approval | A single statement; reports affected rows afterwards |
| Dry run | `dbcli query "update ..." --allow-write --dry-run` + approval | Executes inside a transaction, then `ROLLBACK`; reports affected rows only |

- Read-only interception: `insert/update/delete/merge/truncate/drop/alter/create/grant/revoke/call`,
  `select ... into outfile`, `for update`, `nextval()/setval()`, `pragma` assignments, multiple statements,
  and non-read-only `explain`. Redis goes through a command allowlist; Mongo rejects `$out/$merge`;
  Elasticsearch only allows GET/HEAD and query-style POST; Kafka only allows
  topics/describe/peek/groups/lag/offsets/configs/cluster.
- Session-level backstop: MySQL `SET SESSION TRANSACTION READ ONLY` plus `START TRANSACTION READ ONLY` per statement;
  PG `default_transaction_read_only=on` plus `BEGIN READ ONLY`; Oracle `SET TRANSACTION READ ONLY`;
  SQLite opened with `readOnly`; ClickHouse requests carry `readonly=1`.
- `--dry-run` on its own is an error (a trial run still takes real locks and fires triggers, so it may not be used silently).
- Dry run is supported for MySQL/OceanBase/PostgreSQL/Oracle/DM8/SQL Server/SQLite;
  not for ClickHouse (no transactions) or Redis/Mongo/ES (the CLI explains why).

## Write approval (confirmation dialog)

**`--allow-write` alone never changes anything.** It prints a confirmation card, a request ID and a one-time
code, then exits **7**. Nothing reaches the database until the user answers a dialog the agent must show.

```bash
# 1) Request the write (--json returns the ready-to-use dialog arguments; nothing is executed)
dbcli query "update orders set status='X' where id=42" --allow-write --json
# {"status":"approval_required","channel":"agent","host":"dsh","requestId":"c969…","approvalCode":"VP54ST",
#  "plan":{…},"card":{…},"next":{"tool":"ask_user_question","params":{…},"onApprove":"…","thenRun":"…"}}

# 2) The agent shows card.question to the user with the host confirmation tool (DSH: ask_user_question)

# 3) The user picked 「同意执行」 → sign the approval
dbcli approve --id c969938a796806a1 --answer "同意执行"

# 4) Run the write
dbcli query "update orders set status='X' where id=42" --allow-write --approve VP54ST --agent
```

- The card is Chinese (`数据库写操作授权` … `[同意执行] [取消]`) because a human reads it; its labels must be
  passed to `--answer` verbatim.
- The approval fingerprint covers verb + mode + engine + connection + masked target + the exact statement, so
  any change (including a different `--db`) invalidates the code. Codes are single-use, expire after 5 minutes
  (10 for the signed grant), and are bound to the host session that asked.
- A signed **write** approval also covers the matching `--dry-run`, and the trial run does not spend it:
  approve once, dry-run to see the affected rows, then commit. A dry-run approval never covers a write.
- Host mapping: DSH `ask_user_question`, Claude Code `AskUserQuestion`, WorkBuddy `AskUserQuestion`,
  Codex (no question tool: show the card, run `approve` after an explicit yes), anything else text confirmation.
  `dbcli doctor` prints the detected host, tool and session.
- Hand-off record: `<temp>/dbcli-approvals/approvals.json` (`DBCLI_STATE_DIR` overrides). It stores fingerprints,
  the masked target, a truncated statement preview and timestamps — no passwords, no result rows — and entries
  are deleted on use. If it cannot be written, the command fails instead of executing (fail closed).
- A human at a terminal gets the same card plus a `y/N` prompt; no env var or config key approves anything.

Honest boundary: the agent and the CLI share one shell, so a hostile agent could replay the record. The
guarantee is "nothing silent by default, and every write is traceable to a request ID, host and channel".

## Engine support matrix

| Engine | Query | Tables/schema | DDL | Indexes | Locks | Slow SQL | Write | Dry run | Protocol/driver |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MySQL / MariaDB / TiDB / TDSQL / PolarDB / GoldenDB | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | mysql2 |
| OceanBase (MySQL mode) | Yes | Yes | Yes | Yes | Partial | Partial | Yes | Yes | mysql2 |
| OceanBase (Oracle mode, `MODE=oracle`) | Yes | Yes | Yes | Yes | Partial | Partial | Yes | Yes | mysql2 |
| PostgreSQL / Kingbase / Vastbase / GaussDB / openGauss | Yes | Yes | Yes (rebuilt) | Yes | Yes | Yes | Yes | Yes | pg |
| Oracle | Yes | Yes | Yes (rebuilt) | Yes | Yes | Yes | Yes | Yes | oracledb |
| DM8 (Dameng) | Yes | Yes | Yes (rebuilt) | Yes | Partial | Partial | Yes | Yes | dmdb (official) |
| SQL Server | Yes | Yes | Yes (rebuilt) | Yes | Yes | Yes | Yes | Yes | mssql |
| SQLite | Yes | Yes | Yes | Yes | No | No | Yes | Yes | node:sqlite |
| MongoDB | Yes | Yes (field sampling) | Partial | Yes | Yes | Yes | No | No | mongodb |
| Redis | Yes (commands) | No | No | No | No | Yes (SLOWLOG) | Yes (allowlist) | No | built-in RESP client |
| Kafka / Redpanda | Yes (read-only ops) | Yes (topics) | No | No | No (see ISR/leader) | No (see consumer lag) | No | No | kafkajs |
| ClickHouse | Yes | Yes | Yes | Yes (primary/sorting key) | No | Yes | Yes | No | HTTP |
| Elasticsearch | Yes (REST) | Yes (indexes/mapping) | Partial | No | No | No | No | No | HTTP |

`Partial` means the result depends on the server version and permissions; when a command fails, the CLI prints the
alternative view name available on that version instead of an empty result.

## Drivers: installed on demand, keeping the skill small

| Engine | Dependency | Size (approx.) |
| --- | --- | --- |
| SQLite / Redis / ClickHouse / Elasticsearch | none (Node built-ins / HTTP) | 0 |
| MySQL / OceanBase | `mysql2` | ~2 MB |
| PostgreSQL family | `pg` | ~1 MB |
| MongoDB | `mongodb` | ~6 MB |
| Kafka / Redpanda | `kafkajs` | ~3 MB |
| SQL Server | `mssql` | ~2 MB |
| Oracle | `oracledb` (thin mode) | ~15 MB |
| DM8 | `dmdb` (official tarball) | ~10 MB |

```bash
dbcli drivers install mysql postgres      # install only what you use
dbcli drivers install all                 # every npm driver except DM8
dbcli drivers clean                       # remove node_modules and the npm cache
```

- Install location: `<skill>/node_modules` by default; set `DB_DRIVER_DIR` to change it (useful when the skill directory is read-only).
- **Reuses project dependencies**: the CLI resolves packages from the current project directory, so an existing `mysql2`/`pg` means no extra install.
- Restricted network: add `--registry https://registry.npmmirror.com`.
- DM8: the official driver is not on public npm. Take `drivers/nodejs/dmdb-*.tgz` from the DM installation and run
  `DB_DM_DRIVER_TGZ=<tgz> dbcli drivers install dameng`; `dmdb` is a native addon, so the Node version must match.

## Output contract

- `--format auto`: a table on a TTY, JSON when piped or captured.
- JSON: `{columns, rowCount, truncated, durationMs, rows}`; document results use `documents`;
  writes and dry runs return `{mode, statement, affectedRows, rolledBack, authorizedBy}`.
- A write awaiting approval returns `{status:"approval_required", requestId, approvalCode, plan, card,
  next:{tool, params, onApprove, thenRun, thenRunArgs}}` and exits 7; `next.params` feeds the host
  confirmation tool directly, and `next.thenRunArgs` is the exact argument list for the approved rerun.
- A capped result sets `truncated: true`; cells are truncated according to `--max-cell`; binary values render as `<binary N B>`;
  bigint values become strings so no precision is lost.
- Passwords never appear: listings show only `passwordSet` and a length; connection strings inside error messages are masked.

Exit codes: `0` success, `1` other error, `2` usage error, `3` connection selection, `4` read-only guard,
`5` missing driver, `6` connection failure, `7` write approval required / not granted (nothing executed).

## Architecture

```text
bin/dbcli.mjs            entry point (thin)
lib/cli.mjs              argument parsing, dispatch, help, exit codes
lib/commands.mjs         command implementations (thin: connect, gate, call driver, render)
lib/connections.mjs      env vars -> connection model (URL/JDBC/DSN parsing, dedupe, masking)
lib/discover.mjs         project discovery (.env layering, docker-compose, Spring)
lib/configfiles.mjs      language-agnostic config adapters (.NET appsettings, Rails, Node, INI/JSON URLs)
lib/env.mjs              .env parsing (quotes/escapes/expansion/line numbers)
lib/yaml.mjs             minimal YAML / properties (only for compose and Spring)
lib/guard.mjs            read-only guard, statement splitting, LIMIT injection, Redis/Mongo/ES allowlists, blast-radius hints
lib/approval.mjs         write approval store: fingerprints, one-time codes, TTLs, session binding
lib/hosts.mjs            host detection (DSH/Claude/Codex/WorkBuddy) + the confirmation card
lib/authorize.mjs        the write gate: plan -> card -> approve -> `--approve` verification
lib/errors.mjs           error -> troubleshooting hints (dozens of engine codes)
lib/output.mjs           table/JSON/CSV/Markdown, masking, truncation
lib/drivers/*.mjs        one driver per engine: ping/query/tables/describe/ddl/indexes/locks/slow
```

To add an engine: create a `create(conn, options)` module in `lib/drivers/` (implement whichever methods you can, and throw
`UnsupportedError` with an alternative query for the rest), register the type and its dependency in `DRIVERS` in
`lib/drivers/index.mjs`, and add aliases and the default port to `TYPE_ALIASES`/`TYPE_META` in `lib/connections.mjs`.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the full checklist.

## Security model

- **Nothing persisted**: no `.env` writes, no connection caches, no history; every invocation re-reads the project.
  The only file written is the short-lived approval hand-off record (fingerprints, masked target, timestamps).
- **Least privilege**: read-only connections by default; use a read-only account against production.
- **Auditable**: every output carries the target (`mysql://user@host:port/db`) and where the credentials came from (file:line).
- **Accident prevention**: a write needs `--allow-write`, a per-statement confirmation dialog, and
  `dbcli approve` signed by the user's answer; `--dry-run` (also approved) shows the affected row count first.
- **Leak prevention**: passwords are never printed, and connection strings in error messages are masked.

## Testing

```bash
npm test                                                    # standard runner (per-file process isolation)
npm run test:sandbox                                        # no child processes: use in sandboxes (e.g. DSH)
```

Coverage: `.env` parsing and variable expansion, compose/Spring discovery, connection strings (JDBC/Go DSN/libpq),
the read-only guard and LIMIT injection, write approval (fingerprints, one-time codes, expiry/session binding,
`approve` end-to-end, blast-radius hints), output formats and masking, end-to-end SQLite against a real database,
Redis (RESP mock), ClickHouse/Elasticsearch (HTTP mock), and the driver registry.

## Known limitations

- Lock and slow-query views for DM8/OceanBase depend on version-specific internal views; when unavailable the CLI suggests an
  alternative query rather than promising out-of-the-box results.
- `ddl` for Oracle/PG/SQL Server/DM8 is rebuilt from the data dictionary (partitions, storage parameters and constraint names are incomplete).
- SQL Server cannot report column names for an empty result set (a TDS driver limitation); the CLI says so explicitly.
- Writes and dry runs are unsupported for ES/Mongo (no transactions, and outside the troubleshooting scope).
- Kafka is read-only: no producing, no config changes, no offset resets; `peek` creates a temporary consumer group and never commits offsets.
- SQL dialect differences are not rewritten automatically; the CLI only enforces read-only checks and injects row limits.
