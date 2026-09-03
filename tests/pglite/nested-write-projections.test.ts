import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A nested write reads keys: which target rows an operand matches, which links a parent already
// has, which key a freshly created row got. Every table here carries a column no nested write
// ever needs — `authors.bio`, `tags.description`, `posts_to_tags.note` — and these pin that the
// statements never ask for it, so a wide row is not dragged across the wire for one key.
const Authors = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  bio: text('bio'),
});
const Posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});
const Tags = pgTable('tags', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
});
const PostsToTags = pgTable(
  'posts_to_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
    note: text('note'),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);

const r = createRelationsHelper({ Authors, Posts, Tags, PostsToTags });
const relations = buildRelations(
  { Authors, Posts, Tags, PostsToTags },
  {
    Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
    Posts: {
      author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }),
      tags: r.many.Tags({
        from: r.Posts.id.through(r.PostsToTags.postId),
        to: r.Tags.id.through(r.PostsToTags.tagId),
      }),
    },
    Tags: {
      posts: r.many.Posts({
        from: r.Tags.id.through(r.PostsToTags.tagId),
        to: r.Posts.id.through(r.PostsToTags.postId),
      }),
    },
  },
);
const schema = { Authors, Posts, Tags, PostsToTags, relations };

const DATA_DIR = `./tests/.temp/pgdata-nested-write-projections-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let queries: string[] = [];

const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });

/** The statements this write issued against `table`, cut down to their select/returning list. */
const projectionsOn = (table: string, keyword: 'select' | 'returning') =>
  queries
    .filter((query) => query.includes(`"${table}"`) && query.includes(keyword))
    .map((query) =>
      keyword === 'select'
        ? query.slice(query.indexOf('select') + 'select'.length, query.indexOf(' from '))
        : query.slice(query.indexOf('returning') + 'returning'.length),
    );

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({
    client: pglite,
    schema,
    relations,
    logger: { logQuery: (query: string) => queries.push(query) },
  });

  await db.execute(sql`CREATE TABLE "authors" (
		"id" serial PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"bio" text
	);`);
  await db.execute(sql`CREATE TABLE "posts" (
		"id" serial PRIMARY KEY NOT NULL,
		"author_id" integer,
		"title" text NOT NULL
	);`);
  await db.execute(sql`CREATE TABLE "tags" (
		"id" serial PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"description" text
	);`);
  await db.execute(sql`CREATE TABLE "posts_to_tags" (
		"post_id" integer NOT NULL,
		"tag_id" integer NOT NULL,
		"note" text,
		PRIMARY KEY ("post_id", "tag_id")
	);`);

  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "authors", "posts", "tags", "posts_to_tags" RESTART IDENTITY`);
  await db.insert(Authors).values([{ name: 'Ada', bio: 'a long biography' }]);
  await db.insert(Tags).values([{ name: 'sql', description: 'a long description' }]);
  queries = [];
});

describe.sequential('nested writes read only the keys they use', () => {
  it('reads one column when connecting the parent side', async () => {
    const res = await run(`mutation {
			createPostsSingle(values: { title: "Hello", author: { connect: { name: { eq: "Ada" } } } }) { authorId }
		}`);

    expect(res.errors).toBeUndefined();
    expect((res.data as any).createPostsSingle.authorId).toBe(1);
    const selects = projectionsOn('authors', 'select');
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain('"id"');
    expect(selects[0]).not.toContain('"bio"');
  });

  it('returns one column when creating the parent side', async () => {
    const res = await run(`mutation {
			createPostsSingle(values: { title: "Hello", author: { create: { name: "Bob", bio: "another long one" } } }) {
				authorId
			}
		}`);

    expect(res.errors).toBeUndefined();
    expect((res.data as any).createPostsSingle.authorId).toBe(2);
    const returned = projectionsOn('authors', 'returning');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toContain('"id"');
    expect(returned[0]).not.toContain('"bio"');
  });

  it('reads one column from the target and the junction when linking through', async () => {
    const res = await run(`mutation {
			createPostsSingle(values: { title: "Hello", tags: { connect: [{ name: { eq: "sql" } }] } }) { id }
		}`);

    expect(res.errors).toBeUndefined();

    const targetSelects = projectionsOn('tags', 'select').filter((list) => !list.includes('post_id'));
    expect(targetSelects).toHaveLength(1);
    expect(targetSelects[0]).toContain('"id"');
    expect(targetSelects[0]).not.toContain('"description"');

    const junctionSelects = projectionsOn('posts_to_tags', 'select');
    expect(junctionSelects).toHaveLength(1);
    expect(junctionSelects[0]).toContain('"tag_id"');
    expect(junctionSelects[0]).not.toContain('"note"');

    // The link still lands, projection or not.
    expect(await db.select().from(PostsToTags)).toStrictEqual([{ postId: 1, tagId: 1, note: null }]);
  });
});
