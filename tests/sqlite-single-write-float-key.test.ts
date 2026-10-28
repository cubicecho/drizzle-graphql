import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A Single write reads the key of the row it checked and narrows the write to it. On a float key
// that is only safe if the value read binds back to the same value; SQLite hands the driver a
// REAL as the double it stores, so it does. This guards that, as PostgreSQL and MySQL need help.

const ByReal = sqliteTable('by_real', { k: real('k').primaryKey(), label: text('label').notNull() });
const ByUniqueReal = sqliteTable('by_unique_real', { k: real('k').notNull().unique(), label: text('label').notNull() });
const tables = { ByReal, ByUniqueReal };

let client: Client;
let db: any;
let schema: GraphQLSchema;

const run = async (source: string) => await graphql({ schema, source: `mutation { ${source} }`, contextValue: {} });
const labels = async (table: any) =>
  (await db.select({ label: table.label }).from(table).orderBy(table.label)).map((row: any) => row.label);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations: buildRelations(tables, {}) });
  await db.run(sql`CREATE TABLE by_real (k real PRIMARY KEY, label text NOT NULL)`);
  await db.run(sql`CREATE TABLE by_unique_real (k real NOT NULL UNIQUE, label text NOT NULL)`);
  schema = buildSchema(db).schema;
});

afterAll(() => {
  client?.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM by_real`);
  await db.run(sql`DELETE FROM by_unique_real`);
  await db.run(sql`INSERT INTO by_real VALUES (0.1, 'a'), (0.30000000000000004, 'b')`);
  await db.run(sql`INSERT INTO by_unique_real VALUES (0.30000000000000004, 'a'), (0.3, 'b')`);
});

describe.sequential('SQLite: a Single write on a table keyed by a REAL column', () => {
  it('primary key: update writes the row the check found', async () => {
    const res = await run('updateByRealSingle(where: { label: { eq: "a" } }, set: { label: "z" }) { label }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateByRealSingle: { label: 'z' } });
    expect(await labels(ByReal)).toEqual(['b', 'z']);
  });

  it('NOT NULL unique key: delete removes only the row the check found', async () => {
    const res = await run('deleteByUniqueRealSingle(where: { label: { eq: "a" } }) { label }');
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteByUniqueRealSingle: { label: 'a' } });
    expect(await labels(ByUniqueReal)).toEqual(['b']);
  });
});
