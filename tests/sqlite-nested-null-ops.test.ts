import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Every nested operation is a nullable input field, so a client can send `create: null`.
// An explicit null has to mean the same as leaving the operation out.
// users.notes   to-many, FK on the child
// users.avatar  to-one, FK on the child, nullable (attaching detaches the old row)
// posts.author  to-one, FK on the parent
const Users = sqliteTable('no_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name'),
});
const Notes = sqliteTable('no_notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id'),
  body: text('body'),
});
const Avatars = sqliteTable('no_avatars', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id'),
  url: text('url'),
});
const Posts = sqliteTable('no_posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  authorId: integer('author_id'),
  title: text('title'),
});

const tables = { Users, Notes, Avatars, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    notes: r.many.Notes({ from: r.Users.id, to: r.Notes.userId }),
    avatar: r.one.Avatars({ from: r.Users.id, to: r.Avatars.userId }),
  },
  Posts: { author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id }) },
});

let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;
const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });
const updateUser = (set: string) => run(`mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: ${set}) { id } }`);

beforeAll(async () => {
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema: { ...tables, relations }, relations });
  await db.run(sql`CREATE TABLE no_users (id integer PRIMARY KEY AUTOINCREMENT, name text)`);
  await db.run(sql`CREATE TABLE no_notes (id integer PRIMARY KEY AUTOINCREMENT, user_id integer, body text)`);
  await db.run(sql`CREATE TABLE no_avatars (id integer PRIMARY KEY AUTOINCREMENT, user_id integer, url text)`);
  await db.run(sql`CREATE TABLE no_posts (id integer PRIMARY KEY AUTOINCREMENT, author_id integer, title text)`);
  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});
afterAll(() => client.close());
beforeEach(async () => {
  for (const table of ['no_users', 'no_notes', 'no_avatars', 'no_posts']) {
    await db.run(sql.raw(`DELETE FROM ${table}`));
  }
  await db.run(sql`DELETE FROM sqlite_sequence`);
  await db.insert(Users).values({ name: 'Ada' });
  await db.insert(Notes).values({ userId: 1, body: 'kept' });
  await db.insert(Avatars).values({ userId: 1, url: 'a.png' });
});

describe.sequential('nested writes: an explicit null operation is absent', () => {
  it('to-many `create: null` inserts no row', async () => {
    const result = await updateUser('{ notes: { create: null } }');
    expect(result.errors).toBeUndefined();
    expect(await db.select().from(Notes)).toEqual([{ id: 1, userId: 1, body: 'kept' }]);
  });

  it.each(['connect', 'set', 'disconnect'])('to-many `%s: null` is ignored', async (operation) => {
    const result = await updateUser(`{ name: "Bea", notes: { ${operation}: null } }`);
    expect(result.errors).toBeUndefined();
    expect(await db.select().from(Users)).toEqual([{ id: 1, name: 'Bea' }]);
    expect(await db.select().from(Notes)).toEqual([{ id: 1, userId: 1, body: 'kept' }]);
  });

  it('to-one child-side `create: null` keeps the attached row', async () => {
    const result = await updateUser('{ avatar: { create: null } }');
    expect(result.errors).toBeUndefined();
    expect(await db.select().from(Avatars)).toEqual([{ id: 1, userId: 1, url: 'a.png' }]);
  });

  it('an operation object whose every field is null is a no-op, like `{}`', async () => {
    const result = await updateUser('{ avatar: { create: null, connect: null, disconnect: null } }');
    expect(result.errors).toBeUndefined();
    expect(await db.select().from(Avatars)).toEqual([{ id: 1, userId: 1, url: 'a.png' }]);
  });

  it('a null relation input is a no-op', async () => {
    const result = await updateUser('{ name: "Bea", notes: null, avatar: null }');
    expect(result.errors).toBeUndefined();
    expect(await db.select().from(Notes)).toEqual([{ id: 1, userId: 1, body: 'kept' }]);
    expect(await db.select().from(Avatars)).toEqual([{ id: 1, userId: 1, url: 'a.png' }]);
  });

  it('parent-side `{ create: null, connect }` connects without inserting a blank row', async () => {
    const result = await run(
      `mutation { createPostsSingle(values: { title: "P", author: { create: null, connect: { id: { eq: 1 } } } }) { authorId } }`,
    );
    expect(result.errors).toBeUndefined();
    expect((result.data as any).createPostsSingle.authorId).toBe(1);
    expect(await db.select().from(Users)).toEqual([{ id: 1, name: 'Ada' }]);
  });
});
