import { type Client, createClient } from '@libsql/client';
import { buildRelations, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';

// The SQLite half of tests/pglite/upsert-correctness.test.ts: the conflict branch of an
// upsert keeps the promises an update makes.

const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  authorId: integer('author_id').notNull(),
  title: text('title'),
});
const Users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name'),
  email: text('email'),
});
const Accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    deletedAt: integer('deleted_at'),
  },
  (t) => [uniqueIndex('accounts_email_live').on(t.email).where(isNull(t.deletedAt))],
);
const relations = buildRelations({ Posts, Users, Accounts }, { Posts: {}, Users: {}, Accounts: {} });

let client: Client;
let db: any;

const build = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { features: { upsert: true }, ...config } as any).schema;
const run = (schema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema, source, contextValue });
const rootMessage = (e: any): string =>
  e?.cause ? rootMessage(e.cause) : e?.originalError ? rootMessage(e.originalError) : e?.message;

beforeAll(async () => {
  // A transaction hands libsql's connection away, which would drop a private :memory: database.
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, relations });
  await db.run(
    sql`CREATE TABLE "posts" ("id" integer PRIMARY KEY NOT NULL, "org_id" integer NOT NULL, "author_id" integer NOT NULL, "title" text)`,
  );
  await db.run(sql`CREATE TABLE "users" ("id" integer PRIMARY KEY NOT NULL, "name" text, "email" text)`);
  await db.run(
    sql`CREATE TABLE "accounts" ("id" integer PRIMARY KEY NOT NULL, "email" text NOT NULL, "name" text, "deleted_at" integer)`,
  );
  await db.run(sql`CREATE UNIQUE INDEX "accounts_email_live" ON "accounts" ("email") WHERE "deleted_at" IS NULL`);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "posts"`);
  await db.run(sql`DELETE FROM "users"`);
  await db.run(sql`DELETE FROM "accounts"`);
  await db.insert(Posts).values({ id: 1, orgId: 1, authorId: 100, title: 'Alice wrote this' });
  await db.insert(Users).values([
    { id: 1, name: 'Alice', email: 'a@x' },
    { id: 2, name: 'Bob', email: 'b@x' },
  ]);
  await db.insert(Accounts).values([
    { id: 1, email: 'a@x', name: 'Old' },
    { id: 9, email: 'gone@x', name: 'Tombstone', deletedAt: 1 },
  ]);
});

describe.sequential('SQLite upsert: contextValues columns', () => {
  const contextValues = { Posts: { orgId: (ctx: any) => ctx.orgId, authorId: (ctx: any) => ctx.userId } };

  it('are not rewritten by the conflict branch, scoped or not', async () => {
    const plain = await run(
      build({ contextValues }),
      `mutation { upsertPostsSingle(values: { id: 1, title: "taken over" }) { id orgId authorId title } }`,
      { orgId: 2, userId: 200 },
    );
    expect(plain.errors).toBeUndefined();
    expect(plain.data?.['upsertPostsSingle']).toEqual({ id: 1, orgId: 1, authorId: 100, title: 'taken over' });

    const scoped = await run(
      build({ contextValues, scope: { Posts: (ctx: any, table: any) => eq(table.orgId, ctx.orgId) } }),
      `mutation { upsertPosts(values: [{ id: 1, title: "again" }]) { id } }`,
      { orgId: 1, userId: 200 },
    );
    expect(scoped.errors).toBeUndefined();
    expect((await db.select().from(Posts))[0]).toMatchObject({ orgId: 1, authorId: 100, title: 'again' });
  });
});

describe.sequential('SQLite upsert: a batch whose rows supply different columns', () => {
  it('leaves a column alone on a row that did not supply it, and keeps the order', async () => {
    const res = await run(
      build({}),
      `mutation { upsertUsers(values: [{ id: 2, email: "b2@x" }, { id: 3, name: "Cara" }, { id: 1, name: "Alice2" }]) { id name email } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['upsertUsers']).toEqual([
      { id: 2, name: 'Bob', email: 'b2@x' },
      { id: 3, name: 'Cara', email: null },
      { id: 1, name: 'Alice2', email: 'a@x' },
    ]);
  });
});

describe.sequential('SQLite upsert: a partial unique index as the conflict target', () => {
  it('carries the index predicate', async () => {
    const res = await run(
      build({}),
      `mutation { upsertAccountsSingle(values: { id: 2, email: "a@x", name: "New" }, onConflict: { target: [email], update: [name] }) { id name } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccountsSingle']).toEqual({ id: 1, name: 'New' });
  });

  it('inserts beside a row the predicate excludes', async () => {
    const res = await run(
      build({}),
      `mutation { upsertAccounts(values: [{ id: 2, email: "gone@x", name: "Reborn" }], onConflict: { target: [email] }) { id name } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccounts']).toEqual([{ id: 2, name: 'Reborn' }]);
  });
});
