---
name: database-client
version: 0.3.0
description: "数据库/中间件排查客户端（dbcli）：连接信息全部来自项目环境变量/.env，skill 自身不保存任何地址与密码；默认只读，能执行 SQL、看表结构/索引/DDL、锁等待与慢 SQL TOP N，也能查 Kafka 的 topic/分区/消息采样/消费积压。支持 MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB、OceanBase（MySQL/Oracle 模式）、PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss、Oracle、达梦 DM8、SQL Server、SQLite、MongoDB、Redis、Kafka/Redpanda、ClickHouse、Elasticsearch。当用户提到连数据库看数据、查表结构、跑条 SQL、慢查询、锁等待/死锁、连接不上库、Access denied、ORA-、OceanBase/达梦/信创数据库、explain、核对线上数据、Kafka topic 没消息/消费积压/分区不均衡、Redis 慢命令、ES 索引查询时使用。不负责生成或优化业务 SQL，也不负责改数据/发消息（每条写操作都必须先弹确认框、由用户逐次授权后才执行）。"
metadata:
  requires:
    bins: ["node"]
  cliHelp: "node bin/dbcli.mjs --help"
---

# database-client

[English](SKILL.md) | 简体中文

`dbcli` 是一个**薄驱动层**：Agent 自己写 SQL，它只负责「连上去、执行、把结果和错误讲明白」。

三条硬约束：

1. **不存凭据**：没有配置文件、没有连接缓存、没有历史记录。每次调用重新读当前项目的环境变量 / `.env`，
   密码只在内存里活一次。`list`、`env`、错误信息、JSON 输出都不含明文密码。（唯一会落盘的是
   短期「授权交接记录」——只有指纹和时间戳，不含任何凭据，见「写操作授权」。）
2. **默认只读**：写语句在解析阶段就被拦下（退出码 4），会话层再做只读事务/只读打开。
   要写必须 `--allow-write` **并且**过一道用户确认框（每条语句单独授权，未授权时退出码 7），确认前什么都不执行。
3. **不做 SQL 生成器**：没有 `sample`/`count`/`explain` 这类包装命令——那些就是 `query` 加一句 SQL。

支持：MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB、OceanBase（两种模式）、
PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss、Oracle、达梦 DM8、SQL Server、SQLite、
MongoDB、Redis、Kafka/Redpanda、ClickHouse、Elasticsearch。

## 使用前自检

```bash
node <skill目录>/bin/dbcli.mjs doctor          # Node/驱动/配置发现/连通性一把过
node <skill目录>/bin/dbcli.mjs drivers         # 驱动状态（缺哪个装哪个，见「驱动按需安装」）
node <skill目录>/bin/dbcli.mjs list            # 当前发现了哪些连接（脱敏）
```

`doctor` 里出现 `FAILED` 时不要继续猜，先按「常见错误」表定位；`list` 里的「来源」列会告诉你
这个密码/地址来自哪个文件的第几行，出问题直接去那一行核对。

## 何时用 / 何时不用

**用**：

- 「连一下 XX 库，看下 orders 表最近的数据」
- 「这个接口报错，帮我查库里这条记录／这张表结构对不对」
- 「线上很慢，看下有没有锁、哪个 SQL 最慢」
- 「表结构/索引是什么、DDL 发我」
- 「这个环境连的是哪个库？密码是不是配错了？」

**不用**：

- 让 skill 帮你**写业务 SQL**（Agent 自己写；skill 只提供方言差异与执行能力）
- **改数据/改表结构**：默认只读；确需写时逐次授权，且只允许单条语句
- 数据迁移、ETL、性能调优方案设计

## 配置从哪来（不存任何凭据）

优先级（高 → 低）：

