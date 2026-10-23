import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// The SQLite half of the parent-side cases in tests/pglite/nested-writes-policies.test.ts: a
// write through a to-one relation whose key is on the parent reaches only what the relation's
// own `where` shows. On an update the key is written as a CASE expression over the row's own
// column, which SQLite has to accept inside UPDATE … SET.

const Users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
  published: integer('published', { mode: 'boolean' }).notNull().default(false),
});
const tables = { Users, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    publishedPosts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId, where: { published: true }, alias: 'pub' }),
  },
  Posts: {
    publishedAuthor: r.one.Users({ alias: 'pub' }),
    shownAuthor: r.one.Users({ from: r.Posts.authorId, to: r.Users.id, where: { name: { ne: 'hidden' } } }),
  },
});

let client: Client;
let db: any;
let schema: GraphQLSchema;
const run = (source: string) => graphql({ schema, source, contextValue: {} });
const post = async (id: number) => (await db.select().from(Posts).where(eq(Posts.id, id)))[0];

beforeAll(async () => {
  // A transaction hands libsql's connection away, which would drop a private :memory: database.
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL)`);
  await db.run(
    sql`CREATE TABLE posts (id integer PRIMARY KEY, title text NOT NULL, author_id integer, published integer NOT NULL DEFAULT 0)`,
  );
  schema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});
afterAll(() => client.close());
beforeEach(async () => {
  await db.run(sql`DELETE FROM posts`);
  await db.run(sql`DELETE FROM users`);
  await db.insert(Users).values([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'hidden' },
  ]);
  await db.insert(Posts).values([
    { id: 1, title: 'published', authorId: null, published: true },
    { id: 2, title: 'draft', authorId: null, published: false },
    { id: 3, title: 'hidden author', authorId: 3, published: true },
    { id: 4, title: 'shown author', authorId: 1, published: true },
  ]);
});

describe("SQLite: a parent-side relation's own where", () => {
  it('refuses a write through an inherited where on a row it hides the relation for', async () => {
    const res = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 2 } }, set: { publishedAuthor: { connect: { id: { eq: 2 } } } }) { id } }',
    );
    expect(res.errors?.[0]?.message).toMatch(/hides the relation/);
    expect((await post(2)).authorId).toBeNull();
  });

  it('disconnect clears only a key the relation shows', async () => {
    const res = await run(
      'mutation { updatePosts(where: { id: { inArray: [3, 4] } }, set: { shownAuthor: { disconnect: true } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    expect((await post(3)).authorId).toBe(3);
    expect((await post(4)).authorId).toBeNull();
  });

  it('connect refuses to replace a key the relation hides, and replaces one it shows', async () => {
    const hidden = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 3 } }, set: { shownAuthor: { connect: { id: { eq: 2 } } } }) { id } }',
    );
    expect((hidden.errors?.[0] as any)?.extensions?.code).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect((await post(3)).authorId).toBe(3);

    const shown = await run(
      'mutation { updatePostsMany(updates: [{ where: { id: { eq: 4 } }, set: { shownAuthor: { connect: { id: { eq: 2 } } } } }]) { id } }',
    );
    expect(shown.errors).toBeUndefined();
    expect((await post(4)).authorId).toBe(2);
  });
});
