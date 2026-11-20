/**
 * Driver registry and lazy loading.
 *
 * Design notes:
 * - **Runs with zero dependencies**: SQLite / Redis / ClickHouse / Elasticsearch use Node built-ins or HTTP and work out of the box;
 * - MySQL / PostgreSQL / Oracle / SQL Server / MongoDB need npm drivers, **installed on demand**
 *   (`dbcli drivers install mysql`); when missing, a ready-to-copy install command is printed;
 * - Packages are resolved from both the "skill directory" and the "current project directory": if the project already has mysql2/pg, it is reused instead of reinstalled.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UnsupportedError } from '../errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, '..', '..');

export const DRIVERS = {
  mysql: { key: 'mysql', packageName: 'mysql2', module: './mysql.mjs', label: 'MySQL / MariaDB / TiDB / TDSQL / PolarDB / GoldenDB' },
  oceanbase: { key: 'oceanbase', packageName: 'mysql2', module: './mysql.mjs', label: 'OceanBase (MySQL protocol; dialect=oracle uses the Oracle dialect)' },
  postgres: { key: 'postgres', packageName: 'pg', module: './postgres.mjs', label: 'PostgreSQL / Kingbase / Vastbase / GaussDB / openGauss' },
  oracle: { key: 'oracle', packageName: 'oracledb', module: './oracle.mjs', label: 'Oracle' },
  dameng: { key: 'dameng', packageName: 'dmdb', module: './dameng.mjs', label: 'Dameng DM8 (requires the official dmdb driver)' },
  sqlserver: { key: 'sqlserver', packageName: 'mssql', module: './sqlserver.mjs', label: 'SQL Server' },
  mongodb: { key: 'mongodb', packageName: 'mongodb', module: './mongodb.mjs', label: 'MongoDB' },
  kafka: { key: 'kafka', packageName: 'kafkajs', module: './kafka.mjs', label: 'Kafka / Redpanda' },
  redis: { key: 'redis', packageName: null, module: './redis.mjs', label: 'Redis', builtin: 'Node net/tls (custom RESP)' },
  sqlite: { key: 'sqlite', packageName: null, module: './sqlite.mjs', label: 'SQLite', builtin: 'node:sqlite (Node >= 22.13)' },
  clickhouse: { key: 'clickhouse', packageName: null, module: './clickhouse.mjs', label: 'ClickHouse', builtin: 'HTTP interface' },
  elasticsearch: { key: 'elasticsearch', packageName: null, module: './elasticsearch.mjs', label: 'Elasticsearch', builtin: 'HTTP interface' },
};

export class DriverMissingError extends Error {
  constructor(spec) {
    const bin = path.join(SKILL_DIR, 'bin', 'dbcli.mjs');
    super(`Missing the ${spec.label} driver (npm package ${spec.packageName} is not installed)`);
    this.name = 'DriverMissingError';
    this.exitCode = 5;
    if (spec.packageName === 'dmdb') {
      this.hint = [
        'The official Dameng Node driver is not on public npm; get it from the DM8 installation media:',
        '  1) Locate <DM_HOME>/drivers/nodejs/dmdb-*.tgz (shipped with the DM administration tools)',
        '  2) Set DB_DM_DRIVER_TGZ=<absolute path to that tgz>, then run:',
        `     node "${bin}" drivers install dameng`,
        '  3) Or install dmdb straight into the project: npm i <DM_HOME>/drivers/nodejs/dmdb-*.tgz (the CLI prefers project dependencies)',
        'Note: dmdb is a native addon; on Windows it needs a prebuilt package matching your Node version (ask your DBA/Dameng support).',
      ].join('\n');
      return;
    }
    this.hint = [
      `Install: node "${bin}" drivers install ${spec.key}`,
      `  Or: run \`npm i -D ${spec.packageName}\` in the project root (the CLI prefers project dependencies)`,
      '  Or: point DB_DRIVER_DIR at a custom directory that already has this package installed.',
      'After installing, confirm with `dbcli drivers`, then verify connectivity with `dbcli doctor`.',
    ].join('\n');
  }
}

export function driverRoots() {
  const roots = [process.env.DB_DRIVER_DIR, process.env.DB_HOME, SKILL_DIR, process.cwd()];
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** Where drivers get installed: the skill directory by default; point DB_DRIVER_DIR elsewhere when the skill directory is read-only */
export function driverInstallDir() {
  return path.resolve(process.env.DB_DRIVER_DIR || SKILL_DIR);
}

