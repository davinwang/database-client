---
name: database-client
version: 0.4.0
description: "数据库/中间件排查客户端（dbcli）：连接信息只来自项目环境变量/.env，skill 不保存任何地址与密码；默认只读，可执行 SQL、看表结构/索引/DDL、锁等待与慢 SQL、Kafka topic/分区/消息与消费积压。支持 MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB、OceanBase、PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss、Oracle、达梦 DM8、SQL Server、SQLite、MongoDB、Redis、Kafka/Redpanda、ClickHouse、Elasticsearch。当用户提到连库看数据、查表结构、跑 SQL、慢查询、锁等待/死锁、连不上库、Access denied、ORA-、OceanBase/达梦/信创数据库、explain、核对线上数据、Kafka 没消息/消费积压、Redis 慢命令、ES 索引查询时使用。不负责生成或优化业务 SQL，也不负责改数据/发消息：每条写操作都必须先弹确认框、由用户逐次授权。"
metadata:
  requires:
    bins: ["node"]
  cliHelp: "node bin/dbcli.mjs --help"
---

# database-client

[English](SKILL.md) | 简体中文

`dbcli` 是一层**薄驱动**：SQL 由 Agent 写，CLI 只负责连接、执行，并把结果和错误解释清楚。本文件中的
`dbcli` 均指 `node <skill目录>/bin/dbcli.mjs`。

三条硬规则：

1. **不保存凭据**：没有配置文件、没有连接缓存、没有历史记录。每次执行都重新读取项目环境变量与 `.env`，
   密码只存在于内存中；`list`、`env`、错误与 JSON 输出永远不含明文密码。唯一会落盘的是短期写授权
   交接记录（只含指纹，不含凭据）。
2. **默认只读**：写语句在解析阶段就被拒绝（退出码 4）；要执行必须 `--allow-write` **且**用户逐条确认
   （在此之前退出码 7），确认前不会执行任何东西。
3. **不生成 SQL**：没有 `sample`/`count`/`explain` 之类的包装命令，它们就是 `query` 加一条语句。

支持：MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB、OceanBase（两种模式）、
PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss、Oracle、达梦 DM8、SQL Server、SQLite、MongoDB、Redis、
Kafka/Redpanda、ClickHouse、Elasticsearch。各引擎具体能力见 `references/engines.md`。

## 先跑这三步

```bash
dbcli doctor     # Node、驱动、配置发现、连通性
dbcli list       # 发现的连接（已脱敏）；source 列标出每个值来自哪个文件哪一行
dbcli query "select 1"
```

`doctor` 报 `FAILED` → 看 `references/troubleshooting.md`；找不到连接或连错了库 → 看
`references/configuration.md`。

## 什么时候用 / 不用

适用：连测试库看最新几行数据；接口报错时核对表里那条记录；线上慢，查锁等待和最慢 SQL；要表结构/索引/
DDL；确认环境到底连的哪个库；Kafka 消费积压、topic 看起来没消息。

不适用：替你写业务 SQL；改数据/改表结构（默认只读，写操作需要弹确认框、逐条执行）；迁移、ETL、
性能调优方案设计。

## 命令

| 命令 | 用途 | 示例 |
| --- | --- | --- |
| `list` / `ls` | 发现的连接（脱敏） | `dbcli list --all` |
| `env` | 配置来源与覆盖关系 | `dbcli env` |
| `doctor` | 自检 + 逐连接探测 | `dbcli doctor` |
| `drivers` | 驱动状态/安装/清理 | `dbcli drivers install mysql postgres` |
| `ping` | 版本、库、用户、延迟 | `dbcli ping --db erp` |
| `query` | 执行 SQL（也可跑 Redis 命令、Mongo JSON、ES REST、Kafka 只读操作） | `dbcli query "select * from orders where id=1"` |
| `approve` | 用户确认后签发写授权 | `dbcli approve --id <requestId> --answer "同意执行"` |
| `tables` | 表/视图（Mongo 集合、ES 索引、Kafka topic） | `dbcli tables --db erp --pattern 'order%'` |
| `desc` | 列/类型/可空/默认值/键（Kafka：分区/ISR/offset） | `dbcli desc orders --db erp` |
| `ddl` | 建表语句 / 字段映射 | `dbcli ddl orders` |
| `indexes` | 索引与列顺序（慢查询第一嫌疑） | `dbcli indexes orders` |
| `locks` | 锁等待（谁阻塞谁） | `dbcli locks` |
| `slow` | 慢 SQL / 慢命令 TOP N | `dbcli slow -n 10` |

常用参数：`--db <name>`、`--schema <schema>`、`--limit <N>`（query 默认 200，slow 默认 20）、`--no-limit`、
`--format table|json|csv|md`、`--timeout <ms>`、`--env-file`、`--insecure-tls`；写操作另需 `--allow-write`、
`--dry-run`、`--approve <code>`、`--agent`。

Redis / MongoDB / Elasticsearch / Kafka 的写法见 `references/non-sql.md`。

不要用脚本替掉 CLI："连的哪个库"用 `list`/`env`，跑语句用 `query`，表结构用 `desc`/`ddl`/`indexes`，
锁与慢查询用 `locks`/`slow`，Kafka 用 `tables`/`{"op":"lag"}`/`{"op":"peek"}`，连不上用 `ping` +
`references/troubleshooting.md`。只有跨库聚合、批量比对、后处理才写脚本——消费 `--format json`，不要自己
重写连接逻辑。

