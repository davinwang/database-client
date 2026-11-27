---
name: database-client
version: 0.4.0
description: "Database and middleware troubleshooting client (dbcli) for coding agents. Credentials come only from the project's env vars and .env files; the skill stores none. Read-only by default: run SQL, inspect schema/indexes/DDL, find lock waits and slow queries, read Kafka topics/messages/consumer lag. Engines: MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB, OceanBase, PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss, Oracle, DM8, SQL Server, SQLite, MongoDB, Redis, Kafka/Redpanda, ClickHouse, Elasticsearch. Use for querying a database, table or index structure, ad-hoc SQL, slow queries, lock waits or deadlocks, connection or auth failures (Access denied, ORA-*, ECONNREFUSED), domestic databases (OceanBase, DM8, Kingbase), EXPLAIN plans, verifying production data, Kafka missing messages or consumer lag, Redis slow commands, Elasticsearch indices. Not a SQL generator or data-modification tool: every write needs a per-statement confirmation dialog."
metadata:
  requires:
    bins: ["node"]
  cliHelp: "node bin/dbcli.mjs --help"
---

# database-client

English | [简体中文](SKILL.zh-CN.md)

`dbcli` is a **thin driver layer**: you write the SQL, the CLI connects, executes, and explains results and
errors. In this file `dbcli` means `node <skill-dir>/bin/dbcli.mjs`.

Three hard rules:

1. **No stored credentials.** No config file, no cache, no history. Every run re-reads the project's env vars
   and `.env` files; passwords live only in memory. `list`, `env`, errors and JSON output never contain a
   plaintext password. The only file ever written is the short-lived approval hand-off record (fingerprints,
   never credentials).
2. **Read-only by default.** A write is rejected at parse time (exit 4); it needs `--allow-write` **and** a
   confirmation dialog the user answers, per statement (exit 7 until then). Nothing executes before that.
3. **Not a SQL generator.** No `sample`/`count`/`explain` wrapper commands — those are just `query` plus a
   statement.

Supported: MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB, OceanBase (both modes),
PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss, Oracle, DM8, SQL Server, SQLite, MongoDB, Redis,
Kafka/Redpanda, ClickHouse, Elasticsearch. What each engine can actually do → `references/engines.md`.

## Start here

```bash
dbcli doctor     # Node, drivers, config discovery, connectivity
dbcli list       # discovered connections (masked); the source column names the file and line of each value
dbcli query "select 1"
```

`doctor` reports `FAILED` → `references/troubleshooting.md`. No connection found, or the wrong database →
`references/configuration.md`.

## When to use / when not to

Use it for: "connect to staging and show the latest orders"; "this API call fails — is the row what we
expect?"; "production is slow — lock waits? which SQL is slowest?"; "what is the schema/index? send me the
DDL"; "which database is this environment actually pointing at?"; "this Kafka consumer is lagging / the topic
looks empty".

Not for: writing application SQL, changing data or schema (read-only by default; each write needs a
confirmation dialog and runs one statement at a time), migrations, ETL, or performance-tuning design.

## Commands

| Command | Purpose | Example |
| --- | --- | --- |
| `list` / `ls` | Discovered connections (masked) | `dbcli list --all` |
| `env` | Where configuration comes from and what overrides what | `dbcli env` |
| `doctor` | Self-check plus per-connection probe | `dbcli doctor` |
| `drivers` | Driver status / install / clean | `dbcli drivers install mysql postgres` |
| `ping` | Version, database, user, latency | `dbcli ping --db erp` |
| `query` | Execute SQL (also Redis commands, Mongo JSON, ES REST, Kafka read ops) | `dbcli query "select * from orders where id=1"` |
| `approve` | Sign a write approval after the user confirms | `dbcli approve --id <requestId> --answer "同意执行"` |
| `tables` | Tables/views (Mongo collections, ES indices, Kafka topics) | `dbcli tables --db erp --pattern 'order%'` |
| `desc` | Columns/types/nullability/defaults/keys (Kafka: partitions/ISR/offsets) | `dbcli desc orders --db erp` |
| `ddl` | CREATE statement / field mapping | `dbcli ddl orders` |
| `indexes` | Indexes and column order (first suspect for slow queries) | `dbcli indexes orders` |
| `locks` | Lock waits (who blocks whom) | `dbcli locks` |
| `slow` | Slow SQL / slow commands, top N | `dbcli slow -n 10` |

Common options: `--db <name>`, `--schema <schema>`, `--limit <N>` (query default 200, slow default 20),
`--no-limit`, `--format table|json|csv|md`, `--timeout <ms>`, `--env-file`, `--insecure-tls`, and for writes
`--allow-write`, `--dry-run`, `--approve <code>`, `--agent`.

Redis / MongoDB / Elasticsearch / Kafka query syntax → `references/non-sql.md`.

Do not replace the CLI with scripts: "which database am I on" is `list`/`env`, a statement is `query`, schema
is `desc`/`ddl`/`indexes`, lock/slow diagnosis is `locks`/`slow`, Kafka is `tables`/`{"op":"lag"}`/`{"op":"peek"}`,
and connection problems are `ping` + `references/troubleshooting.md`. Write scripts only for cross-database
aggregation, batch comparison, or post-processing — consume `--format json` instead of re-implementing
connections.

