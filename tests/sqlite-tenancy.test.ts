import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, GraphQLObjectType, GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';

const Orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  name: text('name'),
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

let client: Client;
let db: any;

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema => buildSchema(db, config as any).schema;

const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue: { ...contextValue } });

beforeAll(async () => {
  // A shared-cache in-memory database: a plain `:memory:` connection is discarded when a
  // transaction rolls back, which the batch-update path opens.
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "orgs" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.run(sql`CREATE TABLE "items" ("id" integer PRIMARY KEY NOT NULL, "org_id" integer NOT NULL, "name" text);`);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "items"`);
  await db.run(sql`DELETE FROM "orgs"`);
  await db.insert(Orgs).values([
    { id: 1, name: 'Acme' },
    { id: 2, name: 'Globex' },
  ]);
  await db.insert(Items).values([
    { id: 1, orgId: 1, name: 'A1' },
    { id: 2, orgId: 1, name: 'A2' },
    { id: 3, orgId: 2, name: 'G1' },
  ]);
});

// The same policy the PostgreSQL suite exercises, run against the SQLite generator.
const ownItems: Partial<BuildSchemaConfig> = {
  scope: { Items: (ctx: any, table: any) => eq(table.orgId, ctx.orgId) },
};

describe.sequential('SQLite row scope', () => {
  it('confines a list query, a single query and an aggregate', async () => {
    const gqlSchema = buildWith(ownItems);
    const res = await run(
      gqlSchema,
      `{ items { id } itemsSingle(where: { id: { eq: 3 } }) { id } itemsAggregate { count } }`,
      { orgId: 1 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['items']).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.data?.['itemsSingle']).toBeNull();
    expect(res.data?.['itemsAggregate']).toEqual({ count: 2 });
  });

  it('confines a relation field and its aggregate', async () => {
    const gqlSchema = buildWith(ownItems);
    const res = await run(
      gqlSchema,
      `{ orgs(orderBy: { id: { direction: asc, priority: 1 } }) { id items { id } itemsAggregate { count } } }`,
      { orgId: 1 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['orgs']).toEqual([
      { id: 1, items: [{ id: 1 }, { id: 2 }], itemsAggregate: { count: 2 } },
      { id: 2, items: [], itemsAggregate: { count: 0 } },
    ]);
  });

  it('confines update, updateMany and delete', async () => {
    const gqlSchema = buildWith(ownItems);
    // One document each: the libsql in-memory client cannot run a delete after a batch
    // update's transaction in the same request.
    const updated = await run(
      gqlSchema,
      `mutation { updateItems(where: { id: { eq: 3 } }, set: { name: "TAKEN" }) { id } }`,
      {
        orgId: 1,
      },
    );
    const batched = await run(
      gqlSchema,
      `mutation { updateItemsMany(updates: [{ where: { id: { eq: 3 } }, set: { name: "TAKEN" } }]) { id } }`,
      { orgId: 1 },
    );
    const deleted = await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 3 } }) { id } }`, { orgId: 1 });

    expect(updated.errors).toBeUndefined();
    expect(updated.data?.['updateItems']).toEqual([]);
    expect(batched.errors).toBeUndefined();
    expect(batched.data?.['updateItemsMany']).toEqual([null]);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data?.['deleteItems']).toEqual([]);
    const [row] = await db.select().from(Items).where(eq(Items.id, 3));
    expect(row).toMatchObject({ id: 3, name: 'G1' });
  });

  it('confines the count mutations, and counts only in-scope rows', async () => {
    const gqlSchema = buildWith({ ...ownItems, features: { countMutations: true } });
    const updated = await run(gqlSchema, `mutation { updateItemsCount(set: { name: "MINE" }) }`, { orgId: 1 });
    const deleted = await run(gqlSchema, `mutation { deleteItemsCount(where: { id: { inArray: [2, 3] } }) }`, {
      orgId: 1,
    });

    expect(updated.errors).toBeUndefined();
    expect(updated.data).toEqual({ updateItemsCount: 2 });
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data).toEqual({ deleteItemsCount: 1 });
    expect(await db.select().from(Items).orderBy(Items.id)).toEqual([
      { id: 1, orgId: 1, name: 'MINE' },
      { id: 3, orgId: 2, name: 'G1' },
    ]);
  });

  it("stops an upsert's conflict branch from taking over an out-of-scope row", async () => {
    const gqlSchema = buildWith({ ...ownItems, features: { upsert: true } });
    const res = await run(
      gqlSchema,
      `mutation { upsertItemsSingle(values: { id: 3, orgId: 2, name: "TAKEN" }) { id } }`,
      { orgId: 1 },
    );

    expect(res.errors).toBeUndefined();
    const [row] = await db.select().from(Items).where(eq(Items.id, 3));
    expect(row.name).toBe('G1');
  });

  it('accepts a filter object that scopes through a relation', async () => {
    const gqlSchema = buildWith({ scope: { Items: (ctx: any) => ({ org: { name: { eq: ctx.org } } }) } });
    const res = await run(gqlSchema, `{ items { id } }`, { org: 'Globex' });

    expect(res.errors).toBeUndefined();
    expect(res.data?.['items']).toEqual([{ id: 3 }]);
  });
});

