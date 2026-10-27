// Cursor pagination walks every row exactly once, in order, on PostgreSQL — through the
// row-value keyset predicate (all-NOT-NULL keys sorted one way) and the expanded one alike.
// See tests/util/cursor-walk.ts.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, expect } from 'vitest';
import { buildSchema } from '@/index';
import { defineCursorWalkTests, WALK_GROUPS, WALK_ITEMS, WALK_PAIRS } from '../util/cursor-walk';

const WalkGroups = pgTable('walk_groups', { id: integer('id').primaryKey() });
const WalkItems = pgTable('walk_items', {
  id: integer('id').primaryKey(),
  groupId: integer('group_id').notNull(),
  at: timestamp('at').notNull(),
  rank: integer('rank').notNull(),
  score: integer('score'),
  code: text('code').notNull(),
});
const WalkPairs = pgTable('walk_pairs', { a: integer('a').notNull(), b: integer('b').notNull() }, (t) => [
  primaryKey({ columns: [t.a, t.b] }),
]);
const tables = { WalkGroups, WalkItems, WalkPairs };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  WalkGroups: { items: r.many.WalkItems({ from: r.WalkGroups.id, to: r.WalkItems.groupId }) },
});

let pglite: PGlite;
let schema: GraphQLSchema;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE walk_groups (id integer PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE walk_items (
    id integer PRIMARY KEY,
    group_id integer NOT NULL,
    at timestamp NOT NULL,
    rank integer NOT NULL,
    score integer,
    code text NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE walk_pairs (a integer NOT NULL, b integer NOT NULL, PRIMARY KEY (a, b))`);
  await db.insert(WalkGroups).values(WALK_GROUPS);
  await db.insert(WalkItems).values(WALK_ITEMS);
  await db.insert(WalkPairs).values(WALK_PAIRS);
  schema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const run = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};

defineCursorWalkTests(run, 'nulls-largest');
