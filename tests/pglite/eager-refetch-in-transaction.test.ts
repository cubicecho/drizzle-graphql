import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/index';

// A mutation's relation re-fetch can fail at run time (here `numeric_in` overflows on a valid
// DecimalString). On Postgres a failed statement aborts the surrounding transaction, so the
// library must keep that failure from turning the write's COMMIT into a silent ROLLBACK.

const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Articles = pgTable('articles', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
  price: numeric('price'),
});
const r = createRelationsHelper({ Authors, Articles });
const relations = buildRelations(
  { Authors, Articles },
  {
    Authors: { articles: r.many.Articles({ from: r.Authors.id, to: r.Articles.authorId }) },
    Articles: { author: r.one.Authors({ from: r.Articles.authorId, to: r.Authors.id }) },
  },
);

const DATA_DIR = `./tests/.temp/pgdata-eager-refetch-tx-${Date.now()}`;
// Valid GraphQL, but Postgres raises "value overflows numeric format" when it runs.
const FAILING_RELATION = 'articles(where: { price: { eq: "1e200000" } }) { id }';

let pglite: PGlite;
let db: any;

const authorIds = async () => (await db.select({ id: Authors.id }).from(Authors)).map((row: any) => row.id);

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "articles" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer, "price" numeric);`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM "articles"`);
  await db.execute(sql`DELETE FROM "authors"`);
  // The fallback is expected to warn; keep the output quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe.sequential('PG: a failed relation re-fetch after a write inside a transaction', () => {
  it('auto transaction: the reported writes are committed', async () => {
    const { schema } = buildSchema(db, { transactions: 'auto' });
    const res = await graphql({
      schema,
      source: `mutation {
        a: createAuthorsSingle(values: { id: 1, name: "a" }) { id }
        b: updateAuthorsSingle(where: { id: { eq: 1 } }, set: { name: "b" }) { id ${FAILING_RELATION} }
      }`,
      contextValue: {},
    });
    expect((res.data as any)?.a).toEqual({ id: 1 });
    expect(await authorIds()).toEqual([1]);
  });

  it('onWrite-forced transaction: the row the resolver reported is committed', async () => {
    const { schema } = buildSchema(db, { onWrite: { Authors: { after: async () => {} } } });
    await graphql({
      schema,
      source: `mutation { createAuthorsSingle(values: { id: 1, name: "a" }) { id ${FAILING_RELATION} } }`,
      contextValue: {},
    });
    expect(await authorIds()).toEqual([1]);
  });
});
