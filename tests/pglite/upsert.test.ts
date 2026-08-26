import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── Schema with something to conflict on ──────────────────────────────────────
const Items = pgTable(
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
// No primary key and no unique constraint: nothing to conflict on.
const Logs = pgTable('logs', { body: text('body') });

const relations = buildRelations({ Items, Logs }, { Items: {}, Logs: {} });
const schema = { Items, Logs, relations };

const DATA_DIR = `./tests/.temp/pgdata-upsert-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const items = () => db.select().from(Items).orderBy(Items.id);

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "items" (
		"id" integer PRIMARY KEY NOT NULL,
		"sku" text NOT NULL,
		"region" text NOT NULL,
		"name" text,
		"qty" integer,
		CONSTRAINT "items_sku_region" UNIQUE("sku", "region")
	);`);
  await db.execute(sql`CREATE TABLE "logs" ("body" text);`);

  gqlSchema = buildSchema(db, { features: { upsert: true } }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM "items"`);
  await db.insert(Items).values({ id: 1, sku: 'A', region: 'eu', name: 'Original', qty: 5 });
});

describe.sequential('upsert: generated surface', () => {
  it('generates nothing unless the feature is switched on', () => {
    const defaults = buildSchema(db).schema;

    expect(defaults.getMutationType()!.getFields()['upsertItems']).toBeUndefined();
    expect(defaults.getMutationType()!.getFields()['upsertItemsSingle']).toBeUndefined();
    expect(defaults.getType('ItemsOnConflict')).toBeUndefined();
    expect(defaults.getType('ItemsConflictTarget')).toBeUndefined();
  });

  it('generates array and single upsert mutations when switched on', () => {
    const mutations = gqlSchema.getMutationType()!.getFields();

    expect(mutations['upsertItems']).toBeDefined();
    expect(mutations['upsertItemsSingle']).toBeDefined();
    expect(mutations['upsertItems']!.args.map((a) => a.name).sort()).toEqual(['onConflict', 'values']);
    // The upsert reuses the insert input rather than emitting an identical copy.
    expect(gqlSchema.getType('CreateItemsInput')).toBeDefined();
  });

  it('offers only unique column sets as conflict targets', () => {
    const target = gqlSchema.getType('ItemsConflictTarget') as any;

    expect(Object.keys(target.getValues ? target.toConfig().values : {}).sort()).toEqual(['id', 'region', 'sku']);
    // Any column can be overwritten, unique or not.
    expect(Object.keys((gqlSchema.getType('ItemsUpdateColumn') as any).toConfig().values).sort()).toEqual([
      'id',
      'name',
      'qty',
      'region',
      'sku',
    ]);
  });

  it('skips a table that has nothing to conflict on', () => {
    const mutations = gqlSchema.getMutationType()!.getFields();

    expect(mutations['upsertLogs']).toBeUndefined();
    expect(gqlSchema.getType('LogsOnConflict')).toBeUndefined();
    // Its ordinary mutations are untouched.
    expect(mutations['createLogs']).toBeDefined();
  });
});

describe.sequential('upsert: behaviour', () => {
  it('inserts a row that does not conflict', async () => {
    const result = await run(
      `mutation { upsertItemsSingle(values: { id: 2, sku: "B", region: "eu", name: "New", qty: 1 }) { id name } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItemsSingle']).toMatchObject({ id: 2, name: 'New' });
    expect(await items()).toHaveLength(2);
  });

  it('overwrites the conflicting row on the primary key by default', async () => {
    const result = await run(
      `mutation { upsertItemsSingle(values: { id: 1, sku: "A", region: "eu", name: "Replaced", qty: 9 }) { id name qty } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItemsSingle']).toMatchObject({ id: 1, name: 'Replaced', qty: 9 });
    expect(await items()).toHaveLength(1);
  });

  it('updates each row of a batch with its own values', async () => {
    await db.insert(Items).values({ id: 2, sku: 'B', region: 'eu', name: 'Second', qty: 2 });

    const result = await run(`mutation {
      upsertItems(values: [
        { id: 1, sku: "A", region: "eu", name: "One", qty: 11 },
        { id: 2, sku: "B", region: "eu", name: "Two", qty: 22 },
        { id: 3, sku: "C", region: "eu", name: "Three", qty: 33 }
      ]) { id name qty }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItems']).toEqual([
      { id: 1, name: 'One', qty: 11 },
      { id: 2, name: 'Two', qty: 22 },
      { id: 3, name: 'Three', qty: 33 },
    ]);
  });

  it('leaves the existing row alone when the action is NOTHING', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(
        values: { id: 1, sku: "A", region: "eu", name: "Ignored", qty: 99 }
        onConflict: { action: NOTHING }
      ) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    // Nothing was inserted, so there is no row to return.
    expect(result.data?.['upsertItemsSingle']).toBeNull();
    expect((await items())[0]).toMatchObject({ name: 'Original', qty: 5 });
  });

  it('conflicts on an explicit unique constraint instead of the primary key', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(
        values: { id: 7, sku: "A", region: "eu", name: "BySku", qty: 3 }
        onConflict: { target: [sku, region], update: [name, qty] }
      ) { id name qty }
    }`);

    expect(result.errors).toBeUndefined();
    // The row kept its original id — it was updated, not inserted.
    expect(result.data?.['upsertItemsSingle']).toMatchObject({ id: 1, name: 'BySku', qty: 3 });
    expect(await items()).toHaveLength(1);
  });

  it('rejects a conflict target that is not a unique constraint', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(values: { id: 1, sku: "A", region: "eu" }, onConflict: { target: [sku] }) { id }
    }`);

    expect(result.errors?.[0]?.message).toContain('is not a unique constraint');
    // The error names the targets that would have worked.
    expect(result.errors?.[0]?.message).toContain('[id]');
    expect(result.errors?.[0]?.message).toContain('[sku, region]');
  });

  it('overwrites only the listed columns', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(
        values: { id: 1, sku: "A", region: "eu", name: "Fresh", qty: 42 }
        onConflict: { update: [qty] }
      ) { id name qty }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertItemsSingle']).toMatchObject({ name: 'Original', qty: 42 });
  });

  it('rejects an update column the values do not supply', async () => {
    const result = await run(`mutation {
      upsertItemsSingle(values: { id: 1, sku: "A", region: "eu" }, onConflict: { update: [name] }) { id }
    }`);

    expect(result.errors?.[0]?.message).toContain('which the values do not supply');
  });

  it('only overwrites rows that match the where guard', async () => {
    const blocked = await run(`mutation {
      upsertItemsSingle(
        values: { id: 1, sku: "A", region: "eu", name: "Blocked", qty: 1 }
        onConflict: { where: { name: { eq: "Missing" } } }
      ) { id name }
    }`);

    expect(blocked.errors).toBeUndefined();
    expect(blocked.data?.['upsertItemsSingle']).toBeNull();
    expect((await items())[0]).toMatchObject({ name: 'Original' });

    const allowed = await run(`mutation {
      upsertItemsSingle(
        values: { id: 1, sku: "A", region: "eu", name: "Allowed", qty: 1 }
        onConflict: { where: { name: { eq: "Original" } } }
      ) { id name }
    }`);

    expect(allowed.errors).toBeUndefined();
    expect(allowed.data?.['upsertItemsSingle']).toMatchObject({ name: 'Allowed' });
  });

  it('does nothing when the only supplied columns are the conflict target', async () => {
    const result = await run(`mutation { upsertItemsSingle(values: { id: 1, sku: "A", region: "eu" }) { id } }`);

    // sku/region are supplied too, so this really is an update of those columns.
    expect(result.errors).toBeUndefined();
    expect((await items())[0]).toMatchObject({ name: 'Original', qty: 5 });
  });
});