describe.sequential('SQLite context-derived column values', () => {
  const stamped: Partial<BuildSchemaConfig> = {
    contextValues: { Items: { orgId: (ctx: any) => ctx.orgId } },
  };

  it('removes the column from the write inputs and stamps it on insert', async () => {
    const gqlSchema = buildWith(stamped);
    const insert = gqlSchema.getType('CreateItemsInput') as GraphQLInputObjectType;
    const update = gqlSchema.getType('UpdateItemsInput') as GraphQLInputObjectType;
    expect(Object.keys(insert.getFields())).not.toContain('orgId');
    expect(Object.keys(update.getFields())).not.toContain('orgId');

    const res = await run(gqlSchema, `mutation { createItemsSingle(values: { id: 9, name: "New" }) { orgId } }`, {
      orgId: 2,
    });

    expect(res.errors).toBeUndefined();
    expect(res.data?.['createItemsSingle']).toEqual({ orgId: 2 });
  });

  it('leaves the column untouched by an update', async () => {
    const gqlSchema = buildWith(stamped);
    const res = await run(
      gqlSchema,
      `mutation { updateItems(where: { id: { eq: 3 } }, set: { name: "EDITED" }) { id orgId name } }`,
      { orgId: 1 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateItems']).toEqual([{ id: 3, orgId: 2, name: 'EDITED' }]);
  });

  it('leaves the column untouched by a count update, even when the key is stitched in', async () => {
    const { entities } = buildSchema(db, { ...stamped, features: { countMutations: true } } as any);
    const generated = (entities.mutations as any)['updateItemsCount'];
    // Lets the key past input validation, as a stitched schema can, so only the resolver
    // stands between the request and the ownership column.
    const stitched = new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Query', fields: { items: (entities.queries as any)['items'] } }),
      mutation: new GraphQLObjectType({
        name: 'Mutation',
        fields: {
          updateItemsCount: {
            ...generated,
            resolve: (source: unknown, args: any, context: unknown, info: unknown) =>
              generated.resolve(source, { ...args, set: { ...args.set, orgId: 1 } }, context, info),
          },
        },
      }),
    });

    const res = await run(
      stitched,
      `mutation { updateItemsCount(where: { id: { eq: 3 } }, set: { name: "EDITED" }) }`,
      {
        orgId: 1,
      },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateItemsCount: 1 });
    const [row] = await db.select().from(Items).where(eq(Items.id, 3));
    expect(row).toEqual({ id: 3, orgId: 2, name: 'EDITED' });
  });
});
