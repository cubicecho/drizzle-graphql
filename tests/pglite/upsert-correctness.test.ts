import { PGlite } from '@electric-sql/pglite';
import { buildRelations, eq, isNull, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';

// ── The conflict branch of an upsert is an update, and has to keep an update's promises ──
// Each block below is a regression for a way the DO UPDATE SET wrote something a plain
// `update<Table>` never would: a server-owned column, a column the row did not supply, or a
// target the database could not match.

const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  authorId: integer('author_id').notNull(),
  title: text('title'),
});
const People = pgTable(
  'people',
  {
    id: integer('id').primaryKey(),
    handle: text('handle').notNull(),
    name: text('name'),
    email: text('email'),
  },
  (t) => [unique('people_handle').on(t.handle)],
);
// The soft-delete companion the README recommends: a unique index over live rows only.
const Accounts = pgTable(
  'accounts',
  {
    id: integer('id').primaryKey(),
    email: text('email').notNull(),
    region: text('region').notNull(),
    name: text('name'),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    uniqueIndex('accounts_email_live').on(t.email).where(sql`deleted_at IS NULL`),
    uniqueIndex('accounts_email_region_live').on(t.email, t.region).where(isNull(t.deletedAt)),
  ],
);

const relations = buildRelations({ Posts, People, Accounts }, { Posts: {}, People: {}, Accounts: {} });

let pglite: PGlite;
let db: any;