| 来源 | 说明 |
| --- | --- |
| 命令行参数 | `--db`、`--schema`、`--env-file` |
| 系统环境变量 | Agent 宿主通常在这里按项目注入，**最高优先级** |
| `--env-file <path>` | 显式指定的 .env（可重复） |
| `.env.<profile>.local` → `.env.<profile>` → `.env.local` → `.env` | profile 取 `SPRING_PROFILES_ACTIVE`/`APP_ENV`/`NODE_ENV`/`PROFILE`/`ENV` |
| `docker-compose.yml` / `compose.yml` | 兜底：从 `services` 的 image/ports/environment 推出来 |
| Spring `application.yml`/`application-<profile>.yml`/`application.properties` | 兜底：`spring.datasource.*`、`spring.data.redis.*`、`spring.data.mongodb.uri`、`spring.elasticsearch.uris` |

中间件/框架常见变量直接用，不必改名：`DATABASE_URL`、`MYSQL_*`、`PG*`/`POSTGRES_*`、`REDIS_URL`/`REDIS_*`、
`MONGO_URI`/`MONGODB_URI`、`CLICKHOUSE_*`、`ES_URL`/`ELASTICSEARCH_*`、`SPRING_DATASOURCE_*`、`JDBC_URL`。

### 推荐命名

```bash
# 单库项目
DB_URL=mysql://app:密码@127.0.0.1:3306/appdb

# 多库项目（用 --db 指定；不指定且只有一个连接时自动选中）
DB_ERP_URL=mysql://app:密码@10.0.0.5:3306/erp
DB_LOG_URL=postgres://log:密码@10.0.0.6:5432/logdb
DB_DEFAULT=erp

# 密码含特殊字符 / 被拆散时用分段写法（名字里带类型可省 TYPE）
DB_REPORT_HOST=pg-report
DB_REPORT_PORT=5433
DB_REPORT_USER=report
DB_REPORT_PASSWORD=密码
DB_REPORT_DATABASE=dw
DB_REPORT_TYPE=postgres

# Kafka（broker 用逗号分隔；SASL 三件套 + SSL 按需）
KAFKA_BROKERS=10.0.0.7:9092,10.0.0.8:9092
KAFKA_SASL_USERNAME=app
KAFKA_SASL_PASSWORD=密码
KAFKA_SASL_MECHANISM=scram-sha-256
KAFKA_SSL=true
```

连接串支持：`mysql://`、`postgres://`、`oracle://`、`sqlserver://`、`mongodb://`、`mongodb+srv://`、
`redis://`/`rediss://`、`sqlite:path`、`clickhouse://`、`http(s)://`（ES/CH，配 `DB_<名字>_TYPE`）、
`jdbc:mysql|postgresql|oracle:thin|sqlserver|sqlite:`、Go 的 `user:pass@tcp(host:3306)/db`、libpq 的 `host=... dbname=...`。

### 框架配置文件（不绑定语言）

配置发现对所有语言一视同仁：同一套适配器在每个项目上都会跑，文件只读不写。

| 来源 | 常见技术栈 | 映射方式 |
| --- | --- | --- |
| `.env*` | 任意语言 | 变量，按 profile 分层 |
| `docker-compose.yml` | 任意（本地容器） | 服务 image/ports/environment |
| `application*.yml` / `application*.properties` | Java / Spring Boot | `spring.datasource.*`、`dynamic.datasource.*`、`spring.data.redis.*` |
| `appsettings*.json` | .NET | `ConnectionStrings:<name>`（ADO.NET 串或 URL）→ `dotnet-<name>` |
| `ormconfig.json`、`config/*.json` | Node（TypeORM/node-config） | 连接对象 → `config-<路径>` |
| `database.yml` | Ruby / Rails | `adapter` + host/database/username → `rails-<env>` |
| `*.ini`、通用 JSON/YAML/properties | Python（alembic）等 | 数据库相关 key 里的连接 URL → `config-<key>` |

Spring 细节：`spring.datasource.dynamic.datasource.<name>.*` → 每个数据源一条 `spring-<name>` 连接（primary 在备注标注）；
`spring.redis.cluster.nodes` 解析为集群连接；值会用项目环境变量展开。展开后仍是占位符
（`${DATASOURCE_URL}` / `<%= ENV['...'] %>`）的数据源会被跳过并告警变量名；把它配到环境变量，或显式指定定义它的文件：

```bash
dbcli list --env-file src/main/resources/application-dev.properties
```

