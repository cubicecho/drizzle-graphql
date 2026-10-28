import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/index';
import { withRowArrivingBeforeWrite } from './util/write-race';

// A Single write checks that its `where` matches one row, then writes. A row that starts matching
// between the check and the write must not be written: the write is narrowed to the row checked.

const Authors = sqliteTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  orgId: integer('org_id'),
});
const relations = buildRelations({ Authors }, {});
const ORG = 7;

let client: Client;
let db: any;

const allAuthors = async () => await db.select().from(Authors).orderBy(Authors.id);

beforeAll(async () => {
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, relations });
  await db.run(
    sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL, "org_id" integer);`,
  );
});

afterAll(() => {
  client?.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "authors"`);
  await db.insert(Authors).values({ id: 1, name: 'original', orgId: ORG });
});

describe.sequential('SQLite (async driver): a row that starts matching during a Single write', () => {
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
// (NULLs never collide in a unique constraint, so a NULL names no single row).
const NotNullUnique = sqliteTable('not_null_unique', {
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  orgId: integer('org_id'),
});
const CompositeUnique = sqliteTable(
  'composite_unique',
  {
    a: integer('a').notNull(),
    b: integer('b').notNull(),
    name: text('name').notNull(),
    orgId: integer('org_id'),
  },
  (t) => [unique('composite_unique_ab').on(t.a, t.b)],
);
const NullableUnique = sqliteTable('nullable_unique', {
  code: text('code').unique(),
  name: text('name').notNull(),
  orgId: integer('org_id'),
});
const NoKey = sqliteTable('no_key', {
  name: text('name').notNull(),
  orgId: integer('org_id'),
});

describe.sequential('SQLite: a Single write on a table without a primary key', () => {
  const keyless = { NotNullUnique, CompositeUnique, NullableUnique, NoKey };
  let keylessClient: Client;
  let keylessDb: any;

  beforeAll(async () => {
    keylessClient = createClient({ url: ':memory:' });
    keylessDb = (drizzle as any)({ client: keylessClient, relations: buildRelations(keyless, {}) });
    await keylessDb.run(
      sql`CREATE TABLE "not_null_unique" ("code" text NOT NULL UNIQUE, "name" text NOT NULL, "org_id" integer)`,
    );
    await keylessDb.run(
      sql`CREATE TABLE "composite_unique" ("a" integer NOT NULL, "b" integer NOT NULL, "name" text NOT NULL, "org_id" integer, CONSTRAINT "composite_unique_ab" UNIQUE ("a", "b"))`,
    );
    await keylessDb.run(
      sql`CREATE TABLE "nullable_unique" ("code" text UNIQUE, "name" text NOT NULL, "org_id" integer)`,
    );
    await keylessDb.run(sql`CREATE TABLE "no_key" ("name" text NOT NULL, "org_id" integer)`);
  });

  afterAll(() => {
    keylessClient?.close();
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

  it('composite NOT NULL unique constraint: update writes only the row the check found', async () => {
    const { res, rows } = await race(
      CompositeUnique,
      { a: 1, b: 1, name: 'first', orgId: ORG },
      { a: 1, b: 2, name: 'second', orgId: ORG },
      `updateCompositeUniqueSingle(where: { orgId: { eq: ${ORG} } }, set: { orgId: 8 }) { b }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateCompositeUniqueSingle: { b: 1 } });
    expect(rows).toEqual([
      { name: 'first', orgId: 8 },
      { name: 'second', orgId: ORG },
    ]);
  });

  it('nullable unique column holding a value: the write is narrowed to the row the check found', async () => {
    const { res, rows } = await race(
      NullableUnique,
      { code: 'a', name: 'first', orgId: ORG },
      { code: null, name: 'second', orgId: ORG },
      `deleteNullableUniqueSingle(where: { orgId: { eq: ${ORG} } }) { code }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteNullableUniqueSingle: { code: 'a' } });
    expect(rows).toEqual([{ name: 'second', orgId: ORG }]);
  });

  it('nullable unique column holding NULL: nothing names the row, so the arriving row is written too', async () => {
    const { res, rows } = await race(
      NullableUnique,
      { code: null, name: 'first', orgId: ORG },
      { code: null, name: 'second', orgId: ORG },
      `updateNullableUniqueSingle(where: { orgId: { eq: ${ORG} } }, set: { orgId: 8 }) { code }`,
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
      `deleteNoKeySingle(where: { orgId: { eq: ${ORG} } }) { name }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteNoKeySingle: null });
    expect(rows).toEqual([{ name: 'second', orgId: ORG }]);
  });

  it('the build warns once about the tables with no key to narrow by', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      buildSchema(keylessDb);
      const messages = warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('no primary key'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/: NoKey\.$/);
    } finally {
      warn.mockRestore();
    }
  });
});
