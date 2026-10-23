// SQLite's LIKE folds ASCII case, so the case-sensitive string operators compile to GLOB there:
// `contains` / `startsWith` / `endsWith` and the raw `like` / `notLike` match case the way they do
// on PostgreSQL. The `i`-prefixed operators and `insensitive: true` keep folding it, and every
// wildcard in a literal search term — LIKE's and GLOB's — still matches only itself.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  name: text('name'),
  meta: text('meta', { mode: 'json' }),
});
const relations = buildRelations({ Items }, {});

let client: Client;
let schema: GraphQLSchema;

const ids = async (where: string) => {
  const res = await graphql({
    schema,
    source: `{ items(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    contextValue: {},
  });
  expect(res.errors).toBeUndefined();
  return (res.data!['items'] as { id: number }[]).map((row) => row.id);
};

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE items (id integer primary key, name text, meta text)`);
  await db.insert(Items).values([
    { id: 1, name: 'apple', meta: { label: 'apple' } },
    { id: 2, name: 'Apple', meta: { label: 'Apple' } },
    { id: 3, name: '50% off_now', meta: null },
    { id: 4, name: '50x offXnow', meta: null },
    { id: 5, name: 'a*b?c[d]\\e', meta: null },
    { id: 6, name: 'aXbYc[d]\\e', meta: null },
  ]);
  schema = buildSchema(db).schema;
});
afterAll(() => client.close());

describe('sqlite: case-sensitive string operators', () => {
  it('contains / startsWith / endsWith match case', async () => {
    expect(await ids('{ name: { contains: "App" } }')).toEqual([2]);
    expect(await ids('{ name: { startsWith: "a" } }')).toEqual([1, 5, 6]);
    expect(await ids('{ name: { endsWith: "PLE" } }')).toEqual([]);
    expect(await ids('{ name: { endsWith: "ple" } }')).toEqual([1, 2]);
  });

  it('an empty term matches every non-null value', async () => {
    expect(await ids('{ name: { contains: "" } }')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('treats LIKE and GLOB wildcards in the term literally', async () => {
    expect(await ids('{ name: { contains: "% off_" } }')).toEqual([3]);
    expect(await ids('{ name: { startsWith: "a*b?c[d]" } }')).toEqual([5]);
    expect(await ids('{ name: { endsWith: "[d]\\\\e" } }')).toEqual([5, 6]);
    expect(await ids('{ name: { contains: "?" } }')).toEqual([5]);
  });

  it('the i-prefixed operators and insensitive: true still fold case', async () => {
    expect(await ids('{ name: { iContains: "APP" } }')).toEqual([1, 2]);
    expect(await ids('{ name: { iStartsWith: "A" } }')).toEqual([1, 2, 5, 6]);
    expect(await ids('{ name: { contains: "APP", insensitive: true } }')).toEqual([1, 2]);
  });

  it('like / notLike match case, with % and _ as their wildcards', async () => {
    expect(await ids('{ name: { like: "A%" } }')).toEqual([2]);
    expect(await ids('{ name: { like: "_pple" } }')).toEqual([1, 2]);
    expect(await ids('{ name: { like: "a*b%" } }')).toEqual([5]);
    expect(await ids('{ name: { notLike: "%pple" } }')).toEqual([3, 4, 5, 6]);
    expect(await ids('{ name: { notLike: "a%" } }')).toEqual([2, 3, 4]);
    expect(await ids('{ name: { like: "A%", insensitive: true } }')).toEqual([1, 2, 5, 6]);
  });

  it('JSON path string operators match case too', async () => {
    expect(await ids('{ meta: { path: { path: ["label"], startsWith: "A" } } }')).toEqual([2]);
    expect(await ids('{ meta: { path: { path: ["label"], iStartsWith: "A" } } }')).toEqual([1, 2]);
  });
});
