import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, type WriteHook, type WriteHookPayload } from '@/index';

const Orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id'),
  name: text('name'),
  deletedAt: text('deleted_at'),
});
const r = createRelationsHelper({ Orgs, Items });
const relations = buildRelations(
  { Orgs, Items },
  {
    Orgs: { items: r.many.Items({ from: r.Orgs.id, to: r.Items.orgId }) },
    Items: { org: r.one.Orgs({ from: r.Items.orgId, to: r.Orgs.id }) },
  },
);
const schema = { Orgs, Items, relations };

// A file database: libsql's `:memory:` loses its data once a transaction ends, and every
// hooked write runs in one.
let dir: string;
let client: Client;
let db: any;

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error: unknown) => error as Error, ...config }).schema;

const run = async (gqlSchema: GraphQLSchema, source: string) => {
  const res = await graphql({ schema: gqlSchema, source, contextValue: {} });
  expect(res.errors).toBeUndefined();
  return res;
};

let calls: string[] = [];
const log =
  (tag: string): WriteHook =>
  (payload: WriteHookPayload) => {
    const nested = payload.nested ? `:${payload.nested.op}` : '';
    calls.push(`${tag}:${payload.table}:${payload.operation}:${payload.position}${nested}`);
  };
const rowKeys =
  (tag: string): WriteHook =>
  (payload: WriteHookPayload) => {
    calls.push(`${tag}:${payload.operation}:${payload.rows.map((row) => Object.keys(row).sort().join('+')).join(',')}`);
  };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drizzle-graphql-on-write-per-op-'));
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  db = (drizzle as any)({ client, schema, relations });
  await db.run(sql`CREATE TABLE "orgs" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.run(
    sql`CREATE TABLE "items" ("id" integer PRIMARY KEY NOT NULL, "org_id" integer, "name" text, "deleted_at" text);`,
  );
});

afterAll(async () => {
  client.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  await db.run(sql`DELETE FROM "items"`);
  await db.run(sql`DELETE FROM "orgs"`);
  await db.insert(Orgs).values([{ id: 1, name: 'Acme' }]);
  await db.insert(Items).values([
    { id: 1, orgId: 1, name: 'A1' },
    { id: 2, orgId: 1, name: 'A2' },
  ]);
});

describe.sequential('SQLite onWrite per operation', () => {
  it('runs each operation key for that operation only', async () => {
    const gqlSchema = buildWith({
      features: { upsert: true, countMutations: true },
      softDelete: { Items: 'deletedAt' },
      onWrite: {
        Items: {
          insert: log('insert'),
          update: log('update'),
          updateMany: log('updateMany'),
          upsert: log('upsert'),
          delete: log('delete'),
          restore: log('restore'),
        },
      },
    });

    await run(gqlSchema, `mutation { createItemsSingle(values: { id: 3, name: "A3" }) { id } }`);
    await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { id } }`);
    await run(
      gqlSchema,
      `mutation { updateItemsMany(updates: [{ set: { name: "y" }, where: { id: { eq: 2 } } }]) { id } }`,
    );
    await run(gqlSchema, `mutation { upsertItems(values: [{ id: 4, name: "A4" }]) { id } }`);
    await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 4 } }) { id } }`);
    await run(gqlSchema, `mutation { restoreItems(where: { id: { eq: 4 } }) { id } }`);
    await run(gqlSchema, `mutation { updateItemsCount(set: { name: "z" }, where: { id: { eq: 1 } }) }`);
    await run(gqlSchema, `mutation { deleteItemsCount(where: { id: { eq: 3 } }) }`);

    expect(calls).toEqual([
      'insert:Items:insert:after',
      'update:Items:update:after',
      'updateMany:Items:updateMany:after',
      'upsert:Items:upsert:after',
      'delete:Items:delete:after',
      'restore:Items:restore:after',
      'update:Items:update:after',
      'delete:Items:delete:after',
    ]);
  });

  it('runs the shared positions first, then the operation key', async () => {
    const gqlSchema = buildWith({
      onWrite: { Items: { before: log('shared'), update: { before: log('own'), after: log('own') } } },
    });

    await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { id } }`);
    await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 2 } }) { id } }`);

    expect(calls).toEqual([
      'shared:Items:update:before',
      'own:Items:update:before',
      'own:Items:update:after',
      'shared:Items:delete:before',
    ]);
  });

  it('reads operation keys alone at the top level as every table, and combines them with shared positions', async () => {
    const opsOnly = buildWith({ onWrite: { insert: log('insert') } });
    await run(opsOnly, `mutation { createOrgs(values: [{ id: 2, name: "Beta" }]) { id } }`);
    await run(opsOnly, `mutation { createItems(values: [{ id: 3, name: "B1" }]) { id } }`);
    await run(opsOnly, `mutation { deleteItems(where: { id: { eq: 3 } }) { id } }`);

    const combined = buildWith({ onWrite: { after: log('shared'), delete: { before: log('own') } } });
    await run(combined, `mutation { deleteOrgs(where: { id: { eq: 2 } }) { id } }`);

    expect(calls).toEqual([
      'insert:Orgs:insert:after',
      'insert:Items:insert:after',
      'own:Orgs:delete:before',
      'shared:Orgs:delete:after',
    ]);
  });

  it("adds an operation's columns to that operation's rows only", async () => {
    const gqlSchema = buildWith({
      onWrite: { Items: { insert: rowKeys('insert'), delete: { after: rowKeys('delete'), columns: ['orgId'] } } },
    });

    await run(gqlSchema, `mutation { createItems(values: [{ id: 3, orgId: 1 }]) { id } }`);
    const deleted = await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 3 } }) { id } }`);

    expect(calls).toEqual(['insert:insert:id', 'delete:delete:id+orgId']);
    expect(deleted.data).toEqual({ deleteItems: [{ id: 3 }] });
  });

  it('fires nested statements under the operation they perform', async () => {
    const gqlSchema = buildWith({
      features: { nestedWrites: true },
      onWrite: { Items: { insert: log('insert'), update: log('update') }, Orgs: { update: log('orgs') } },
    });

    await run(
      gqlSchema,
      `mutation { createOrgsSingle(values: { id: 2, name: "Beta", items: {
        create: [{ id: 3, name: "B1" }], connect: [{ id: { eq: 2 } }]
      } }) { id } }`,
    );

    // The root insert of Orgs has no `insert` key, so only the nested statements fire.
    expect(calls).toEqual(['update:Items:update:after:connect', 'insert:Items:insert:after:create']);
  });

  it('treats a null hook, columns or operation key as no hook', async () => {
    const off: WriteHook | null = null;
    const gqlSchema = buildWith({
      onWrite: {
        Items: {
          before: off,
          after: log('shared'),
          columns: null,
          update: { before: off, after: log('own') },
          delete: null,
        },
        Orgs: { restore: null },
      },
    });

    await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { id } }`);
    await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 2 } }) { id } }`);

    expect(calls).toEqual(['shared:Items:update:after', 'own:Items:update:after', 'shared:Items:delete:after']);
    expect(() => buildWith({ onWrite: { Items: { before: 'nope' as any } } })).toThrow(
      'config.onWrite.Items.before must be a function, got string.',
    );
  });

  it('fails the build for an unknown operation key or a restore the table lacks', () => {
    expect(() => buildWith({ onWrite: { Items: { remove: () => {} } as any } })).toThrow(
      "config.onWrite.Items has an unknown key 'remove'",
    );
    expect(() => buildWith({ onWrite: { Orgs: { restore: () => {} } } })).toThrow(
      "config.onWrite.Orgs.restore is registered, but 'Orgs' does not soft-delete",
    );
  });
});
