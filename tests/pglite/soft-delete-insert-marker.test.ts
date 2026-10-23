import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { boolean, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A NOT NULL soft-delete marker is taken out of every create input — only the delete and
// restore mutations write it — so when drizzle declares no default for it, an insert has to
// stamp its restored value ("not deleted") or every insert is a NOT NULL violation. Root,
// upsert and nested `create` inserts alike.

const Lists = pgTable('lists', { id: serial('id').primaryKey(), name: text('name').notNull() });
const Items = pgTable('items', {
  id: serial('id').primaryKey(),
  listId: integer('list_id'),
  label: text('label').notNull(),
  isDeleted: boolean('is_deleted').notNull(),
});
const tables = { Lists, Items };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Lists: { items: r.many.Items({ from: r.Lists.id, to: r.Items.listId }) },
  Items: { list: r.one.Lists({ from: r.Items.listId, to: r.Lists.id }) },
});

let db: any;
let schema: GraphQLSchema;
beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(sql`create table lists (id serial primary key, name text not null)`);
  await db.execute(
    sql`create table items (id serial primary key, list_id int, label text not null, is_deleted boolean not null)`,
  );
  schema = buildSchema(db, {
    features: { nestedWrites: true, upsert: true },
    onError: (error: unknown) => error as Error,
    softDelete: { Items: { column: 'isDeleted', deletedValue: true, restoredValue: false } },
  }).schema;
});
beforeEach(async () => {
  await db.execute(sql`truncate items, lists restart identity`);
});

const run = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors).toBeUndefined();
  return res.data as any;
};

describe('inserting into a table whose NOT NULL soft-delete marker has no default', () => {
  it('a root create writes the restored value', async () => {
    const data = await run('mutation { createItemsSingle(values: { label: "a" }) { id isDeleted } }');
    expect(data.createItemsSingle.isDeleted).toBe(false);
    const many = await run('mutation { createItems(values: [{ label: "b" }, { label: "c" }]) { isDeleted } }');
    expect(many.createItems).toEqual([{ isDeleted: false }, { isDeleted: false }]);
  });

  it('an upsert writes the restored value', async () => {
    const data = await run('mutation { upsertItemsSingle(values: { label: "b" }) { id isDeleted } }');
    expect(data.upsertItemsSingle.isDeleted).toBe(false);
  });

  it("an upsert's conflict branch leaves a marked row marked", async () => {
    await db.execute(sql`insert into items (id, label, is_deleted) values (100, 'old', true)`);
    // The stamped marker is server-owned, never part of the conflict branch's SET — and the
    // soft delete keeps the write off the marked row altogether.
    await graphql({ schema, source: 'mutation { upsertItemsSingle(values: { id: 100, label: "new" }) { id } }' });
    expect(await db.select().from(Items)).toEqual([{ id: 100, listId: null, label: 'old', isDeleted: true }]);
  });

  it('a child-side nested create writes the restored value', async () => {
    const data = await run(
      'mutation { createListsSingle(values: { name: "l", items: { create: [{ label: "c" }] } }) { items { isDeleted } } }',
    );
    expect(data.createListsSingle.items).toEqual([{ isDeleted: false }]);
  });

  it('a parent-side nested create into the marked table is unaffected', async () => {
    const data = await run(
      'mutation { createItemsSingle(values: { label: "d", list: { create: { name: "m" } } }) { isDeleted list { name } } }',
    );
    expect(data.createItemsSingle).toEqual({ isDeleted: false, list: { name: 'm' } });
  });
});
