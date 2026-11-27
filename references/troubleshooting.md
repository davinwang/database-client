# Troubleshooting SOP and error table

Read this when `doctor` fails, when you cannot connect, when a query is slow or stuck, when the data does not
match expectations, or when you need to turn an error message into the next action.

## SOP

**1. Cannot connect** — run `dbcli ping --db <name>`, match the error against the table below, then check
`dbcli list` (target and credential source). Most failures are a wrong environment/port or a compose service
without a published port.

**2. Slow / stuck**:

```bash
dbcli slow -n 10        # MySQL: performance_schema; PG: pg_stat_statements; Oracle: v$sql; DM8: V$LONG_EXEC_SQLS; SQL Server: dm_exec_query_stats
dbcli locks             # then check for lock waits (waiting/blocking, wait_seconds)
dbcli desc <table>      # is the filter column indexed?
dbcli indexes <table>   # look before rewriting the SQL
dbcli query "EXPLAIN <original SQL>"
```

**3. Data does not match** — query the exact row with a `WHERE`, then `desc` the table to check types,
defaults and time zone. This CLI shows raw stored values (MySQL `dateStrings`, PostgreSQL text parsing), so
timestamps are not shifted into local time.

**4. Schema / indexes** — `dbcli ddl` returns the full definition. Oracle/PostgreSQL/SQL Server/DM8 have no
`SHOW CREATE TABLE`; those are reconstructed from the data dictionary and labelled as such.

**5. Kafka** — `lag` for consumer backlog, `desc` for ISR/leader health, `groups` for rebalance loops, `peek`
for actual message content.

**6. Output looks garbled** — on Windows, PowerShell may mangle UTF-8 when stdout is piped or redirected
(`node bin/dbcli.mjs ... | Select-Object`). The database value is usually fine: redirect to a file
(`--format json > out.json`) or read the file as UTF-8 instead of judging the console. This is a
terminal-encoding issue, not a data-encoding issue.

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
| Read-only rejection (exit 4) | statement is a write | run it with `--allow-write`: that only prints the confirmation card, then approve and rerun with `--approve <code> --agent` |
| Write needs approval (exit 7) | no `--approve`, or the code is wrong/expired/used, or the SQL/connection changed | rerun the same command without `--approve` for a fresh card; never guess a code |
| Approval cannot be recorded | the state directory is not writable | allow writes there, or set `DBCLI_STATE_DIR` to a writable directory |
| Driver missing (exit 5) | engine driver not installed | `dbcli drivers install <name>` (see `references/engines.md`) |
| Certificate / `self-signed certificate` | internal TLS | add `--insecure-tls` on trusted networks |

Error output includes "How to diagnose" plus the target and credential source. Do not bypass it by
hand-building connection strings.
