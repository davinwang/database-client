# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-27

### Changed

- **The skill documentation is now progressive-disclosure.** `SKILL.md` is loaded in full on every activation, so it
  is now an entrypoint (10.3 KB / 165 lines, was 28.5 KB / 491 lines) instead of a manual: hard rules, the commands
  needed to start, the write-approval flow and its agent rules, the output contract, the security rules, and an index
  of where the details live. The long tail moved to `references/` and is read only when its trigger applies:
  `configuration.md` (config discovery), `writes.md` (approval detail), `non-sql.md` (Redis/MongoDB/ES/Kafka),
  `engines.md` (capabilities + drivers), `troubleshooting.md` (SOP + error table), `development.md`.
  `SKILL.zh-CN.md` mirrors the entrypoint and points at the same reference files, so there is one source of truth.
- The skill `description` was shortened from 1197 to 946 characters (the Chinese one from 533 to 478). Some hosts
  deactivate a skill whose description exceeds 1024 characters; the wording keeps every routing keyword
  (engine names, `Access denied`, `ORA-*`, `ECONNREFUSED`, `EXPLAIN`, consumer lag, …).
- The DM8 note in `list` no longer claims that "DM8 does not support direct queries yet" — it does, through the
  official `dmdb` driver — and the hint for an unsupported command points at `references/engines.md` instead of a
  section that no longer exists in `SKILL.md`.

### Added

- `tests/skill-docs.test.mjs` guards the documentation: the 1024-character description limit, the frontmatter
  (name/version/`cliHelp`, version in sync with `package.json`), the `SKILL.md` size budget (12 KB / 200 lines),
  that every `references/…` path mentioned in the docs or in `lib/` resolves, and that every reference file is
  listed in both language entrypoints.
- `CONTRIBUTING.md` documents the layout: details go into the matching reference file plus at most a one-line
  pointer in `SKILL.md`.

### Fixed

- `package.json` `files` now ships `references/` and `SKILL.zh-CN.md`, which the published package was missing.

## [0.3.0] - 2026-11-24

### Added

- **Write approval (confirmation dialog).** `--allow-write` alone now executes nothing: it prints a
  confirmation card, a request ID and a one-time code, then exits 7. The agent shows the card through the host
  confirmation tool (`ask_user_question` on DSH, `AskUserQuestion` on Claude Code/WorkBuddy, text fallback
  elsewhere), runs `dbcli approve --id <requestId> --answer "同意执行"`, and reruns the same command with
  `--approve <code> --agent`. Approvals are fingerprint-bound (verb + mode + engine + connection + masked
  target + the exact statement), single-use, session-bound, and expire (5 min for the request, 10 min for the
  signed grant).
- A signed write approval also covers the matching `--dry-run` and is not spent by it, so "verify the blast
  radius, then commit" costs one dialog.
- The card states the action, location, impact and statement, including blast-radius hints (no `WHERE`,
  `WHERE 1=1`, `INSERT ... SELECT`, auto-committing DDL in a dry run).
- `doctor` reports the detected approval host, confirmation tool, session marker and hand-off file.
- New modules `lib/approval.mjs`, `lib/hosts.mjs`, `lib/authorize.mjs`; tests `tests/approval.test.mjs`
  (fingerprints, one-time codes, TTL, session binding, dry-run interaction) and `tests/approve-cli.test.mjs`
  (8 end-to-end cases over SQLite).

### Changed

- **Breaking:** `--allow-write` no longer executes a write by itself; automation must go through `approve` and
  `--approve <code> --agent`. A human at a terminal gets the same card plus a `y/N` prompt instead of a
  second command.
- `--dry-run` requires approval too: on MySQL/Oracle-style engines DDL commits implicitly, so a trial run can
  really change the schema.
- Write JSON output gained `authorizedBy`; new exit code `7` = write approval required / not granted (nothing
  executed).
- The driver registry now records which modes each engine can execute, so an engine that cannot write fails with
  its own explanation instead of prompting for an approval it could not use. The capability matrix reflects
  that ClickHouse writes are unsupported (the driver always rejected them).
- The approval hand-off record lives in `<temp>/dbcli-approvals/approvals.json` (`DBCLI_STATE_DIR` overrides
  it); it holds no credentials and no result rows, and the CLI fails closed when it cannot be written.

## [0.2.3] - 2026-11-20

### Fixed

- `env` no longer prints secrets for `*_PASS` variables or `redis://:password@host` URLs, and masks
  password-like values inside `*_PARAMS`; `list --json` no longer exposes the password length.
- The read-only guard rejects MySQL executable comments (`/*! ... */`), whose content the server executes.
- Row-limit injection now works when the statement ends with `;`, and cannot be swallowed by a trailing
  `--` or `#` comment (the limit is injected on a new line).
- `--cwd` now also applies to SQLite file paths and `--file`, not just to configuration discovery.
- OceanBase Oracle mode `indexes` returned columns in the wrong order (status where the table belonged), so
  `ddl` printed the index status instead of its columns; fixed in `indexes` and covered by a regression test.
- `drivers clean` refuses to delete `node_modules` outside the skill directory unless `--force`, and never
  removes `package-lock.json` there.
