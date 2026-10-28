// A cursor is client input. A forged value inside one used to reach the query as-is: a bad
// date bound as an invalid Date and silently returned an empty page, and a bad bigint, an
// object or an array failed as an Internal server error. Each is now DRIZZLE_INVALID_CURSOR.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = sqliteTable('items', { id: integer('id').primaryKey(), at: integer('at', { mode: 'timestamp' }) });

let client: Client;
let schema: GraphQLSchema;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations: buildRelations({ Items }, {}) });
  await db.run(sql`CREATE TABLE items (id integer primary key, at integer)`);
  await db.insert(Items).values([
    { id: 1, at: new Date('2024-01-01T00:00:00Z') },
    { id: 2, at: new Date('2024-01-02T00:00:00Z') },
  ]);
  schema = buildSchema(db).schema;
});
afterAll(() => client.close());

describe('sqlite: forged cursor values', () => {
  it.each([
    [
      'a bad date',
      '{ at: { direction: asc, priority: 1 } }',
      [
        ['at', 'asc'],
        ['id', 'asc'],
      ],
      [{ $type: 'date', value: 'nope' }, 1],
    ],
    ['a bad bigint', '{ id: { direction: asc, priority: 1 } }', [['id', 'asc']], [{ $type: 'bigint', value: 'nope' }]],
    ['an object', '{ id: { direction: asc, priority: 1 } }', [['id', 'asc']], [{ a: 1 }]],
    ['an array', '{ id: { direction: asc, priority: 1 } }', [['id', 'asc']], [[1, 2]]],
  ])('%s is DRIZZLE_INVALID_CURSOR', async (_name, orderBy, o, v) => {
    const res = await graphql({
      schema,
      source: `{ items(orderBy: ${orderBy}, after: "${forge({ o, v })}") { id } }`,
      contextValue: {},
    });
    expect(res.errors?.map((error) => error.extensions?.['code'])).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });

  it('a genuine cursor still pages', async () => {
    const orderBy = '{ at: { direction: asc, priority: 1 } }';
    const first: any = await graphql({
      schema,
      source: `{ items(orderBy: ${orderBy}, limit: 1) { id cursor } }`,
      contextValue: {},
    });
    const next: any = await graphql({
      schema,
      source: `{ items(orderBy: ${orderBy}, after: "${first.data.items[0].cursor}") { id } }`,
      contextValue: {},
    });
    expect(next.errors).toBeUndefined();
    expect(next.data.items).toEqual([{ id: 2 }]);
  });
});
