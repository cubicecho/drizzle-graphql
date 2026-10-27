// A cursor's values are client input, and a well-formed value of the wrong kind for its column
// (a string where a date belongs, a boolean for an integer) used to reach PostgreSQL, which
// refused it as an Internal server error, or compared it oddly. Each value is now checked
// against what its column reads into, on the root list and on a relation field's `after`.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { date, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  // Default precision (6): a cursor carries its value as PostgreSQL's own text.
  born: timestamp('born'),
  // Precision 3 fits a JS Date, so a cursor carries it as a tagged date.
  seen: timestamp('seen', { precision: 3 }),
  day: date('day', { mode: 'date' }),
  score: integer('score'),
});
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  at: timestamp('at', { precision: 3 }).notNull(),
});
const tables = { Authors, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
});

let pglite: PGlite;
let schema: GraphQLSchema;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE authors (
    id integer primary key, name text not null, born timestamp, seen timestamp(3), day date, score integer)`);
  await db.execute(
    sql`CREATE TABLE posts (id integer primary key, author_id integer not null, at timestamp(3) not null)`,
  );
  await db.execute(sql`INSERT INTO authors VALUES
    (1, 'a', '2024-01-01 00:00:00.000001', '2024-01-01', '2024-01-01', 1),
    (2, 'b', '2024-01-02 00:00:00.000002', '2024-01-02', '2024-01-02', 2)`);
  await db.execute(sql`INSERT INTO posts VALUES (1, 1, '2024-01-01'), (2, 1, '2024-01-02')`);
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const codes = (res: Awaited<ReturnType<typeof run>>) => res.errors?.map((error) => error.extensions?.['code']);
const order = (column: string) => `{ ${column}: { direction: asc, priority: 1 } }`;

const DATE = { $type: 'date', value: '2024-01-01T00:00:00.000Z' };

describe('pglite: cursor values of the wrong kind for their column', () => {
  it.each<[string, string, unknown]>([
    ['a plain string for a timestamp', 'seen', 'nope'],
    ['an unparseable text for a full-precision timestamp', 'born', 'nope'],
    ['an out-of-range month in a full-precision timestamp', 'born', '2024-13-01 00:00:00'],
    ["a year past PostgreSQL's range", 'born', '294277-01-01 00:00:00'],
    ['a string for a date', 'day', '2024-01-01'],
    ['a tagged bigint for a timestamp', 'seen', { $type: 'bigint', value: '5' }],
    ['a number for a text column', 'name', 5],
    ['a boolean for an integer column', 'score', true],
    ['a fraction for an integer column', 'score', 1.5],
    ['a non-finite number for an integer column', 'score', { $type: 'float', value: 'Infinity' }],
    ['a date for an integer column', 'score', DATE],
  ])('%s is DRIZZLE_INVALID_CURSOR on the root list', async (_name, column, value) => {
    const after = forge({
      o: [
        [column, 'asc'],
        ['id', 'asc'],
      ],
      v: [value, 1],
    });
    const res = await run(`{ authors(orderBy: ${order(column)}, after: "${after}") { id } }`);
    expect(codes(res)).toEqual(['DRIZZLE_INVALID_CURSOR']);
    expect(res.errors?.[0]?.message).toMatch(new RegExp(`'${column}'`));
  });

  it('a null for a NOT NULL column is DRIZZLE_INVALID_CURSOR', async () => {
    const res = await run(`{ authors(after: "${forge({ o: [['id', 'asc']], v: [null] })}") { id } }`);
    expect(codes(res)).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });

  it('a wrong-kind value is DRIZZLE_INVALID_CURSOR on a relation field', async () => {
    const after = forge({
      o: [
        ['at', 'asc'],
        ['id', 'asc'],
      ],
      v: ['nope', 1],
    });
    const res = await run(
      `{ authors(orderBy: ${order('id')}) { id posts(orderBy: ${order('at')}, after: "${after}") { id } } }`,
    );
    expect([...new Set(codes(res))]).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });

  it.each<[string, string, unknown, number[]]>([
    ['a null for a nullable column', 'score', null, []],
    ['a full-precision timestamp text', 'born', '2024-01-01 00:00:00.000001', [2]],
    ['a tagged date for a date', 'day', DATE, [2]],
    ['an integer for an integer column', 'score', 1, [2]],
  ])('%s still pages', async (_name, column, value, ids) => {
    const after = forge({
      o: [
        [column, 'asc'],
        ['id', 'asc'],
      ],
      v: [value, 1],
    });
    const res = await run(`{ authors(orderBy: ${order(column)}, after: "${after}") { id } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).authors.map((row: { id: number }) => row.id)).toEqual(ids);
  });

  it('genuine cursors page on the root list and a relation field', async () => {
    for (const column of ['born', 'seen', 'day', 'name', 'score']) {
      const first: any = await run(`{ authors(orderBy: ${order(column)}, limit: 1) { id cursor } }`);
      const next: any = await run(
        `{ authors(orderBy: ${order(column)}, after: "${first.data.authors[0].cursor}") { id } }`,
      );
      expect(next.errors).toBeUndefined();
      expect(next.data.authors).toEqual([{ id: 2 }]);
    }
    const first: any = await run(
      `{ authorsSingle(where: { id: { eq: 1 } }) { posts(orderBy: ${order('at')}, limit: 1) { cursor } } }`,
    );
    const next: any = await run(
      `{ authorsSingle(where: { id: { eq: 1 } }) { posts(orderBy: ${order('at')}, after: "${first.data.authorsSingle.posts[0].cursor}") { id } } }`,
    );
    expect(next.errors).toBeUndefined();
    expect(next.data.authorsSingle.posts).toEqual([{ id: 2 }]);
  });
});
