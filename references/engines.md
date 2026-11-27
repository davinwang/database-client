# Engine capabilities and drivers

Read this before promising an operation to the user ("can I see DDL on Oracle?", "does ClickHouse support
writes?"), when a command answers "the current engine does not support ...", or when a driver is missing
(exit code 5) and has to be installed.

## Capability matrix

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
| ClickHouse | ✅ | ✅ | ✅ SHOW CREATE | ✅ primary/sorting key | ❌ (no row locks) | ✅ system.query_log | ❌ (no transactions) | ❌ (no transactions) | HTTP |
| Elasticsearch | ✅ REST | ✅ indices/mapping | ⚠️ no DDL | ❌ | ❌ | ❌ | ❌ | ❌ | HTTP |

`⚠️` means the result depends on the exact version/privileges; when unsupported, the command says so and
suggests the equivalent view instead of returning an empty result.

## Unsupported capabilities (what "no" means per engine)

- **SQLite** — no server-side lock waits (single file) and no slow-query log; use `EXPLAIN QUERY PLAN` via
  `dbcli query` instead of `locks`/`slow`.
- **MongoDB** — read-only: no DDL and no writes (`$out`/`$merge` blocked). Indexes are listed, DDL is not
  reconstructed.
- **Redis** — command-oriented: no `desc`/`ddl`/`indexes`, no lock view (single-threaded server). `slow` reads
  SLOWLOG; writes are allow-listed commands and still need approval.
- **Kafka / Redpanda** — read-only inspection (topics, partitions/ISR, message peek, consumer lag, configs,
  cluster). No produce, no config change, no offset reset. There is no "lock" concept: check ISR/leader and
  consumer lag instead.
- **ClickHouse** — no transactions, so no writes and no `--dry-run` (the driver rejects both); no row locks.
  `ddl` uses `SHOW CREATE TABLE`, `indexes` shows primary/sorting keys.
- **Elasticsearch** — read-only REST: no DDL, no index-level lock/slow-query views. Only GET/HEAD and
  query-style POST are allowed.
- **DM8** — queries work through the official `dmdb` driver. Lock and slow-query views differ between DM
  versions (`V$TRXWAIT`/`V$LOCK`, `V$LONG_EXEC_SQLS`); if the view is missing the command says so and points at
  `V$SESSIONS`. The driver is not on public npm — see "On-demand drivers" below.
- **OceanBase** — both modes are served by the `mysql2` driver; some management views differ from MySQL, so
  `locks`/`slow` may degrade to "not available on this version".

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
