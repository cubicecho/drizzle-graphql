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
// A partial index whose predicate compares to a value. SQLite matches the conflict target's
// predicate textually, so it has to be written literally, not as a bound parameter.
const Members = sqliteTable(
  'members',
  {
    id: integer('id').primaryKey(),
    email: text('email').notNull(),
    status: text('status').notNull(),
    name: text('name'),
  },
  (t) => [uniqueIndex('members_email_active').on(t.email).where(eq(t.status, 'active'))],
);
const relations = buildRelations(
  { Posts, Users, Accounts, Members },
  { Posts: {}, Users: {}, Accounts: {}, Members: {} },
);

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
  await db.run(
    sql`CREATE TABLE "members" ("id" integer PRIMARY KEY NOT NULL, "email" text NOT NULL, "status" text NOT NULL, "name" text)`,
  );
  await db.run(sql`CREATE UNIQUE INDEX "members_email_active" ON "members" ("email") WHERE "status" = 'active'`);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "posts"`);
  await db.run(sql`DELETE FROM "users"`);
  await db.run(sql`DELETE FROM "accounts"`);
  await db.run(sql`DELETE FROM "members"`);
  await db.run(sql`INSERT INTO "members" VALUES (1, 'a@x', 'active', 'Old')`);
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

  it('skips the conflicting row under action NOTHING', async () => {
    const res = await run(
      build({}),
      `mutation { upsertAccounts(values: [{ id: 2, email: "a@x" }, { id: 3, email: "c@x" }], onConflict: { target: [email], action: NOTHING }) { id } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccounts']).toEqual([{ id: 3 }]);
    expect(await db.select().from(Accounts).orderBy(Accounts.id)).toEqual([
      { id: 1, email: 'a@x', name: 'Old', deletedAt: null },
      { id: 3, email: 'c@x', name: null, deletedAt: null },
      { id: 9, email: 'gone@x', name: 'Tombstone', deletedAt: 1 },
    ]);
  });

  it('skips the conflicting row when an UPDATE has nothing to write', async () => {
    const res = await run(
      build({}),
      `mutation { upsertAccountsSingle(values: { email: "a@x" }, onConflict: { target: [email] }) { id } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccountsSingle']).toBeNull();
  });

  it('matches a predicate that compares to a value', async () => {
    const res = await run(
      build({}),
      `mutation { upsertMembersSingle(values: { id: 2, email: "a@x", status: "active", name: "New" }, onConflict: { target: [email], update: [name] }) { id name } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertMembersSingle']).toEqual({ id: 1, name: 'New' });
  });

  it('skips a conflict on a value predicate under action NOTHING', async () => {
    const res = await run(
      build({}),
      `mutation { upsertMembers(values: [{ id: 2, email: "a@x", status: "active" }], onConflict: { target: [email], action: NOTHING }) { id } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertMembers']).toEqual([]);
  });
});
