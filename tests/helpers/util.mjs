/** Test helpers: temp directories, CLI subprocess runs, mock servers. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = path.join(ROOT, 'bin', 'dbcli.mjs');

export function tempDir(prefix = 'dbcli-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/** Run the CLI and return {code, stdout, stderr}; env is merged over process.env (inherited DB_* vars are stripped by default).
 *  1) Async: mock servers run in the same process, so a synchronous spawn would block the event loop;
 *  2) Output goes to files instead of pipes: some sandboxes (DSH) forbid named pipes for child processes (spawn EPERM). */
export function runCli(args, { cwd = ROOT, env = {}, stripDbEnv = true } = {}) {
  const baseEnv = { ...process.env };
  if (stripDbEnv) {
    for (const key of Object.keys(baseEnv)) {
      if (/^(DB_|DATABASE_|MYSQL_|PG|POSTGRES_|ORACLE_|REDIS_|MONGO|MONGODB_|CLICKHOUSE_|ELASTIC|ES_|SQLSERVER|MSSQL_|SQLITE_|SPRING_DATASOURCE|SPRING_DATA_|JDBC_)/i.test(key)) delete baseEnv[key];
    }
  }
  // Short TTLs set by the approval unit tests must not leak into subprocess runs (all test files share one process)
  delete baseEnv.DBCLI_APPROVE_TTL_MS;
  delete baseEnv.DBCLI_GRANT_TTL_MS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbcli-run-'));
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', outFd, errFd],
    });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', () => {
      clearTimeout(timer);
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({ code: -1, stdout: '', stderr: 'spawn failed' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code: code ?? -1, stdout, stderr, signal });
    });
  });
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Per-test approval hand-off directory + a fixed host session (so grants cannot leak between tests) */
export function approvalEnv({ session = 'test-session' } = {}) {
  const dir = tempDir('dbcli-approval-state-');
  return { DBCLI_STATE_DIR: dir, DSH_SESSION_ID: session, _dir: dir };
}

/**
 * Run a write through the full approval flow:
 * request (no --approve) → `approve --id ... --answer ...` → rerun with --approve/--agent.
 * Returns every step so a test can assert on the intermediate payload too.
 */
export async function approveWrite(args, { env = {}, cwd = ROOT, accept = '同意执行' } = {}) {
  const requested = await runCli(args, { env, cwd });
  const payload = parseJson(requested.stdout);
  if (!payload || payload.status !== 'approval_required') return { requested, payload, approved: null, executed: null };
  const approved = await runCli(['approve', '--id', payload.requestId, '--answer', accept, '--format', 'json'], { env, cwd });
  const executed = await runCli([...args, '--approve', payload.approvalCode, '--agent'], { env, cwd });
  return { requested, payload, approved, executed };
}
