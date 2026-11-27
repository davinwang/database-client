# Redis / MongoDB / Elasticsearch / Kafka

Read this when the target is not a SQL engine: `query` still runs the statement, but the accepted text is a
command (Redis), a JSON spec (MongoDB), a REST path or JSON spec (Elasticsearch) or a read op (Kafka).

`tables`, `desc`, `query` keep their meaning: list things, describe one thing, read data.

## Redis — commands are passed through, allow-listed

```bash
dbcli query "INFO server"
dbcli query "SCAN 0 MATCH user:* COUNT 100"
dbcli query "MEMORY USAGE user:1"
dbcli slow -n 10                       # SLOWLOG GET
```

## MongoDB — JSON spec

```bash
dbcli query '{"collection":"users","filter":{"status":"A"},"projection":{"name":1},"limit":5}'
dbcli query '{"collection":"orders","aggregate":[{"$match":{}}],"limit":5}'
dbcli query '{"op":"count","collection":"users","filter":{}}'
dbcli tables                           # collections
```

MongoDB is read-only: `$out` and `$merge` are rejected.

## Elasticsearch — REST path or JSON spec

```bash
dbcli query "/_cat/indices?format=json"
dbcli query '{"method":"POST","path":"/logs-2026/_search","body":{"size":5,"query":{"match_all":{}}}}'
dbcli tables --pattern 'logs-*'
dbcli desc logs-2026
```

Only GET/HEAD and query-style POST are allowed.

## Kafka — read-only operations

```bash
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

Kafka `peek` uses a **temporary consumer group** and does not commit offsets (the broker keeps an empty group
until `offsets.retention` expires). The CLI never produces messages, changes configs, or resets offsets.

`--pattern` accepts `*` or `%` as wildcards for SQL engines (a pattern without a wildcard is treated as a
substring); Elasticsearch uses index globs (`logs-*`) and MongoDB uses a substring match.
