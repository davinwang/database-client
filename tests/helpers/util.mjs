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
