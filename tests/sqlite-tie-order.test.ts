// Tied rows in an ordered list come back in primary-key order on SQLite, with or without
// `cursor` and with or without a page (issue #236). The `(grp, id desc)` index is what SQLite
// walks for an ORDER BY on `grp` alone, so untiebroken ties come back in the reverse of key
// order. See tests/util/tie-order.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { afterAll, beforeAll, expect } from 'vitest';
import { buildSchema } from '@/index';
import { defineTieOrderTests, TIE_ITEMS, TIE_LOGS, TIE_PARENTS } from './util/tie-order';

const TieParents = sqliteTable('tie_parents', { id: integer('id').primaryKey() });
const TieItems = sqliteTable('tie_items', {
  id: integer('id').primaryKey(),
  parentId: integer('parent_id').notNull(),
  grp: integer('grp').notNull(),
});
const TieLogs = sqliteTable('tie_logs', { grp: integer('grp').notNull(), note: text('note').notNull() });
const tables = { TieParents, TieItems, TieLogs };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  TieParents: { items: r.many.TieItems({ from: r.TieParents.id, to: r.TieItems.parentId }) },
});

let dir: string;
let client: Client;
let db: any;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'drizzle-graphql-tie-order-'));
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE tie_parents (id integer PRIMARY KEY)`);
  await db.run(sql`CREATE TABLE tie_items (id integer PRIMARY KEY, parent_id integer NOT NULL, grp integer NOT NULL)`);
  await db.run(sql`CREATE INDEX tie_items_grp ON tie_items (grp, id DESC)`);
  await db.run(sql`CREATE TABLE tie_logs (grp integer NOT NULL, note text NOT NULL)`);
  await db.insert(TieParents).values(TIE_PARENTS);
  await db.insert(TieItems).values(TIE_ITEMS);
  await db.insert(TieLogs).values(TIE_LOGS);
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

defineTieOrderTests(async (source, config) => {
  const res = await graphql({ schema: buildSchema(db, config as any).schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
});