dotenv 风格（`DATASOURCE_URL=jdbc:mysql://...`）的 `application-<profile>.properties` 在设置了
`SPRING_PROFILES_ACTIVE=<profile>` 时会**自动参与 `${...}` 展开**。注意：`Config files read` 只表示文件被读取，
不代表里面的占位符已经解析成功。

### 账号密码含特殊字符

`user@tenant#instance` 这类用户名、含 `% # &` 的密码，**不要拼进 `scheme://user:pass@host`**：
`@`、`#` 是分隔符，连接会悄悄指向错误的主机。要么百分号编码（`@`→`%40`、`#`→`%23`、`%`→`%25`），
要么直接用拆分字段（推荐）：

```bash
DB_OB_TYPE=oceanbase
DB_OB_HOST=10.0.0.9
DB_OB_PORT=2881
DB_OB_USER=user@tenant#instance
DB_OB_PASSWORD=p%a#ss&word
DB_OB_DATABASE=app
```

### 先看，再连

```bash
dbcli list              # 连接清单：名字/类型/目标/来源/备注
dbcli env               # 每个变量的值与来源（值已脱敏）
dbcli env --all         # 连被覆盖的变量一起看（排查「为什么连错库」）
```

## 读写控制（重要）

三种模式，只有这三种：

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| `read`（默认） | 什么都不加 | 语句白名单 + 会话级只读（MySQL/PG/Oracle/SQLite/ClickHouse）+ 自动行数上限 |
| `write` | `--allow-write` + 授权 | 单条写语句，执行后报告影响行数 |
| `dry-run` | `--allow-write --dry-run` + 授权 | 在事务里真跑一遍再 `ROLLBACK`，只报告影响行数（不改变数据） |

`--dry-run` 单独使用会直接报错——**试跑也会真实执行**（加锁、触发触发器），而 MySQL/Oracle 系引擎的 DDL
会自动提交、ROLLBACK 挡不住，所以「试跑」也可能真的改了结构。这就是 `--dry-run` 也必须单独授权、
不能拿来「悄悄试一下」的原因。

只读拦截覆盖：`insert/update/delete/merge/truncate/drop/alter/create/grant/revoke/call`、
`select ... into outfile`、`for update`、`nextval()/setval()`、读服务器文件、
`pragma 赋值`、多语句、`explain` 非只读语句。Redis 走命令白名单，Mongo 拦 `$out/$merge`，
ES 只放行 GET/HEAD 与 `_search/_count/_msearch` 类 POST。

## 写操作授权（确认框）

写命令**不带 `--approve` 时不会改动任何东西**：它只打印确认卡片 + 请求号 + 一次性授权码，退出码 **7**。
授权只认「用户在交互弹框里选了同意」，四步，没有旁路：

```bash
# 1) Agent 发起写请求（不执行；--json 直接给出可用的弹框参数）
dbcli query "update orders set status='X' where id=42" --allow-write --json
# → {"status":"approval_required","channel":"agent","host":"dsh","requestId":"c969938a796806a1",
#    "approvalCode":"VP54ST","plan":{...},"card":{...},
#    "next":{"tool":"ask_user_question","params":{...},"onApprove":"...","thenRun":"..."}}

# 2) Agent 用本宿主的确认工具把 card 原样弹给用户（DSH 是 ask_user_question，见下表）

# 3) 用户选「同意执行」→ 签发一次性凭据
dbcli approve --id c969938a796806a1 --answer "同意执行"

# 4) 带码执行
dbcli query "update orders set status='X' where id=42" --allow-write --approve VP54ST --agent
```

卡片长这样（用户读的就是这段，措辞与选项不要改写）：

```
数据库写操作授权
Agent 要执行一条会修改数据库的语句，请确认：
动作：UPDATE（write 真实提交）
位置：erp（mysql）· mysql://app@10.0.0.5:3306/erp
影响：没有 WHERE 条件，可能影响整表所有行
语句：update orders set status='X'
是否允许执行？            [同意执行] [取消]
```

