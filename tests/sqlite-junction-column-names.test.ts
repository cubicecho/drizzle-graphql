import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A many-to-many whose target has a column with the same database name as the junction's
// source column (`posts.user_id` and `likes.user_id`). The paginated batch reads both out of
// one subquery, so each must come back under its own name, or the rows are grouped under
// the wrong parent. See tests/pglite/junction-column-names.test.ts for PostgreSQL.

const Users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  title: text('title').notNull(),
});
const Likes = sqliteTable(
  'likes',
  { userId: integer('user_id').notNull(), postId: integer('post_id').notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.postId] })],
);
const tables = { Users, Posts, Likes };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    likedPosts: r.many.Posts({ from: r.Users.id.through(r.Likes.userId), to: r.Posts.id.through(r.Likes.postId) }),
  },
});

let client: Client;
let db: any;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL)`);
  await db.run(sql`CREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL, title text NOT NULL)`);
  await db.run(
    sql`CREATE TABLE likes (user_id integer NOT NULL, post_id integer NOT NULL, PRIMARY KEY (user_id, post_id))`,
  );
  await db.insert(Users).values([
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
    { id: 3, name: 'C' },
  ]);
  // Both posts are written by user 3, who likes neither.
  await db.insert(Posts).values([
    { id: 10, userId: 3, title: 'x' },
    { id: 11, userId: 3, title: 'y' },
  ]);
  await db.insert(Likes).values([
    { userId: 1, postId: 10 },
    { userId: 2, postId: 10 },
    { userId: 2, postId: 11 },
  ]);
});
afterAll(() => client?.close());

const BY_ID = '{ id: { direction: asc, priority: 1 } }';
const LIKED = [
  { id: 1, likedPosts: [{ id: 10, userId: 3 }] },
  {
    id: 2,
    likedPosts: [
      { id: 10, userId: 3 },
      { id: 11, userId: 3 },
    ],
  },
  { id: 3, likedPosts: [] },
];

const run = async (config: Record<string, unknown>, source: string) => {
  const { schema } = buildSchema(db, config as any);
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return (result.data as any).users;
};

describe('junction source column sharing a database name with a target column', () => {
  it.each([
    ['eager', true],
    ['lazy', false],
  ])('%s: a paginated relation groups rows under the parent that links them', async (_label, eager) => {
    const users = await run(
      { eagerLoadRelations: eager },
      `{ users(orderBy: ${BY_ID}) { id likedPosts(limit: 5, orderBy: ${BY_ID}) { id userId } } }`,
    );
    expect(users).toEqual(LIKED);
  });

  it.each([
    ['eager', true],
    ['lazy', false],
  ])('%s: an unpaginated relation groups rows under the parent that links them', async (_label, eager) => {
    const users = await run(
      { eagerLoadRelations: eager },
      `{ users(orderBy: ${BY_ID}) { id likedPosts(orderBy: ${BY_ID}) { id userId } } }`,
    );
    expect(users).toEqual(LIKED);
  });

  it('lazy: a paginated cursor page keeps its rows under the right parent', async () => {
    const users = await run(
      { eagerLoadRelations: false },
      `{ users(orderBy: ${BY_ID}) { id likedPosts(limit: 5, orderBy: ${BY_ID}) { id userId cursor } } }`,
    );
    expect(users.map((user: any) => user.likedPosts.map((post: any) => post.id))).toEqual([[10], [10, 11], []]);
  });

  it('default build: a junction with a scope and a defaultLimit reads through the batch', async () => {
    const users = await run(
      { limits: { defaultLimit: 50 }, scope: { Likes: () => undefined } },
      `{ users(orderBy: ${BY_ID}) { id likedPosts(orderBy: ${BY_ID}) { id userId } } }`,
    );
    expect(users).toEqual(LIKED);
  });
});
