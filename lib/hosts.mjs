/**
 * Agent-host compatibility for the confirmation dialog.
 *
 * The CLI cannot open a dialog itself: it can only print the request (a card plus a one-time code). The
 * agent turns that into its host's interactive confirmation tool, and the CLI verifies the outcome in a
 * separate step (`dbcli approve`). This module answers two questions: *who is running me* and *what does
 * the card look like*.
 *
 * Honest boundary: the agent and the CLI share one shell, so a malicious agent could in principle read the
 * approval record and replay it. What is guaranteed is "nothing is silent by default, and every write can be
 * traced back to a request id, a host, and a channel".
 */

import { ACCEPT_LABEL, DECLINE_LABEL } from './approval.mjs';

export const HOSTS = {
  dsh: {
    name: 'DSH',
    tool: 'ask_user_question',
    detect: () => Boolean(process.env.DSH_SESSION_ID),
    sessionEnv: 'DSH_SESSION_ID',
    params: 'questions[{ id, header, question, options[{label,description}], multi_select }]',
    note: 'native support: the card fields match the tool arguments, so next.params can be passed as-is',
  },
  claude: {
    name: 'Claude Code',
    tool: 'AskUserQuestion',
    detect: () => Boolean(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.ANTHROPIC_CLI),
    sessionEnv: null,
    params: 'questions[{ question, header, options[{label,description}], multiSelect }]',
    note: 'PascalCase tool name; same shape but multiSelect is camelCase; no session variable, so the session falls back to user@host',
  },
  codex: {
    name: 'Codex CLI',
    tool: '(approval mode, no question tool)',
    detect: () => Boolean(process.env.CODEX_SANDBOX || process.env.CODEX_HOME || process.env.OPENAI_CODEX),
    sessionEnv: null,
    params: 'no ask-user tool: let the user approve the command itself, then run dbcli approve',
    note: 'no open-ended question tool; show the request verbatim, and only after an explicit "yes" run dbcli approve',
  },
  workbuddy: {
    name: 'WorkBuddy',
    tool: 'AskUserQuestion',
    detect: () => Boolean(process.env.WORKBUDDY || process.env.WB_SESSION_ID),
    sessionEnv: 'WB_SESSION_ID',
    params: 'question + options (at most 4 options per question)',
    note: 'same option-style design; map question/options onto the tool arguments',
  },
  generic: {
    name: 'generic / unknown host',
    tool: '(text confirmation)',
    detect: () => true,
    sessionEnv: null,
    params: 'show the request in the conversation and wait for an explicit reply',
    note: 'fallback: relay the request verbatim and execute only after a clear yes',
  },
};

const HOST_ORDER = ['dsh', 'claude', 'codex', 'workbuddy'];

export function detectHost() {
  for (const key of HOST_ORDER) {
    if (HOSTS[key].detect()) return { key, ...HOSTS[key] };
  }
  return { key: 'generic', ...HOSTS.generic };
}

export function hostName() {
  return detectHost().key;
}

/**
 * Session marker a grant is bound to. DSH/WorkBuddy expose a real session id; other hosts degrade to a
 * per-machine marker, which still means "the same agent shell that asked is the one that runs".
 */
export function hostSession() {
  return process.env.DSH_SESSION_ID || process.env.AGENT_SESSION_ID || process.env.WB_SESSION_ID || fallbackSession();
}

export function fallbackSession() {
  const user = process.env.USERNAME || process.env.USER || 'user';
  const host = process.env.COMPUTERNAME || process.env.HOSTNAME || 'host';
  return `local:${user}@${host}`;
}

function impactText(plan) {
  const risks = Array.isArray(plan.risks) ? plan.risks.filter(Boolean) : [];
  if (risks.length) return risks.join('；');
  if (plan.mode === 'dry-run') return '执行后回滚，不保留修改（但仍会取锁、触发触发器）';
  return '影响行数未知，建议先加 --dry-run 预演确认行数';
}

/**
 * The confirmation card. Chinese on purpose: this text is read by the person who approves, and it is the
 * exact wording that SKILL.md tells the agent to relay. The accepted label (同意执行) must be passed
 * verbatim to `dbcli approve --answer`.
 * @param {{verb?:string, mode?:string, connection?:string, engine?:string, target?:string, statementPreview?:string, risks?:string[]}} plan
 */
export function buildCard(plan = {}) {
  const modeLabel = plan.mode === 'dry-run' ? 'dry-run 预演后回滚' : 'write 真实提交';
  return {
    header: '数据库写操作授权',
    question: [
      'Agent 要执行一条会修改数据库的语句，请确认：',
      `动作：${String(plan.verb || 'write').toUpperCase()}（${modeLabel}）`,
      `位置：${plan.connection || '(未命名连接)'}（${plan.engine || 'unknown'}）· ${plan.target || '(目标未知)'}`,
      `影响：${impactText(plan)}`,
      `语句：${plan.statementPreview || '(空)'}`,
      '',
      '是否允许执行？',
    ].join('\n'),
    options: [
      { label: ACCEPT_LABEL, description: '只执行这一次；语句、连接或模式变化都需要重新授权' },
      { label: DECLINE_LABEL, description: '不执行，数据保持原样' },
    ],
    multi_select: false,
  };
}

/** One-line host report for `dbcli doctor` */
export function hostSummary() {
  const host = detectHost();
  return { host: host.key, name: host.name, tool: host.tool, session: hostSession(), sessionEnv: host.sessionEnv };
}