授权指纹包含：动作 + 模式 + 引擎 + 连接名 + 脱敏目标 + **完整语句文本**。任一项变化，旧码立即失效。
授权码一次性使用，请求 5 分钟内有效（凭据 10 分钟），并且绑定在发起请求的宿主会话上。

**「先预演再执行」不用弹第二次框**：已签发的 `write` 授权同时覆盖同一语句的 `--dry-run`，且试跑不消耗它：

```bash
dbcli query "update orders set status='X' where id=42" --allow-write --dry-run --approve VP54ST --agent   # affectedRows: 1
dbcli query "update orders set status='X' where id=42" --allow-write --approve VP54ST --agent             # 真正提交
```

反过来不成立：`dry-run` 的授权不能用来执行真实写入。

### 各 Agent 的确认工具

先跑 `dbcli doctor`，它会打印识别到的宿主、确认工具、会话标识和交接记录位置。

| 宿主 | 确认工具 | 关键差异 |
| --- | --- | --- |
| **DSH** | `ask_user_question` | 原生支持：`next.params` 可直接传入（`questions[{id,header,question,options,multi_select}]`） |
| **Claude Code** | `AskUserQuestion` | 工具名 PascalCase；参数同构但 `multiSelect` 是驼峰；无会话变量，会话退化为 `user@host` |
| **Codex CLI** | 无独立提问工具 | 把卡片原样展示，用户明确同意后再跑 `dbcli approve` |
| **WorkBuddy** | `AskUserQuestion` | 选项式提问，每题最多 4 项 |
| 其它/未知 | 文本确认 | 把卡片原样转述，等用户明确回复 |

Agent 必须遵守：

1. **必须弹框**（或宿主等价机制），不能只在文字里问一句就执行。
2. 卡片里的「动作/位置/影响/语句」要与 CLI 输出**完全一致**，不要美化、不要省略影响、不要丢掉语句。
3. 选项文案保持 `同意执行` / `取消`；`--answer` 必须与用户的选择逐字一致，否则签不出来。
4. 用户选「取消」→ 停止。不要重试、不要换个参数再来、不要在同一个回复里再问一次。
5. 不许代替用户执行 `dbcli approve`，也不许凭记忆/猜测填 `--approve`。
6. 人在终端里直接跑时，看到的是同一张卡片 + `y/N` 提示；不存在任何环境变量或配置项能替代授权。

### 授权状态存在哪

`<系统临时目录>/dbcli-approvals/approvals.json`（可用 `DBCLI_STATE_DIR` 改）。里面只有计划指纹、
脱敏目标、截断后的语句预览、宿主会话标记和时间戳——**没有密码、没有查询结果**；用掉即删，过期即清。
该目录不可写时命令直接失败（fail closed），不会退化成「无授权也执行」。

诚实边界：Agent 与 CLI 同处一个 shell，恶意 Agent 理论上能读到交接记录并重放。这里保证的是
「默认不静默执行 + 每次都能追到请求号、宿主与通道」；要密码学级隔离需要带外审批（如 IM 审批卡片）。

## 命令速查

| 命令 | 用途 | 例子 |
| --- | --- | --- |
| `list` / `ls` | 连接清单（脱敏） | `dbcli list --all` |
| `env` | 配置来源与覆盖关系 | `dbcli env` |
| `doctor` | 自检 + 逐连接探测 | `dbcli doctor` |
| `drivers` | 驱动状态/安装/清理 | `dbcli drivers install mysql postgres` |
| `ping` | 版本、库、延迟 | `dbcli ping --db erp` |
| `query` | 执行 SQL（Redis 命令 / Mongo JSON / ES REST 也走这里） | `dbcli query "select * from orders where id=1"` |
| `approve` | 用户确认后签发写操作授权 | `dbcli approve --id <请求号> --answer "同意执行"` |
| `tables` | 表/视图（Mongo 集合、ES 索引、Kafka topic） | `dbcli tables --db erp --pattern 'order%'` |
| `desc` | 列/类型/可空/默认值/主键（Kafka：分区/ISR/位点） | `dbcli desc orders --db erp` |
| `ddl` | 建表语句/字段映射 | `dbcli ddl orders` |
| `indexes` | 索引（慢查询先看这里） | `dbcli indexes orders` |
| `locks` | 锁等待（谁阻塞了谁） | `dbcli locks` |
| `slow` | 慢 SQL / 慢命令 TOP N | `dbcli slow -n 10` |