/**
 * Remove on-demand drivers (restores the skill to a small footprint for hand-off/machine moves).
 *
 * `DB_DRIVER_DIR` may point at a project so its existing node_modules can be reused; cleaning
 * that directory would delete the project's dependencies, so it requires an explicit `force`
 * and never removes package-lock files outside the skill directory.
 */
export async function cleanDrivers({ force = false } = {}) {
  const fs = await import('node:fs/promises');
  const dir = driverInstallDir();
  const isSkillDir = path.resolve(dir) === path.resolve(SKILL_DIR);
  if (!isSkillDir && !force) return { dir, removed: [], refused: true };

  const targets = isSkillDir
    ? ['node_modules', '.npm-cache', 'package-lock.json', '.package-lock.json']
    : ['node_modules', '.npm-cache'];
  const removed = [];
  for (const target of targets) {
    const full = path.join(dir, target);
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      /* Ignore if it does not exist */
    }
  }
  return { dir, removed, refused: false };
}

/** Resolve a package through the candidate directories/node_modules chain; returns the absolute entry file path */
export function resolvePackage(pkg, roots = driverRoots()) {
  for (const root of roots) {
    try {
      const require = createRequire(path.join(root, '__dbcli_resolve__.cjs'));
      return require.resolve(pkg);
    } catch {
      /* Try the next directory */
    }
  }
  return null;
}

export async function loadPackage(pkg, roots = driverRoots()) {
  const entry = resolvePackage(pkg, roots);
  if (!entry) throw new Error(`Cannot find package ${pkg}`);
  return await import(pathToFileURL(entry).href);
}

export function driverStatus() {
  const roots = driverRoots();
  return Object.values(DRIVERS).map((spec) => {
    const entry = spec.packageName ? resolvePackage(spec.packageName, roots) : null;
    return {
      key: spec.key,
      label: spec.label,
      packageName: spec.packageName,
      builtin: spec.builtin ?? null,
      installed: spec.packageName ? Boolean(entry) : true,
      entry,
    };
  });
}

/** Create a driver instance. conn = connection object, options = {timeoutMs, allowWrite, insecureTls, limit} */
export async function createDriver(conn, options = {}) {
  const spec = DRIVERS[conn.type];
  if (!spec) {
    throw new UnsupportedError(
      `${conn.type} databases are not supported yet. Supported: MySQL, PostgreSQL, Oracle, SQL Server, SQLite, MongoDB, Redis, ClickHouse, Elasticsearch.`,
      { hint: 'For Dameng (DM)/DB2, export CSV or troubleshoot with the vendor client; for Kingbase/GaussDB set TYPE to postgres (protocol compatible).' },
    );
  }
  const roots = options.roots ?? driverRoots();
  if (spec.packageName && !resolvePackage(spec.packageName, roots)) throw new DriverMissingError(spec);

  let module;
  try {
    module = await import(new URL(spec.module, import.meta.url));
  } catch (error) {
    if (/node:sqlite/.test(String(error?.message)) || error?.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      throw new UnsupportedError('The SQLite driver relies on Node built-in node:sqlite (Node >= 22.13)', {
        hint: `Current Node is ${process.version}. Upgrade Node to use it, or use the sqlite3 CLI.`,
      });
    }
    throw error;
  }

  return module.create(conn, {
    ...options,
    roots,
    loadPackage: (pkg) => loadPackage(pkg, roots),
  });
}

