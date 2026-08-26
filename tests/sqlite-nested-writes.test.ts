import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Authors = sqliteTable('authors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});

const r = createRelationsHelper({ Authors, Posts });
const relations = buildRelations(
  { Authors, Posts },
  {
    Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
    Posts: { author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }) },
  },
);
const schema = { Authors, Posts, relations };

let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });
const posts = () => db.select().from(Posts).orderBy(Posts.id);
const authors = () => db.select().from(Authors).orderBy(Authors.id);

beforeAll(async () => {
  // Shared cache rather than a plain `:memory:`: a nested write runs its statements on a
  // transaction, which libsql serves from a second connection — one that would otherwise
  // open an empty database of its own.
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "authors" (
		"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
		"name" text NOT NULL
	);`);
  await db.run(sql`CREATE TABLE "posts" (
		"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
		"author_id" integer,
		"title" text NOT NULL
	);`);

  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "posts"`);
  await db.run(sql`DELETE FROM "authors"`);
  await db.run(sql`DELETE FROM "sqlite_sequence"`);
});

describe.sequential('SQLite nested writes', () => {
  it('is opt-in', () => {
    const defaults = buildSchema(db).schema;

    expect((defaults.getType('CreateAuthorsInput') as GraphQLInputObjectType).getFields()['posts']).toBeUndefined();
  });

  it('adds the relation fields to the create and update inputs', () => {
    const create = (gqlSchema.getType('CreateAuthorsInput') as GraphQLInputObjectType).getFields();
    const update = (gqlSchema.getType('UpdateAuthorsInput') as GraphQLInputObjectType).getFields();

    expect(String(create['posts']!.type)).toBe('AuthorsPostsNestedCreateInput');
    expect(String(update['posts']!.type)).toBe('AuthorsPostsNestedUpdateInput');
  });

  it('creates and attaches children', async () => {
    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { create: [{ title: "First" }] } }) { id name posts { title } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createAuthorsSingle: { id: 1, name: 'Ada', posts: [{ title: 'First' }] } });
    expect(await posts()).toEqual([{ id: 1, authorId: 1, title: 'First' }]);
  });

  it('writes the parent side first and points the new row at it', async () => {
    const result = await run(`mutation {
      createPostsSingle(values: { title: "Hello", author: { create: { name: "Grace" } } }) { authorId }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).createPostsSingle.authorId).toBe(1);
  });

  it('replaces the whole set on update', async () => {
    await db.insert(Authors).values({ name: 'Ada' });
    await db.insert(Posts).values([{ title: 'A1', authorId: 1 }, { title: 'Free' }]);

    const result = await run(`mutation {
      updateAuthorsSingle(where: { id: { eq: 1 } }, set: { posts: { set: [{ title: { eq: "Free" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts()).map((p: any) => p.authorId)).toEqual([null, 1]);
  });

  it('gives each entry of a batch update its own nested operations', async () => {
    await db.insert(Authors).values([{ name: 'Ada' }, { name: 'Grace' }]);
    await db.insert(Posts).values([{ title: 'Free' }]);

    const result = await run(`mutation {
      updateAuthorsMany(updates: [
        { where: { id: { eq: 1 } }, set: { name: "Ada L" } },
        { where: { id: { eq: 2 } }, set: { posts: { connect: [{ title: { eq: "Free" } }] } } }
      ]) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts())[0].authorId).toBe(2);
    expect((await authors())[0].name).toBe('Ada L');
  });

  it('rolls the whole write back when a nested operation fails', async () => {
    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { connect: [{}] } }) { id }
    }`);

    expect(result.errors?.[0]?.message).toMatch(/matches everything/);
    expect(await authors()).toHaveLength(0);
  });
});