## Read-only by default; writes need approval

| Mode | Trigger | Behaviour |
| --- | --- | --- |
| `read` (default) | nothing | statement allow-list + session-level read-only + automatic row limit |
| `write` | `--allow-write` + approval | one write statement, reports affected rows |
| `dry-run` | `--allow-write --dry-run` + approval | executes inside a transaction, then `ROLLBACK` |

`--dry-run` alone is rejected: it still takes locks and fires triggers, and on MySQL/Oracle-style engines DDL
commits implicitly, so a "dry run" can change the schema for real.

Four steps, no shortcuts:

```bash
# 1) Request. Nothing executes; --json returns the ready-to-use dialog arguments
dbcli query "update orders set status='X' where id=42" --allow-write --json
# → {"status":"approval_required","requestId":"c969938a796806a1","approvalCode":"VP54ST",
#    "plan":{...},"card":{...},"next":{"tool":"ask_user_question","params":{...},...}}

# 2) Show `card` with the host confirmation tool (ask_user_question on DSH, AskUserQuestion on Claude Code;
#    Codex CLI / unknown host: relay the card verbatim and wait for a clear yes)

# 3) The user picked 「同意执行」 → sign it
dbcli approve --id c969938a796806a1 --answer "同意执行"

# 4) Rerun the same command with the code
dbcli query "update orders set status='X' where id=42" --allow-write --approve VP54ST --agent
```

Agent rules:

1. **The dialog is mandatory** — never ask "in passing" in prose and then run the write.
2. Relay `card.question` **as-is**: action, location, impact and statement. Do not soften the impact or drop
   the statement.
3. Keep the option labels `同意执行` / `取消`; `--answer` must match the user's choice verbatim.
4. User picked `取消` → stop. Do not retry, rephrase the SQL, or ask again.
5. Never run `dbcli approve` on the user's behalf, and never pass a guessed or remembered code.

Card text, what is fingerprinted, TTL/session binding, the dry-run blast-radius trick, the per-host tool table
and the hand-off record → `references/writes.md`.

## Output and exit codes

- Default `--format auto`: a table on a TTY, JSON when piped/captured by an agent (`--format` overrides).
- JSON shape: `{columns, rowCount, truncated, durationMs, rows:[{...}]}`; document results
  (Mongo/ES/Kafka peek) are `{rowCount, documents:[...]}`; writes/dry-runs are
  `{mode, statement, affectedRows, rolledBack, authorizedBy}`.
- A write that still needs approval is `{status:"approval_required", requestId, approvalCode, plan, card,
  next:{tool, params, onApprove, thenRun, thenRunArgs}}` with exit code 7. `next.thenRunArgs` is the exact
  argument list to rerun; `next.params` goes straight into the host confirmation tool.
- **`truncated: true` means the row limit cut the result**, not that this is all the data. Use `--no-limit`
  (carefully) or add a `WHERE`.
- Cells are truncated by default: 80 chars for tables, 4096 for JSON (`--max-cell`); binary is shown as
  `<binary N B>`; bigints are strings to avoid precision loss; `NULL` is `NULL` in tables and `null` in JSON.

Exit codes: `0` success · `1` other error · `2` usage · `3` connection selection · `4` read-only guard ·
`5` driver missing · `6` connection failed · `7` write approval required / not granted (nothing executed).

## Security rules

1. **Never print passwords.** `list`/`env`/errors/JSON expose only `passwordSet` and the source line.
2. **Never write config.** No `.env` generation, no token storage, no connection cache.
3. **Never bypass read-only.** Do not write your own mysql/redis scripts around the guard, and do not work
   around the approval gate (no `--approve` on the user's behalf, no hand-editing the state file).
4. Prefer read-only accounts for production; with a privileged account, still query read-only first and get
   the per-statement approval before any write.
5. Always bound large queries with `WHERE`/`LIMIT`; `--no-limit` only for known-small tables.
6. Do not dump whole tables containing personal data (ID numbers, phone numbers, password hashes) into the
   conversation.

## Reference files (read on demand)

Paths are relative to this skill's directory. Load one only when its trigger applies.

| File | Read when |
| --- | --- |
| `references/configuration.md` | no connection found, wrong database, `--env-file`, passwords/URLs with `@ # % &`, `.env` layering, compose/Spring/.NET/Rails/TypeORM config discovery |
| `references/writes.md` | a write is requested: exact card text, fingerprint/TTL, dry-run blast radius, per-host confirmation tools, hand-off record, exit-7 recovery |
| `references/non-sql.md` | the target is Redis, MongoDB, Elasticsearch or Kafka |
| `references/engines.md` | "can this engine do X?", capability matrix, unsupported operations per engine, driver install (exit 5) |
| `references/troubleshooting.md` | `doctor` failed, cannot connect, slow/stuck queries, lock waits, garbled output, common error → next step |
| `references/development.md` | changing the skill itself: tests, coverage, version |
