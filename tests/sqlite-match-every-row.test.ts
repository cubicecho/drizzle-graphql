// A filter that matches every row by construction — `notInArray: []`, `NOT: { inArray: [] }` —
// compiles to "no condition", not to an always-true predicate: reads return every row, and
// writes that require a `where` (`requireWhere`, the Single writes) reject it.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = sqliteTable('items', { id: integer('id').primaryKey(), name: text('name') });
const Posts = sqliteTable('posts', { id: integer('id').primaryKey(), itemId: integer('item_id') });
const tables = { Items, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Items: { posts: r.many.Posts({ from: r.Items.id, to: r.Posts.itemId }) },
  Posts: { item: r.one.Items({ from: r.Posts.itemId, to: r.Items.id }) },
});

const ALL_IDS = [1, 2, 3];

let client: Client;
let db: any;
let schema: GraphQLSchema;
let guarded: GraphQLSchema;
const runOn = (target: GraphQLSchema, source: string) => graphql({ schema: target, source, contextValue: {} });
const codes = (res: { errors?: readonly any[] }) => res.errors?.map((error) => error.extensions?.code);
const remaining = async () => (await db.select().from(Items)).map((row: any) => row.id).sort();
const ids = async (where: string) => {
  const res: any = await runOn(
    schema,
    `{ items(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
  );
  expect(res.errors).toBeUndefined();
  return res.data.items.map((row: any) => row.id);
};

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE items (id integer primary key, name text)`);
  await db.run(sql`CREATE TABLE posts (id integer primary key, item_id integer)`);
  schema = buildSchema(db).schema;
  guarded = buildSchema(db, { features: { requireWhere: true } }).schema;
});
beforeEach(async () => {
  await db.run(sql`DELETE FROM items`);
  await db.run(sql`DELETE FROM posts`);
  await db.insert(Items).values([
    { id: 1, name: 'a' },
    { id: 2, name: null },
    { id: 3, name: 'c' },
  ]);
  await db.insert(Posts).values([{ id: 1, itemId: 1 }]);
});
afterAll(() => client.close());

describe('requireWhere rejects filters that match every row', () => {
  it.each([
    ['notInArray: []', '{ id: { notInArray: [] } }'],
    ['NOT inArray: []', '{ NOT: { id: { inArray: [] } } }'],
    ['NOT (eq AND inArray: [])', '{ NOT: { id: { eq: 1, inArray: [] } } }'],
    ['OR with a match-all branch', '{ OR: [{ id: { eq: 1 } }, { id: { notInArray: [] } }] }'],
    ['NOT of an OR of match-nothing branches', '{ NOT: { OR: [{ id: { inArray: [] } }, { name: { inArray: [] } }] } }'],
  ])('deleteItems(%s) is DRIZZLE_WHERE_REQUIRED and deletes nothing', async (_name, where) => {
    const res = await runOn(guarded, `mutation { deleteItems(where: ${where}) { id } }`);
    expect(codes(res)).toEqual(['DRIZZLE_WHERE_REQUIRED']);
    expect(await remaining()).toEqual(ALL_IDS);
  });

  it('updateItems(NOT inArray: []) is DRIZZLE_WHERE_REQUIRED and updates nothing', async () => {
    const res = await runOn(
      guarded,
      `mutation { updateItems(set: { name: "zz" }, where: { NOT: { id: { inArray: [] } } }) { id } }`,
    );
    expect(codes(res)).toEqual(['DRIZZLE_WHERE_REQUIRED']);
    const renamed = (await db.select().from(Items)).filter((row: any) => row.name === 'zz');
    expect(renamed).toEqual([]);
  });

  it('a Single delete rejects notInArray: [] even without requireWhere', async () => {
    const res = await runOn(schema, `mutation { deleteItemsSingle(where: { id: { notInArray: [] } }) { id } }`);
    expect(codes(res)).toEqual(['DRIZZLE_WHERE_REQUIRED']);
    expect(await remaining()).toEqual(ALL_IDS);
  });

  it('notInArray: [] ANDed with a real condition is that condition', async () => {
    const res = await runOn(guarded, `mutation { deleteItems(where: { id: { notInArray: [], eq: 2 } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(await remaining()).toEqual([1, 3]);
  });

  it('inArray: [] is a filter that matches no row, so it is allowed and deletes nothing', async () => {
    const res: any = await runOn(guarded, `mutation { deleteItems(where: { id: { inArray: [] } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.deleteItems).toEqual([]);
    expect(await remaining()).toEqual(ALL_IDS);
  });
});

describe('reads of filters that match every row or no row', () => {
  it.each([
    ['notInArray: []', '{ id: { notInArray: [] } }', ALL_IDS],
    ['NOT inArray: [] keeps NULL rows', '{ NOT: { name: { inArray: [] } } }', ALL_IDS],
    ['NOT notInArray: []', '{ NOT: { id: { notInArray: [] } } }', []],
    ['NOT NOT notInArray: []', '{ NOT: { NOT: { id: { notInArray: [] } } } }', ALL_IDS],
    ['OR of inArray: [] and eq', '{ OR: [{ id: { inArray: [] } }, { id: { eq: 3 } }] }', [3]],
    ['column-level NOT inArray: []', '{ name: { NOT: { inArray: [] } } }', ALL_IDS],
  ])('%s', async (_name, where, expected) => {
    expect(await ids(where)).toEqual(expected);
  });

  it.each([
    ['some with a match-all inner filter has any related row', '{ posts: { some: { id: { notInArray: [] } } } }', [1]],
    [
      'none with a match-all inner filter has no related row',
      '{ posts: { none: { id: { notInArray: [] } } } }',
      [2, 3],
    ],
    [
      'every with a match-all inner filter is vacuously true',
      '{ posts: { every: { id: { notInArray: [] } } } }',
      ALL_IDS,
    ],
    [
      'every with a match-nothing inner filter has no related row',
      '{ posts: { every: { id: { inArray: [] } } } }',
      [2, 3],
    ],
    ['some with a match-nothing inner filter matches nothing', '{ posts: { some: { id: { inArray: [] } } } }', []],
  ])('relation filter: %s', async (_name, where, expected) => {
    expect(await ids(where)).toEqual(expected);
  });
});