## 默认只读；写操作需要授权

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| `read`（默认） | 无 | 语句白名单 + 会话级只读 + 自动行数上限 |
| `write` | `--allow-write` + 授权 | 执行一条写语句，报告影响行数 |
| `dry-run` | `--allow-write --dry-run` + 授权 | 在事务中执行后 `ROLLBACK`，报告影响行数 |

单独 `--dry-run` 会被拒绝：试跑同样会加锁、触发 trigger，而 MySQL/Oracle 系引擎的 DDL 会隐式提交，
"试跑"可能真的改表。

四步，没有捷径：

```bash
# 1) 申请。不执行任何语句；--json 直接给出可用的确认框参数
dbcli query "update orders set status='X' where id=42" --allow-write --json
# → {"status":"approval_required","requestId":"c969938a796806a1","approvalCode":"VP54ST",
#    "plan":{...},"card":{...},"next":{"tool":"ask_user_question","params":{...},...}}

# 2) 用宿主的确认工具展示 `card`（DSH 用 ask_user_question，Claude Code 用 AskUserQuestion；
#    Codex CLI 或未知宿主：原样转述卡片，等到明确的同意）

# 3) 用户选了「同意执行」→ 签发
dbcli approve --id c969938a796806a1 --answer "同意执行"

# 4) 用授权码重跑同一条命令
dbcli query "update orders set status='X' where id=42" --allow-write --approve VP54ST --agent
```

Agent 规则：

1. **确认框是强制的**——不许在正文里"顺便问一句"然后直接执行写。
2. 原样转述 `card.question`：动作、位置、影响、语句一项不删，不许弱化影响。
3. 选项文案固定为 `同意执行` / `取消`；`--answer` 必须与用户选择完全一致。
4. 用户选 `取消` → 停止。不重试、不改写 SQL、不再追问。
5. 永不替用户执行 `dbcli approve`，永不使用猜测或记住的授权码。

卡片原文、指纹范围、TTL/会话绑定、dry-run 探影响面的技巧、各宿主确认工具对照表、交接记录位置 →
`references/writes.md`。

## 输出与退出码

- 默认 `--format auto`：TTY 下是表格，被 Agent 管道/捕获时是 JSON（`--format` 可覆盖）。
- JSON 结构：查询 `{columns, rowCount, truncated, durationMs, rows:[{...}]}`；文档类结果
  （Mongo/ES/Kafka peek）为 `{rowCount, documents:[...]}`；写/dry-run 为
  `{mode, statement, affectedRows, rolledBack, authorizedBy}`。
- 还需授权的写操作返回 `{status:"approval_required", requestId, approvalCode, plan, card,
  next:{tool, params, onApprove, thenRun, thenRunArgs}}`，退出码 7。`next.thenRunArgs` 是重跑用的完整参数，
  `next.params` 可直接传给宿主确认工具。
- **`truncated: true` 说明结果被行数上限截断**，不代表就这么多数据；用 `--no-limit`（谨慎）或加 `WHERE`。
- 单元格默认截断：表格 80 字符、JSON 4096（`--max-cell`）；二进制显示为 `<binary N B>`；大整数转字符串
  防止精度丢失；`NULL` 在表格中是 `NULL`，在 JSON 中是 `null`。

退出码：`0` 成功 · `1` 其他错误 · `2` 用法错误 · `3` 连接选择 · `4` 只读拦截 · `5` 驱动缺失 ·
`6` 连接失败 · `7` 需要写授权/未获授权（什么都没执行）。

## 安全规则

1. **不打印密码**：`list`/`env`/错误/JSON 只给 `passwordSet` 和来源行。
2. **不写配置**：不生成 `.env`、不存 token、不建连接缓存。
3. **不绕过只读**：别自己写 mysql/redis 脚本绕开守卫，也别绕开授权（不替用户 `--approve`、不手改状态文件）。
4. 生产优先用只读账号；只有高权账号时也要先只读查询，写之前逐条取得授权。
5. 大查询始终加 `WHERE`/`LIMIT`；`--no-limit` 只用于确定很小的表。
6. 不把含个人信息（身份证、手机号、密码哈希）的整表数据倒进对话。

## 参考文件（按需读取）

路径相对 skill 目录；只在对应场景下再读，不必预先加载。**参考文件目前为英文**。

| 文件 | 什么时候读 |
| --- | --- |
| `references/configuration.md` | 找不到连接、连错库、`--env-file`、密码/URL 含 `@ # % &`、`.env` 分层、compose/Spring/.NET/Rails/TypeORM 配置发现 |
| `references/writes.md` | 要做写操作：卡片原文、指纹与有效期、dry-run 探影响面、各宿主确认工具、交接记录、退出码 7 的恢复 |
| `references/non-sql.md` | 目标是 Redis、MongoDB、Elasticsearch 或 Kafka |
| `references/engines.md` | "这个引擎能做某某吗"、能力矩阵、各引擎不支持的操作、驱动安装（退出码 5） |
| `references/troubleshooting.md` | `doctor` 失败、连不上、慢/卡住、锁等待、输出乱码、常见错误 → 下一步 |
| `references/development.md` | 修改 skill 本身：测试、覆盖率、版本 |