- `--limit 0` (or a negative value) is rejected instead of silently disabling the row limit.
- `appsettings*.json` files with a UTF-8 BOM are parsed; `appsettings.<Environment>.json` overrides
  `appsettings.json` instead of adding a duplicate connection.

### Changed

- Node.js requirement is now 22.13+ (`node:sqlite` is unflagged there).
- `npm test` uses the standard test runner; `npm run test:sandbox` keeps the `--test-isolation=none` variant
  for sandboxed environments.
- Added a GitHub Actions CI workflow (Node 22/24), package metadata (`license`, `repository`, `author`), and
  `package-lock.json` is ignored.

## [0.2.2] - 2026-11-20

### Added

- Redis Cluster support: slot routing (CRC16 with hash tags), MOVED/ASK redirects, and fan-out helpers for
  `SCAN`, `KEYS`, `DBSIZE`, `INFO`, `CLIENT LIST` and `SLOWLOG`; `rediss://` continues to work per node.
- Language-agnostic configuration adapters: .NET `appsettings*.json` (`ConnectionStrings`), Ruby/Rails
  `database.yml`, Node `ormconfig.json` / `config/*.json` connection objects, and generic JSON/YAML/properties/INI
  files that contain database URLs.
- YAML anchors and merge keys (`&default`, `<<: *default`), used by Rails `database.yml`.

## [0.2.1] - 2026-11-20

### Fixed

- `--pattern` now accepts `*` as a wildcard (previously only `%` worked, so `*member*` matched nothing) and the
  help text matches the implementation; Elasticsearch converts `%` to an index glob and MongoDB strips both
  wildcards for its substring match.
- Spring datasource URLs that are still `${...}` placeholders are skipped with a warning that names the missing
  variable and explains how to define it, instead of failing with "missing scheme://".
- Dotenv-style `application-<profile>.properties` files now participate in `${...}` expansion, so
  `spring.datasource.url: ${DATASOURCE_URL}` resolves without `--env-file`.
- `spring.datasource.dynamic.datasource.<name>.*` (dynamic-datasource) is discovered as one connection per
  datasource (`spring-<name>`, primary marked in notes).
- Connections are no longer invented with `localhost` when only part of the configuration is present (for
  example `REDIS_PASSWORD` without a host); such groups are skipped with a warning.
- Redis cluster nodes (`REDIS_CLUSTER_NODES`, `SPRING_REDIS_CLUSTER_NODES`, `spring.redis.cluster.nodes`) are
  parsed into a cluster connection, and MOVED/ASK errors now explain the single-node limitation.
- Connections pointing at the same target are de-duplicated even when only one side has an explicit port.
- `drivers install` verifies the packages are resolvable from the install directory before reporting success,
  and points at `DB_DRIVER_DIR` when the directory is read-only or ephemeral.
- Dotenv keys may contain dots and hyphens, so passing a `.properties` file to `--env-file` no longer produces
  "invalid variable name" noise.

## [0.2.0] - 2026-11-20

### Added

- Initial public release of `database-client` / `dbcli`, a zero-credential database and middleware client for coding agents.
- Twelve engine families: MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB, OceanBase (MySQL and Oracle modes),
  PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss, Oracle, DM8, SQL Server, SQLite, MongoDB, Redis, Kafka/Redpanda,
  ClickHouse and Elasticsearch.
- Zero-credential configuration discovery: project environment variables, layered `.env` files, `docker-compose.yml`,
  and Spring `application.yml`/`application.properties`, with per-value source reporting (`file:line`) in `dbcli env`.
- Connection-string parsing for `scheme://` URLs, JDBC strings, Go DSNs and libpq DSNs, plus `DB_*`, `DATABASE_URL`,
  `JDBC_URL`, `SPRING_DATASOURCE_*`, `MYSQL_*`, `PG*`/`POSTGRES_*`, `REDIS_*`, `MONGO_URI`, `KAFKA_*`, `CLICKHOUSE_*`,
  `ES_*`/`ELASTICSEARCH_*` naming.
- Read-only guard enabled by default, combining a statement allowlist, session-level read-only transactions and automatic
  row-limit injection; write mode requires `--allow-write`, and `--allow-write --dry-run` executes inside a transaction
  and rolls back.
- On-demand driver installation (`dbcli drivers install <name>|all`, `dbcli drivers clean`) that keeps the skill itself
  dependency-free and reuses drivers already present in the project.
- Kafka support for read-only troubleshooting: topic and partition description, message sampling, consumer groups,
  consumer lag, offsets, topic configs and cluster info.

### Changed

- Commands are split into connection (`list`, `env`, `doctor`, `drivers`, `ping`) and inspection (`query`, `tables`,
  `desc`, `ddl`, `indexes`, `locks`, `slow`) commands, with `--format auto|table|json|csv|md` output and stable exit codes.
- SQLite, Redis, ClickHouse and Elasticsearch are served by built-in transports (Node `node:sqlite`, a hand-written RESP
  client, and HTTP), so they need no npm packages.
- Query defaults to a 200-row cap (20 for `slow`), truncates long cells and reports `truncated: true` so results stay
  safe to hand to an agent.

### Fixed

- Errors now carry the target connection and the credential source, and connection strings in error messages are masked.
- Lock and slow-query commands fall back to version-appropriate alternative views when an engine does not expose the
  expected one, instead of returning empty results.
