# Configuration discovery

Read this when `dbcli list` shows nothing, when the connection targets the wrong database, when a password or
URL contains special characters, or when the project configures its datasource through a framework file.

The CLI never stores or caches connections: every invocation re-reads the current project's process
environment and `.env`-style files. Nothing here is ever written back.

## Priority (highest first)

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

## Recommended naming

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

## Framework configuration files (any language)

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

## Credentials with special characters

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

## Look before you connect

```bash
dbcli list           # connection list: name/type/target/source/notes
dbcli env            # every variable, its value (masked) and where it came from
dbcli env --all      # include overridden variables (debug "why is it connecting to the wrong DB?")
```

The `source` column in `list` tells you which file and line a value came from — check that line first.