通用参数：`--db <名字>`、`--schema <schema>`、`--limit <N>`（query 默认 200，slow 默认 20）、
`--no-limit`、`--format table|json|csv|md`、`--timeout <ms>`、`--env-file`、`--insecure-tls`；
写操作另加 `--allow-write`、`--dry-run`、`--approve <授权码>`、`--agent`。

`--pattern`：SQL 引擎接受 `*` 或 `%` 通配符（不带通配符时按子串匹配）；Elasticsearch 用索引 glob
（`logs-*`）；MongoDB 按子串匹配。

### 非 SQL 引擎怎么查

```bash
# Redis：命令原样传，只读白名单
dbcli query "INFO server"
dbcli query "SCAN 0 MATCH user:* COUNT 100"
dbcli query "MEMORY USAGE user:1"
dbcli slow -n 10                       # SLOWLOG GET

# MongoDB：JSON 规格
dbcli query '{"collection":"users","filter":{"status":"A"},"projection":{"name":1},"limit":5}'
dbcli query '{"collection":"orders","aggregate":[{"$match":{}}],"limit":5}'
dbcli query '{"op":"count","collection":"users","filter":{}}'
dbcli tables                          # 集合

# Elasticsearch：REST 路径或 JSON 规格
dbcli query "/_cat/indices?format=json"
dbcli query '{"method":"POST","path":"/logs-2026/_search","body":{"size":5,"query":{"match_all":{}}}}'
dbcli tables --pattern 'logs-*'
dbcli desc logs-2026

# Kafka：只读操作（topic / 分区 / 消息采样 / 消费积压）
dbcli tables                                     # topic 清单（分区数、副本数）
dbcli desc orders                                # 分区 leader / ISR / 起止位点 / 消息量
dbcli query topics                               # 等价写法（也支持 --format json）
dbcli query '{"op":"peek","topic":"orders","limit":5,"from":"latest"}'
dbcli query '{"op":"peek","topic":"orders","limit":5,"from":"earliest","partition":0}'
dbcli query '{"op":"groups"}'                    # 消费组（state / members）
dbcli query '{"op":"lag","group":"app-consumer"}'
dbcli query '{"op":"configs","topic":"orders"}'
dbcli query '{"op":"cluster"}'
```

Kafka 的 `peek` 用**临时消费组**读消息且不提交位点（broker 上会留下一个空消费组，按
`offsets.retention` 过期）；本 CLI **不发消息、不改配置、不重置位点**。

## 排障 SOP

**1. 连不上**：`dbcli ping --db <名字>` 看错误 → 对照「常见错误」表 →
`dbcli list` 核对目标与凭据来源（经常是连错环境/端口，或 compose 没做端口映射）。

**2. 慢 / 卡住**：

```bash
dbcli slow -n 10        # 先定位 TOP SQL（MySQL: performance_schema；PG: pg_stat_statements；Oracle: v$sql；DM: V$LONG_EXEC_SQLS；SQLServer: dm_exec_query_stats）
dbcli locks             # 再看是不是锁等待（输出里找 waiting/blocking、wait_seconds）
dbcli desc <表>          # 看过滤字段有没有索引
dbcli indexes <表>       # 没有索引就别急着动 SQL
dbcli query "EXPLAIN <原 SQL>"   # 看执行计划（PG/Oracle/SQLite 用 EXPLAIN；MySQL 用 EXPLAIN）
```

**3. 数据对不上**：用 `query` 加 `WHERE` 精确查一条，再 `desc` 核对字段类型/默认值/时区。
时区类问题优先看驱动取到的是字符串还是时间对象（本 CLI 对 MySQL 用 `dateStrings`、对 PG 用文本解析，
**看到的就是库里的原值**，不会被转成本地时间）。

