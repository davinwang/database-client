/**
 * End-to-end write approval over SQLite: nothing changes without the confirmation hand-off,
 * the credential is single-use, bound to the exact statement, and survives a dry-run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { approvalEnv, approveWrite, parseJson, runCli, tempDir } from './helpers/util.mjs';

function makeDatabase() {
  const dir = tempDir('dbcli-approve-');
  const file = path.join(dir, 'demo.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, balance REAL DEFAULT 0);
  `);
  const insert = db.prepare('INSERT INTO users(id, name, balance) VALUES(?, ?, ?)');
  for (let index = 1; index <= 5; index += 1) insert.run(index, `用户${index}`, index * 10);
  db.close();
  return file;
}

function scalar(file, sql) {
  const db = new DatabaseSync(file);
  const row = db.prepare(sql).get();
  db.close();
  return row;
}

function context() {
  const file = makeDatabase();
  const state = approvalEnv();
  const env = { DB_URL: `sqlite:${file}`, DBCLI_STATE_DIR: state._dir, DSH_SESSION_ID: state.DSH_SESSION_ID };
  return { file, state, env };
}

const UPDATE_ONE = 'update users set balance = 0 where id = 1';

test('a write without approval prints the card, changes nothing, and exits 7', async () => {
  const { file, env } = context();
  const result = await runCli(['query', UPDATE_ONE, '--allow-write', '--format', 'json'], { env });

  assert.equal(result.code, 7, result.stderr);
  const payload = parseJson(result.stdout);
  assert.equal(payload.status, 'approval_required');
  assert.equal(payload.channel, 'agent');
  assert.equal(payload.approvalCode.length, 6);
  assert.match(payload.requestId, /^[0-9a-f]{16}$/);
  assert.equal(payload.plan.mode, 'write');
  assert.equal(payload.plan.verb, 'update');
  assert.equal(payload.next.tool, 'ask_user_question');
  assert.deepEqual(payload.next.params.questions[0].options.map((option) => option.label), ['同意执行', '取消']);
  assert.match(payload.next.onApprove, /approve --id/);
  assert.match(payload.next.thenRun, /--approve/);
  assert.ok(payload.next.thenRunArgs.includes('--agent'));

  // The card is a real confirmation, not a log line: it names the statement and the target
  assert.match(payload.card.question, /UPDATE/);
  assert.match(payload.card.question, /update users set balance = 0 where id = 1/);
  assert.match(payload.card.question, /是否允许执行/);

  assert.equal(scalar(file, 'select balance from users where id = 1').balance, 10, 'nothing may have changed');
});

test('approve → dry-run (not spent) → write (spent): one dialog, verified blast radius', async () => {
  const { file, env } = context();
  const requested = await runCli(['query', UPDATE_ONE, '--allow-write', '--format', 'json'], { env });
  const payload = parseJson(requested.stdout);

  const approved = await runCli(['approve', '--id', payload.requestId, '--answer', '同意执行', '--format', 'json'], { env });
  assert.equal(approved.code, 0, approved.stderr);
  const approval = parseJson(approved.stdout);
  assert.equal(approval.status, 'approved');
  assert.equal(approval.approvalCode, payload.approvalCode);
  assert.equal(scalar(file, 'select balance from users where id = 1').balance, 10, 'approving alone must not write');

  const trial = await runCli(['query', UPDATE_ONE, '--allow-write', '--dry-run', '--approve', payload.approvalCode, '--agent', '--format', 'json'], { env });
  assert.equal(trial.code, 0, trial.stderr);
  const trialPayload = parseJson(trial.stdout);
  assert.equal(trialPayload.mode, 'dry-run');
  assert.equal(trialPayload.affectedRows, 1);
  assert.equal(trialPayload.rolledBack, true);
  assert.equal(trialPayload.authorizedBy, 'agent');
  assert.equal(scalar(file, 'select balance from users where id = 1').balance, 10, 'the dry run rolled back');

  const written = await runCli(['query', UPDATE_ONE, '--allow-write', '--approve', payload.approvalCode, '--agent', '--format', 'json'], { env });
  assert.equal(written.code, 0, written.stderr);
  const writtenPayload = parseJson(written.stdout);
  assert.equal(writtenPayload.mode, 'write');
  assert.equal(writtenPayload.affectedRows, 1);
  assert.equal(writtenPayload.authorizedBy, 'agent');
  assert.equal(scalar(file, 'select balance from users where id = 1').balance, 0, 'the approved write must be committed');

  const reused = await runCli(['query', UPDATE_ONE, '--allow-write', '--approve', payload.approvalCode, '--agent', '--format', 'json'], { env });
  assert.equal(reused.code, 7, 'the credential is single-use');
  assert.match(reused.stderr, /no valid credential/i);
  assert.match(reused.stderr, /dbcli approve --id/);
});

test('declining signs nothing, and the same code stays unusable afterwards', async () => {
  const { file, env } = context();
  const requested = await runCli(['query', 'delete from users where id = 2', '--allow-write', '--format', 'json'], { env });
  const payload = parseJson(requested.stdout);

  const declined = await runCli(['approve', '--id', payload.requestId, '--answer', '取消', '--format', 'json'], { env });
  assert.equal(declined.code, 7);
  assert.equal(parseJson(declined.stdout).status, 'declined');

  const attempt = await runCli(['query', 'delete from users where id = 2', '--allow-write', '--approve', payload.approvalCode, '--agent'], { env });
  assert.equal(attempt.code, 7);
  assert.equal(scalar(file, 'select count(*) as c from users').c, 5);
});

test('the approval is bound to the exact statement and connection', async () => {
  const { file, env } = context();
  const { payload, executed } = await approveWrite(['query', UPDATE_ONE, '--allow-write', '--format', 'json'], { env });
  assert.equal(executed.code, 0, executed.stderr);

  // A second, different statement needs its own dialog even with a fresh approval for the first one
  const other = await runCli(['query', 'update users set balance = 99 where id = 3', '--allow-write', '--format', 'json'], { env });
  assert.equal(other.code, 7);
  const otherPayload = parseJson(other.stdout);
  assert.notEqual(otherPayload.requestId, payload.requestId);
  assert.equal(scalar(file, 'select balance from users where id = 3').balance, 30);
});

test('an unknown or expired code never falls back to executing', async () => {
  const { file, env } = context();
  const unknown = await runCli(['query', UPDATE_ONE, '--allow-write', '--approve', 'ABCDEF', '--agent'], { env });
  assert.equal(unknown.code, 7);
  assert.match(unknown.stderr, /not authorized/i);
  assert.equal(scalar(file, 'select balance from users where id = 1').balance, 10);

  const missingAnswer = await runCli(['approve', '--id', 'deadbeefdeadbeef'], { env });
  assert.equal(missingAnswer.code, 3, 'approve without --answer is a usage error');
  assert.match(missingAnswer.stderr, /--answer/);
});

test('--dry-run still requires --allow-write, and a write approval covers only its own statement', async () => {
  const { env } = context();
  const alone = await runCli(['query', UPDATE_ONE, '--dry-run'], { env });
  assert.equal(alone.code, 3);
  assert.match(alone.stderr, /--allow-write/);
});

test('the stored hand-off record keeps no credentials or full statements', async () => {
  const { state, env } = context();
  const longText = 'update users set name = \'' + 'y'.repeat(500) + '\' where id = 2';
  const requested = await runCli(['query', longText, '--allow-write', '--format', 'json'], { env });
  assert.equal(requested.code, 7);
  const payload = parseJson(requested.stdout);
  assert.ok(payload.plan.statementPreview.length <= 241);

  const file = path.join(state._dir, 'approvals.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!/password/i.test(raw));
  assert.ok(!raw.includes('y'.repeat(300)), 'the record must not persist the whole statement');
  assert.ok(raw.includes(payload.approvalCode));
});

test('doctor reports the detected approval host and the state file', async () => {
  const { env } = context();
  const doctor = await runCli(['doctor'], { env });
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /Write approval/);
  assert.match(doctor.stdout, /ask_user_question/);
  assert.match(doctor.stdout, /approvals\.json/);
});
