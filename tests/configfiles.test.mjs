import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discover } from '../lib/discover.mjs';
import { buildConnections } from '../lib/connections.mjs';
import { extractConfigConnections, listConfigFiles, parseAdoConnectionString } from '../lib/configfiles.mjs';
import { tempDir, writeFile } from './helpers/util.mjs';

async function projectWith(files) {
  const dir = tempDir('dbcli-config-');
  writeFile(dir, 'package.json', '{}');
  for (const [name, content] of Object.entries(files)) writeFile(dir, name, content);
  const discovered = await discover({ cwd: dir, processEnv: {} });
  const built = buildConnections(discovered.varMap, { extra: discovered.extra, warnings: discovered.warnings });
  return { dir, discovered, ...built };
}

test('.NET appsettings.json: ConnectionStrings become dotnet-<name> connections', async () => {
  const { connections } = await projectWith({
    'appsettings.json': JSON.stringify({
      ConnectionStrings: {
        Default: 'Server=db.internal;Database=app;User Id=sa;Password=s3cret;',
      },
    }),
  });
  const conn = connections.find((item) => item.name === 'dotnet-default');
  assert.ok(conn, connections.map((item) => item.name).join(','));
  assert.equal(conn.type, 'sqlserver');
  assert.equal(conn.host, 'db.internal');
  assert.equal(conn.user, 'sa');
  assert.equal(conn.database, 'app');
  assert.equal(conn.password, 's3cret');
});

test('.NET appsettings: Host=... uses the PostgreSQL wire protocol', async () => {
  const { connections } = await projectWith({
    'appsettings.Production.json': JSON.stringify({
      ConnectionStrings: { Reports: 'Host=pg.internal;Port=5433;Database=dw;Username=report;Password=pw;' },
    }),
  });
  const conn = connections.find((item) => item.name === 'dotnet-reports');
  assert.ok(conn);
  assert.equal(conn.type, 'postgres');
  assert.equal(conn.port, 5433);
});

test('Node ormconfig.json: connection-shaped objects are picked up', async () => {
  const { connections } = await projectWith({
    'ormconfig.json': JSON.stringify([
      { type: 'postgres', host: 'pg', port: 5432, username: 'app', password: 'pw', database: 'app' },
      { type: 'mysql', host: 'mysql', username: 'root', password: 'root', database: 'shop' },
    ]),
  });
  const types = connections.map((item) => item.type).sort();
  assert.deepEqual(types, ['mysql', 'postgres']);
});

test('Ruby/Rails database.yml: environments become rails-<env> connections', async () => {
  const { connections } = await projectWith({
    'config/database.yml': [
      'default: &default',
      '  adapter: postgresql',
      '  encoding: unicode',
      'development:',
      '  <<: *default',
      '  host: pg.local',
      '  database: app_dev',
      '  username: app',
      '  password: app_pw',
      '',
    ].join('\n'),
  });
  const conn = connections.find((item) => item.name === 'rails-development');
  assert.ok(conn, connections.map((item) => item.name).join(','));
  assert.equal(conn.type, 'postgres');
  assert.equal(conn.host, 'pg.local');
  assert.equal(conn.database, 'app_dev');
});

test('INI files: a sqlalchemy.url value is discovered', async () => {
  const { connections } = await projectWith({
    'alembic.ini': ['[alembic]', 'sqlalchemy.url = postgresql://app:pw@pg:5432/app', ''].join('\n'),
  });
  const conn = connections.find((item) => item.type === 'postgres');
  assert.ok(conn, connections.map((item) => `${item.name}:${item.type}`).join(','));
  assert.equal(conn.host, 'pg');
});

test('non-database URLs and unresolved placeholders are ignored', async () => {
  const { connections } = await projectWith({
    'config.json': JSON.stringify({
      homepage: 'https://example.com',
      database: 'postgres://app:pw@pg:5432/app',
      broken: '${DATABASE_URL}',
    }),
  });
  assert.equal(connections.filter((item) => item.type === 'postgres').length, 1);
});

test('parseAdoConnectionString handles URL-style values and ports', () => {
  const fromUrl = parseAdoConnectionString('postgres://app:pw@pg:5432/app');
  assert.equal(fromUrl.type, 'postgres');
  assert.equal(fromUrl.host, 'pg');
  const adoSql = parseAdoConnectionString('Server=tcp:sql.internal,1435;Initial Catalog=core;User Id=sa;Password=pw;');
  assert.equal(adoSql.type, 'sqlserver');
  assert.equal(adoSql.port, 1435);
  assert.equal(adoSql.database, 'core');
  assert.equal(adoSql.user, 'sa');
});

test('appsettings with a UTF-8 BOM is still parsed', async () => {
  const dir = tempDir('dbcli-bom-');
  writeFile(dir, 'package.json', '{}');
  const body = JSON.stringify({ ConnectionStrings: { Default: 'Server=bomdb;Database=app;User Id=sa;Password=pw;' } });
  fs.writeFileSync(path.join(dir, 'appsettings.json'), `\uFEFF${body}`, 'utf8');
  const discovered = await discover({ cwd: dir, processEnv: {} });
  const { connections, warnings } = buildConnections(discovered.varMap, { extra: discovered.extra, warnings: discovered.warnings });
  assert.equal(warnings.filter((item) => /parse failed/.test(item)).length, 0, warnings.join('\n'));
  const conn = connections.find((item) => item.name === 'dotnet-default');
  assert.ok(conn);
  assert.equal(conn.host, 'bomdb');
});

test('appsettings.<Environment>.json overrides appsettings.json', async () => {
  const dir = tempDir('dbcli-appsettings-override-');
  writeFile(dir, 'package.json', '{}');
  writeFile(dir, 'appsettings.json', JSON.stringify({ ConnectionStrings: { Default: 'Server=base;Database=app;User Id=sa;Password=pw;' } }));
  writeFile(
    dir,
    'appsettings.Development.json',
    JSON.stringify({ ConnectionStrings: { Default: 'Server=devdb;Database=app;User Id=sa;Password=pw;' } }),
  );
  const discovered = await discover({ cwd: dir, processEnv: {} });
  const { connections } = buildConnections(discovered.varMap, { extra: discovered.extra, warnings: discovered.warnings });
  const dotnet = connections.filter((item) => item.name.startsWith('dotnet-default'));
  assert.equal(dotnet.length, 1, dotnet.map((item) => `${item.name}:${item.host}`).join(','));
  assert.equal(dotnet[0].host, 'devdb');
});

test('listConfigFiles finds adapters without scanning unrelated files', async () => {
  const dir = tempDir('dbcli-config-list-');
  writeFile(dir, 'package.json', '{}');
  writeFile(dir, 'appsettings.json', '{}');
  writeFile(dir, 'config/database.yml', 'development:\n  adapter: sqlite3\n  database: db/development.sqlite3\n');
  const found = await listConfigFiles({ cwd: dir, projectRoot: dir });
  assert.ok(found.some((file) => file.endsWith('appsettings.json')));
  assert.ok(found.some((file) => file.endsWith(path.join('config', 'database.yml'))));
  const { connections } = await extractConfigConnections({ files: found, varMap: new Map(), warnings: [] });
  assert.ok(connections.some((item) => item.name === 'rails-development'));
});
