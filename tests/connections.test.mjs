import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConnections,
  describeConnection,
  parseConnectionUrl,
  resolveConnection,
  targetText,
  TYPE_META,
} from '../lib/connections.mjs';

const envMap = (pairs) =>
  new Map(Object.entries(pairs).map(([key, value]) => [key, { value, source: { kind: 'process', var: key } }]));

test('URL forms: mysql / postgres / redis / mongo / sqlite', () => {
  assert.deepEqual(
    (({ type, host, port, user, password, database }) => ({ type, host, port, user, password, database }))(
      parseConnectionUrl('mysql://app:s3cret@10.0.0.5:3306/erp'),
    ),
    { type: 'mysql', host: '10.0.0.5', port: 3306, user: 'app', password: 's3cret', database: 'erp' },
  );
  const pg = parseConnectionUrl('postgres://u:p@pg:5432/app?sslmode=require');
  assert.equal(pg.type, 'postgres');
  assert.equal(pg.ssl, true);
  const redis = parseConnectionUrl('redis://:pw@127.0.0.1:6379/2');
  assert.equal(redis.type, 'redis');
  assert.equal(redis.database, '2');
  assert.equal(redis.password, 'pw');
  const mongo = parseConnectionUrl('mongodb://u:p@m1:27017/app?authSource=admin');
  assert.equal(mongo.type, 'mongodb');
  assert.equal(mongo.params.authSource, 'admin');
  assert.equal(mongo.url, 'mongodb://u:p@m1:27017/app?authSource=admin');
  const sqlite = parseConnectionUrl('sqlite:.tmp/app.db');
  assert.equal(sqlite.type, 'sqlite');
  assert.equal(sqlite.path, '.tmp/app.db');
  const sqliteWin = parseConnectionUrl('sqlite:///C:/data/app.db');
  assert.equal(sqliteWin.path, 'C:/data/app.db');
});

test('domestic databases: dm / oceanbase / kingbase / tidb', () => {
  assert.equal(parseConnectionUrl('dm://SYSDBA:pw@dm-host:5236').type, 'dameng');
  const ob = parseConnectionUrl('oceanbase://root:pw@ob:2881/app?mode=oracle');
  assert.equal(ob.type, 'oceanbase');
  assert.equal(ob.dialect, 'oracle');
  const kb = parseConnectionUrl('kingbase://u:p@kb:5432/app');
  assert.equal(kb.type, 'postgres');
  assert.ok(kb.notes.some((note) => note.includes('Kingbase')));
  assert.equal(parseConnectionUrl('tidb://u:p@t:4000/app').type, 'mysql');
  assert.ok(TYPE_META.dameng && TYPE_META.oceanbase);
});

test('JDBC forms: mysql / postgresql / oracle thin / sqlserver / sqlite', () => {
  const mysql = parseConnectionUrl('jdbc:mysql://db:3306/core?useUnicode=true&characterEncoding=utf8');
  assert.equal(mysql.type, 'mysql');
  assert.equal(mysql.database, 'core');

  const pg = parseConnectionUrl('jdbc:postgresql://pg:5432/app');
  assert.equal(pg.type, 'postgres');

  const ora = parseConnectionUrl('jdbc:oracle:thin:@//ora:1521/ORCLPDB1');
  assert.equal(ora.type, 'oracle');
  assert.equal(ora.service, 'ORCLPDB1');

  const oraSid = parseConnectionUrl('jdbc:oracle:thin:@ora:1521:ORCL');
  assert.equal(oraSid.sid, 'ORCL');

  const mssql = parseConnectionUrl('jdbc:sqlserver://mssql:1433;databaseName=app;user=sa;password=pw;encrypt=true');
  assert.equal(mssql.type, 'sqlserver');
  assert.equal(mssql.database, 'app');
  assert.equal(mssql.user, 'sa');
  assert.equal(mssql.ssl, true);

  const lite = parseConnectionUrl('jdbc:sqlite:./data/app.db');
  assert.equal(lite.type, 'sqlite');
});

test('Go DSN / libpq DSN', () => {
  const go = parseConnectionUrl('app:pw@tcp(127.0.0.1:3306)/erp?charset=utf8mb4', { hintType: 'mysql' });
  assert.equal(go.type, 'mysql');
  assert.equal(go.host, '127.0.0.1');
  assert.equal(go.database, 'erp');
  const libpq = parseConnectionUrl('host=pg port=5432 user=app password=pw dbname=erp');
  assert.equal(libpq.type, 'postgres');
  assert.equal(libpq.database, 'erp');
});

test('buildConnections: DB_URL, named groups and ecosystem variables', () => {
  const { connections } = buildConnections(
    envMap({
      DB_URL: 'postgres://app:pw@pg:5432/app',
      DB_ERP_URL: 'mysql://erp:pw@10.0.0.5:3306/erp',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_USER: 'root',
      MYSQL_PASSWORD: 'rootpw',
      MYSQL_DATABASE: 'shop',
    }),
  );
  const names = connections.map((conn) => conn.name).sort();
  assert.deepEqual(names, ['default', 'erp', 'mysql']);
  const erp = connections.find((conn) => conn.name === 'erp');
  assert.equal(erp.type, 'mysql');
  assert.equal(erp.source.kind, 'process');
  assert.equal(erp.source.var, 'DB_ERP_URL');
  const mysql = connections.find((conn) => conn.name === 'mysql');
  assert.equal(mysql.port, 3306, 'default port should be filled in');
  assert.equal(mysql.database, 'shop');
});

