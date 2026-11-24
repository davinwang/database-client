/**
 * Write approval store: the credential layer behind "no write runs without a human confirmation".
 *
 * Rule 1 of this skill is "no stored credentials". An approval decision, however, has to survive between
 * two processes: the one that **asks** (prints the confirmation card) and the one that **runs** (after the
 * user agreed). So this module keeps a short-lived record in a temporary directory:
 *
 *   { requests: { <requestId>: {...} }, grants: { <fingerprint>: {...} } }
 *
 * What is stored: a sha256 fingerprint of the plan, the connection **name/label** (masked target, never a
 * URL with a password), a truncated statement preview, the host session marker, and timestamps.
 * What is never stored: passwords, tokens, connection strings with credentials, result rows.
 *
 * Both records expire (a request in 5 minutes, a grant in 10) and are deleted after use, so the store is
 * not a history: it is a hand-off slot. A plan change (statement, connection, target, mode) changes the
 * fingerprint, which makes every older code useless.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Confirmation option labels; the agent must pass the accepted one verbatim to `dbcli approve --answer` */
export const ACCEPT_LABEL = '同意执行';
export const DECLINE_LABEL = '取消';
export const DECLINE_LABELS = [DECLINE_LABEL];

/** Code alphabet without 0/O/1/I/L so a code can be read aloud or retyped without mistakes */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** How long the confirmation prompt stays valid */
export const APPROVE_TTL_MS = numberEnv('DBCLI_APPROVE_TTL_MS', 5 * 60 * 1000);
/** How long a signed approval can be used, and only once (a dry-run does not spend a write approval) */
export const GRANT_TTL_MS = numberEnv('DBCLI_GRANT_TTL_MS', 10 * 60 * 1000);

/** How much of the statement is kept for the card/list preview (the fingerprint uses the full text) */
const PREVIEW_LIMIT = 400;

/**
 * Where the hand-off record lives. Deliberately the OS temp directory: writable in agent sandboxes, wiped by
 * the OS, and separate from any project file. Point DBCLI_STATE_DIR elsewhere when temp is not writable.
 */
export function storeDir() {
  return process.env.DBCLI_STATE_DIR ? path.resolve(process.env.DBCLI_STATE_DIR) : path.join(os.tmpdir(), 'dbcli-approvals');
}

export function storeFile() {
  return path.join(storeDir(), 'approvals.json');
}

function emptyStore() {
  return { version: 1, requests: {}, grants: {} };
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    return { version: 1, requests: raw.requests ?? {}, grants: raw.grants ?? {} };
  } catch {
    return emptyStore();
  }
}

/** Drop expired entries so the file cannot grow without bound */
function prune(store, now = Date.now()) {
  for (const bucket of ['requests', 'grants']) {
    for (const [key, value] of Object.entries(store[bucket])) {
      if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) delete store[bucket][key];
    }
  }
  return store;
}

function storeError(file, error) {
  // Fail closed: without a place to record the decision there is no approval, so no write either.
  return new Error(
    [
      `Cannot record the approval state in ${file} (${error?.code || error?.message}).`,
      'Approval bookkeeping must live somewhere writable; while it cannot be written, no write is executed.',
      'Let the execution environment write that directory, or point DBCLI_STATE_DIR at a writable one.',
    ].join('\n'),
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeStore(store) {
  const file = storeFile();
  const data = JSON.stringify(prune(store), null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    throw storeError(file, error);
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    try {
      // Write-then-rename so a concurrent reader never sees a half-written file
      fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore: the temp file may not exist */
      }
      // Windows: an antivirus/indexer scan can briefly lock the file (EPERM/EBUSY).
      // Fall back to an in-place write, which is still atomic enough for a single short record.
      try {
        fs.writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 });
        return;
      } catch (inner) {
        lastError = inner;
      }
      sleepSync(20);
    }
  }
  throw storeError(file, lastError);
}

/**
 * A write plan. Everything that changes what the database does must be part of the fingerprint,
 * so a changed statement/connection/mode silently invalidates every earlier code.
 * @param {{verb?:string, mode?:string, engine?:string, connection?:string, target?:string, statement?:string}} plan
 */
