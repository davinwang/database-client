# database-client（dbcli）

[English](README.md) | 简体中文

给编程 Agent 用的数据库排查客户端：**连接信息全部来自项目环境变量 / `.env`，skill 自身不保存任何地址与密码**。
默认只读，能跑 SQL、看表结构/索引/DDL、查锁等待与慢 SQL TOP N。

- 支持：MySQL/MariaDB/TiDB/TDSQL/PolarDB/GoldenDB、OceanBase（MySQL/Oracle 模式）、
  PostgreSQL/Kingbase/Vastbase/GaussDB/openGauss、Oracle、达梦 DM8、SQL Server、SQLite、
  MongoDB、Redis、Kafka/Redpanda、ClickHouse、Elasticsearch。
- 零依赖可用：SQLite、Redis、ClickHouse、Elasticsearch（Node 内置能力或 HTTP）。
- 其余引擎按需安装 npm 驱动（`dbcli drivers install ...`），**不随 skill 源码分发**。

## 为什么不用现成的 SQL 客户端

Agent 排查问题的成本不在「执行 SQL」，而在：

1. **这个项目现在该连哪个库？** —— 每个项目/环境的环境变量都不同，写死配置必错；
2. **连不上/没权限时到底为什么？** —— 驱动只回一句 `Access denied`，Agent 只能瞎猜；
3. **一条 `SELECT *` 会不会把整张表拉进上下文？** —— 需要默认限行、可截断、可脱敏；
4. **只读还是可写？** —— 排查场景默认不该有写权限。

`dbcli` 就解决这四件事，SQL 由 Agent 自己写。

## 环境要求

- Node.js **≥ 22.13**（`node:sqlite` 从 22.13 起不再需要实验开关；更低版本不受支持）
- 无需 Java、无需数据库客户端、无需预装驱动

## 安装

把整个目录放到 skills 目录即可（例如 `~/.agents/skills/database-client`），然后：

```bash
node <skill目录>/bin/dbcli.mjs --help
```

也可以加入 PATH：`bin/dbcli`（POSIX）/ `bin/dbcli.cmd`（Windows）。

## 快速开始

```bash
# 1) 当前项目里已经配了 DB_URL / DATABASE_URL / MYSQL_* 之类时，直接就绪
export DB_URL='mysql://app:密码@127.0.0.1:3306/appdb'

node bin/dbcli.mjs list          # 发现了什么连接（密码不显示）
node bin/dbcli.mjs doctor        # 自检：Node / 驱动 / 配置 / 连通性
node bin/dbcli.mjs tables        # 看表
node bin/dbcli.mjs desc orders   # 看表结构
node bin/dbcli.mjs query "select * from orders where status='NEW' order by id desc" --limit 20
node bin/dbcli.mjs locks         # 谁在等锁
node bin/dbcli.mjs slow -n 10    # 最慢的 SQL
```

没有配环境变量也没关系：项目根有 `.env`、`docker-compose.yml` 或 Spring 的 `application.yml` 时，
CLI 会自动发现（详见「配置发现」）。用 `dbcli env` 可以看清每个值来自哪个文件第几行。

## 配置发现

### 优先级（高 → 低）

1. 命令行参数（`--db`、`--env-file`、`--schema`）
2. 系统环境变量（Agent 宿主通常按项目注入）
3. `--env-file` 指定的文件（可重复，按顺序后者覆盖前者）
4. `.env.<profile>.local` → `.env.<profile>` → `.env.local` → `.env`
   （profile 取 `SPRING_PROFILES_ACTIVE` / `APP_ENV` / `NODE_ENV` / `PROFILE` / `ENV` 的第一个值）
5. `docker-compose.yml` / `compose.yml` 的 `services`
6. Spring `application.yml` / `application-<profile>.yml` / `application.properties` / `config/` / `src/main/resources/`

搜索目录：当前目录 + 向上找到的项目根（有 `.git`/`package.json`/`pom.xml`/`go.mod` 等标记）。

### 变量命名