const build = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { features: { upsert: true }, ...config } as any).schema;
const run = (schema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema, source, contextValue });
// Walk to the driver's own message under the masked "Internal server error".
const rootMessage = (e: any): string =>
  e?.cause ? rootMessage(e.cause) : e?.originalError ? rootMessage(e.originalError) : e?.message;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations, logger: !!process.env['LOG_SQL'] });
  await db.execute(
    sql`CREATE TABLE "posts" ("id" integer PRIMARY KEY, "org_id" integer NOT NULL, "author_id" integer NOT NULL, "title" text)`,
  );
  await db.execute(
    sql`CREATE TABLE "people" ("id" integer PRIMARY KEY, "handle" text NOT NULL CONSTRAINT "people_handle" UNIQUE, "name" text, "email" text)`,
  );
  await db.execute(
    sql`CREATE TABLE "accounts" ("id" integer PRIMARY KEY, "email" text NOT NULL, "region" text NOT NULL, "name" text, "deleted_at" timestamp)`,
  );
  await db.execute(sql`CREATE UNIQUE INDEX "accounts_email_live" ON "accounts" ("email") WHERE deleted_at IS NULL`);
  await db.execute(
    sql`CREATE UNIQUE INDEX "accounts_email_region_live" ON "accounts" ("email", "region") WHERE deleted_at IS NULL`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM "posts"`);
  await db.execute(sql`DELETE FROM "people"`);
  await db.execute(sql`DELETE FROM "accounts"`);
  await db.insert(Posts).values({ id: 1, orgId: 1, authorId: 100, title: 'Alice wrote this' });
  await db.insert(People).values([
    { id: 1, handle: 'alice', name: 'Alice', email: 'a@x' },
    { id: 2, handle: 'bob', name: 'Bob', email: 'b@x' },
  ]);
  await db.insert(Accounts).values([
    { id: 1, email: 'a@x', region: 'eu', name: 'Old' },
    { id: 9, email: 'gone@x', region: 'eu', name: 'Tombstone', deletedAt: new Date('2020-01-01T00:00:00Z') },
  ]);
});

describe.sequential('upsert: contextValues columns are never rewritten on conflict', () => {
  const contextValues = { Posts: { orgId: (ctx: any) => ctx.orgId, authorId: (ctx: any) => ctx.userId } };
  const post = async () => (await db.select().from(Posts).where(eq(Posts.id, 1)))[0];

  it('keeps the original owner when the conflict branch runs', async () => {
    const res = await run(
      build({ contextValues }),
      `mutation { upsertPostsSingle(values: { id: 1, title: "taken over" }) { id orgId authorId title } }`,
      { orgId: 2, userId: 200 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['upsertPostsSingle']).toEqual({ id: 1, orgId: 1, authorId: 100, title: 'taken over' });
    expect(await post()).toMatchObject({ orgId: 1, authorId: 100 });
  });

  it('keeps it inside a scope that lets the conflict through', async () => {
    const res = await run(
      build({ contextValues, scope: { Posts: (ctx: any, table: any) => eq(table.orgId, ctx.orgId) } }),
      `mutation { upsertPosts(values: [{ id: 1, title: "taken over" }]) { id } }`,
      { orgId: 1, userId: 200 },
    );

    expect(res.errors).toBeUndefined();
    expect(await post()).toMatchObject({ orgId: 1, authorId: 100, title: 'taken over' });
  });

  it('still stamps the columns on the insert branch', async () => {
    const res = await run(
      build({ contextValues }),
      `mutation { upsertPostsSingle(values: { id: 2, title: "new" }) { id orgId authorId } }`,
      { orgId: 2, userId: 200 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['upsertPostsSingle']).toEqual({ id: 2, orgId: 2, authorId: 200 });
  });

  it('leaves them out of the columns onConflict.update can name', () => {
    const updateColumns = build({ contextValues }).getType('PostsUpdateColumn') as any;
    expect(updateColumns.getValues().map((value: any) => value.name)).toEqual(['id', 'title']);
  });
});

describe.sequential('upsert: a batch whose rows supply different columns', () => {
  const people = () => db.select().from(People).orderBy(People.id);

  it('leaves a column alone on a row that did not supply it', async () => {
    const res = await run(
      build({}),
      `mutation { upsertPeople(values: [{ id: 1, handle: "alice", name: "Alice2" }, { id: 2, handle: "bob", email: "b2@x" }]) { id name email } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(await people()).toEqual([
      { id: 1, handle: 'alice', name: 'Alice2', email: 'a@x' },
      { id: 2, handle: 'bob', name: 'Bob', email: 'b2@x' },
    ]);
  });

  it('returns the rows in the order they were sent, inserts and updates interleaved', async () => {
    const res = await run(
      build({}),
      `mutation { upsertPeople(values: [
        { id: 2, handle: "bob", email: "b2@x" }
        { id: 3, handle: "cara", name: "Cara" }
        { id: 1, handle: "alice", email: "a2@x" }
        { id: 4, handle: "dan", name: "Dan", email: "d@x" }
      ]) { id name email } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['upsertPeople']).toEqual([
      { id: 2, name: 'Bob', email: 'b2@x' },
      { id: 3, name: 'Cara', email: null },
      { id: 1, name: 'Alice', email: 'a2@x' },
      { id: 4, name: 'Dan', email: 'd@x' },
    ]);
  });

  it('writes only the listed columns a row supplied, and still rejects one no row supplied', async () => {
    const res = await run(
      build({}),
      `mutation { upsertPeople(
        values: [{ id: 1, handle: "alice", name: "Alice2", email: "a2@x" }, { id: 2, handle: "bob", email: "b2@x" }]
        onConflict: { update: [name] }
      ) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(await people()).toEqual([
      { id: 1, handle: 'alice', name: 'Alice2', email: 'a@x' },
      { id: 2, handle: 'bob', name: 'Bob', email: 'b@x' },
    ]);

    const rejected = await run(
      build({}),
      `mutation { upsertPeople(values: [{ id: 1, handle: "alice" }], onConflict: { update: [name] }) { id } }`,
    );
    expect(rejected.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_INVALID_ON_CONFLICT');
  });

  it('is atomic: a failing group rolls back the groups before it', async () => {
    const res = await run(
      build({}),
      // Row 3 violates the unique handle constraint on insert, after row 1's group has run.
      `mutation { upsertPeople(values: [{ id: 1, handle: "alice", name: "Alice2" }, { id: 3, handle: "bob", email: "c@x" }]) { id } }`,
    );

    expect(res.errors).toBeDefined();
    expect((await people())[0]).toMatchObject({ name: 'Alice' });
  });
});

describe.sequential('upsert: a partial unique index as the conflict target', () => {
  const accounts = () => db.select().from(Accounts).orderBy(Accounts.id);

  it('carries the index predicate, so PostgreSQL can match the index', async () => {
    const res = await run(
      build({ softDelete: { Accounts: 'deletedAt' } }),
      `mutation { upsertAccountsSingle(values: { id: 2, email: "a@x", region: "eu", name: "New" }, onConflict: { target: [email], update: [name] }) { id name } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccountsSingle']).toEqual({ id: 1, name: 'New' });
  });

  it('carries a predicate built from columns, too', async () => {
    const res = await run(
      build({}),
      `mutation { upsertAccounts(values: [{ id: 2, email: "a@x", region: "eu", name: "New" }], onConflict: { target: [email, region], update: [name] }) { id name } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccounts']).toEqual([{ id: 1, name: 'New' }]);
  });

  it('inserts beside a row the predicate excludes, rather than conflicting with it', async () => {
    const res = await run(
      build({}),
      `mutation { upsertAccountsSingle(values: { id: 2, email: "gone@x", region: "eu", name: "Reborn" }, onConflict: { target: [email] }) { id name } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccountsSingle']).toEqual({ id: 2, name: 'Reborn' });
    expect((await accounts()).map((row: any) => row.id)).toEqual([1, 2, 9]);
  });

  it('carries it on action NOTHING too', async () => {
    const res = await run(
      build({}),
      `mutation { upsertAccounts(values: [{ id: 2, email: "a@x", region: "eu" }], onConflict: { target: [email], action: NOTHING }) { id } }`,
    );

    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data?.['upsertAccounts']).toEqual([]);
  });

  it('gets no uniqueKeyFilters field: it does not name one row once marked rows are included', () => {
    const schema = build({ features: { upsert: true, uniqueKeyFilters: true } });
    const fields = (schema.getType('AccountsFilters') as GraphQLInputObjectType).getFields();
    expect(fields['email_region']).toBeUndefined();
  });
});
