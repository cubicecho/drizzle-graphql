// A well-formed cursor value of the wrong kind for its column used to reach the query: a string
// or a tagged bigint for an integer timestamp failed in drizzle's encoder as an Internal server
// error, and a number for a text column compared under SQLite's type affinity rules. Each is
// now DRIZZLE_INVALID_CURSOR, on the root list and on a relation field's `after`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Authors = sqliteTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  at: integer('at', { mode: 'timestamp' }),
  active: integer('active', { mode: 'boolean' }),
  rank: integer('rank'),
});
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  at: integer('at', { mode: 'timestamp' }).notNull(),
});
const tables = { Authors, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
});

let dir: string;
let client: Client;
let schema: GraphQLSchema;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dgql-cursor-value-type-'));
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  const db = (drizzle as any)({ client, relations });
  await db.run(
    sql`CREATE TABLE authors (id integer primary key, name text not null, at integer, active integer, rank integer)`,
  );
  await db.run(sql`CREATE TABLE posts (id integer primary key, author_id integer not null, at integer not null)`);
  await db.insert(Authors).values([
    { id: 1, name: 'a', at: new Date('2024-01-01T00:00:00Z'), active: false, rank: 1 },
    { id: 2, name: 'b', at: new Date('2024-01-02T00:00:00Z'), active: true, rank: 2 },
  ]);
  await db.insert(Posts).values([
    { id: 1, authorId: 1, at: new Date('2024-01-01T00:00:00Z') },
    { id: 2, authorId: 1, at: new Date('2024-01-02T00:00:00Z') },
  ]);
  schema = buildSchema(db).schema;
});
afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const codes = (res: Awaited<ReturnType<typeof run>>) => res.errors?.map((error) => error.extensions?.['code']);
const order = (column: string) => `{ ${column}: { direction: asc, priority: 1 } }`;
const forgeAfter = (column: string, value: unknown) =>
  forge({
    o: [
      [column, 'asc'],
      ['id', 'asc'],
    ],
    v: [value, 1],
  });

describe('sqlite: cursor values of the wrong kind for their column', () => {
  it.each<[string, string, unknown]>([
    ['a plain string for a timestamp', 'at', '2024-01-01T00:00:00.000Z'],
    ['a tagged bigint for a timestamp', 'at', { $type: 'bigint', value: '5' }],
    ['a number for a text column', 'name', 5],
    ['a number for a boolean column', 'active', 1],
    ['a boolean for an integer column', 'rank', true],
  ])('%s is DRIZZLE_INVALID_CURSOR on the root list', async (_name, column, value) => {
    const res = await run(`{ authors(orderBy: ${order(column)}, after: "${forgeAfter(column, value)}") { id } }`);
    expect(codes(res)).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });

  it('a wrong-kind value is DRIZZLE_INVALID_CURSOR on a relation field', async () => {
    const after = forgeAfter('at', 'nope');
    const res = await run(`{ authors { id posts(orderBy: ${order('at')}, after: "${after}") { id } } }`);
    expect([...new Set(codes(res))]).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });

  it('genuine cursors page on the root list and a relation field', async () => {
    for (const column of ['name', 'at', 'active', 'rank', 'id']) {
      const first: any = await run(`{ authors(orderBy: ${order(column)}, limit: 1) { id cursor } }`);
      const next: any = await run(
        `{ authors(orderBy: ${order(column)}, after: "${first.data.authors[0].cursor}") { id } }`,
      );
      expect(next.errors).toBeUndefined();
      expect(next.data.authors).toEqual([{ id: 2 }]);
    }
    const posts = (after: string) =>
      run(`{ authorsSingle(where: { id: { eq: 1 } }) { posts(orderBy: ${order('at')}, ${after}) { id cursor } } }`);
    const first: any = await posts('limit: 1');
    const next: any = await posts(`after: "${first.data.authorsSingle.posts[0].cursor}"`);
    expect(next.errors).toBeUndefined();
    expect(next.data.authorsSingle.posts.map((post: { id: number }) => post.id)).toEqual([2]);
  });
});
