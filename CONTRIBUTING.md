# Contributing to database-client

Thanks for helping. `dbcli` is a thin, zero-credential database and middleware client for coding agents, and the bar for
changes is simple: keep it read-only by default, keep the skill free of stored credentials, and keep errors actionable.

## Requirements

- Node.js **>= 22.13** (SQLite uses the built-in `node:sqlite`).
- No install step for the zero-dependency engines (SQLite, Redis, ClickHouse, Elasticsearch). Everything works straight from
  the checkout.
- npm is only involved when you exercise the on-demand drivers (`dbcli drivers install ...`).

## Setup

```bash
git clone <repo-url> database-client
cd database-client
node bin/dbcli.mjs --help
node bin/dbcli.mjs doctor
```

There is no build and no `npm install` in the common path. To try a real connection, export the variables the project would
use and run the CLI directly, for example:

```bash
DB_URL='sqlite:./.tmp/dev.db' node bin/dbcli.mjs tables
```

## Running the tests

```bash
npm test                                  # standard runner (per-file process isolation)
npm run test:sandbox                      # no child processes: use inside sandboxes (e.g. DSH)
node --test --test-isolation=none tests/guard.test.mjs   # a single file
```

Guidelines for tests:

- Tests must run offline. No network calls, no external databases, no credentials.
- SQLite tests use a real temporary database file; Redis, ClickHouse, Elasticsearch and Kafka tests use the mocks in
  `tests/helpers/`.
- Add a test next to the behaviour you change. A user-visible bug fix without a regression test is usually sent back.

## Project layout

| Path | Responsibility |
| --- | --- |
| `bin/dbcli.mjs` | Thin entry point |
| `lib/cli.mjs` | Argument parsing, dispatch, help, exit codes |
| `lib/commands.mjs` | Command implementations: connect, call the driver, render |
| `lib/connections.mjs` | Environment variables to a connection model (URL/JDBC/DSN parsing, dedupe, masking) |
| `lib/discover.mjs` | Project discovery: `.env` layering, docker-compose, Spring config |
| `lib/guard.mjs` | Read-only guard, statement splitting, LIMIT injection, Redis/Mongo/ES/Kafka allowlists |
| `lib/output.mjs` | Table/JSON/CSV/Markdown rendering, masking, truncation |
| `lib/errors.mjs` | Error translation into troubleshooting hints |
| `lib/drivers/*.mjs` | One driver per engine |

## Adding a new engine driver

1. **Create `lib/drivers/<engine>.mjs`** exporting `create(conn, options)`:

   ```js
   export async function create(conn, options = {}) {
     return {
       type: '<engine>',
       async ping() {},
       async query(sql, { mode = 'read' } = {}) {},
       async tables({ schema, pattern } = {}) {},
       async describe(name, { schema } = {}) {},
       async ddl(name, { schema } = {}) {},
       async indexes(name, { schema } = {}) {},
       async locks() {},
       async slow({ limit } = {}) {},
       async close() {},
     };
   }
   ```

   - Implement every method you can. For the rest, throw `UnsupportedError` with a `hint` that names the alternative query
     the user should run on that engine; never return a silently empty result.
   - `options` carries `{ timeoutMs, allowWrite, insecureTls, cwd, roots, loadPackage }`. `allowWrite` is informational:
     the guard in `lib/guard.mjs` is the authority, but drivers may add a session-level read-only backstop.
   - Build result payloads with the helpers in `lib/drivers/shared.mjs` (`result`, `qualifiedName`, `buildDdl`, ...) so
     column naming and notices stay consistent.
   - Close pools, sockets and cursors in `close()`; `commands.mjs` calls it in a `finally`.

2. **Register it in `lib/drivers/index.mjs`** in the `DRIVERS` map:

   ```js
   newengine: { key: 'newengine', packageName: 'the-npm-driver', module: './newengine.mjs', label: 'New Engine' },
   ```

   Use `packageName: null` plus `builtin: '...'` for zero-dependency engines. The registry drives `dbcli drivers`,
   `dbcli doctor` and the missing-driver error message, so nothing else needs editing for installation to work.

3. **Add type aliases and metadata in `lib/connections.mjs`**: an entry in `TYPE_ALIASES` for every name users might write
   (`newengine`, vendor-specific spellings), and an entry in `TYPE_META` with `label`, `kind` (`sql`/`mongo`/`redis`/`mq`/`es`),
   `driver` and `defaultPort`. If the engine needs its own URL scheme or DSN shape, extend `parseConnectionUrl` in the same file.

4. **Add docs**: the engine support matrix, the driver table and the connection-string list in `README.md`; the same matrix plus
   any troubleshooting notes in `SKILL.md`; the changelog entry in `CHANGELOG.md`.

5. **Add tests**: a new `tests/<engine>.test.mjs`. Mock the transport rather than requiring a live server, cover the read-only
   path, and cover at least one unsupported method returning a useful `UnsupportedError`.

## Code style

- ES modules only (`import`/`export`), Node built-ins over packages.
- 2-space indentation, single quotes, semicolons, trailing commas where the existing code has them.
- English comments and JSDoc. Explain *why* a workaround exists, not what the line obviously does.
- **No external dependencies for the zero-dependency engines.** SQLite must stay on `node:sqlite`, Redis on the hand-written
  RESP client over `node:net`/`node:tls`, and ClickHouse/Elasticsearch on plain HTTP. Drivers for other engines are optional
  packages, resolved at runtime through `loadPackage`; never add them to `dependencies`.
- Keep modules thin and focused: `commands.mjs` connects and renders, drivers talk to the server, `guard.mjs` decides what is allowed.
- Error messages must tell the user what to do next (install a driver, check a file/line, run an alternative query). Exit codes
  live in `lib/errors.mjs` and `lib/guard.mjs`; do not invent new ones.
- Never print, log or serialise a password. Masking helpers already exist in `lib/output.mjs` and `lib/connections.mjs`.

## Write capability rule

**Every write capability must stay opt-in behind `--allow-write`.** No exceptions.

- New statements, Redis commands, Mongo stages, Elasticsearch methods or Kafka operations start out blocked in `lib/guard.mjs`;
  only add them to an allowlist if they are genuinely read-only.
- If an engine supports transactions, implement `--dry-run` by executing inside a transaction and rolling back. If it does not,
  throw `UnsupportedError` explaining why, instead of pretending to dry-run.
- `--dry-run` without `--allow-write` must remain a usage error.
- Document any new write support (and its dry-run status) in the README engine matrix and in `SKILL.md`.
- Tests must prove both halves: the operation is rejected without `--allow-write`, and accepted with it.

## Submitting changes

- Keep pull requests small and focused; unrelated reformatting makes review harder.
- Run the full test suite before opening a PR, and describe any manual verification you did against a real server.
- Update `CHANGELOG.md` under the next version for user-visible changes.
- Do not commit real credentials, `.env` files, `node_modules/`, or driver tarballs.
