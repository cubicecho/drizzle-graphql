import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { withRowArrivingBeforeWrite } from '../util/write-race';

// A Single write checks that its `where` matches one row, then writes. A row that starts matching
// between the check and the write must not be written: the write is narrowed to the row checked.

const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  orgId: integer('org_id'),
});
const relations = buildRelations({ Authors }, {});

const DATA_DIR = `./tests/.temp/pgdata-single-write-race-${Date.now()}`;
const ORG = 7;

let pglite: PGlite;
let db: any;

const allAuthors = async () => await db.select().from(Authors).orderBy(Authors.id);

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(
    sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL, "org_id" integer);`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM "authors"`);
  await db.insert(Authors).values({ id: 1, name: 'original', orgId: ORG });
});

describe.sequential('PG: a row that starts matching during a Single write', () => {
  const racingSchema = () =>
    buildSchema(
      withRowArrivingBeforeWrite(db, (executor) =>
        executor.insert(Authors).values({ id: 2, name: 'original', orgId: ORG }),
      ),
    ).schema;

  it('update: writes only the row the check found', async () => {
    const res = await graphql({
      schema: racingSchema(),
      source: `mutation { updateAuthorsSingle(where: { orgId: { eq: ${ORG} } }, set: { name: "changed" }) { id } }`,
      contextValue: {},
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateAuthorsSingle: { id: 1 } });
    expect(await allAuthors()).toEqual([
      { id: 1, name: 'changed', orgId: ORG },
      { id: 2, name: 'original', orgId: ORG },
    ]);
  });

  it('delete: deletes only the row the check found', async () => {
    const res = await graphql({
      schema: racingSchema(),
      source: `mutation { deleteAuthorsSingle(where: { orgId: { eq: ${ORG} } }) { id } }`,
      contextValue: {},
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteAuthorsSingle: { id: 1 } });
    expect(await allAuthors()).toEqual([{ id: 2, name: 'original', orgId: ORG }]);
  });
});

// Without a primary key the write is narrowed by a unique key instead, when the table has one
// that can name the checked row: every column NOT NULL, or every column non-null on that row
// (NULLs never collide in a unique constraint, so a NULL names no single row). A partial unique
// index only holds where its predicate does, so it names no row either.
const NotNullUnique = pgTable('not_null_unique', {
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  orgId: integer('org_id'),
});
const NullableUnique = pgTable('nullable_unique', {
  code: text('code').unique(),
  name: text('name').notNull(),
  orgId: integer('org_id'),
});
const PartialUnique = pgTable(
  'partial_unique',
  {
    code: text('code').notNull(),
    name: text('name').notNull(),
    orgId: integer('org_id'),
  },
  (t) => [uniqueIndex('partial_unique_code').on(t.code).where(sql`${t.orgId} > 100`)],
);
const NoKey = pgTable('no_key', {
  name: text('name').notNull(),
  orgId: integer('org_id'),
});

