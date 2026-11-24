/**
 * Read-only guard.
 *
 * Troubleshooting is 99% reads, so the default is **read-only**: write statements are blocked during
 * parsing, and where possible a second lock is applied at the database session layer (MySQL/Postgres
 * read-only transactions, SQLite opened read-only). When data really must change, `--allow-write` is
 * required, and SKILL.md requires confirming with the user first.
 */

export class WriteBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriteBlockedError';
    this.exitCode = 4;
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 3;
  }
}

const READ_KEYWORDS = new Set(['select', 'with', 'show', 'desc', 'describe', 'explain', 'pragma', 'values', 'table', 'help']);
const WRITE_WORDS =
  /\b(insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|rename|call|exec|execute|load|copy|attach|detach|vacuum|reindex|refresh|kill|shutdown|flush|optimize|repair|backup|restore|commit|rollback|savepoint|comment\s+on)\b/i;
const DANGEROUS_FUNCS =
  /\b(nextval|setval|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|xp_cmdshell|sp_executesql|openrowset|opendatasource|load_file|sys_exec|sys_eval)\s*\(/i;

/**
 * Remove string literals and comments (replaced with spaces), leaving only the skeleton used for
 * keyword checks. Supports '...', ''...'' (MySQL), "...", `...`, -- line comments, # line comments,
 * /* *\/ block comments, and $tag$...$tag$.
 */
export function stripLiterals(sql) {
  const text = String(sql ?? '');
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '-' && next === '-') {
      while (index < text.length && text[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      out += '  ';
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        out += text[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < text.length) {
        out += '  ';
        index += 2;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += ' ';
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\' && quote === "'") {
          out += '  ';
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          if (text[index + 1] === quote) {
            out += '  ';
            index += 2;
            continue;
          }
          out += ' ';
          index += 1;
          break;
        }
        out += text[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (char === '$') {
      const tagMatch = text.slice(index).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = text.indexOf(tag, index + tag.length);
        const stop = end === -1 ? text.length : end + tag.length;
        for (let cursor = index; cursor < stop; cursor += 1) out += text[cursor] === '\n' ? '\n' : ' ';
        index = stop;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Split statements on semicolons (skipping semicolons inside strings/comments) */
export function splitStatements(sql) {
  const text = String(sql ?? '');
  const statements = [];
  let start = 0;
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === "'") {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '$') {
      const tagMatch = text.slice(index).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const end = text.indexOf(tagMatch[0], index + tagMatch[0].length);
        index = end === -1 ? text.length : end + tagMatch[0].length;
        continue;
      }
    }
    if (char === ';') {
      const piece = text.slice(start, index).trim();
      if (piece) statements.push(piece);
      start = index + 1;
    }
    index += 1;
  }
  const tail = text.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

export function firstKeyword(sql) {
  const naked = stripLiterals(sql).trim();
  return (naked.match(/^([A-Za-z]+)/)?.[1] ?? '').toLowerCase();
}

function writeBlockedHint(keyword) {
  return [
    `Refusing to run: looks like a write statement (${keyword || 'unknown'}).`,
    'Diagnosis usually does not need writes; if you really must change data:',
    '  1) Tell the user which table changes, what changes, and roughly how many rows;',
    '  2) Rerun with --allow-write: that executes nothing, it prints a confirmation card (requestId + one-time code);',
    '  3) After the user approves in the host dialog: dbcli approve --id <requestId> --answer "同意执行",',
    '     then rerun with --approve <code> --agent (add --dry-run first to verify the blast radius).',
  ].join('\n');
}

/** True when the SQL contains a MySQL executable comment (the `/*!` form) outside literals and ordinary comments. */
export function hasExecutableComment(sql) {
  const text = String(sql ?? '');
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === "'") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      if (text[index + 2] === '!') return true;
      const end = text.indexOf('*/', index + 2);
      if (end === -1) return false;
      index = end + 1;
    }
  }
  return false;
}

/**
 * Validate and normalize a single SQL statement. Only one statement per run (split batches so each
 * one can be confirmed individually).
 * @returns {{sql:string, keyword:string}}
 */
export function guardSql(sql, { allowWrite = false } = {}) {
  const text = String(sql ?? '').trim();
  if (!text) throw new UsageError('SQL is empty');
  const statements = splitStatements(text);
  if (!statements.length) throw new UsageError('SQL is empty');
  if (statements.length > 1) {
    throw new UsageError(
      `Only one statement per run is allowed (found ${statements.length}). Run them one at a time so results and impact stay clear.`,
    );
  }
  const single = statements[0];
  const keyword = firstKeyword(single);
  if (allowWrite) return { sql: single, keyword };

  if (hasExecutableComment(single)) {
    throw new WriteBlockedError(
      [
        'Refusing MySQL executable comments (/*! ... */) in read-only mode.',
        'The server executes their content, so they can carry writes (INTO OUTFILE, DDL, ...) past the guard.',
      ].join('\n'),
    );
  }
  if (!READ_KEYWORDS.has(keyword)) throw new WriteBlockedError(writeBlockedHint(keyword));
  if (keyword === 'pragma' && /pragma\s+[A-Za-z_][A-Za-z0-9_]*\s*=/i.test(stripLiterals(single))) {
    throw new WriteBlockedError(`${writeBlockedHint('PRAGMA assignment')}\n(only read-only PRAGMA is allowed, e.g. PRAGMA table_info(t))`);
  }

  const naked = stripLiterals(single);
  const body = keyword === 'explain' ? naked.replace(/^explain\s*(\([^)]*\))?\s*/i, '') : naked;
  const bodyKeyword = (body.trim().match(/^([A-Za-z]+)/)?.[1] ?? '').toLowerCase();
  if (keyword === 'explain' && !['select', 'with', 'values', 'table'].includes(bodyKeyword)) {
    throw new WriteBlockedError(`Only read-only EXPLAIN statements are allowed; EXPLAIN ${bodyKeyword.toUpperCase()} may actually perform writes.`);
  }
  if (keyword !== 'show' && keyword !== 'desc' && keyword !== 'describe') {
    const hit = body.match(WRITE_WORDS);
    if (hit) throw new WriteBlockedError(writeBlockedHint(hit[1]));
    const fn = body.match(DANGEROUS_FUNCS);
    if (fn) {
      throw new WriteBlockedError(
        `${writeBlockedHint(`function ${fn[1]}()`)}\n(these functions modify data, read server files, or terminate sessions; not allowed in read-only mode)`,
      );
    }
    if (/\binto\s+(out|dump)file\b/i.test(body)) throw new WriteBlockedError(writeBlockedHint('INTO OUTFILE/DUMPFILE'));
    if (/\bfor\s+(update|share|no\s+key\s+update)\b/i.test(body) || /\block\s+in\s+share\s+mode\b/i.test(body)) {
      throw new WriteBlockedError(writeBlockedHint('SELECT ... FOR UPDATE / LOCK IN SHARE MODE takes locks and affects live transactions'));
    }
    if (/\binto\s+[A-Za-z_"`]/i.test(body)) throw new WriteBlockedError(writeBlockedHint('SELECT ... INTO a new table'));
  }
  return { sql: single, keyword };
}

/**
 * Add a row limit automatically so one SELECT from an agent cannot pull back an entire table.
 * Not injected when LIMIT/TOP/FETCH/ROWNUM is already present.
 * @returns {{sql:string, injected:boolean, notice?:string}}
 */
export function applySqlLimit(sql, { limit, engine } = {}) {
  if (!Number.isFinite(limit) || limit <= 0) return { sql, injected: false };
  // Drop trailing semicolons: a single statement has already been enforced, and the
  // terminator would otherwise prevent (or break) limit injection.
  const text = String(sql).trim().replace(/;+\s*$/, '');
  if (!text) return { sql, injected: false };
  const keyword = firstKeyword(text);
  if (!['select', 'with', 'values', 'table'].includes(keyword)) return { sql: text, injected: false };
  const naked = stripLiterals(text);
  if (/\blimit\b|\bfetch\s+(first|next)\b|\btop\s*\(|\btop\s+\d|\brownum\b/i.test(naked)) {
    return { sql: text, injected: false };
  }
  // Always inject on a new line: a trailing `-- ...` or `# ...` comment must not swallow the limit.
  if (engine === 'oracle') {
    // 11g does not understand FETCH FIRST; wrap the subquery with ROWNUM (also correct on 12c+)
    return { sql: `SELECT * FROM (\n${text}\n) WHERE ROWNUM <= ${limit}`, injected: true };
  }
  if (engine === 'sqlserver') {
    if (/\border\s+by\b/i.test(naked)) {
      return { sql: text, injected: false, notice: 'SQL Server cannot safely wrap TOP around ORDER BY; no row limit injected (add TOP yourself)' };
    }
    return { sql: `SELECT TOP (${limit}) * FROM (\n${text}\n) AS _dbcli_q`, injected: true };
  }
  return { sql: `${text}\nLIMIT ${limit}`, injected: true };
}

/** Rough query cost / blast-radius hints: full scans without WHERE (aggregates/counts excluded) */
export function scanRisks(sql) {
  const naked = stripLiterals(sql).toLowerCase();
  const risks = [];
  const aggregate = /\b(count|sum|avg|min|max|group_concat|string_agg|array_agg)\s*\(/.test(naked);
  if (/^\s*select\b/.test(naked) && !/\bwhere\b/.test(naked) && !/\blimit\b/.test(naked) && !aggregate) {
    risks.push('This query has no WHERE/LIMIT; it may scan the whole table when the table is large');
  }
  if (/\bselect\s+\*/i.test(naked) && /\bwhere\b/.test(naked) && /\bor\b/.test(naked)) {
    risks.push('WHERE contains OR; verify that an index is still used');
  }
  return risks;
}

/** DDL that must not be mistaken for a reversible trial run */
const DDL_KEYWORDS = new Set(['drop', 'truncate', 'alter', 'create', 'rename', 'grant', 'revoke']);
/** Engines whose DDL commits implicitly, so --dry-run cannot roll it back */
const AUTOCOMMIT_DDL_ENGINES = new Set(['mysql', 'oceanbase', 'oracle', 'dameng']);

/**
 * Blast-radius hints for a write statement, rendered on the approval card.
 *
 * This does not analyse the plan or rewrite the SQL: it only states what the text alone proves
 * (no WHERE, DDL that cannot roll back), which is exactly what the person approving needs to see.
 * @returns {string[]} human-readable risks (empty when the statement looks tightly scoped)
 */
export function writeRisks(sql, { mode = 'write', engine = '' } = {}) {
  const naked = stripLiterals(sql).toLowerCase();
  const keyword = (naked.trim().match(/^([a-z]+)/) ?? [])[1] ?? '';
  const risks = [];
  const hasWhere = /\bwhere\b/.test(naked);

  if (['update', 'delete'].includes(keyword)) {
    if (!hasWhere) risks.push('没有 WHERE 条件，可能影响整表所有行');
    else if (/\bwhere\s+(1\s*=\s*1|true)\b/.test(naked)) risks.push('WHERE 恒为真，等于没有过滤条件，可能影响整表');
  }
  if (keyword === 'truncate' || keyword === 'drop') risks.push('结构性删除，执行后无法通过本命令回滚，先确认有备份');
  if (keyword === 'insert' && /\bselect\b/.test(naked)) risks.push('INSERT ... SELECT：写入行数由子查询决定，执行前先统计');
  if (keyword === 'grant' || keyword === 'revoke') risks.push('权限变更会影响这个库上的其他账号与程序');
  if (mode === 'dry-run' && DDL_KEYWORDS.has(keyword) && AUTOCOMMIT_DDL_ENGINES.has(engine)) {
    risks.push(`${engine} 的 DDL 会自动提交，--dry-run 的 ROLLBACK 挡不住，预演也可能真的改掉结构`);
  }
  if (mode === 'dry-run' && !risks.length) risks.push('预演同样是真实执行（取锁、触发触发器）后回滚，不是免费的空跑');
  return risks;
}

const REDIS_READ_COMMANDS = new Set([
  'PING',
  'INFO',
  'DBSIZE',
  'SCAN',
  'TYPE',
  'TTL',
  'PTTL',
  'EXISTS',
  'GET',
  'MGET',
  'STRLEN',
  'GETRANGE',
  'SUBSTR',
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'HSCAN',
  'LRANGE',
  'LLEN',
  'LINDEX',
  'SMEMBERS',
  'SCARD',
  'SISMEMBER',
  'SSCAN',
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZREVRANGE',
  'ZSCORE',
  'ZCARD',
  'ZRANK',
  'ZCOUNT',
  'ZSCAN',
  'XRANGE',
  'XREVRANGE',
  'XLEN',
  'XINFO',
  'XPENDING',
  'MEMORY',
  'OBJECT',
  'SLOWLOG',
  'CLIENT',
  'CONFIG',
  'COMMAND',
  'LATENCY',
  'TIME',
  'RANDOMKEY',
  'LASTSAVE',
  'ROLE',
  'SELECT',
  'AUTH',
  'ECHO',
  'KEYS',
  'DUMP',
  'GETDEL',
]);

const REDIS_DENY_ALWAYS = new Set(['FLUSHALL', 'FLUSHDB', 'DEBUG', 'MONITOR', 'SHUTDOWN', 'REPLICAOF', 'SLAVEOF', 'SCRIPT', 'FUNCTION', 'EVAL', 'EVALSHA', 'MIGRATE', 'RESTORE', 'SWAPDB']);

const REDIS_SUBCOMMAND_RULES = {
  CONFIG: ['GET', 'RESETSTAT'],
  CLIENT: ['LIST', 'INFO', 'GETNAME', 'ID', 'TRACKINGINFO'],
  MEMORY: ['USAGE', 'STATS', 'DOCTOR', 'MALLOC-STATS'],
  OBJECT: ['ENCODING', 'REFCOUNT', 'IDLETIME', 'FREQ', 'HELP'],
  SLOWLOG: ['GET', 'LEN', 'RESET'],
  CLUSTER: ['INFO', 'NODES', 'SLOTS', 'SHARDS', 'MYID'],
};

/** Redis command allowlist: enough for read-only diagnosis; every write command is blocked */
export function guardRedis(args, { allowWrite = false } = {}) {
  const list = (Array.isArray(args) ? args : [args]).map((item) => String(item));
  if (!list.length) throw new UsageError('Redis command is empty, e.g. dbcli query "INFO server"');
  const command = list[0].toUpperCase();
  if (allowWrite) {
    if (REDIS_DENY_ALWAYS.has(command)) {
      throw new WriteBlockedError(`Redis ${command} is never run, even with --allow-write: the blast radius is too large (flushes the DB, stops the server, or runs managed scripts).`);
    }
    return;
  }
  if (REDIS_DENY_ALWAYS.has(command)) {
    throw new WriteBlockedError(`Refusing Redis ${command} in read-only mode.`);
  }
  if (!REDIS_READ_COMMANDS.has(command)) {
    throw new WriteBlockedError(
      [
        `Refusing Redis ${command} in read-only mode: it is not on the read-only allowlist.`,
        'Read-only commands for diagnosis: PING/INFO/DBSIZE/SCAN/TYPE/TTL/GET/MGET/HGETALL/LRANGE/SMEMBERS/ZRANGE/MEMORY USAGE/SLOWLOG GET/CLIENT LIST.',
        'If you really need to write: add --allow-write to print the confirmation card, then approve and rerun with --approve <code> --agent.',
      ].join('\n'),
    );
  }
  const rule = REDIS_SUBCOMMAND_RULES[command];
  if (rule) {
    const sub = (list[1] ?? '').toUpperCase();
    if (!rule.includes(sub)) {
      throw new WriteBlockedError(
        `Read-only mode only allows ${command} ${rule.join('|')}; ${command} ${sub || '(empty)'} may change configuration or data.`,
      );
    }
  }
  // GETDEL is a write command (GET+DEL); do not be fooled by the name
  if (command === 'GETDEL') throw new WriteBlockedError('Refusing GETDEL in read-only mode (it deletes the key).');
}

const MONGO_READ_OPS = new Set([
  'find',
  'findOne',
  'count',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'aggregate',
  'listCollections',
  'listIndexes',
  'listDatabases',
  'dbStats',
  'collStats',
  'serverStatus',
  'currentOp',
  'explain',
  'getParameter',
  'connectionStatus',
  'hostInfo',
  'buildInfo',
  'isMaster',
  'hello',
  'ping',
]);

/** Mongo read-only check: allowlisted operation names, and no $out/$merge in aggregation pipelines */
export function guardMongoOperation(operation, { pipeline, allowWrite = false } = {}) {
  const op = String(operation ?? '');
  if (allowWrite) return;
  if (!MONGO_READ_OPS.has(op)) {
    throw new WriteBlockedError(
      `Refusing Mongo operation ${op || '(empty)'} in read-only mode; available read-only operations: find / aggregate / countDocuments / distinct / listCollections / listIndexes / currentOp / dbStats.`,
    );
  }
  if (Array.isArray(pipeline)) {
    for (const stage of pipeline) {
      if (!stage || typeof stage !== 'object') continue;
      const keys = Object.keys(stage);
      if (keys.includes('$out') || keys.includes('$merge')) {
        throw new WriteBlockedError('Refusing $out / $merge in an aggregation pipeline in read-only mode (they write results back into a collection).');
      }
    }
  }
}

/** Elasticsearch read-only check: method + path allowlist */
export function guardEsRequest(method, path, { allowWrite = false } = {}) {
  const verb = String(method ?? 'GET').toUpperCase();
  const target = String(path ?? '/');
  if (allowWrite) return;
  if (verb !== 'GET' && verb !== 'HEAD') {
    // Only query-style endpoints are allowed for POST
    const allowed =
      verb === 'POST' &&
      /(\/_search|\/_count|\/_msearch|\/_field_caps|\/_resolve\/index|\/_analyze|\/_explain|\/_validate\/query|\/_mget)(\/|$|\?)/.test(
        target,
      );
    if (!allowed) {
      throw new WriteBlockedError(
        `Refusing ${verb} ${target} in read-only mode: only GET/HEAD and POST _search/_count/_msearch/_field_caps/_analyze are allowed.`,
      );
    }
  }
  if (/\/(_bulk|_update|_delete_by_query|_update_by_query|_reindex|_close|_open|_forcemerge|_refresh)\b/.test(target)) {
    throw new WriteBlockedError(`Refusing ${verb} ${target} in read-only mode (index writes / maintenance operations).`);
  }
}

const KAFKA_READ_OPS = new Set([
  'topics',
  'listTopics',
  'describe',
  'describeTopic',
  'metadata',
  'fetchTopicMetadata',
  'offsets',
  'fetchTopicOffsets',
  'cluster',
  'describeCluster',
  'groups',
  'listGroups',
  'describeGroups',
  'lag',
  'peek',
  'configs',
  'describeConfigs',
]);

/** Kafka read-only check: this CLI cannot produce messages, change configs, or reset offsets */
export function guardKafkaOperation(operation, { allowWrite = false } = {}) {
  const op = String(operation ?? '').trim();
  if (allowWrite) {
    throw new UsageError(
      'Kafka is read-only in this CLI: producing messages, changing topic configs, and resetting consumer offsets are not supported.\n' +
        'Use read operations for diagnosis (topics/describe/peek/groups/lag/cluster); to publish messages, use application code or a Kafka console.',
    );
  }
  if (!op) {
    throw new UsageError('Missing Kafka operation, e.g. dbcli query \'{"op":"topics"}\'');
  }
  if (!KAFKA_READ_OPS.has(op)) {
    throw new WriteBlockedError(
      `Kafka only supports read-only operations: ${[...KAFKA_READ_OPS].join(' / ')}; got "${op}".`,
    );
  }
}
