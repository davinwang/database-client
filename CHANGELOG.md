# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
