import test from 'node:test';
import assert from 'node:assert/strict';
import { create as createPostgres } from '../lib/drivers/postgres.mjs';
import { create as createMysql } from '../lib/drivers/mysql.mjs';

/** Minimal pg double: enough for `ddl` (columns + indexes + current_schema). */
function fakePg() {
  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      const text = String(sql);
      if (/current_schema/.test(text)) return { fields: [{ name: 'current_schema' }], rows: [{ current_schema: 'public' }] };
      if (/pg_attribute/.test(text)) {
        return {
          fields: [
            { name: 'attname' },
            { name: 'format_type' },
            { name: 'attnotnull' },
            { name: 'pg_get_expr' },
            { name: 'col_description' },
          ],
          rows: [{ attname: 'id', format_type: 'integer', attnotnull: true, pg_get_expr: null, col_description: null }],
        };
      }
      if (/pg_indexes/.test(text)) {
        return {
          fields: [{ name: 'indexname' }, { name: 'indexdef' }],
          rows: [{ indexname: 'orders_pkey', indexdef: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)' }],
        };
      }
      return { fields: [], rows: [] };
    },
  };
  return { default: { Client: class { constructor() { return client; } }, types: { getTypeParser: () => (value) => value } } };
}

/** Minimal mysql2 double for the OceanBase Oracle-mode `ddl` path. */
function fakeMysql2() {
  const fields = (names) => names.map((name) => ({ name }));
  const connection = {
    async end() {},
    async query(sql) {
      const text = String(sql);
      if (/all_tab_columns/i.test(text)) {
        return [[[1, 'ID', 'NUMBER', 'N', '', null]], fields(['#', 'column', 'type', 'null', 'default', 'comment'])];
      }
      if (/all_constraints/i.test(text)) return [[['ID']], fields(['column_name'])];
      if (/all_indexes/i.test(text)) return [[['ORDERS', 'IDX_ORDERS_ID', 'UNIQUE', 'NORMAL', 'VALID']], fields(['table_name', 'index_name', 'uniqueness', 'index_type', 'status'])];
      if (/all_ind_columns/i.test(text)) return [[['IDX_ORDERS_ID', 'ID']], fields(['index_name', 'column_name'])];
      if (/SYS_CONTEXT/i.test(text)) return [[['APP']], fields(['s'])];
      return [[], []];
    },
  };
  return { createConnection: async () => connection };
}

test('PostgreSQL ddl emits real CREATE INDEX definitions', async () => {
  const driver = await createPostgres(
    { type: 'postgres', host: 'pg', port: 5432, user: 'u', password: 'p', database: 'app' },
    { loadPackage: async () => fakePg(), timeoutMs: 500 },
  );
  const outcome = await driver.ddl('orders', { schema: 'public' });
  const ddl = outcome.rows[0][0];
  await driver.close();
  assert.match(ddl, /CREATE UNIQUE INDEX orders_pkey ON public\.orders USING btree \(id\);/);
  assert.ok(!/\norders_pkey;\n/.test(ddl), 'index name alone is not a valid statement');
});

test('OceanBase Oracle mode ddl prints index columns, not status', async () => {
  const driver = await createMysql(
    { type: 'oceanbase', dialect: 'oracle', host: 'ob', port: 2881, user: 'u', password: 'p', database: 'APP' },
    { loadPackage: async () => fakeMysql2(), timeoutMs: 500 },
  );
  const outcome = await driver.ddl('orders', { schema: 'APP' });
  const ddl = outcome.rows[0][0];
  await driver.close();
  assert.match(ddl, /IDX_ORDERS_ID \(ID\)/);
  assert.ok(!/IDX_ORDERS_ID \(VALID\)/.test(ddl));
});
