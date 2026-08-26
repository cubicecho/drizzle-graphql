import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, drizzleExecutorKey } from '@/index';

// `name` is NOT NULL so a `set: { name: null }` entry can force a mid-batch failure.
const Items = pgTable('items', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty'),
  category: text('category'),
});

const relations = buildRelations({ Items }, { Items: {} });
const schema = { Items, relations };

const DATA_DIR = `./tests/.temp/pgdata-update-many-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const items = () => db.select().from(Items).orderBy(Items.id);

const UPDATE_MANY = /* GraphQL */ `
  mutation ($updates: [UpdateItemsManyInput!]!) {
    updateItemsMany(updates: $updates) {
      id
      name
      qty
      category
    }
  }
`;

beforeAll(async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(DATA_DIR, { recursive: true });
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "items" (
		"id" integer PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"qty" integer,
		"category" text
	);`);

  gqlSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM "items"`);
  await db.insert(Items).values([
    { id: 1, name: 'One', qty: 1, category: 'a' },
    { id: 2, name: 'Two', qty: 2, category: 'a' },
    { id: 3, name: 'Three', qty: 3, category: 'b' },
  ]);
});

describe.sequential('updateMany: generated surface', () => {
  it('generates the mutation with the expected SDL shape', () => {
    const field = gqlSchema.getMutationType()!.getFields()['updateItemsMany']!;

    expect(field).toBeDefined();
    expect(field.args.map((a) => a.name)).toEqual(['updates']);
    expect(String(field.args[0]!.type)).toBe('[UpdateItemsManyInput!]!');
    // Nullable items: an entry whose `where` matched nothing yields `null` in its slot.
    expect(String(field.type)).toBe('[Items]!');
  });

  it('generates the entry input from the update set input and the table filters', () => {
    const input = gqlSchema.getType('UpdateItemsManyInput') as GraphQLInputObjectType;
    const fields = input.getFields();

    expect(Object.keys(fields).sort()).toEqual(['set', 'where']);
    expect(String(fields['set']!.type)).toBe('UpdateItemsInput!');
    expect(String(fields['where']!.type)).toBe('ItemsFilters');
  });

  it('is switched off by its own feature flag, and off with update itself', () => {
    const noMany = buildSchema(db, { features: { updateMany: false } }).schema;
    expect(noMany.getMutationType()!.getFields()['updateItemsMany']).toBeUndefined();
    expect(noMany.getType('UpdateItemsManyInput')).toBeUndefined();
    // The single-set update is untouched.
    expect(noMany.getMutationType()!.getFields()['updateItems']).toBeDefined();

    // The batch update reuses the update set input, so update: false removes it too.
    const noUpdate = buildSchema(db, { features: { update: false } }).schema;
    expect(noUpdate.getMutationType()!.getFields()['updateItemsMany']).toBeUndefined();
    expect(noUpdate.getType('UpdateItemsManyInput')).toBeUndefined();
  });
});

describe.sequential('updateMany: behavior', () => {
  it('applies a distinct set per entry and returns the rows in input order', async () => {
    const result = await run(UPDATE_MANY, {
      updates: [
        { where: { id: { eq: 3 } }, set: { qty: 30 } },
        { where: { id: { eq: 1 } }, set: { qty: 10, name: 'OneEdited' } },
        { where: { id: { eq: 2 } }, set: { qty: 20 } },
      ],
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.['updateItemsMany']).toEqual([
      { id: 3, name: 'Three', qty: 30, category: 'b' },
      { id: 1, name: 'OneEdited', qty: 10, category: 'a' },
      { id: 2, name: 'Two', qty: 20, category: 'a' },
    ]);

    expect(await items()).toEqual([
      { id: 1, name: 'OneEdited', qty: 10, category: 'a' },
      { id: 2, name: 'Two', qty: 20, category: 'a' },
      { id: 3, name: 'Three', qty: 30, category: 'b' },
    ]);
  });

  it('returns null in the slot of an entry whose where matched no rows', async () => {
    const result = await run(UPDATE_MANY, {
      updates: [
        { where: { id: { eq: 1 } }, set: { qty: 10 } },
        { where: { id: { eq: 999 } }, set: { qty: 990 } },
        { where: { id: { eq: 2 } }, set: { qty: 20 } },
      ],
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.['updateItemsMany']).toEqual([
      { id: 1, name: 'One', qty: 10, category: 'a' },
      null,
      { id: 2, name: 'Two', qty: 20, category: 'a' },
    ]);
  });

  it('lets one entry update several rows, contributing each of them', async () => {
    const result = await run(UPDATE_MANY, {
      updates: [
        { where: { category: { eq: 'a' } }, set: { qty: 100 } },
        { where: { id: { eq: 3 } }, set: { qty: 30 } },
      ],
    });

    expect(result.errors).toBeUndefined();
    const rows = result.data?.['updateItemsMany'] as any[];
    expect(rows).toHaveLength(3);
    // The first entry's rows come first; their order within the entry is the database's.
    expect(
      rows
        .slice(0, 2)
        .map((r) => r.id)
        .sort(),
    ).toEqual([1, 2]);
    expect(rows.slice(0, 2).every((r) => r.qty === 100)).toBe(true);
    expect(rows[2]).toEqual({ id: 3, name: 'Three', qty: 30, category: 'b' });
  });

  it('applies entries matching the same row in input order', async () => {
    const result = await run(UPDATE_MANY, {
      updates: [
        { where: { id: { eq: 1 } }, set: { qty: 10 } },
        { where: { id: { eq: 1 } }, set: { name: 'OneEdited' } },
      ],
    });

    expect(result.errors).toBeUndefined();
    // Each slot returns the row as of its own statement, so the second slot sees the first's set.
    expect(result.data?.['updateItemsMany']).toEqual([
      { id: 1, name: 'One', qty: 10, category: 'a' },
      { id: 1, name: 'OneEdited', qty: 10, category: 'a' },
    ]);
    expect((await items())[0]).toEqual({ id: 1, name: 'OneEdited', qty: 10, category: 'a' });
  });

  it('rolls back every entry when one of them fails', async () => {
    const result = await run(UPDATE_MANY, {
      updates: [
        { where: { id: { eq: 1 } }, set: { qty: 100 } },
        // Violates NOT NULL on name — the whole batch must fail.
        { where: { id: { eq: 2 } }, set: { name: null } },
      ],
    });

    expect(result.errors).toBeDefined();
    // The first entry's update was rolled back with the failing one.
    expect(await items()).toEqual([
      { id: 1, name: 'One', qty: 1, category: 'a' },
      { id: 2, name: 'Two', qty: 2, category: 'a' },
      { id: 3, name: 'Three', qty: 3, category: 'b' },
    ]);
  });

  it('rejects an empty batch and an entry with an empty set before touching the database', async () => {
    const empty = await run(UPDATE_MANY, { updates: [] });
    expect(empty.errors?.[0]?.message).toBe('No updates were provided!');

    const emptySet = await run(UPDATE_MANY, {
      updates: [
        { where: { id: { eq: 1 } }, set: { qty: 10 } },
        { where: { id: { eq: 2 } }, set: {} },
      ],
    });
    expect(emptySet.errors?.[0]?.message).toBe('Unable to update with no values specified!');
    // The malformed entry rejected the request before any update ran.
    expect((await items())[0]?.qty).toBe(1);
  });

  it('runs on a caller-supplied transaction from the context', async () => {
    await db
      .transaction(async (tx: any) => {
        const result = await graphql({
          schema: gqlSchema,
          source: UPDATE_MANY,
          variableValues: { updates: [{ where: { id: { eq: 1 } }, set: { qty: 10 } }] },
          contextValue: { [drizzleExecutorKey]: tx },
        });

        expect(result.errors).toBeUndefined();
        expect((result.data?.['updateItemsMany'] as any[])[0].qty).toBe(10);

        // The write is visible inside the caller's transaction...
        const inside = await tx.select().from(Items).orderBy(Items.id);
        expect(inside[0].qty).toBe(10);

        tx.rollback();
      })
      .catch(() => {
        // db.transaction rethrows the rollback — expected.
      });

    // ...and gone once the caller rolls it back: the batch's savepoint nested correctly.
    expect((await items())[0]?.qty).toBe(1);
  });
});
