import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql, printType } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── One table per shape a unique constraint comes in ──────────────────────────
const Stock = pgTable(
  'stock',
  {
    id: integer('id').primaryKey(),
    itemId: text('item_id').notNull(),
    locationId: text('location_id').notNull(),
    quantity: integer('quantity').notNull(),
    // A single-column constraint: `eq` already names the row, so it gets no key field.
    barcode: text('barcode').unique(),
  },
  (t) => [unique('stock_item_location').on(t.itemId, t.locationId)],
);

// A composite primary key is a unique constraint like any other.
const Memberships = pgTable(
  'memberships',
  {
    userId: text('user_id').notNull(),
    teamId: text('team_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.teamId] })],
);

// A column already holds the name the constraint's field would take.
const Collisions = pgTable(
  'collisions',
  {
    id: integer('id').primaryKey(),
    a: text('a').notNull(),
    b: text('b').notNull(),
    a_b: text('a_b'),
  },
  (t) => [unique('collisions_a_b').on(t.a, t.b)],
);

const tables = { Stock, Memberships, Collisions };
const relations = buildRelations(tables, { Stock: {}, Memberships: {}, Collisions: {} });

const DATA_DIR = `./tests/.temp/pgdata-unique-key-filters-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema: { ...tables, relations }, relations });

  await db.execute(sql`CREATE TABLE "stock" (
    "id" integer PRIMARY KEY,
    "item_id" text NOT NULL,
    "location_id" text NOT NULL,
    "quantity" integer NOT NULL,
    "barcode" text UNIQUE,
    CONSTRAINT "stock_item_location" UNIQUE("item_id", "location_id")
  );`);
  await db.execute(sql`CREATE TABLE "memberships" (
    "user_id" text NOT NULL,
    "team_id" text NOT NULL,
    "role" text NOT NULL,
    PRIMARY KEY ("user_id", "team_id")
  );`);
  await db.execute(sql`CREATE TABLE "collisions" (
    "id" integer PRIMARY KEY,
    "a" text NOT NULL,
    "b" text NOT NULL,
    "a_b" text,
    CONSTRAINT "collisions_a_b" UNIQUE("a", "b")
  );`);

  gqlSchema = buildSchema(db, { features: { uniqueKeyFilters: true } }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "stock", "memberships", "collisions";`);
  await db.execute(sql`INSERT INTO "stock" VALUES
    (1, 'widget', 'eu', 5, 'bc-1'),
    (2, 'widget', 'us', 9, 'bc-2'),
    (3, 'gadget', 'eu', 2, 'bc-3');`);
  await db.execute(sql`INSERT INTO "memberships" VALUES ('u1', 't1', 'owner'), ('u1', 't2', 'member');`);
  await db.execute(sql`INSERT INTO "collisions" VALUES (1, 'x', 'y', 'own-column');`);
});

describe.sequential('unique key filters', () => {
  it('is off unless asked for', () => {
    const bare = buildSchema(db).schema;
    expect(bare.getTypeMap()['StockItemIdLocationIdKey']).toBeUndefined();
    expect(printType(bare.getTypeMap()['StockFilters']!)).not.toContain('itemId_locationId');
  });

  it('offers one input per compound constraint, with every member required', () => {
    expect(printType(gqlSchema.getTypeMap()['StockItemIdLocationIdKey']!)).toBe(
      [
        '"""',
        'The unique constraint on itemId + locationId of Stock. Every field is required — a half-supplied key is an error, not a broader filter.',
        '"""',
        'input StockItemIdLocationIdKey {',
        '  itemId: String!',
        '  locationId: String!',
        '}',
      ].join('\n'),
    );
    expect(printType(gqlSchema.getTypeMap()['StockFilters']!)).toContain('itemId_locationId: StockItemIdLocationIdKey');
  });

  it('names the row it is a key for', async () => {
    const res = await run(
      `{ stockSingle(where: { itemId_locationId: { itemId: "widget", locationId: "us" } }) { id quantity } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['stockSingle']).toEqual({ id: 2, quantity: 9 });
  });

  it('rejects a half-supplied key instead of returning a broader match', async () => {
    const res = await run(`{ stockSingle(where: { itemId_locationId: { itemId: "widget" } }) { id } }`);

    expect(res.data).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('Field "StockItemIdLocationIdKey.locationId" of required type');
  });

  it('takes the key from variables', async () => {
    const res = await run(
      `query Lookup($item: String!, $location: String!) {
        stockSingle(where: { itemId_locationId: { itemId: $item, locationId: $location } }) { id }
      }`,
      { item: 'gadget', location: 'eu' },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['stockSingle']).toEqual({ id: 3 });
  });

  it('is ANDed with sibling filters like any other', async () => {
    const matches = await run(
      `{ stock(where: { itemId_locationId: { itemId: "widget", locationId: "eu" }, quantity: { gt: 1 } }) { id } }`,
    );
    expect(matches.data?.['stock']).toEqual([{ id: 1 }]);

    const excluded = await run(
      `{ stock(where: { itemId_locationId: { itemId: "widget", locationId: "eu" }, quantity: { gt: 100 } }) { id } }`,
    );
    expect(excluded.data?.['stock']).toEqual([]);
  });

  it('works in a boolean branch', async () => {
    const res = await run(
      `{ stock(where: { OR: [
          { itemId_locationId: { itemId: "widget", locationId: "eu" } },
          { itemId_locationId: { itemId: "gadget", locationId: "eu" } }
        ] }, orderBy: { id: { priority: 1, direction: asc } }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['stock']).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('names the row a single-row write touches', async () => {
    const updated = await run(
      `mutation { updateStockSingle(
        where: { itemId_locationId: { itemId: "widget", locationId: "eu" } }
        set: { quantity: 12 }
      ) { id quantity } }`,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.['updateStockSingle']).toEqual({ id: 1, quantity: 12 });

    const deleted = await run(
      `mutation { deleteStockSingle(where: { itemId_locationId: { itemId: "gadget", locationId: "eu" } }) { id } }`,
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data?.['deleteStockSingle']).toEqual({ id: 3 });
  });

  it('covers a composite primary key', async () => {
    expect(printType(gqlSchema.getTypeMap()['MembershipsFilters']!)).toContain(
      'userId_teamId: MembershipsUserIdTeamIdKey',
    );

    const res = await run(`{ membershipsSingle(where: { userId_teamId: { userId: "u1", teamId: "t2" } }) { role } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['membershipsSingle']).toEqual({ role: 'member' });
  });

  it('leaves a single-column constraint to `eq`', () => {
    const printed = printType(gqlSchema.getTypeMap()['StockFilters']!);
    expect(printed).toContain('barcode: StringFilter');
    expect(gqlSchema.getTypeMap()['StockBarcodeKey']).toBeUndefined();
  });

  it('leaves a name a column already holds to the column', async () => {
    expect(gqlSchema.getTypeMap()['CollisionsABKey']).toBeUndefined();

    const res = await run(`{ collisionsSingle(where: { a_b: { eq: "own-column" } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['collisionsSingle']).toEqual({ id: 1 });
  });

  it('rejects a key field the build did not generate', async () => {
    const bare = buildSchema(db).schema;
    const res = await graphql({
      schema: bare,
      source: `{ stockSingle(where: { itemId_locationId: { itemId: "widget", locationId: "eu" } }) { id } }`,
      contextValue: {},
    });

    expect(res.errors?.[0]?.message).toContain('Field "itemId_locationId" is not defined');
  });
});
