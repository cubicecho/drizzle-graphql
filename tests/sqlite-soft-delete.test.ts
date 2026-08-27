import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';

// The same two shapes the PostgreSQL suite covers, against the SQLite generator: a nullable
// timestamp marker on `Items`, a NOT NULL boolean marker on `Flags`, and `Orgs` declaring
// nothing so it keeps a real DELETE.
const Orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  name: text('name'),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
});
const Flags = sqliteTable('flags', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
  isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
});
const r = createRelationsHelper({ Orgs, Items, Flags });
const relations = buildRelations(
  { Orgs, Items, Flags },
  {
    Orgs: { items: r.many.Items({ from: r.Orgs.id, to: r.Items.orgId }) },
    Items: { org: r.one.Orgs({ from: r.Items.orgId, to: r.Orgs.id }) },
  },
);
const schema = { Orgs, Items, Flags, relations };

let client: Client;
let db: any;

const softDelete: Partial<BuildSchemaConfig> = {
  softDelete: {
    Items: 'deletedAt',
    Flags: { column: 'isArchived', deletedValue: true, restoredValue: false },
  },
};

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error) => error as Error, ...config } as any).schema;

const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue: { ...contextValue } });

beforeAll(async () => {
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "orgs" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.run(
    sql`CREATE TABLE "items" ("id" integer PRIMARY KEY NOT NULL, "org_id" integer NOT NULL, "name" text, "deleted_at" integer);`,
  );
  await db.run(
    sql`CREATE TABLE "flags" ("id" integer PRIMARY KEY NOT NULL, "label" text NOT NULL, "is_archived" integer NOT NULL DEFAULT 0);`,
  );
});

afterAll(() => {
  client.close();
});

// Items 1 and 2 belong to org 1, item 3 to org 2. Item 3 starts out marked.
beforeEach(async () => {
  await db.run(sql`DELETE FROM "items"`);
  await db.run(sql`DELETE FROM "orgs"`);
  await db.run(sql`DELETE FROM "flags"`);
  await db.insert(Orgs).values([
    { id: 1, name: 'Acme' },
    { id: 2, name: 'Globex' },
  ]);
  await db.insert(Items).values([
    { id: 1, orgId: 1, name: 'A1', deletedAt: null },
    { id: 2, orgId: 1, name: 'A2', deletedAt: null },
    { id: 3, orgId: 2, name: 'G1', deletedAt: new Date('2020-01-01T00:00:00Z') },
  ]);
  await db.insert(Flags).values([
    { id: 1, label: 'live', isArchived: false },
    { id: 2, label: 'archived', isArchived: true },
  ]);
});

