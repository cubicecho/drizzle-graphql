// PostgreSQL sibling of tests/sqlite-filter-semantics.test.ts.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, json, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { JSON_DOCS, JSON_PATH_CASES } from '../util/filter-semantics';

const Items = pgTable('items', { id: integer('id').primaryKey(), name: text('name') });
const Posts = pgTable('posts', { id: integer('id').primaryKey(), itemId: integer('item_id'), title: text('title') });
const Comments = pgTable('comments', {
  id: integer('id').primaryKey(),
  postId: integer('post_id'),
  body: text('body'),
});
const Docs = pgTable('docs', { id: integer('id').primaryKey(), meta: jsonb('meta'), metaJson: json('meta_json') });
const tables = { Items, Posts, Comments, Docs };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Items: { posts: r.many.Posts({ from: r.Items.id, to: r.Posts.itemId }) },
  Posts: {
    item: r.one.Items({ from: r.Posts.itemId, to: r.Items.id }),
    comments: r.many.Comments({ from: r.Posts.id, to: r.Comments.postId }),
  },
  Comments: { post: r.one.Posts({ from: r.Comments.postId, to: r.Posts.id }) },
});

let pglite: PGlite;
let schema: GraphQLSchema;

const ids = async (root: string, where: string): Promise<number[]> => {
  const res: any = await graphql({
    schema,
    source: `{ ${root}(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    contextValue: {},
  });
  expect(res.errors).toBeUndefined();
  return res.data[root].map((row: any) => row.id);
};

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db: any = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE items (id integer primary key, name text)`);
  await db.execute(sql`CREATE TABLE posts (id integer primary key, item_id integer, title text)`);
  await db.execute(sql`CREATE TABLE comments (id integer primary key, post_id integer, body text)`);
  // 1: every post is "x" · 2: no posts · 3: one NULL-title post · 4: "x" and NULL · 5: "y"
  await db.insert(Items).values([1, 2, 3, 4, 5].map((id) => ({ id, name: id === 1 ? null : 'n' })));
  await db.insert(Posts).values([
    { id: 1, itemId: 1, title: 'x' },
    { id: 2, itemId: 1, title: 'x' },
    { id: 3, itemId: 3, title: null },
    { id: 4, itemId: 4, title: 'x' },
    { id: 5, itemId: 4, title: null },
    { id: 6, itemId: 5, title: 'y' },
  ]);
  await db.insert(Comments).values([
    { id: 1, postId: 1, body: 'ok' },
    { id: 2, postId: 2, body: null },
    { id: 3, postId: 6, body: 'ok' },
  ]);
  await db.execute(sql`CREATE TABLE docs (id integer primary key, meta jsonb, meta_json json)`);
  await db.insert(Docs).values(JSON_DOCS.map((doc) => ({ ...doc, metaJson: doc.meta })));
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('every: a related row whose compared column is NULL fails', () => {
  it('passes only items whose every post matches, and items with no posts', async () => {
    expect(await ids('items', '{ posts: { every: { title: { eq: "x" } } } }')).toEqual([1, 2]);
  });

  it('NOT every is its exact complement', async () => {
    expect(await ids('items', '{ NOT: { posts: { every: { title: { eq: "x" } } } } }')).toEqual([3, 4, 5]);
  });

  it('nested every inside every fails a NULL comment body', async () => {
    expect(await ids('items', '{ posts: { every: { comments: { every: { body: { eq: "ok" } } } } } }')).toEqual([
      2, 3, 4, 5,
    ]);
  });

  it('a match-all inner filter keeps every item; a match-nothing one keeps only items with no posts', async () => {
    expect(await ids('items', '{ posts: { every: { title: { notInArray: [] } } } }')).toEqual([1, 2, 3, 4, 5]);
    expect(await ids('items', '{ posts: { every: { title: { inArray: [] } } } }')).toEqual([2]);
  });

  it('a to-one filter does not match a NULL target column', async () => {
    expect(await ids('posts', '{ item: { name: { ne: "n" } } }')).toEqual([]);
    expect(await ids('posts', '{ item: { name: { isNull: true } } }')).toEqual([1, 2]);
  });
});

describe('JSON path as: NUMBER / BOOLEAN needs that JSON type', () => {
  const cases = (['meta', 'metaJson'] as const).flatMap((column) =>
    JSON_PATH_CASES.map(([filter, expected]) => [column, filter, expected] as const),
  );
  it.each(cases)('%s path %s', async (column, filter, expected) => {
    expect(await ids('docs', `{ ${column}: { path: ${filter} } }`)).toEqual(expected);
  });
});