/** Run npm install to install drivers; returns the exit code */
export async function installDrivers(keys, { registry, log = console.log } = {}) {
  const { spawn } = await import('node:child_process');
  const installAll = keys.includes('all');
  const nodes = installAll
    ? Object.values(DRIVERS).filter((spec) => spec.packageName && spec.packageName !== 'dmdb')
    : keys.map((key) => DRIVERS[key]).filter((spec) => spec?.packageName);

  if (!nodes.length) {
    const known = Object.values(DRIVERS)
      .filter((spec) => spec.packageName && spec.packageName !== 'dmdb')
      .map((spec) => spec.key)
      .join(' / ');
    throw new Error(`No drivers to install. Installable: ${known}, or all; the Dameng dmdb driver must be installed separately via DB_DM_DRIVER_TGZ`);
  }

  const packages = nodes.map((spec) => spec.packageName);
  if (packages.includes('dmdb')) {
    const tarball = process.env.DB_DM_DRIVER_TGZ;
    if (!tarball) {
      throw new Error(
        [
          'The Dameng dmdb driver is not on public npm, so npm install cannot fetch it directly.',
          'Find drivers/nodejs/dmdb-*.tgz in the DM8 installation directory, then:',
          '  set DB_DM_DRIVER_TGZ=<absolute path to the tgz>   # PowerShell: $env:DB_DM_DRIVER_TGZ="..."',
          `  node "${path.join(SKILL_DIR, 'bin', 'dbcli.mjs')}" drivers install dameng`,
        ].join('\n'),
      );
    }
    const at = packages.indexOf('dmdb');
    packages[at] = tarball;
  }
  const cacheDir = path.join(SKILL_DIR, '.npm-cache');
  const prefix = driverInstallDir();
  const args = [
    'install',
    '--prefix',
    prefix,
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--cache',
    cacheDir,
    ...(registry ? ['--registry', registry] : []),
    ...packages,
  ];
  log(`Installing ${packages.join(' ')} → ${prefix}`);
  log(`(installed on demand; the skill itself ships no drivers; behind a restricted network add --registry https://registry.npmmirror.com)`);

  return await new Promise((resolve) => {
    // On Windows, spawn('npm.cmd') must go through a shell, but shell + args warns on Node 24 and is easily broken by quoting;
    // so prefer calling npm's JS entry directly (same node process, no shell).
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    let hasNpmCli = false;
    try {
      hasNpmCli = existsSync(npmCli);
    } catch {
      hasNpmCli = false;
    }
    const child = hasNpmCli
      ? spawn(process.execPath, [npmCli, ...args], { cwd: SKILL_DIR, stdio: 'inherit' })
      : spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          cwd: SKILL_DIR,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
    child.on('error', (error) => {
      log(`Failed to start npm: ${error.message}`);
      resolve(1);
    });
    child.on('exit', async (code) => {
      if ((code ?? 1) === 0) {
        // npm can report success while the packages are not resolvable from the
        // install directory (read-only or ephemeral skill directory, npm prefix
        // ignored). Verify before claiming success.
        const missing = nodes.filter((spec) => !resolvePackage(spec.packageName, [prefix]));
        if (missing.length) {
          log(`npm exited 0 but these packages are not resolvable under ${prefix}: ${missing.map((spec) => spec.packageName).join(', ')}`);
          log('The install directory may be read-only or reset after the command. Set DB_DRIVER_DIR to a persistent writable directory and retry.');
          try {
            const fs = await import('node:fs/promises');
            await fs.rm(cacheDir, { recursive: true, force: true });
          } catch {
            /* Ignore */
          }
          resolve(1);
          return;
        }
        log(`Verified: ${nodes.map((spec) => spec.packageName).join(', ')} resolvable from ${prefix}`);
        // Clean up the npm cache afterwards so the skill directory does not grow
        try {
          const fs = await import('node:fs/promises');
          await fs.rm(cacheDir, { recursive: true, force: true });
        } catch {
          /* Ignore */
        }
      }
      resolve(code ?? 1);
    });
  });
}
