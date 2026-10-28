import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
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
