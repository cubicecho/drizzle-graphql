// A write whose arguments alone are invalid is refused before the `before` hook runs, on every
// write path, and a valid write fires it exactly once. The hook can write (it gets `tx`), so a
// request it saw but the library then refused would have run consumer side effects for nothing.
// The same cases run on SQLite (libsql) and PGlite; tests/mysql-before-hook-order.test.ts covers
// MySQL.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/libsql';
import { integer as pgInteger, pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const sqliteTables = {
  Orgs: sqliteTable('orgs', { id: integer('id').primaryKey(), name: text('name') }),
  Items: sqliteTable('items', {
    id: integer('id').primaryKey(),
    orgId: integer('org_id'),
    qty: integer('qty'),
    deletedAt: text('deleted_at'),
  }),
};
const pgTables = {
  Orgs: pgTable('orgs', { id: pgInteger('id').primaryKey(), name: pgText('name') }),
  Items: pgTable('items', {
    id: pgInteger('id').primaryKey(),
    orgId: pgInteger('org_id'),
    qty: pgInteger('qty'),
    deletedAt: pgText('deleted_at'),
  }),
};

const relationsOf = (tables: typeof sqliteTables | typeof pgTables) => {
  const r = createRelationsHelper(tables);
  return buildRelations(tables, {
    Orgs: { items: r.many.Items({ from: r.Orgs.id, to: r.Items.orgId }) },
    Items: { org: r.one.Orgs({ from: r.Items.orgId, to: r.Orgs.id }) },
  });
};

const CREATE_ORGS = sql`CREATE TABLE orgs (id integer PRIMARY KEY NOT NULL, name text)`;
const CREATE_ITEMS = sql`CREATE TABLE items (id integer PRIMARY KEY NOT NULL, org_id integer, qty integer, deleted_at text)`;

/** A request the library must refuse from its arguments alone, and the code it refuses with. */
type Rejected = { name: string; source: string; code: string };

const REJECTED: Rejected[] = [
  { name: 'insert: no values', source: 'createItems(values: []) { id }', code: 'DRIZZLE_NO_VALUES' },
  {
    name: 'insert: nested connect matching every row',
    source: 'createItems(values: [{ id: 9, org: { connect: {} } }]) { id }',
    code: 'DRIZZLE_NESTED_WRITE_INVALID',
  },
  {
    name: 'insertSingle: nested to-one given two inputs',
    source: 'createItemsSingle(values: { id: 9, org: { create: { id: 5 }, connect: { id: { eq: 1 } } } }) { id }',
    code: 'DRIZZLE_NESTED_WRITE_INVALID',
  },
  { name: 'upsert: no values', source: 'upsertItems(values: []) { id }', code: 'DRIZZLE_NO_VALUES' },
  {
    name: 'upsert: conflict update naming a column the values leave out',
    source: 'upsertItems(values: [{ id: 1 }], onConflict: { update: [qty] }) { id }',
    code: 'DRIZZLE_INVALID_ON_CONFLICT',
  },
  {
    name: 'update: empty set',
    source: 'updateItems(where: { id: { eq: 1 } }, set: {}) { id }',
    code: 'DRIZZLE_NO_VALUES',
  },
  {
    name: 'update: where matching every row under requireWhere',
    source: 'updateItems(where: {}, set: { qty: { set: 2 } }) { id }',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  {
    name: 'update: two field operations on one column',
    source: 'updateItems(where: { id: { eq: 1 } }, set: { qty: { increment: 1, decrement: 1 } }) { id }',
    code: 'DRIZZLE_INVALID_UPDATE_OPERATION',
  },
  {
    name: 'update: nested connect matching every row',
    source: 'updateOrgs(where: { id: { eq: 1 } }, set: { items: { connect: [{}] } }) { id }',
    code: 'DRIZZLE_NESTED_WRITE_INVALID',
  },
  {
    name: 'updateSingle: empty where',
    source: 'updateItemsSingle(where: {}, set: { qty: { set: 2 } }) { id }',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  { name: 'updateMany: no updates', source: 'updateItemsMany(updates: []) { id }', code: 'DRIZZLE_NO_VALUES' },
  {
    name: 'updateMany: an entry with an empty set',
    source: 'updateItemsMany(updates: [{ where: { id: { eq: 1 } }, set: {} }]) { id }',
    code: 'DRIZZLE_NO_VALUES',
  },
  {
    name: 'updateMany: an entry without a where under requireWhere',
    source: 'updateItemsMany(updates: [{ set: { qty: { set: 2 } } }]) { id }',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  { name: 'delete: empty where', source: 'deleteItems(where: {}) { id }', code: 'DRIZZLE_WHERE_REQUIRED' },
  { name: 'deleteSingle: empty where', source: 'deleteItemsSingle(where: {}) { id }', code: 'DRIZZLE_WHERE_REQUIRED' },
  { name: 'restore: empty where', source: 'restoreItems(where: {}) { id }', code: 'DRIZZLE_WHERE_REQUIRED' },
  {
    name: 'update count: empty set',
    source: 'updateItemsCount(where: { id: { eq: 1 } }, set: {})',
    code: 'DRIZZLE_NO_VALUES',
  },
  {
    name: 'update count: empty where',
    source: 'updateItemsCount(where: {}, set: { qty: { set: 2 } })',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  { name: 'delete count: empty where', source: 'deleteItemsCount(where: {})', code: 'DRIZZLE_WHERE_REQUIRED' },
];

/** One valid request per path: each fires the hook once. */
const ACCEPTED: { name: string; source: string }[] = [
  { name: 'insert', source: 'createItems(values: [{ id: 3 }]) { id }' },
  { name: 'insertSingle', source: 'createItemsSingle(values: { id: 3 }) { id }' },
  { name: 'upsert', source: 'upsertItems(values: [{ id: 1, qty: 5 }]) { id }' },
  { name: 'update', source: 'updateItems(where: { id: { eq: 1 } }, set: { qty: { set: 2 } }) { id }' },
  { name: 'updateSingle', source: 'updateItemsSingle(where: { id: { eq: 1 } }, set: { qty: { set: 2 } }) { id }' },
  {
    name: 'updateMany',
    source: 'updateItemsMany(updates: [{ where: { id: { eq: 1 } }, set: { qty: { set: 2 } } }]) { id }',
  },
  { name: 'delete', source: 'deleteItems(where: { id: { eq: 1 } }) { id }' },
  { name: 'deleteSingle', source: 'deleteItemsSingle(where: { id: { eq: 1 } }) { id }' },
  { name: 'restore', source: 'restoreItems(where: { id: { eq: 2 } }) { id }' },
  { name: 'update count', source: 'updateItemsCount(where: { id: { eq: 1 } }, set: { qty: { set: 2 } })' },
  { name: 'delete count', source: 'deleteItemsCount(where: { id: { eq: 1 } })' },
];

type Harness = {
  db: any;
  setUp: () => Promise<void>;
  tearDown: () => Promise<void>;
};

const sqliteHarness = (): Harness => {
  let dir: string;
  let client: Client;
  const harness: Harness = {
    db: undefined,
    // A file, not `:memory:`: libsql loses an in-memory database after a transaction, and
    // every hooked write runs in one.
    setUp: async () => {
      dir = await mkdtemp(join(tmpdir(), 'dgql-before-hook-'));
      client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
      harness.db = (drizzleSqlite as any)({ client, relations: relationsOf(sqliteTables) });
      await harness.db.run(CREATE_ORGS);
      await harness.db.run(CREATE_ITEMS);
    },
    tearDown: async () => {
      client?.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return harness;
};

const pgliteHarness = (): Harness => {
  let pglite: PGlite;
  const harness: Harness = {
    db: undefined,
    setUp: async () => {
      pglite = new PGlite();
      await pglite.waitReady;
      harness.db = (drizzlePglite as any)({ client: pglite, relations: relationsOf(pgTables) });
      await harness.db.execute(CREATE_ORGS);
      await harness.db.execute(CREATE_ITEMS);
    },
    tearDown: async () => {
      await pglite?.close().catch(() => {});
    },
  };
  return harness;
};

const dialects: [string, () => Harness, typeof sqliteTables | typeof pgTables][] = [
  ['sqlite', sqliteHarness, sqliteTables],
  ['pglite', pgliteHarness, pgTables],
];

for (const [dialect, makeHarness, tables] of dialects) {
  describe.sequential(`${dialect}: the before hook runs only once the arguments have passed`, () => {
    const harness = makeHarness();
    let schema: GraphQLSchema;
    let fired = 0;

    beforeAll(async () => {
      await harness.setUp();
      schema = buildSchema(harness.db, {
        onError: (error: unknown) => error as Error,
        features: {
          upsert: true,
          countMutations: true,
          nestedWrites: true,
          requireWhere: true,
          fieldUpdateOperations: true,
        },
        softDelete: { Items: 'deletedAt' },
        onWrite: {
          Items: {
            before: () => {
              fired++;
            },
          },
          Orgs: {
            before: () => {
              fired++;
            },
          },
        },
      } as any).schema;
    });

    afterAll(async () => {
      await harness.tearDown();
    });

    beforeEach(async () => {
      fired = 0;
      await harness.db.delete(tables.Items);
      await harness.db.delete(tables.Orgs);
      await harness.db.insert(tables.Orgs).values([{ id: 1, name: 'Acme' }]);
      await harness.db.insert(tables.Items).values([
        { id: 1, orgId: 1, qty: 1 },
        { id: 2, orgId: 1, qty: 1, deletedAt: 'gone' },
      ]);
    });

    it.each(REJECTED)('$name: refused without firing the hook', async ({ source, code }) => {
      const res = await graphql({ schema, source: `mutation { ${source} }`, contextValue: {} });

      expect(res.errors?.[0]?.extensions?.['code']).toBe(code);
      expect(fired).toBe(0);
    });

    it.each(ACCEPTED)('$name: fires the hook once', async ({ source }) => {
      const res = await graphql({ schema, source: `mutation { ${source} }`, contextValue: {} });

      expect(res.errors).toBeUndefined();
      expect(fired).toBe(1);
    });
  });
}
