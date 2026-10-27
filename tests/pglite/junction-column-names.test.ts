import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// PostgreSQL counterpart of tests/sqlite-junction-column-names.test.ts: the paginated batch's
// subquery selects `posts.user_id` and `likes.user_id`, which PostgreSQL refuses to read back
// by name unless each is aliased.

const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  title: text('title').notNull(),
});
const Likes = pgTable('likes', { userId: integer('user_id').notNull(), postId: integer('post_id').notNull() }, (t) => [
  primaryKey({ columns: [t.userId, t.postId] }),
]);
const tables = { Users, Posts, Likes };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    likedPosts: r.many.Posts({ from: r.Users.id.through(r.Likes.userId), to: r.Posts.id.through(r.Likes.postId) }),
  },
});

const DATA_DIR = `./tests/.temp/pgdata-junction-column-names-${Date.now()}`;
let pglite: PGlite;
let db: any;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL)`);
  await db.execute(sql`CREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL, title text NOT NULL)`);
  await db.execute(
    sql`CREATE TABLE likes (user_id integer NOT NULL, post_id integer NOT NULL, PRIMARY KEY (user_id, post_id))`,
  );
  await db.insert(Users).values([
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
    { id: 3, name: 'C' },
  ]);
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

afterAll(async () => {
  await pglite?.close();
  await rm(DATA_DIR, { recursive: true, force: true });
});

const BY_ID = '{ id: { direction: asc, priority: 1 } }';

describe('junction source column sharing a database name with a target column', () => {
  it.each([
    ['eager', true],
    ['lazy', false],
  ])('%s: a paginated relation groups rows under the parent that links them', async (_label, eager) => {
    const { schema } = buildSchema(db, { eagerLoadRelations: eager });
    const result = await graphql({
      schema,
      source: `{ users(orderBy: ${BY_ID}) { id likedPosts(limit: 5, orderBy: ${BY_ID}) { id userId } } }`,
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).users).toEqual([
      { id: 1, likedPosts: [{ id: 10, userId: 3 }] },
      {
        id: 2,
        likedPosts: [
          { id: 10, userId: 3 },
          { id: 11, userId: 3 },
        ],
      },
      { id: 3, likedPosts: [] },
    ]);
  });
});
