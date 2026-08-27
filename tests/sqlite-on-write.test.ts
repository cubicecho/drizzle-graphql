import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, type WriteHookPayload } from '@/index';

const Orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  name: text('name'),
});
// Written only by hooks, so its contents are the record of what committed.
const Audit = sqliteTable('audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  operation: text('operation').notNull(),
  position: text('position').notNull(),
  detail: text('detail'),
});
const r = createRelationsHelper({ Orgs, Items, Audit });
const relations = buildRelations(
  { Orgs, Items, Audit },
  { Orgs: { items: r.many.Items({ from: r.Orgs.id, to: r.Items.orgId }) } },
);
const schema = { Orgs, Items, Audit, relations };

let client: Client;
let db: any;

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error) => error as Error, ...config } as any).schema;

const run = (gqlSchema: GraphQLSchema, source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });

const auditRows = async () => await db.select().from(Audit).orderBy(Audit.id);

const record = async (payload: WriteHookPayload) => {
  await payload.tx.insert(Audit).values({
    tableName: payload.table,
    operation: payload.operation,
    position: payload.position,
    detail: payload.rows.map((row: any) => row.id).join(','),
  });
};

beforeAll(async () => {
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "orgs" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.run(
    sql`CREATE TABLE "items" ("id" integer PRIMARY KEY NOT NULL, "org_id" integer NOT NULL, "name" text);`,
  );
  await db.run(
    sql`CREATE TABLE "audit" ("id" integer PRIMARY KEY AUTOINCREMENT, "table_name" text NOT NULL, "operation" text NOT NULL, "position" text NOT NULL, "detail" text);`,
  );
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "audit"`);
  await db.run(sql`DELETE FROM "items"`);
  await db.run(sql`DELETE FROM "orgs"`);
  await db.insert(Orgs).values([{ id: 1, name: 'Acme' }]);
  await db.insert(Items).values([
    { id: 1, orgId: 1, name: 'A1' },
    { id: 2, orgId: 1, name: 'A2' },
  ]);
});

describe.sequential('SQLite onWrite', () => {
  it('runs after the write and commits with the mutation', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: record } });
    const res = await run(gqlSchema, `mutation { createItems(values: [{ id: 3, orgId: 1 }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([
      expect.objectContaining({ tableName: 'Items', operation: 'insert', position: 'after', detail: '3' }),
    ]);
  });

  it('throwing rolls a single mutation field back', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Items: async () => {
          throw new Error('audit failed');
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createItems(values: [{ id: 3, orgId: 1 }]) { id } }`);
    expect(res.errors?.[0]?.message).toContain('audit failed');
    expect((await db.select().from(Items)).map((row: any) => row.id)).toEqual([1, 2]);
  });

  it('names both positions, and fires for update and delete too', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: { before: record, after: record } } });

    await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { id } }`);
    await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 2 } }) { id } }`);

    expect((await auditRows()).map((row: any) => `${row.operation}:${row.position}`)).toEqual([
      'update:before',
      'update:after',
      'delete:before',
      'delete:after',
    ]);
  });

  it('is registered per table', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: record } });
    const res = await run(gqlSchema, `mutation { createOrgs(values: [{ id: 2, name: "Globex" }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });
});
