/**
 * The write-approval gate.
 *
 * Every statement that changes data or structure passes through `authorizeWrite` before it reaches a driver,
 * and there are exactly two ways through:
 *
 *   1. A signed approval: the command without `--approve` only **describes** the write and prints a
 *      confirmation card; the user confirms in the host dialog; `dbcli approve --id <requestId> --answer
 *      "同意执行"` signs a one-time credential; the command runs again with `--approve <code> --agent`.
 *   2. A human at a terminal: the card is printed and readline asks for `y`. There is no env var, no config
 *      key, and no flag that approves on the user's behalf.
 *
 * The plan (verb + mode + engine + connection + target + statement) is fingerprinted, so changing any of them
 * invalidates every earlier code. `--dry-run` needs approval too: on MySQL/Oracle-style engines DDL commits
 * implicitly and a rollback cannot undo it.
 */

import { ACCEPT_LABEL, consumeGrant, issueRequest } from './approval.mjs';
import { ApprovalError } from './errors.mjs';
import { buildCard, detectHost, hostName, hostSession } from './hosts.mjs';
import { targetText } from './connections.mjs';
import { truncate } from './output.mjs';

/**
 * Describe one write in a way that can be fingerprinted and shown to a human.
 * The statement is the exact text that will run (statement previews are for display only).
 */
export function buildPlan({ conn, mode, statement, verb, risks = [] }) {
  const text = String(statement ?? '');
  return {
    verb: String(verb || 'write').toLowerCase(),
    mode: mode === 'dry-run' ? 'dry-run' : 'write',
    engine: conn?.type ?? 'unknown',
    connection: conn?.name ?? '(unnamed)',
    target: conn ? targetText(conn) : '(unknown target)',
    statement: text.trim(),
    statementPreview: truncate(text.replace(/\s+/g, ' ').trim(), 240),
    risks: Array.isArray(risks) ? risks : [],
  };
}

/** Quote one argument for the copy-paste commands printed in the payload (thenRunArgs stays exact) */
function quoteArg(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/** `<node> "<skill>/bin/dbcli.mjs"` — the same interpreter that is running now, so the hint always works */
function cliPrefix() {
  const script = process.argv[1];
  if (!script) return 'dbcli';
  const executable = /^node(\.exe)?$/i.test(process.execPath.match(/[^\\/]+$/)?.[0] ?? '') ? 'node' : process.execPath;
  return `${quoteArg(executable)} ${quoteArg(script)}`;
}

export function commandText(args = []) {
  return `${cliPrefix()} ${args.map(quoteArg).join(' ')}`;
}function buildApprovalPayload({ plan, card, request, argv }) {
  const host = detectHost();
  const onApproveArgs = ['approve', '--id', request.requestId, '--answer', ACCEPT_LABEL];
  const thenRunArgs = [...argv, '--approve', request.code, '--agent'];
  return {
    status: 'approval_required',
    channel: 'agent',
    host: host.key,
    requestId: request.requestId,
    approvalCode: request.code,
    expiresAt: new Date(request.expiresAt).toISOString(),
    plan,
    card,
    next: {
      tool: host.tool,
      params: {
        questions: [{ id: 'dbcli-approval', header: card.header, question: card.question, options: card.options, multi_select: false }],
      },
      onApprove: commandText(onApproveArgs),
      onApproveArgs,
      thenRun: commandText(thenRunArgs),
      thenRunArgs,
    },
    note:
      'Nothing has been executed. Show the card to the user first; only after they pick 「同意执行」 run onApprove, ' +
      'then run again with --approve/--agent. A signed write approval also covers the matching --dry-run (and the ' +
      'trial run does not spend it).',
  };
}

/** Terminal confirmation: the only path that approves without a separate command */
async function confirmInTerminal(card) {
  process.stderr.write(`\n${card.header}\n${card.question}\n\n`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('  同意执行请输入 y，其它任意输入取消 [y/N] ');
    return new RegExp(`^(y|yes|${ACCEPT_LABEL})$`, 'i').test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Decide whether this write may run.
 *
 * @returns {Promise<
 *   | {ok:true, authorizedBy:'agent'|'code'|'prompt', grant?:object, consumed?:boolean}
 *   | {ok:false, approvalRequired:true, result:{approval:object}}
 *   | {ok:false, declined:true, result:{text:string, exitCode:number}}
 * >}
 */
export async function authorizeWrite({ plan, options = {}, isTty = false, argv = [] }) {
  const session = hostSession();
  const code = options.approve;

  if (code) {
    const result = consumeGrant({ plan, code, session });
    if (!result.ok) throw new ApprovalError(`Write not authorized: ${result.reason}.`);
    return { ok: true, authorizedBy: options.agent ? 'agent' : 'code', grant: result.grant, consumed: result.consumed };
  }

  const card = buildCard(plan);

  if (isTty && process.stdin.isTTY) {
    const approved = await confirmInTerminal(card);
    if (approved) return { ok: true, authorizedBy: 'prompt' };
    return {
      ok: false,
      declined: true,
      result: { text: 'Cancelled: nothing was executed.\n', exitCode: 7 },
    };
  }

  const request = issueRequest(plan, { session, host: hostName() });
  return { ok: false, approvalRequired: true, result: { approval: buildApprovalPayload({ plan, card, request, argv }) } };
}

/** Human-readable form of an approval request (the JSON form is what agents and pipes receive) */
export function approvalText(approval) {
  const lines = [
    'This operation changes the database and needs your confirmation before anything runs.',
    '',
    approval.card.header,
    approval.card.question,
    '',
    `  request : ${approval.requestId}`,
    `  code    : ${approval.approvalCode}   (valid until ${approval.expiresAt})`,
    `  approve : ${approval.next.onApprove}`,
    `  then    : ${approval.next.thenRun}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function renderApproval(approval, { format = 'auto', isTty = false } = {}) {
  const mode = format === 'auto' ? (isTty ? 'table' : 'json') : format;
  if (mode === 'json') return `${JSON.stringify(approval, null, 2)}\n`;
  return approvalText(approval);
}