describe.sequential('SQLite soft delete', () => {
  it('marks the row instead of removing it', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 1 } }) { id deletedAt } }`);

    expect(res.errors).toBeUndefined();
    const deleted = res.data?.['deleteItems'] as any[];
    expect(deleted).toHaveLength(1);
    expect(deleted[0].deletedAt).not.toBeNull();

    const rows = await db.select().from(Items);
    expect(rows).toHaveLength(3);
    expect(rows.find((row: any) => row.id === 1).deletedAt).not.toBeNull();
  });

  it('hides marked rows from every read path, and the argument opts back in', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(
      gqlSchema,
      `{ items { id } itemsSingle(where: { id: { eq: 3 } }) { id } itemsAggregate { count } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.['items']).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.data?.['itemsSingle']).toBeNull();
    expect((res.data?.['itemsAggregate'] as any).count).toBe(2);

    const opened = await run(
      gqlSchema,
      `{ items(deleted: INCLUDE) { id } only: items(deleted: ONLY) { id } itemsAggregate(deleted: INCLUDE) { count } }`,
    );
    expect(opened.errors).toBeUndefined();
    expect((opened.data?.['items'] as any[]).map((i) => i.id)).toEqual([1, 2, 3]);
    expect((opened.data?.['only'] as any[]).map((i) => i.id)).toEqual([3]);
    expect((opened.data?.['itemsAggregate'] as any).count).toBe(3);
  });

  it('hides marked rows inside a relation field and its aggregate', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(
      gqlSchema,
      `{ orgs(orderBy: { id: { priority: 1, direction: asc } }) {
           id items { id } itemsAggregate { count } all: items(deleted: INCLUDE) { id }
         } }`,
    );

    expect(res.errors).toBeUndefined();
    const orgs = res.data?.['orgs'] as any[];
    expect(orgs[1].items).toEqual([]);
    expect(orgs[1].itemsAggregate.count).toBe(0);
    expect((orgs[1].all as any[]).map((i) => i.id)).toEqual([3]);
  });

  it('a write cannot reach a marked row, and restore brings it back', async () => {
    const gqlSchema = buildWith(softDelete);
    const updated = await run(
      gqlSchema,
      `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 3 } }) { id } }`,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.['updateItems']).toEqual([]);

    const restored = await run(gqlSchema, `mutation { restoreItems(where: { id: { eq: 3 } }) { id deletedAt } }`);
    expect(restored.errors).toBeUndefined();
    expect((restored.data?.['restoreItems'] as any[])[0].deletedAt).toBeNull();

    const after = await run(gqlSchema, `{ items { id } }`);
    expect((after.data?.['items'] as any[]).map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('works the same way for a NOT NULL boolean marker', async () => {
    const gqlSchema = buildWith(softDelete);
    const deleted = await run(gqlSchema, `mutation { deleteFlags(where: { id: { eq: 1 } }) { id isArchived } }`);
    expect(deleted.errors).toBeUndefined();
    expect((deleted.data?.['deleteFlags'] as any[])[0].isArchived).toBe(true);

    const only = await run(gqlSchema, `{ flags(deleted: ONLY) { id } }`);
    expect((only.data?.['flags'] as any[]).map((f) => f.id).sort()).toEqual([1, 2]);

    const restored = await run(gqlSchema, `mutation { restoreFlags(where: { id: { eq: 1 } }) { id isArchived } }`);
    expect((restored.data?.['restoreFlags'] as any[])[0].isArchived).toBe(false);
  });

  it('keeps the marker out of the write inputs, and leaves an undeclared table alone', async () => {
    const gqlSchema = buildWith(softDelete);
    const createInput = gqlSchema.getType('CreateItemsInput') as GraphQLInputObjectType;
    expect(Object.keys(createInput.getFields())).not.toContain('deletedAt');
    const updateInput = gqlSchema.getType('UpdateItemsInput') as GraphQLInputObjectType;
    expect(Object.keys(updateInput.getFields())).not.toContain('deletedAt');
    // It is still readable and still filterable — only the write side loses it.
    expect(Object.keys((gqlSchema.getType('Items') as GraphQLObjectType).getFields())).toContain('deletedAt');

    const mutations = gqlSchema.getMutationType()!.getFields();
    expect(mutations['restoreItems']).toBeDefined();
    expect(mutations['restoreOrgs']).toBeUndefined();
    expect(
      gqlSchema
        .getQueryType()!
        .getFields()
        ['orgs']!.args.map((a) => a.name),
    ).not.toContain('deleted');

    const res = await run(gqlSchema, `mutation { deleteOrgs(where: { id: { eq: 2 } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(await db.select().from(Orgs)).toHaveLength(1);
  });

  it('composes with a scope, which still applies on top', async () => {
    const gqlSchema = buildWith({
      ...softDelete,
      scope: { Items: (ctx: any, table: any) => eq(table.orgId, ctx.orgId) },
    });

    const mine = await run(gqlSchema, `{ items { id } }`, { orgId: 1 });
    expect(mine.errors).toBeUndefined();
    expect((mine.data?.['items'] as any[]).map((i) => i.id)).toEqual([1, 2]);

    // Org 2 owns only the marked row, so even INCLUDE stays inside the scope.
    const theirs = await run(gqlSchema, `{ items(deleted: INCLUDE) { id } }`, { orgId: 2 });
    expect((theirs.data?.['items'] as any[]).map((i) => i.id)).toEqual([3]);
    const theirsDefault = await run(gqlSchema, `{ items { id } }`, { orgId: 2 });
    expect(theirsDefault.data?.['items']).toEqual([]);
  });
});