**4. 表结构/索引**：`dbcli ddl` 拿完整定义（Oracle/PG/SQLServer/DM 没有 `SHOW CREATE TABLE`，是按数据字典重建的，
会标注这一点；PostgreSQL 的索引单独列出）。

**5. OceanBase**：MySQL 模式开箱用；Oracle 模式加 `DB_OB_MODE=oracle`（大写标识符、Oracle 数据字典、ROWNUM 限行）。
`locks`/`slow` 在 OB 上会明确告诉你该查 `oceanbase.gv$lock_wait_stat` / `oceanbase.gv$sql_audit`。

**6. 输出看起来乱码**：Windows PowerShell 在把 stdout 接进管道/重定向时可能把 UTF-8 弄乱
（`node bin/dbcli.mjs ... | Select-Object`）。库里通常是好的：改用 `--format json > out.json` 落盘，
再用 UTF-8 读文件；这是终端编码问题，不是数据编码问题。

## 引擎能力矩阵

| 引擎 | query | tables/desc | ddl | indexes | locks | slow | write | dry-run | 驱动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MySQL/MariaDB/TiDB/TDSQL | ✅ | ✅ | ✅ `SHOW CREATE TABLE` | ✅ | ✅ | ✅ performance_schema | ✅ | ✅ | mysql2 |
| OceanBase（MySQL 模式） | ✅ | ✅ | ✅ | ✅ | ⚠️ 给 OB 视图替代 | ⚠️ 给 OB 视图替代 | ✅ | ✅ | mysql2 |
| OceanBase（Oracle 模式） | ✅ | ✅ | ✅ 重建 | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | mysql2 |
| PostgreSQL/Kingbase/Vastbase/GaussDB | ✅ | ✅ | ✅ 重建 | ✅ | ✅ | ✅ pg_stat_statements | ✅ | ✅ | pg |
| Oracle | ✅ | ✅ | ✅ 重建 | ✅ | ✅ v$session | ✅ v$sql | ✅ | ✅ | oracledb |
| 达梦 DM8 | ✅ | ✅ | ✅ 重建 | ✅ | ⚠️ V$TRXWAIT/V$LOCK | ⚠️ V$LONG_EXEC_SQLS | ✅ | ✅ | dmdb（官方） |
| SQL Server | ✅ | ✅ | ✅ 重建 | ✅ | ✅ dm_exec_requests | ✅ dm_exec_query_stats | ✅ | ✅ | mssql |
| SQLite | ✅ | ✅ | ✅ | ✅ | ❌（单文件无服务端锁） | ❌（用 EXPLAIN QUERY PLAN） | ✅ | ✅ | node:sqlite |
| MongoDB | ✅ find/aggregate | ✅ 字段抽样推断 | ⚠️ 无 DDL | ✅ | ✅ currentOp | ✅ system.profile | ❌ | ❌ | mongodb |
| Redis | ✅ 命令 | ❌ | ❌ | ❌ | ❌（单线程） | ✅ SLOWLOG | ✅ 白名单内 | ❌ | 自研 RESP |
| Kafka / Redpanda | ✅ 只读操作 | ✅ topic | ❌ | ❌ | ❌（无锁；看 ISR/leader） | ❌（看消费积压 lag） | ❌ | ❌ | kafkajs |
| ClickHouse | ✅ | ✅ | ✅ SHOW CREATE | ✅ 主键/排序键 | ❌（无行锁） | ✅ system.query_log | ✅ | ❌（无事务） | HTTP |
| Elasticsearch | ✅ REST | ✅ 索引/mapping | ⚠️ 无 DDL | ❌ | ❌ | ❌ | ❌ | ❌ | HTTP |

`⚠️` = 能给出方向但不能保证视图在你这个版本存在；不支持时命令会明确告诉你替代查法，而不是返回空结果。

## 输出约定

- 默认 `--format auto`：**终端里出表格，被管道/Agent 捕获时出 JSON**（`--format` 可覆盖）。
- JSON 结构固定：`{columns, rowCount, truncated, durationMs, rows:[{...}]}`；
  文档型结果（Mongo/ES）是 `{rowCount, documents:[...]}`；写/试跑是
  `{mode, statement, affectedRows, rolledBack, authorizedBy}`。
