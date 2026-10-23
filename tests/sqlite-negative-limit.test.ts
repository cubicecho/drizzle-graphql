// SQLite reads `LIMIT -1` as "no limit", so a negative `limit` used to pass `applyLimitPolicy`
// (it is never above `maxLimit`) and return the whole table. It is rejected instead.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = sqliteTable('items', { id: integer('id').primaryKey(), name: text('name') });
const relations = buildRelations({ Items }, {});

let client: Client;
let db: any;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE items (id integer primary key, name text)`);
  await db.insert(Items).values([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
});
afterAll(() => client.close());

describe('sqlite: negative limit and offset', () => {
  it('rejects a negative limit rather than reading past maxLimit', async () => {
    const { schema } = buildSchema(db, { limits: { maxLimit: 2 } });
    const res = await graphql({ schema, source: `{ items(limit: -1) { id } }`, contextValue: {} });
    expect(res.data?.['items'] ?? null).toBeNull();
    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
  });

  it('rejects a negative limit without a policy too', async () => {
    const { schema } = buildSchema(db);
    const res = await graphql({ schema, source: `{ items(limit: -5) { id } }`, contextValue: {} });
    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
  });

  it('rejects a negative offset', async () => {
    const { schema } = buildSchema(db);
    const res = await graphql({ schema, source: `{ items(limit: 2, offset: -1) { id } }`, contextValue: {} });
    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
  });
});