test('buildConnections: connections pointing at the same target are merged', () => {
  const { connections } = buildConnections(
    envMap({
      DB_URL: 'mysql://app:pw@127.0.0.1:3306/app',
      MYSQL_URL: 'mysql://app:pw@127.0.0.1:3306/app',
    }),
  );
  assert.equal(connections.length, 1);
  assert.ok(connections[0].aliases.includes('mysql'));
});

test('buildConnections: a single connection becomes the default', () => {
  const { connections } = buildConnections(envMap({ DATABASE_URL: 'mysql://app:pw@db:3306/app' }));
  assert.equal(connections.length, 1);
  assert.equal(connections[0].default, true);
  assert.equal(resolveConnection(connections).name, 'default');
});

test('passwords stay in memory: describeConnection has no plaintext', () => {
  const { connections } = buildConnections(envMap({ DB_URL: 'mysql://app:SuperSecret@db:3306/app' }));
  const view = describeConnection(connections[0]);
  assert.equal(view.passwordSet, true);
  assert.equal(view.passwordLength, undefined);
  assert.ok(!JSON.stringify(view).includes('SuperSecret'));
  assert.ok(!targetText(connections[0]).includes('SuperSecret'));
});

test('resolveConnection: by name / type / ambiguity error', () => {
  const { connections } = buildConnections(
    envMap({
      DB_A_URL: 'mysql://u:p@a:3306/x',
      DB_B_URL: 'mysql://u:p@b:3306/y',
    }),
  );
  assert.equal(resolveConnection(connections, 'a').name, 'a');
  assert.throws(() => resolveConnection(connections), /--db/);
  assert.throws(() => resolveConnection(connections, 'mysql'), /is ambiguous/);
  assert.throws(() => resolveConnection(connections, 'nope'), /no connection named/);
});

test('SQLite: different files are not merged', () => {
  const { connections } = buildConnections(
    envMap({ DB_A_URL: 'sqlite:./a.db', DB_B_URL: 'sqlite:./b.db' }),
  );
  assert.equal(connections.length, 2);
  assert.deepEqual(connections.map((conn) => conn.name).sort(), ['a', 'b']);
  assert.deepEqual(connections.map((conn) => conn.path).sort(), ['./a.db', './b.db']);
});

test('DB_DEFAULT selects the default connection', () => {
  const { connections } = buildConnections(envMap({ DB_A_URL: 'sqlite:./a.db', DB_B_URL: 'sqlite:./b.db', DB_DEFAULT: 'b' }), {
    defaultName: 'b',
  });
  assert.equal(connections.find((conn) => conn.default).name, 'b');
});

test('Kafka: broker list / SASL / masked target', () => {
  const parsed = parseConnectionUrl('kafka://app:pw@b1:9092,b2:9093?ssl=true&saslMechanism=scram-sha-512');
  assert.equal(parsed.type, 'kafka');
  assert.deepEqual(parsed.brokers, ['b1:9092', 'b2:9093']);
  assert.equal(parsed.user, 'app');
  assert.equal(parsed.ssl, true);
  assert.equal(parsed.dialect, 'scram-sha-512');

  const { connections } = buildConnections(
    envMap({
      KAFKA_BROKERS: '10.0.0.1:9092,10.0.0.2:9092',
      KAFKA_SASL_USERNAME: 'app',
      KAFKA_SASL_PASSWORD: 'secret',
      KAFKA_SASL_MECHANISM: 'scram-sha-256',
    }),
  );
  assert.equal(connections.length, 1);
  const conn = connections[0];
  assert.equal(conn.type, 'kafka');
  assert.equal(conn.kind, 'mq');
  assert.deepEqual(conn.brokers, ['10.0.0.1:9092', '10.0.0.2:9092']);
  assert.equal(conn.dialect, 'scram-sha-256');
  const target = targetText(conn);
  assert.equal(target, 'kafka://10.0.0.1:9092,10.0.0.2:9092');
  assert.ok(!target.includes('secret'));
  assert.ok(!JSON.stringify(describeConnection(conn)).includes('secret'));
});

test('split DB_<NAME>_* variables build a connection', () => {
  const { connections } = buildConnections(
    envMap({
      DB_REPORT_TYPE: 'postgres',
      DB_REPORT_HOST: 'pg-report',
      DB_REPORT_PORT: '5433',
      DB_REPORT_USER: 'report',
      DB_REPORT_PASSWORD: 'pw',
      DB_REPORT_DATABASE: 'dw',
      DB_REPORT_SCHEMA: 'mart',
    }),
  );
  assert.equal(connections.length, 1);
  assert.equal(connections[0].name, 'report');
  assert.equal(connections[0].port, 5433);
  assert.equal(connections[0].schema, 'mart');
});
