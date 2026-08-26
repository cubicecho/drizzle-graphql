import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = sqliteTable(
  'items',
  {
    id: integer('id').primaryKey(),
    sku: text('sku').notNull(),
    region: text('region').notNull(),
    name: text('name'),
    qty: integer('qty'),
  },
  (t) => [unique('items_sku_region').on(t.sku, t.region)],
);
const relations = buildRelations({ Items }, { Items: {} });
const schema = { Items, relations };

let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });
const items = () => db.select().from(Items).orderBy(Items.id);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "items" (
		"id" integer PRIMARY KEY NOT NULL,
		"sku" text NOT NULL,
		"region" text NOT NULL,
		"name" text,
		"qty" integer,
		CONSTRAINT "items_sku_region" UNIQUE("sku", "region")
	);`);

  gqlSchema = buildSchema(db, { features: { upsert: true } }).schema;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "items"`);
  await db.insert(Items).values({ id: 1, sku: 'A', region: 'eu', name: 'Original', qty: 5 });
});

describe.sequential('SQLite upsert', () => {
  it('is opt-in', () => {
    expect(buildSchema(db).schema.getMutationType()!.getFields()['upsertItems']).toBeUndefined();
  });

  it('inserts a row that does not conflict', async () => {
    const result = await run(
      `mutation { upsertItemsSingle(values: { id: 2, sku: "B", region: "eu", name: "New" }) { id name } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItemsSingle']).toMatchObject({ id: 2, name: 'New' });
  });

  it('overwrites the conflicting row on the primary key by default', async () => {
    const result = await run(
      `mutation { upsertItemsSingle(values: { id: 1, sku: "A", region: "eu", name: "Replaced", qty: 9 }) { name qty } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItemsSingle']).toMatchObject({ name: 'Replaced', qty: 9 });
    expect(await items()).toHaveLength(1);
  });

  it('updates each row of a batch with its own values', async () => {
    const result = await run(`mutation {
      upsertItems(values: [
        { id: 1, sku: "A", region: "eu", name: "One" },
        { id: 2, sku: "B", region: "eu", name: "Two" }
      ]) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItems']).toEqual([
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' },
    ]);
  });

  it('leaves the existing row alone when the action is NOTHING', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(
        values: { id: 1, sku: "A", region: "eu", name: "Ignored" }
        onConflict: { action: NOTHING }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItemsSingle']).toBeNull();
    expect((await items())[0]).toMatchObject({ name: 'Original' });
  });

  it('conflicts on an explicit unique constraint instead of the primary key', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(
        values: { id: 7, sku: "A", region: "eu", name: "BySku" }
        onConflict: { target: [sku, region], update: [name] }
      ) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItemsSingle']).toMatchObject({ id: 1, name: 'BySku' });
  });

  it('rejects a conflict target that is not a unique constraint', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(values: { id: 1, sku: "A", region: "eu" }, onConflict: { target: [sku] }) { id }
    }`);

    expect(result.errors?.[0]?.message).toContain('is not a unique constraint');
  });

  it('only overwrites rows that match the where guard', async () => {
    const blocked = await run(`mutation {
      upsertItemsSingle(
        values: { id: 1, sku: "A", region: "eu", name: "Blocked" }
        onConflict: { where: { name: { eq: "Missing" } } }
      ) { id }
    }`);

    expect(blocked.errors).toBeUndefined();
    expect((await items())[0]).toMatchObject({ name: 'Original' });
  });
});

describe.sequential('SQLite complexity hints', () => {
  const estimate = (field: any, args: any, childComplexity: number) =>
    field.extensions.complexity({ args, childComplexity });

  it('prices list queries and aggregates the same way the other dialects do', () => {
    const queries = gqlSchema.getQueryType()!.getFields();

    expect(estimate(queries['items'], { limit: 3 }, 2)).toBe(6);
    expect(estimate(queries['items'], {}, 2)).toBe(20);
    expect(estimate(queries['itemsAggregate'], {}, 1)).toBe(11);
    expect(queries['itemsSingle']!.extensions['complexity']).toBeUndefined();
  });
});