export function fingerprintOf(plan = {}) {
  const canonical = JSON.stringify([
    String(plan.verb ?? '').toLowerCase(),
    String(plan.mode ?? ''),
    String(plan.engine ?? ''),
    String(plan.connection ?? ''),
    String(plan.target ?? ''),
    String(plan.statement ?? '').trim(),
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function newCode() {
  const bytes = crypto.randomBytes(8);
  return [...bytes].slice(0, 6).map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function preview(statement) {
  const text = String(statement ?? '').replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/**
 * Register a confirmation request (nothing has executed at this point) and return it with its one-time code.
 * @returns {{requestId:string, fingerprint:string, code:string, plan:object, session:string, host:string, expiresAt:number, issuedAt:string, accept:string, declines:string[]}}
 */
export function issueRequest(plan, { session = '', host = '' } = {}) {
  const store = readStore();
  const fingerprint = fingerprintOf(plan);
  const now = Date.now();
  const request = {
    requestId: fingerprint,
    fingerprint,
    code: newCode(),
    plan: { ...plan, statement: undefined, statementPreview: plan.statementPreview ?? preview(plan.statement) },
    session,
    host,
    accept: ACCEPT_LABEL,
    declines: DECLINE_LABELS,
    issuedAt: new Date(now).toISOString(),
    expiresAt: now + APPROVE_TTL_MS,
  };
  store.requests[fingerprint] = request;
  writeStore(store);
  return request;
}

/** Pending (unexpired) requests, oldest first */
export function listRequests() {
  const store = prune(readStore());
  return Object.values(store.requests).sort((a, b) => a.expiresAt - b.expiresAt);
}

/** @returns {object|null} an unexpired request */
export function peekRequest(requestId) {
  const store = readStore();
  const request = store.requests[String(requestId ?? '').trim()] ?? null;
  if (!request) return null;
  return request.expiresAt > Date.now() ? request : null;
}

/**
 * Sign an approval because the user confirmed in the host dialog.
 * The answer must be the accepted label verbatim: a missing answer is not an approval, and any other
 * answer (取消 / no / empty) voids the request.
 * @returns {{approved:boolean, grant?:object, reason?:string, declined?:boolean}}
 */
export function signGrant(requestId, { answer, session = '', host = '' } = {}) {
  const store = readStore();
  const id = String(requestId ?? '').trim();
  const request = store.requests[id];
  if (!request) return { approved: false, reason: 'no such approval request (it may have expired, been used, or been cancelled); run the write command again without --approve to get a new one' };
  if (request.expiresAt <= Date.now()) {
    delete store.requests[id];
    writeStore(store);
    return { approved: false, reason: 'the approval request expired; run the write command again without --approve to get a new one' };
  }
  if (request.session && session && request.session !== session) {
    return { approved: false, reason: `the request belongs to another host session (${request.session}); confirm inside that session` };
  }

  const text = String(answer ?? '').trim();
  if (!text) return { approved: false, reason: 'missing the user\'s explicit answer: silence is not approval' };
  if (text !== request.accept) {
    delete store.requests[id];
    writeStore(store);
    return { approved: false, declined: true, reason: `the user picked "${text}", not "${request.accept}"` };
  }

  const grant = {
    requestId: id,
    code: request.code,
    fingerprint: request.fingerprint,
    plan: request.plan,
    session: request.session || session,
    host: host || request.host,
    channel: 'agent',
    approvedAt: new Date().toISOString(),
    expiresAt: Date.now() + GRANT_TTL_MS,
  };
  store.grants[request.fingerprint] = grant;
  delete store.requests[id];
  writeStore(store);
  return { approved: true, grant };
}

/**
 * Spend an approval code for this exact plan.
 *
 * A signed **write** approval also covers the matching `--dry-run` of the same statement (verifying the
 * blast radius is strictly weaker), and that trial run does not spend it: approve once, dry-run, then write.
 * A dry-run approval never covers a write.
 *
 * @returns {{ok:boolean, grant?:object, consumed?:boolean, reason?:string}}
 */
export function consumeGrant({ plan, code, session = '' } = {}) {
  const store = readStore();
  const wanted = String(code ?? '').trim().toUpperCase();
  const candidates = [fingerprintOf(plan)];
  if (plan?.mode === 'dry-run') candidates.push(fingerprintOf({ ...plan, mode: 'write' }));

  let mismatch = null;
  for (const fingerprint of candidates) {
    const grant = store.grants[fingerprint];
    if (!grant) continue;
    if (grant.expiresAt <= Date.now()) {
      delete store.grants[fingerprint];
      continue;
    }
    if (session && grant.session !== session) {
      mismatch = 'the credential belongs to another host session; ask the user again in this session';
      continue;
    }
    if (grant.code.toUpperCase() !== wanted) {
      mismatch = 'the approval code does not match';
      continue;
    }
    const keep = plan?.mode === 'dry-run' && grant.plan?.mode === 'write';
    if (!keep) delete store.grants[fingerprint];
    writeStore(store);
    return { ok: true, grant, consumed: !keep };
  }

  writeStore(store);
  return {
    ok: false,
    reason:
      mismatch ??
      'there is no valid credential for this operation (never issued, expired, already used, or the statement/connection changed)',
  };
}

/** Test/debug helper: is there any unexpired grant for this plan? */
export function hasGrant(plan, session = '') {
  const store = prune(readStore());
  return Object.values(store.grants).some(
    (grant) => grant.fingerprint === fingerprintOf(plan) && (!session || grant.session === session),
  );
}