- 还需要授权的写操作输出 `{status:"approval_required", requestId, approvalCode, plan, card,
  next:{tool, params, onApprove, thenRun, thenRunArgs}}`，退出码 7。`next.thenRunArgs` 是重跑用的精确参数表，
  `next.params` 可直接喂给宿主确认工具。
- **`truncated: true` 表示结果被行数上限截断**，不是「就这么多」；要全量用 `--no-limit`（慎用）或加 `WHERE`。
- 单元格默认截断：表格 80 字符、JSON 4096 字符（`--max-cell` 调整）；二进制显示为 `<binary N B>`。
- 大整数（`bigint`）输出为字符串，避免 JS 精度丢失；`NULL` 在表格里是 `NULL`、JSON 里是 `null`。

退出码：`0` 成功 · `1` 其他错误 · `2` 用法错误 · `3` 连接选择/参数问题 · `4` 只读护栏拦截 ·
`5` 驱动未安装 · `6` 连接失败 · `7` 写操作待授权/未获授权（什么都没执行）。

## 常见错误 → 下一步

| 报错 | 大概率原因 | 下一步 |
| --- | --- | --- |
| `ECONNREFUSED` | 端口没服务 / compose 没映射端口 | `dbcli list` 看目标；`docker ps`；核对 ports |
| `ETIMEDOUT` / timeout | 网络不通、安全组、需 VPN | 先测连通性；`--timeout` 放长 |
| `ENOTFOUND` / `getaddrinfo` | 域名解析失败 | 检查 hosts/VPN；用 IP 临时验证 |
| `Access denied for user`（MySQL） | 密码错 / 不允许该 IP | `dbcli env` 核对来源；查 `mysql.user` 的 host |
| `28P01` / `password authentication failed`（PG） | 密码错 / pg_hba 认证方式 | 同上，注意 scram/md5 |
| `ORA-01017` | 用户名密码错（注意大写） | 确认 service_name 与用户是否大写 |
| `ORA-12514` / `ORA-12505` | service_name / SID 不对 | 问 DBA 要 service_name |
| `18456`（SQL Server） | 登录失败 / 仅 Windows 认证 | 确认 SQL 认证已开启 |
| `ER_BAD_DB_ERROR` / `3D000` | 库名不存在 | `query "SHOW DATABASES"` / `SELECT datname FROM pg_database` |
| `too many clients` / `53300` | 连接打满 | 看应用连接池；`dbcli slow` 找长事务 |
| Kafka `advertised.listeners` | bootstrap 通了但元数据里的 broker 地址不可达 | 让平台方改 advertised.listeners；或直连可达地址 |
| Kafka `SASL` / `Authentication failed` | 用户名/密码/机制不匹配 | `KAFKA_SASL_MECHANISM` 选 plain/scram-sha-256/scram-sha-512，配 SSL |
| Kafka `COORDINATOR_NOT_AVAILABLE` | 消费组协调器在迁移 | 等几秒重试；持续出现说明 broker 抖动 |
| Kafka `UNKNOWN_TOPIC_OR_PARTITION` | topic 名错 / ACL 隐藏 | `dbcli tables` 确认名字 |
| 只读拒绝（退出码 4） | 语句是写操作 | 加 `--allow-write` 只会打印确认卡片，然后弹框、`approve`、带 `--approve <码> --agent` 重跑 |
| 写操作待授权（退出码 7） | 没带 `--approve`，或码错/过期/已用过，或语句/连接变了 | 去掉 `--approve` 重跑同一命令拿新卡片；不要去猜码 |
| 授权状态写不进去 | 状态目录不可写 | 放开该目录写权限，或用 `DBCLI_STATE_DIR` 指到可写目录 |
| 缺少驱动（退出码 5） | 该类库还没装驱动 | `dbcli drivers install <名字>`（见下节） |
| 证书/`self-signed certificate` | 内网自签 TLS | 信任网络时加 `--insecure-tls` |