describe.sequential('PG: a Single write on a table without a primary key', () => {
  const keyless = { NotNullUnique, NullableUnique, PartialUnique, NoKey };
  let keylessDb: any;

  beforeAll(async () => {
    keylessDb = (drizzle as any)({ client: pglite, relations: buildRelations(keyless, {}) });
    await keylessDb.execute(
      sql`CREATE TABLE "not_null_unique" ("code" text NOT NULL UNIQUE, "name" text NOT NULL, "org_id" integer)`,
    );
    await keylessDb.execute(
      sql`CREATE TABLE "nullable_unique" ("code" text UNIQUE, "name" text NOT NULL, "org_id" integer)`,
    );
    await keylessDb.execute(
      sql`CREATE TABLE "partial_unique" ("code" text NOT NULL, "name" text NOT NULL, "org_id" integer)`,
    );
    await keylessDb.execute(
      sql`CREATE UNIQUE INDEX "partial_unique_code" ON "partial_unique" ("code") WHERE "org_id" > 100`,
    );
    await keylessDb.execute(sql`CREATE TABLE "no_key" ("name" text NOT NULL, "org_id" integer)`);
  });

  beforeEach(async () => {
    for (const table of Object.values(keyless)) {
      await keylessDb.delete(table);
    }
  });

  /** Seeds `first`, builds a schema on which `second` lands just before the write, and runs `source`. */
  const race = async (
    table: any,
    first: Record<string, unknown> | undefined,
    second: Record<string, unknown>,
    source: string,
  ) => {
    if (first) {
      await keylessDb.insert(table).values(first);
    }
    const { schema } = buildSchema(
      withRowArrivingBeforeWrite(keylessDb, (executor) => executor.insert(table).values(second)),
    );
    const res = await graphql({ schema, source: `mutation { ${source} }`, contextValue: {} });
    const rows = await keylessDb.select({ name: table.name, orgId: table.orgId }).from(table).orderBy(table.name);
    return { res, rows };
  };
  const codesOf = (res: any) => res.errors?.map((e: any) => e.extensions?.code);

  it('NOT NULL unique column: update writes only the row the check found', async () => {
    const { res, rows } = await race(
      NotNullUnique,
      { code: 'a', name: 'first', orgId: ORG },
      { code: 'b', name: 'second', orgId: ORG },
      `updateNotNullUniqueSingle(where: { orgId: { eq: ${ORG} } }, set: { orgId: 8 }) { code }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateNotNullUniqueSingle: { code: 'a' } });
    expect(rows).toEqual([
      { name: 'first', orgId: 8 },
      { name: 'second', orgId: ORG },
    ]);
  });

  it('NOT NULL unique column: delete removes only the row the check found', async () => {
    const { res, rows } = await race(
      NotNullUnique,
      { code: 'a', name: 'first', orgId: ORG },
      { code: 'b', name: 'second', orgId: ORG },
      `deleteNotNullUniqueSingle(where: { orgId: { eq: ${ORG} } }) { code }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteNotNullUniqueSingle: { code: 'a' } });
    expect(rows).toEqual([{ name: 'second', orgId: ORG }]);
  });

  it('nullable unique column holding a value: the write is narrowed to the row the check found', async () => {
    const { res, rows } = await race(
      NullableUnique,
      { code: 'a', name: 'first', orgId: ORG },
      { code: null, name: 'second', orgId: ORG },
      `updateNullableUniqueSingle(where: { orgId: { eq: ${ORG} } }, set: { orgId: 8 }) { code }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateNullableUniqueSingle: { code: 'a' } });
    expect(rows).toEqual([
      { name: 'first', orgId: 8 },
      { name: 'second', orgId: ORG },
    ]);
  });

  it('nullable unique column holding NULL: nothing names the row, so the arriving row is written too', async () => {
    const { res, rows } = await race(
      NullableUnique,
      { code: null, name: 'first', orgId: ORG },
      { code: null, name: 'second', orgId: ORG },
      `deleteNullableUniqueSingle(where: { orgId: { eq: ${ORG} } }) { code }`,
    );
    expect(codesOf(res)).toEqual(['DRIZZLE_MULTI_ROW_MATCH']);
    expect(rows).toEqual([]);
  });

  it('partial unique index only: not a key, so the arriving row is written too', async () => {
    const { res, rows } = await race(
      PartialUnique,
      { code: 'a', name: 'first', orgId: ORG },
      { code: 'a', name: 'second', orgId: ORG },
      `updatePartialUniqueSingle(where: { orgId: { eq: ${ORG} } }, set: { orgId: 8 }) { code }`,
    );
    expect(codesOf(res)).toEqual(['DRIZZLE_MULTI_ROW_MATCH']);
    expect(rows).toEqual([
      { name: 'first', orgId: 8 },
      { name: 'second', orgId: 8 },
    ]);
  });

  it('no key at all: the arriving row is written too (documented limitation)', async () => {
    const { res, rows } = await race(
      NoKey,
      { name: 'first', orgId: ORG },
      { name: 'second', orgId: ORG },
      `updateNoKeySingle(where: { orgId: { eq: ${ORG} } }, set: { orgId: 8 }) { name }`,
    );
    expect(codesOf(res)).toEqual(['DRIZZLE_MULTI_ROW_MATCH']);
    expect(rows).toEqual([
      { name: 'first', orgId: 8 },
      { name: 'second', orgId: 8 },
    ]);
  });

  it('no key at all: a row arriving after the check found none is not written', async () => {
    const { res, rows } = await race(
      NoKey,
      undefined,
      { name: 'second', orgId: ORG },
      `updateNoKeySingle(where: { orgId: { eq: ${ORG} } }, set: { orgId: 8 }) { name }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateNoKeySingle: null });
    expect(rows).toEqual([{ name: 'second', orgId: ORG }]);
  });
});
