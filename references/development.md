# Development, tests, version

Read this only when working on the skill itself (changing `bin/`, `lib/`, or the docs), not when using it.

```bash
npm test                                                  # standard runner
npm run test:sandbox                                      # no child processes (sandboxed environments)
```

Coverage: `.env` parsing and expansion, compose/Spring discovery, connection strings (JDBC/Go DSN/libpq),
read-only guard and row-limit injection, write approval (fingerprints, one-time codes, TTL/session binding,
`approve` end-to-end, blast-radius hints), output formats and masking, SQLite end-to-end, Redis (RESP mock),
ClickHouse/Elasticsearch (HTTP mock), Kafka (injected kafkajs double), driver registry, and the documentation
guards (description length, frontmatter, reference links, `SKILL.md` size budget).

Version: `0.4.0` — keep `SKILL.md` and `package.json` in sync; update the changed section, its reference file,
and `README.md` when behaviour changes; add a `CHANGELOG.md` entry for user-visible changes. See
`CONTRIBUTING.md`.