| 形式 | 示例 | 说明 |
| --- | --- | --- |
| 单库 | `DB_URL` | 连接名固定为 `default`，只有它时不用 `--db` |
| 多库 | `DB_ERP_URL` | 连接名 `erp`，用 `--db erp` |
| 分段 | `DB_ERP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | 名字里带类型可省 `_TYPE` |
| 类型别名 | `DB_MYSQL_URL`、`DB_REDIS_HOST` | `mysql`/`redis` 会被识别为类型 |
| 通用 | `DATABASE_URL`、`JDBC_URL`、`SPRING_DATASOURCE_URL` | 自动识别 |
| 生态 | `MYSQL_*`、`PG*`/`POSTGRES_*`、`REDIS_*`、`MONGO_URI`、`KAFKA_*`、`CLICKHOUSE_*`、`ES_*`、`ELASTICSEARCH_*` | 不用改项目原有命名 |

可选：`DB_DEFAULT=<名字>` 指定默认连接；`DB_<名字>_SCHEMA` 指定默认 schema；
`DB_<名字>_DIALECT`/`_MODE`（OceanBase：`oracle`）；`DB_<名字>_SSL=true`；
`DB_<名字>_FILE`（SQLite 路径）；`REDIS_CLUSTER_NODES=a:6379,b:6379`（Redis 集群，单节点视图）。

### 框架配置文件（不绑定语言）

配置发现不绑定某一种生态，同一套适配器对每个项目都会生效：

| 来源 | 技术栈 | 映射 |
| --- | --- | --- |
| `.env*` | 任意 | 变量，按 profile 分层 |
| `docker-compose.yml` | 任意 | 服务 image/ports/environment |
| `application*.yml` / `application*.properties` | Java / Spring Boot | `spring.datasource.*`、`dynamic.datasource.*`、`spring.data.redis.*`、`spring.data.mongodb.uri`、`spring.elasticsearch.uris` |
| `appsettings*.json` | .NET | `ConnectionStrings:<name>`（ADO.NET 串或 URL）→ `dotnet-<name>` |
| `ormconfig.json`、`config/*.json` | Node（TypeORM / node-config） | 连接对象 → `config-<路径>` |
| `database.yml` | Ruby / Rails | `adapter` + host/database/username → `rails-<env>` |
| `*.ini`、通用 JSON/YAML/properties | Python（alembic）等 | 数据库相关 key 里的连接 URL → `config-<key>` |

Spring 的值会用项目环境变量展开；dotenv 风格（`DATASOURCE_URL=...`）的
`application-<profile>.properties` 在设置 `SPRING_PROFILES_ACTIVE` 后也会参与展开。展开后仍是占位符的数据源会被
跳过并告警变量名——配到环境变量或加 `--env-file <文件>`。`Config files read` 只表示文件被解析，不代表占位符解析成功。

含 `@ # % &` 的账号密码（如 `user@tenant#instance`）不要拼进 `scheme://user:pass@host`：
`@`、`#` 是分隔符，会悄悄连到错误的主机。用拆分字段（`DB_<名字>_USER` / `DB_<名字>_PASSWORD`）或百分号编码。

### 连接串格式

```text
mysql://user:pass@host:3306/db?ssl=true
postgres://user:pass@host:5432/db?sslmode=require
oracle://user:pass@host:1521/SERVICE          # 也支持 jdbc:oracle:thin:@//host:1521/SVC 与 @host:1521:SID
dameng://SYSDBA:pass@host:5236
sqlserver://user:pass@host:1433/db?encrypt=true
oceanbase://root:pass@host:2881/db?mode=oracle
sqlite:./data/app.db                          # 相对路径按当前目录解析
mongodb://user:pass@host:27017/db?authSource=admin
mongodb+srv://...
redis://:pass@host:6379/2                     # rediss:// 走 TLS
kafka://user:pass@broker1:9092,broker2:9092?ssl=true&saslMechanism=scram-sha-256
clickhouse://user:pass@host:8123/db           # 也支持 http(s)://
http://user:pass@host:9200                    # ES，需 DB_<名字>_TYPE=elasticsearch 或 ES_URL
jdbc:mysql://host:3306/db?useUnicode=true     # JDBC 串可直接拷
user:pass@tcp(host:3306)/db                   # Go DSN
host=pg port=5432 user=app dbname=erp         # libpq DSN
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `list` / `ls` | 连接清单：名字、默认、类型、目标、来源（文件:行号）、备注 |
| `env` | 每个数据库变量的值与来源（脱敏）；`--all` 连被覆盖的变量一起看 |
| `doctor` | Node 版本 / 驱动状态 / 配置发现 / 逐连接 ping |
| `drivers` | 驱动状态；`drivers install <名字>\|all`；`drivers clean` |
| `ping` | 版本、库、用户、延迟、只读会话状态 |
| `query` | 执行 SQL（Redis 命令 / Mongo JSON / ES REST 也走这里） |
| `approve` | 用户确认后签发写操作授权（`approve --id <请求号> --answer "同意执行"`） |
| `tables` | 表/视图；`--pattern` 过滤；Mongo 集合、ES 索引同理 |
| `desc` | 列名/类型/可空/默认值/主键/注释 |
| `ddl` | 建表语句（MySQL 用 `SHOW CREATE TABLE`，其余按数据字典重建） |
| `indexes` | 索引与列顺序（缺索引是慢查询第一嫌疑） |
| `locks` | 锁等待：waiting/blocking 会话、等待时长、SQL 片段 |
| `slow` | 慢 SQL / 慢命令 TOP N（`-n` 控制条数） |

通用参数：

```text
--db <名字>         多库时指定连接
--schema <schema>   schema / 库名 / owner
--limit <N>         行数上限（query 默认 200，slow 默认 20）
--no-limit          不注入上限
--format auto|table|json|csv|md
--max-cell <N>      单元格截断字符数
--timeout <ms>      连接/查询超时，默认 15000
--env-file <path>   额外 .env（可重复）
--insecure-tls      跳过证书校验
--allow-write       申请写操作（仍需确认框授权）
--dry-run           写操作试跑后回滚（必须配合 --allow-write，且同样需要授权）
--approve <码>      带一次性授权码执行写操作
--agent             标记授权来自宿主确认框（与 --approve 一起用）
```

### 查询示例

```bash
# 普通 SQL（自动包一层只读事务并注入 LIMIT）
dbcli query "select id, name from users where created_at > '2026-01-01'"

# 从文件执行
dbcli query --file ./sql/check.sql

# 非 SQL 引擎
dbcli query "INFO server"                                        # Redis
dbcli query '{"collection":"users","filter":{"status":"A"},"limit":5}'   # Mongo
dbcli query "/_cat/indices?format=json"                          # Elasticsearch
dbcli query '{"op":"lag","group":"app-consumer"}'                # Kafka 消费积压
```

### Kafka 怎么查

Kafka 没有 SQL，`query` 接一个只读操作（JSON 或裸操作名）：

| 操作 | 作用 |
| --- | --- |
| `{"op":"topics"}` / `dbcli tables` | topic 清单（分区数、副本数、是否内部 topic） |
| `{"op":"describe","topic":"orders"}` / `dbcli desc orders` | 分区 leader / replicas / ISR / 起止位点 / 消息量 |
| `{"op":"peek","topic":"orders","limit":5,"from":"latest"}` | 采几条消息（`from`: latest/earliest，可加 `partition`、`timeoutMs`） |
| `{"op":"groups"}` | 消费组列表（state / protocol / members） |
| `{"op":"lag","group":"app-consumer"}` | 每个分区的 committed / high / lag，附总积压 |
| `{"op":"offsets","topic":"orders"}` | 各分区 low/high |
| `{"op":"configs","topic":"orders"}` | topic 配置（retention 等） |
| `{"op":"cluster"}` | clusterId、controller、broker 列表 |

注意：

- 全部只读：**不发消息、不改配置、不重置位点**；`--allow-write` 会被明确拒绝。
- `peek` 用临时消费组（`dbcli-peek-<uuid>`）读消息且 `autoCommit:false`，broker 上会留下一个空消费组，
  按 `offsets.retention` 自动过期；消息默认最多等 5 秒（`timeoutMs` 可调）。
- 积压排查顺序：`lag` 看积压 → `desc` 看 ISR/leader → `groups` 看是否反复 rebalance。

## 读写控制

| 模式 | 命令 | 行为 |
| --- | --- | --- |
| 只读（默认） | `dbcli query "..."` | 语句白名单 + 会话级只读（MySQL/PG/Oracle/SQLite/ClickHouse）+ 自动限行 |
| 写入 | `dbcli query "update ..." --allow-write` + 授权 | 单条语句，执行后报告影响行数 |
| 试跑 | `dbcli query "update ..." --allow-write --dry-run` + 授权 | 事务内执行后 `ROLLBACK`，只报告影响行数 |

- 只读拦截：`insert/update/delete/merge/truncate/drop/alter/create/grant/revoke/call`、
  `select ... into outfile`、`for update`、`nextval()/setval()`、`pragma 赋值`、多语句、
  非只读的 `explain`；Redis 命令白名单；Mongo `$out/$merge`；ES 只放行 GET/HEAD 与查询类 POST；
  Kafka 只放行 topics/describe/peek/groups/lag/offsets/configs/cluster。
- 会话级兜底：MySQL `SET SESSION TRANSACTION READ ONLY` + 每条 `START TRANSACTION READ ONLY`；
  PG `default_transaction_read_only=on` + `BEGIN READ ONLY`；Oracle `SET TRANSACTION READ ONLY`；
  SQLite 以 `readOnly` 打开；ClickHouse 请求带 `readonly=1`。
- `--dry-run` 单独使用会报错（试跑也会真实加锁、触发触发器，不允许偷偷执行）。
- 支持 dry-run：MySQL/OceanBase/PostgreSQL/Oracle/达梦/SQL Server/SQLite；
  不支持：ClickHouse（无事务）、Redis/Mongo/ES（会明确说明原因）。

## 写操作授权（确认框）

**光有 `--allow-write` 什么都不会改**：它只打印确认卡片 + 请求号 + 一次性授权码，然后以退出码 **7** 结束。
在用户回答确认框之前，命令不会碰数据库。

```bash
# 1) 发起写请求（不执行；--json 直接返回可用的弹框参数）
dbcli query "update orders set status='X' where id=42" --allow-write --json
# {"status":"approval_required","channel":"agent","host":"dsh","requestId":"c969…","approvalCode":"VP54ST",
#  "plan":{…},"card":{…},"next":{"tool":"ask_user_question","params":{…},"onApprove":"…","thenRun":"…"}}

# 2) Agent 把 card.question 原样弹给用户（DSH 用 ask_user_question）

# 3) 用户选「同意执行」→ 签发授权
dbcli approve --id c969938a796806a1 --answer "同意执行"

# 4) 带码执行
dbcli query "update orders set status='X' where id=42" --allow-write --approve VP54ST --agent
```

- 卡片是中文的（`数据库写操作授权` … `[同意执行] [取消]`），因为读它的是人；选项文案必须原样传给 `--answer`。
- 授权指纹 = 动作 + 模式 + 引擎 + 连接名 + 脱敏目标 + 完整语句，改任何一项（包括换个 `--db`）旧码立刻失效；
  授权码一次性、5 分钟过期（签发后的凭据 10 分钟），并且绑定发起请求的宿主会话。
- 已签发的 **write** 授权同时覆盖同一语句的 `--dry-run`，且试跑不消耗它：授权一次 → 预演看影响行数 → 真正提交。
  反过来不成立，`dry-run` 的授权不能用来真写。
- 宿主映射：DSH `ask_user_question`、Claude Code `AskUserQuestion`、WorkBuddy `AskUserQuestion`、
  Codex（无提问工具：展示卡片，明确同意后再 `approve`）、其余走文本确认。`dbcli doctor` 会打印识别到的宿主。
- 交接记录位置：`<临时目录>/dbcli-approvals/approvals.json`（`DBCLI_STATE_DIR` 可改）。里面只有指纹、脱敏目标、
  截断的语句预览和时间戳——没有密码、没有查询结果，用掉即删；目录不可写时命令直接失败（fail closed）。
- 人在终端里直接跑时看到同一张卡片 + `y/N` 提示；没有任何环境变量或配置项能替代授权。

诚实边界：Agent 与 CLI 同处一个 shell，恶意 Agent 理论上能读到交接记录并重放；这里保证的是
「默认不静默执行 + 每次都能追到请求号、宿主与通道」。

## 引擎支持矩阵

| 引擎 | 查询 | 表/结构 | DDL | 索引 | 锁 | 慢 SQL | 写入 | dry-run | 协议/驱动 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MySQL / MariaDB / TiDB / TDSQL / PolarDB / GoldenDB | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | mysql2 |
| OceanBase（MySQL 模式） | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | mysql2 |
| OceanBase（Oracle 模式，`MODE=oracle`） | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | mysql2 |
| PostgreSQL / Kingbase / Vastbase / GaussDB / openGauss | ✅ | ✅ | ✅（重建） | ✅ | ✅ | ✅ | ✅ | ✅ | pg |
| Oracle | ✅ | ✅ | ✅（重建） | ✅ | ✅ | ✅ | ✅ | ✅ | oracledb |
| 达梦 DM8 | ✅ | ✅ | ✅（重建） | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | dmdb（官方） |
| SQL Server | ✅ | ✅ | ✅（重建） | ✅ | ✅ | ✅ | ✅ | ✅ | mssql |
| SQLite | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | node:sqlite |
| MongoDB | ✅ | ✅（字段抽样） | ⚠️ | ✅ | ✅ | ✅ | ❌ | ❌ | mongodb |
| Redis | ✅（命令） | ❌ | ❌ | ❌ | ❌ | ✅（SLOWLOG） | ✅（白名单） | ❌ | 自研 RESP |
| Kafka / Redpanda | ✅（只读操作） | ✅（topic） | ❌ | ❌ | ❌（看 ISR/leader） | ❌（看消费积压） | ❌ | ❌ | kafkajs |
| ClickHouse | ✅ | ✅ | ✅ | ✅（主键/排序键） | ❌ | ✅ | ✅ | ❌ | HTTP |
| Elasticsearch | ✅（REST） | ✅（索引/mapping） | ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | HTTP |

`⚠️` 表示依赖具体版本/权限，命令失败时会给出该版本可用的替代视图名。

## 驱动：按需安装，skill 保持小体积

| 引擎 | 依赖 | 体积（约） |
| --- | --- | --- |
| SQLite / Redis / ClickHouse / Elasticsearch | 无（Node 内置 / HTTP） | 0 |
| MySQL / OceanBase | `mysql2` | ~2 MB |
| PostgreSQL 系列 | `pg` | ~1 MB |
| MongoDB | `mongodb` | ~6 MB |
| Kafka / Redpanda | `kafkajs` | ~3 MB |
| SQL Server | `mssql` | ~2 MB |
| Oracle | `oracledb`（thin 模式） | ~15 MB |
| 达梦 | `dmdb`（官方 tgz） | ~10 MB |

```bash
dbcli drivers install mysql postgres      # 用到哪个装哪个
dbcli drivers install all                 # 除达梦外的 npm 驱动
dbcli drivers clean                       # 清掉 node_modules 与 npm 缓存
```

- 安装位置：默认 `<skill>/node_modules`；`DB_DRIVER_DIR` 可改（skill 目录只读时用）。
- **复用项目依赖**：CLI 会从当前项目目录解析包，项目里已有 `mysql2`/`pg` 就不再装。
- 网络受限：`--registry https://registry.npmmirror.com`。
- 达梦：官方驱动不在公共 npm，从 DM 安装目录取 `drivers/nodejs/dmdb-*.tgz`，
  `DB_DM_DRIVER_TGZ=<tgz> dbcli drivers install dameng`；`dmdb` 为原生扩展，Node 版本需匹配。

## 输出约定

- `--format auto`：TTY 出表格，管道/捕获出 JSON。
- JSON：`{columns, rowCount, truncated, durationMs, rows}`；文档结果是 `documents`；
  写/试跑是 `{mode, statement, affectedRows, rolledBack, authorizedBy}`。
- 待授权的写操作返回 `{status:"approval_required", requestId, approvalCode, plan, card,
  next:{tool, params, onApprove, thenRun, thenRunArgs}}`，退出码 7；`next.params` 可直接喂给宿主确认工具，
  `next.thenRunArgs` 是带码重跑用的精确参数表。
- 行数被截断时 `truncated: true`；单元格按 `--max-cell` 截断；二进制显示 `<binary N B>`；
  bigint 转字符串避免精度丢失。
- 密码永不出现：列表只显示 `passwordSet` 与长度；错误信息里的连接串会打码。

退出码：`0` 成功 · `1` 其他 · `2` 用法 · `3` 连接选择 · `4` 只读拦截 · `5` 缺驱动 · `6` 连接失败 ·
`7` 写操作待授权/未获授权（什么都没执行）。

## 架构

```text
bin/dbcli.mjs            入口（薄）
lib/cli.mjs              参数解析、分发、帮助、退出码
lib/commands.mjs         命令实现（薄：连接 + 授权关卡 + 调用驱动 + 渲染）
lib/connections.mjs      环境变量 → 连接模型（URL/JDBC/DSN 解析、去重、脱敏）
lib/discover.mjs         项目发现（.env 层级、docker-compose、Spring）
lib/env.mjs              .env 解析（引号/转义/展开/行号）
lib/yaml.mjs             极简 YAML / properties（只服务 compose 与 Spring）
lib/guard.mjs            只读护栏、语句切分、限行注入、Redis/Mongo/ES 白名单、影响面提示
lib/approval.mjs         写操作授权仓库：指纹、一次性码、有效期、会话绑定
lib/hosts.mjs            宿主识别（DSH/Claude/Codex/WorkBuddy）+ 确认卡片
lib/authorize.mjs        授权关卡：计划 → 卡片 → approve → 校验 --approve
lib/errors.mjs           错误 → 排查建议（各引擎几十种码）
lib/output.mjs           表格/JSON/CSV/Markdown、脱敏、截断
lib/drivers/*.mjs        每个引擎一个驱动：ping/query/tables/describe/ddl/indexes/locks/slow
```

新增一个引擎：在 `lib/drivers/` 加一个 `create(conn, options)` 模块（实现上述方法中能实现的，
不支持的抛 `UnsupportedError` 并给替代查法），在 `lib/drivers/index.mjs` 的 `DRIVERS` 注册类型、
依赖与 `modes`（read/write/dry-run），在 `lib/connections.mjs` 的 `TYPE_ALIASES`/`TYPE_META` 加别名与默认端口。

## 安全模型

- **不落盘**：不写 `.env`、不建连接缓存、不存历史；每次调用重新读取。唯一会写的文件是短期授权交接记录
  （指纹、脱敏目标、时间戳）。
- **最小权限**：默认只读连接；生产库建议使用只读账号。
- **可审计**：所有输出带目标（`mysql://user@host:port/db`）与凭据来源（文件:行号）。
- **防误删**：写操作必须 `--allow-write` + 逐条弹框授权 + `dbcli approve` 签发；`--dry-run`（同样需授权）
  先看影响行数。
- **防泄漏**：密码不打印；错误信息中的连接串自动打码。

## 测试

```bash
node --test --test-isolation=none "tests/**/*.test.mjs"    # 沙箱/CI 推荐（不 spawn 子进程做隔离）
node --test tests/                                          # 常规环境
```

覆盖：`.env` 与变量展开、compose/Spring 发现、连接串（JDBC/Go DSN/libpq）、只读护栏与限行注入、
写操作授权（指纹、一次性码、过期与会话绑定、`approve` 端到端、影响面提示）、
输出格式与脱敏、SQLite 真库端到端、Redis（RESP mock）、ClickHouse/Elasticsearch（HTTP mock）、驱动注册表。

## 已知限制

- 达梦/OceanBase 的锁与慢 SQL 依赖具体版本的内部视图，取不到时会给替代查法，不保证开箱即用。
- Oracle/PG/SQLServer/达梦 的 `ddl` 是按数据字典重建的（分区、存储参数、约束名不完整）。
- SQL Server 空结果集拿不到列名（TDS 驱动限制），会明确提示。
- ES/Mongo 的写入与 dry-run 不支持（无事务/不在排查范围内）。
- Kafka 只读：不支持生产消息、改配置、重置位点；`peek` 会创建一个临时消费组（不提交位点）。
- 不解析 SQL 方言差异做自动改写；只做只读校验与限行注入。