错误输出会附带「怎么排查」和「目标 + 凭据来源」，不要绕过它自己拼连接串。

## 安全红线

1. **不打印密码**：`list`/`env`/错误/JSON 一律只给 `passwordSet` 与来源行号。
2. **不写配置文件**：不生成 `.env`、不落盘 token、不做连接缓存。
3. **不绕过只读**：不要用自己写 mysql/redis 脚本的方式绕过护栏，也不要绕过授权关卡
   （不许代替用户 `approve`、不许手改状态文件）。
4. **生产库优先只读账号**；没有只读账号时也**先只读查询**，写操作每条都要拿到弹框授权。
5. 大表查询一律带 `WHERE`/`LIMIT`；`--no-limit` 只用于确认过规模的场景。
6. 采样/输出里出现身份证、手机号、密码哈希等敏感列时，不要整表 dump 到对话里。

## 驱动按需安装（skill 保持小体积）

**skill 本体零依赖**：以下四种开箱即用，不需要 npm install——

- SQLite（Node 内置 `node:sqlite`，需 Node ≥ 22.13）
- Redis（自研 RESP 客户端，走 `node:net`/`node:tls`）
- ClickHouse（HTTP 接口）
- Elasticsearch（HTTP 接口）

其余引擎**第一次用到时再装**（装到 skill 目录或 `DB_DRIVER_DIR`，不随 skill 源码分发）：

```bash
dbcli drivers install mysql postgres mongodb     # mysql2 / pg / mongodb
dbcli drivers install oracle sqlserver kafka     # oracledb / mssql / kafkajs
dbcli drivers                                      # 看装没装
dbcli drivers clean                                # 不想留了：删掉 node_modules 与 npm 缓存
```

- 项目里本来就装了 `mysql2`/`pg`/`mongodb`/`kafkajs` 时**直接复用**（CLI 会从当前项目目录找包），不用重复装。
- 网络受限：`dbcli drivers install mysql --registry https://registry.npmmirror.com`。
- skill 目录只读时：`DB_DRIVER_DIR=D:\dbcli-drivers` 指定安装位置（该目录也会被自动加入查找路径）。
- **达梦 DM8**：官方驱动不在公共 npm 上，从 DM 安装目录取 `drivers/nodejs/dmdb-*.tgz`：
  `DB_DM_DRIVER_TGZ=<tgz 路径> dbcli drivers install dameng`（或直接 `npm i <tgz>` 到项目里）。
  `dmdb` 是原生扩展，Node 大版本要匹配；装不上时用 DBA 的客户端排查。

## 不要写脚本替代 CLI

| 需求 | 用这条，别自己写脚本 |
| --- | --- |
| 不知道连哪个库 | `dbcli list` / `dbcli env` |
| 跑一条 SQL | `dbcli query "..."` |
| 表结构/DDL/索引 | `dbcli desc` / `dbcli ddl` / `dbcli indexes` |
| 锁/慢 SQL | `dbcli locks` / `dbcli slow` |
| Kafka topic/积压/消息 | `dbcli tables` / `dbcli query '{"op":"lag",...}'` / `{"op":"peek",...}` |
| 连不上 | `dbcli ping` + 「常见错误」表 |

写脚本只在：需要跨库聚合、批量比对、把结果落盘做二次分析（且 CLI 输出用 `--format json` 消费）。

## 开发与测试

```bash
node --test --test-isolation=none "tests/**/*.test.mjs"   # 全量（沙箱里用这个）
node bin/dbcli.mjs driver...                                # 手测
```

测试覆盖：环境变量/`.env` 解析、compose/Spring 发现、连接串（含 JDBC/Go DSN/libpq）、
只读护栏与限行注入、写操作授权（指纹、一次性码、过期与会话绑定、`approve` 端到端、影响面提示）、
输出格式、SQLite 真库端到端、Redis mock（RESP）、ClickHouse/ES mock（HTTP）。

## 版本

`0.3.0` —— 与 `package.json` 保持一致；能力变化请同时更新本文件与 README。
