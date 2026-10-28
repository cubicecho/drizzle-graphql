// Tied rows in an ordered list come back in primary-key order on PostgreSQL, with or without
// `cursor` and with or without a page (issue #236). The rows go in one by one in the reverse of
// key order, so a sort that leaves ties alone returns them that way. See tests/util/tie-order.ts.
import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, expect } from 'vitest';
import { buildSchema } from '@/index';
import { defineTieOrderTests, TIE_ITEMS, TIE_LOGS, TIE_PARENTS } from '../util/tie-order';

const TieParents = pgTable('tie_parents', { id: integer('id').primaryKey() });
const TieItems = pgTable('tie_items', {
  id: integer('id').primaryKey(),
  parentId: integer('parent_id').notNull(),
  grp: integer('grp').notNull(),
});
const TieLogs = pgTable('tie_logs', { grp: integer('grp').notNull(), note: text('note').notNull() });
const relations = defineRelations({ TieParents, TieItems, TieLogs }, (r) => ({
  TieParents: { items: r.many.TieItems({ from: r.TieParents.id, to: r.TieItems.parentId }) },
}));

let client: PGlite;
let db: any;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, relations } as any);
  await client.exec(`
    CREATE TABLE tie_parents (id int primary key);
    CREATE TABLE tie_items (id int primary key, parent_id int not null, grp int not null);
    CREATE TABLE tie_logs (grp int not null, note text not null);
  `);
  await db.insert(TieParents).values(TIE_PARENTS);
  for (const item of TIE_ITEMS) {
    await db.insert(TieItems).values(item);
  }
  await db.insert(TieLogs).values(TIE_LOGS);
});

afterAll(async () => {
  await client.close();
});

defineTieOrderTests(async (source, config) => {
  const res = await graphql({ schema: buildSchema(db, config as any).schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
});
