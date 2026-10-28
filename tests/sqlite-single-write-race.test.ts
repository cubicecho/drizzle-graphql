import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
