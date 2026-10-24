// SQLite string filters that answered differently from PostgreSQL on the same data:
// - a `\` in a raw `like` / `notLike` / `ilike` / `notIlike` pattern escapes the next character on
//   PostgreSQL (and MySQL), but was an ordinary character in SQLite's GLOB translation and in its
//   `lower(col) like lower(?)` form, which had no ESCAPE clause;
// - the case-insensitive safe operators lowercased the operand in JS while SQLite's `lower()`
//   folds only ASCII, so `iContains: "École"` missed the row holding exactly `École`;
// - a JSON path key holding `"` was escaped as `\"`, which SQLite's path parser does not read,
//   so the filter silently matched nothing.
import { PGlite } from '@electric-sql/pglite';
import { type Client, createClient } from '@libsql/client';
import { defineRelations, sql } from 'drizzle-orm';
import { drizzle as drizzleLibsql } from 'drizzle-orm/libsql';
import * as pg from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as sq from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const SqliteWords = sq.sqliteTable('words', {
  id: sq.integer('id').primaryKey(),
  w: sq.text('w'),
  j: sq.text('j', { mode: 'json' }),
});
const PgWords = pg.pgTable('words', { id: pg.integer('id').primaryKey(), w: pg.text('w'), j: pg.jsonb('j') });

const rows = [
  { id: 1, w: 'a%b', j: { 'x"y': 1 } },
  { id: 2, w: 'a_b', j: { 'a\\b': 2 } },
  { id: 3, w: 'axb', j: { 'q"r.s': 3 } },
  { id: 4, w: 'a\\b', j: null },
  { id: 5, w: 'a\\xb', j: null },
  { id: 6, w: 'École', j: null },
  { id: 7, w: 'ÀB', j: null },
  { id: 8, w: 'a*b', j: null },
];

let client: Client;
let pglite: PGlite;
const schemas: Record<'sqlite' | 'pg', GraphQLSchema> = {} as any;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const sqliteDb = (drizzleLibsql as any)({ client, relations: defineRelations({ words: SqliteWords }) });
  await sqliteDb.run(sql`CREATE TABLE words (id integer PRIMARY KEY, w text, j text)`);
  await sqliteDb.insert(SqliteWords).values(rows);
  schemas.sqlite = buildSchema(sqliteDb).schema;

  pglite = new PGlite();
  await pglite.exec('CREATE TABLE words (id integer PRIMARY KEY, w text, j jsonb)');
  const pgDb = (drizzlePglite as any)({ client: pglite, relations: defineRelations({ words: PgWords }) });
  await pgDb.insert(PgWords).values(rows);
  schemas.pg = buildSchema(pgDb).schema;
});

afterAll(async () => {
  client?.close();
  await pglite?.close();
});

const ids = async (dialect: 'sqlite' | 'pg', where: string, variableValues?: Record<string, any>) => {
  const declared = [/\$p\b/.test(where) ? '$p: String' : '', where.includes('$path') ? '$path: [String!]!' : '']
    .filter(Boolean)
    .join(', ');
  const res = await graphql({
    schema: schemas[dialect],
    source: `query${declared ? `(${declared})` : ''} { words(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    variableValues,
    contextValue: {},
  });
  expect(res.errors).toBeUndefined();
  return (res.data as any).words.map((row: { id: number }) => row.id);
};

describe('sqlite: a backslash in a raw LIKE pattern escapes as on PostgreSQL', () => {
  for (const op of ['like', 'notLike', 'ilike', 'notIlike']) {
    for (const pattern of ['a\\%b', 'a\\_b', 'a\\\\b', 'a\\xb', 'a*b', 'a%b']) {
      it(`${op}: ${JSON.stringify(pattern)}`, async () => {
        const where = `{ w: { ${op}: $p } }`;
        expect(await ids('sqlite', where, { p: pattern })).toEqual(await ids('pg', where, { p: pattern }));
      });
    }
  }

  it('matches the expected rows', async () => {
    expect(await ids('sqlite', '{ w: { like: $p } }', { p: 'a\\%b' })).toEqual([1]);
    expect(await ids('sqlite', '{ w: { ilike: $p } }', { p: 'A\\_B' })).toEqual([2]);
    expect(await ids('sqlite', '{ w: { like: $p } }', { p: 'a\\\\b' })).toEqual([4]);
    expect(await ids('sqlite', '{ w: { like: $p, insensitive: true } }', { p: 'A\\%B' })).toEqual([1]);
  });
});

describe('sqlite: case-insensitive safe operators fold the operand as the column is folded', () => {
  it('finds a row whose text is exactly the non-ASCII operand', async () => {
    expect(await ids('sqlite', '{ w: { iContains: "École" } }')).toEqual([6]);
    expect(await ids('sqlite', '{ w: { iStartsWith: "À" } }')).toEqual([7]);
    expect(await ids('sqlite', '{ w: { iEndsWith: "ole" } }')).toEqual([6]);
    expect(await ids('sqlite', '{ w: { contains: "Éc", insensitive: true } }')).toEqual([6]);
    // the raw operator, which lowers both sides in SQL, agrees
    expect(await ids('sqlite', '{ w: { ilike: "%École%" } }')).toEqual([6]);
  });

  it('still folds ASCII case', async () => {
    expect(await ids('sqlite', '{ w: { iContains: "COLE" } }')).toEqual([6]);
    expect(await ids('sqlite', '{ w: { iStartsWith: "A%" } }')).toEqual([1]);
  });
});

describe('JSON path keys holding a quote or a backslash', () => {
  for (const dialect of ['pg', 'sqlite'] as const) {
    it(dialect, async () => {
      const where = (n: number) => `{ j: { path: { path: $path, eq: ${n} } } }`;
      expect(await ids(dialect, where(1), { path: ['x"y'] })).toEqual([1]);
      expect(await ids(dialect, where(2), { path: ['a\\b'] })).toEqual([2]);
      expect(await ids(dialect, where(3), { path: ['q"r.s'] })).toEqual([3]);
    });
  }
});
