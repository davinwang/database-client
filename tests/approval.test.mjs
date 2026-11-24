/**
 * The approval layer, offline: fingerprints, one-time codes, expiry, session binding and
 * the "a write approval also covers the matching dry-run" rule. No database, no network.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { approvalEnv } from './helpers/util.mjs';

const state = approvalEnv();
process.env.DBCLI_STATE_DIR = state._dir;
process.env.DBCLI_APPROVE_TTL_MS = '80';
process.env.DBCLI_GRANT_TTL_MS = '5000';

// `npm run test:sandbox` shares one process across files: do not leave the shortened TTLs behind
after(() => {
  delete process.env.DBCLI_APPROVE_TTL_MS;
  delete process.env.DBCLI_GRANT_TTL_MS;
});

const {
  ACCEPT_LABEL,
  APPROVE_TTL_MS,
  consumeGrant,
  fingerprintOf,
  issueRequest,
  listRequests,
  peekRequest,
  signGrant,
  storeFile,
} = await import('../lib/approval.mjs');
const { buildCard } = await import('../lib/hosts.mjs');

const SESSION = 'session-a';
const PLAN = {
  verb: 'update',
  mode: 'write',
  engine: 'mysql',
  connection: 'erp',
  target: 'mysql://app@10.0.0.5:3306/erp',
  statement: "update orders set status='X' where id = 1",
};

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('fingerprint: stable for the same plan, different for any changed part', () => {
  assert.equal(fingerprintOf(PLAN), fingerprintOf({ ...PLAN, statement: `  ${PLAN.statement}  ` }));
  assert.notEqual(fingerprintOf(PLAN), fingerprintOf({ ...PLAN, statement: 'update orders set status=1' }));
  assert.notEqual(fingerprintOf(PLAN), fingerprintOf({ ...PLAN, mode: 'dry-run' }));
  assert.notEqual(fingerprintOf(PLAN), fingerprintOf({ ...PLAN, connection: 'log' }));
  assert.notEqual(fingerprintOf(PLAN), fingerprintOf({ ...PLAN, target: 'mysql://app@10.0.0.6:3306/erp' }));
  assert.notEqual(fingerprintOf(PLAN), fingerprintOf({ ...PLAN, verb: 'delete' }));
});

test('request → approve → single-use credential (code is case-insensitive)', () => {
  const request = issueRequest(PLAN, { session: SESSION, host: 'dsh' });
  assert.equal(request.code.length, 6);
  assert.equal(request.requestId, fingerprintOf(PLAN));
  assert.equal(peekRequest(request.requestId).code, request.code);

  const signed = signGrant(request.requestId, { answer: ACCEPT_LABEL, session: SESSION, host: 'dsh' });
  assert.equal(signed.approved, true);
  assert.equal(peekRequest(request.requestId), null, 'the request is spent once signed');

  const first = consumeGrant({ plan: PLAN, code: request.code.toLowerCase(), session: SESSION });
  assert.equal(first.ok, true);
  assert.equal(first.consumed, true);

  const second = consumeGrant({ plan: PLAN, code: request.code, session: SESSION });
  assert.equal(second.ok, false);
  assert.match(second.reason, /no valid credential|expired|used/);
});

test('a wrong code is rejected and does not spend the approval', () => {
  const request = issueRequest(PLAN, { session: SESSION });
  signGrant(request.requestId, { answer: ACCEPT_LABEL, session: SESSION });
  const bad = consumeGrant({ plan: PLAN, code: 'ZZZZZZ', session: SESSION });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /does not match/);
  assert.equal(consumeGrant({ plan: PLAN, code: request.code, session: SESSION }).ok, true, 'the correct code still works');
});

test('any change to the plan invalidates the code', () => {
  const request = issueRequest(PLAN, { session: SESSION });
  signGrant(request.requestId, { answer: ACCEPT_LABEL, session: SESSION });
  const other = consumeGrant({ plan: { ...PLAN, statement: "update orders set status='Y' where id = 1" }, code: request.code, session: SESSION });
  assert.equal(other.ok, false);
  assert.equal(consumeGrant({ plan: PLAN, code: request.code, session: SESSION }).ok, true);
});

test('a grant is bound to the host session that asked', () => {
  const request = issueRequest(PLAN, { session: SESSION });
  signGrant(request.requestId, { answer: ACCEPT_LABEL, session: SESSION });
  const foreign = consumeGrant({ plan: PLAN, code: request.code, session: 'session-b' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /another host session/);
  assert.equal(consumeGrant({ plan: PLAN, code: request.code, session: SESSION }).ok, true);
});

test('an empty or negative answer never signs anything', () => {
  const request = issueRequest(PLAN, { session: SESSION });
  const silent = signGrant(request.requestId, { answer: '', session: SESSION });
  assert.equal(silent.approved, false);
  assert.match(silent.reason, /explicit answer/);
  const declined = signGrant(request.requestId, { answer: '取消', session: SESSION });
  assert.equal(declined.approved, false);
  assert.equal(declined.declined, true);
  // the request is void after a decline: no second chance with the same card
  assert.equal(peekRequest(request.requestId), null);
  assert.equal(consumeGrant({ plan: PLAN, code: request.code, session: SESSION }).ok, false);
});

test('an expired request cannot be signed', () => {
  const request = issueRequest(PLAN, { session: SESSION });
  pause(APPROVE_TTL_MS + 40);
  const late = signGrant(request.requestId, { answer: ACCEPT_LABEL, session: SESSION });
  assert.equal(late.approved, false);
  assert.match(late.reason, /expired/);
  assert.equal(listRequests().some((item) => item.requestId === request.requestId), false);
});

test('a signed write approval also covers --dry-run, and the trial run does not spend it', () => {
  const writePlan = { ...PLAN, statement: 'update orders set status=2 where id = 9' };
  const request = issueRequest(writePlan, { session: SESSION });
  signGrant(request.requestId, { answer: ACCEPT_LABEL, session: SESSION });

  const trial = consumeGrant({ plan: { ...writePlan, mode: 'dry-run' }, code: request.code, session: SESSION });
  assert.equal(trial.ok, true);
  assert.equal(trial.consumed, false, 'the dry-run must keep the write approval');

  const real = consumeGrant({ plan: writePlan, code: request.code, session: SESSION });
  assert.equal(real.ok, true);
  assert.equal(real.consumed, true);
});

test('a dry-run approval never covers the real write', () => {
  const trialPlan = { ...PLAN, statement: 'update orders set status=3 where id = 9', mode: 'dry-run' };
  const request = issueRequest(trialPlan, { session: SESSION });
  signGrant(request.requestId, { answer: ACCEPT_LABEL, session: SESSION });
  const real = consumeGrant({ plan: { ...trialPlan, mode: 'write' }, code: request.code, session: SESSION });
  assert.equal(real.ok, false);
  assert.equal(consumeGrant({ plan: trialPlan, code: request.code, session: SESSION }).ok, true);
});

test('the stored record holds a fingerprint and a preview, never credentials', () => {
  const longSql = `update orders set note='${'x'.repeat(600)}' where id = 1`;
  const plan = { ...PLAN, statement: longSql, target: 'mysql://app@10.0.0.5:3306/erp' };
  const request = issueRequest(plan, { session: 'store-check', host: 'dsh' });
  assert.ok(request.plan.statementPreview.length <= 401);
  assert.equal(request.plan.statement, undefined, 'the full statement is not persisted');

  const raw = fs.readFileSync(storeFile(), 'utf8');
  assert.ok(!/password/i.test(raw));
  assert.ok(!raw.includes('x'.repeat(420)), 'the record must not keep the whole statement');
  assert.ok(raw.includes(request.code));
});

test('the card states what is being approved and offers exactly two options', () => {
  const card = buildCard({ ...PLAN, statementPreview: PLAN.statement, risks: ['没有 WHERE 条件，可能影响整表所有行'] });
  assert.equal(card.header, '数据库写操作授权');
  assert.match(card.question, /UPDATE/);
  assert.match(card.question, /erp/);
  assert.match(card.question, /没有 WHERE/);
  assert.match(card.question, /是否允许执行/);
  assert.deepEqual(card.options.map((option) => option.label), ['同意执行', '取消']);
  assert.equal(card.multi_select, false);
});
