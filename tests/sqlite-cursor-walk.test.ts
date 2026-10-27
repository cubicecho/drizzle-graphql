// Cursor pagination walks every row exactly once, in order, on SQLite — through the row-value
// keyset predicate (all-NOT-NULL keys sorted one way) and the expanded one alike. `at` is an
// integer `timestamp`, so the row value has to bind the cursor's Date as the column stores it.
// See tests/util/cursor-walk.ts.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, expect } from 'vitest';
import { buildSchema } from '@/index';
import { defineCursorWalkTests, WALK_GROUPS, WALK_ITEMS, WALK_PAIRS } from './util/cursor-walk';

const WalkGroups = sqliteTable('walk_groups', { id: integer('id').primaryKey() });
const WalkItems = sqliteTable('walk_items', {
  id: integer('id').primaryKey(),
  groupId: integer('group_id').notNull(),
  at: integer('at', { mode: 'timestamp' }).notNull(),
  rank: integer('rank').notNull(),
  score: integer('score'),
  code: text('code').notNull(),
});
const WalkPairs = sqliteTable('walk_pairs', { a: integer('a').notNull(), b: integer('b').notNull() }, (t) => [
  primaryKey({ columns: [t.a, t.b] }),
]);
const tables = { WalkGroups, WalkItems, WalkPairs };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  WalkGroups: { items: r.many.WalkItems({ from: r.WalkGroups.id, to: r.WalkItems.groupId }) },
});

let client: Client;
let schema: GraphQLSchema;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE walk_groups (id integer PRIMARY KEY)`);
  await db.run(sql`CREATE TABLE walk_items (
    id integer PRIMARY KEY,
    group_id integer NOT NULL,
    at integer NOT NULL,
    rank integer NOT NULL,
    score integer,
    code text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE walk_pairs (a integer NOT NULL, b integer NOT NULL, PRIMARY KEY (a, b))`);
  await db.insert(WalkGroups).values(WALK_GROUPS);
  await db.insert(WalkItems).values(WALK_ITEMS);
  await db.insert(WalkPairs).values(WALK_PAIRS);
  schema = buildSchema(db).schema;
});

afterAll(() => {
  client?.close();
});

const run = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};

defineCursorWalkTests(run, 'nulls-smallest');
