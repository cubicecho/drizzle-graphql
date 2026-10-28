import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { doublePrecision, pgTable, real, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A Single write reads the key of the row it checked and narrows the write to it. PostgreSQL
// prints a float with `extra_float_digits`, and below 1 that output is rounded: `0.12345679`
// reads back as `0.123457`, so binding the value read matched no row and nothing was written.
// The key is compared by its binary form instead.

const ByReal = pgTable('by_real', { k: real('k').primaryKey(), label: text('label').notNull() });
const ByDouble = pgTable('by_double', { k: doublePrecision('k').notNull().unique(), label: text('label').notNull() });
const tables = { ByReal, ByDouble };

let pglite: PGlite;
let db: any;
let schema: GraphQLSchema;

const run = async (source: string) => await graphql({ schema, source: `mutation { ${source} }`, contextValue: {} });
const labels = async (table: any) =>
  (await db.select({ label: table.label }).from(table).orderBy(table.label)).map((row: any) => row.label);

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations: buildRelations(tables, {}) });
  await db.execute(sql`CREATE TABLE by_real (k real PRIMARY KEY, label text NOT NULL)`);
  await db.execute(sql`CREATE TABLE by_double (k double precision NOT NULL UNIQUE, label text NOT NULL)`);
  schema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`SET extra_float_digits = 0`);
  await db.execute(sql`DELETE FROM by_real`);
  await db.execute(sql`DELETE FROM by_double`);
  await db.execute(sql`INSERT INTO by_real VALUES (0.12345679, 'a'), (0.1, 'b')`);
  await db.execute(sql`INSERT INTO by_double VALUES (0.30000000000000004, 'a'), (0.1, 'b')`);
});

describe.sequential('PG: a Single write on a table keyed by a float column', () => {
  it('real primary key: update writes the row the check found', async () => {
    const res = await run('updateByRealSingle(where: { label: { eq: "a" } }, set: { label: "z" }) { label }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateByRealSingle: { label: 'z' } });
    expect(await labels(ByReal)).toEqual(['b', 'z']);
  });

  it('real primary key: delete removes the row the check found', async () => {
    const res = await run('deleteByRealSingle(where: { label: { eq: "a" } }) { label }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteByRealSingle: { label: 'a' } });
    expect(await labels(ByReal)).toEqual(['b']);
  });

  it('double precision unique key: update writes the row the check found', async () => {
    const res = await run('updateByDoubleSingle(where: { label: { eq: "a" } }, set: { label: "z" }) { label }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateByDoubleSingle: { label: 'z' } });
    expect(await labels(ByDouble)).toEqual(['b', 'z']);
  });

  it('at the default extra_float_digits too', async () => {
    await db.execute(sql`RESET extra_float_digits`);
    const res = await run('deleteByDoubleSingle(where: { label: { eq: "a" } }) { label }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteByDoubleSingle: { label: 'a' } });
    expect(await labels(ByDouble)).toEqual(['b']);
  });
});
