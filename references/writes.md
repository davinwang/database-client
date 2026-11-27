# Write approval — details

Read this when a write is actually requested: you need the exact card text, the host tool mapping, the
blast-radius (dry-run) trick, or you are debugging an approval that was refused.

`SKILL.md` → "Read-only by default" carries the mandatory flow and the agent rules; this file is the long form.

## What read-only mode blocks

`insert/update/delete/merge/truncate/drop/alter/create/grant/revoke/call`, `select ... into outfile`,
`for update`, `nextval()/setval()`, server-side file reads, `pragma` assignment, multiple statements, and
non-read-only `explain`. Redis is command-allow-listed, MongoDB blocks `$out/$merge`, Elasticsearch only allows
GET/HEAD and query-style POST, and Kafka only allows its read ops.

Blocked statements exit with code `4` during parsing — that is a guard, not a connection error, and it means
the statement *is* a write. Nothing was executed.

## The card (Chinese on purpose — it is what the user reads, and its labels must stay verbatim)

```
数据库写操作授权
Agent 要执行一条会修改数据库的语句，请确认：
动作：UPDATE（write 真实提交）
位置：erp（mysql）· mysql://app@10.0.0.5:3306/erp
影响：没有 WHERE 条件，可能影响整表所有行
语句：update orders set status='X'
是否允许执行？            [同意执行] [取消]
```

Blast-radius hints are computed from the statement: no `WHERE`, `WHERE 1=1`, `INSERT ... SELECT`, and
auto-committing DDL inside a dry run.

## What is fingerprinted

Any change invalidates the old code: verb + mode + engine + connection name + masked target + the **exact
statement text**. The code is single-use and expires in 5 minutes (request) / 10 minutes (grant), and it is
bound to the host session that asked.

**Verify the blast radius without a second dialog.** A signed `write` approval also covers the matching
`--dry-run`, and the trial run does not spend it:

```bash
dbcli query "update orders set status='X' where id=42" --allow-write --dry-run --approve VP54ST --agent   # affectedRows: 1
dbcli query "update orders set status='X' where id=42" --allow-write --approve VP54ST --agent             # committed
```

A `dry-run` approval never covers the real write.

## Host confirmation tools

Run `dbcli doctor` to see the detected host, tool, session, and where the hand-off record lives.

| Host | Confirmation tool | Notes |
| --- | --- | --- |
| **DSH** | `ask_user_question` | native: `next.params` passes straight through (`questions[{id,header,question,options,multi_select}]`) |
| **Claude Code** | `AskUserQuestion` | PascalCase tool name; same shape but `multiSelect` is camelCase; no session variable, session falls back to `user@host` |
| **Codex CLI** | none (command approval) | show the card verbatim; run `dbcli approve` only after an explicit yes |
| **WorkBuddy** | `AskUserQuestion` | option-style, at most 4 options per question |
| **other / unknown** | text confirmation | relay the card verbatim, wait for a clear yes |

## Where the hand-off record lives

`$TMPDIR/dbcli-approvals/approvals.json` (override with `DBCLI_STATE_DIR`). It holds only plan fingerprints,
the masked target, a truncated statement preview, the session marker and timestamps — **no passwords, no
result rows**, and entries are deleted when used and pruned when expired. If that directory is not writable
the command fails instead of executing (fail closed).

Honest boundary: the agent and the CLI share one shell, so a hostile agent could in principle read and replay
the record. What is guaranteed is "nothing silent by default, and every write is traceable to a request ID, a
host, and a channel". For cryptographic isolation, use out-of-band approval (e.g. an IM approval card).

## Recovering from a refusal (exit 7)

Wrong, expired, already-used or guessed code, or a statement/connection that changed after the card was
printed → rerun the same command **without** `--approve` to get a fresh card and a fresh code. Never guess,
never reuse, never edit the state file. "Approval cannot be recorded" means the state directory is not
writable: allow writes there or point `DBCLI_STATE_DIR` at a writable directory.
