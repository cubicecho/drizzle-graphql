// A mutation payload's relations come from two places: the eager re-fetch attaches the ones
// `eagerLoadRelations` loads, and the relation resolver fetches the rest from the written row's
// join column. These pin that RETURNING carries the join column of a relation left to its own
// resolver, and that the re-fetch compiles relation arguments that filter or order through a
// relation — instead of failing, warning, and falling back to the lazy loader.

import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { boolean, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/index';

const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull(),
  editorId: integer('editor_id'),
  published: boolean('published').notNull(),
});
const Tags = pgTable('tags', { id: integer('id').primaryKey(), name: text('name').notNull() });
const PostTags = pgTable(
  'post_tags',
  { postId: integer('post_id').notNull(), tagId: integer('tag_id').notNull() },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);

const relations = defineRelations({ Users, Posts, Tags, PostTags }, (r) => ({
  Users: {
    posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId, alias: 'author' }),
    edited: r.many.Posts({ from: r.Users.id, to: r.Posts.editorId, alias: 'editor' }),
  },
  Posts: {
    author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id, alias: 'author', optional: false }),
    editor: r.one.Users({ from: r.Posts.editorId, to: r.Users.id, alias: 'editor' }),
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostTags.postId), to: r.Tags.id.through(r.PostTags.tagId) }),
  },
}));

let client: PGlite;
let db: any;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle({ client, relations } as any);
  await client.exec(`
    CREATE TABLE users (id int primary key, name text not null);
    CREATE TABLE posts (id int primary key, title text not null, author_id int not null, editor_id int, published boolean not null);
    CREATE TABLE tags (id int primary key, name text not null);
    CREATE TABLE post_tags (post_id int not null, tag_id int not null, primary key (post_id, tag_id));
    INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol');
    INSERT INTO posts VALUES (1, 'a1', 1, 2, true), (2, 'a2', 1, NULL, false), (4, 'b1', 2, 3, true), (5, 'b2', 2, 1, false);
    INSERT INTO tags VALUES (1, 'x'), (2, 'z');
    INSERT INTO post_tags VALUES (1, 1), (2, 2), (4, 2);
  `);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
});

const run = async (eagerLoadRelations: unknown, source: string) =>
  (await graphql({ schema: buildSchema(db, { eagerLoadRelations } as any).schema, source, contextValue: {} })) as any;

describe('a mutation payload relation that is not eager-loaded', () => {
  it('eagerLoadRelations: false — an update resolves the to-one relations', async () => {
    const result = await run(
      false,
      `mutation { updatePostsSingle(set: { title: "z" }, where: { id: { eq: 1 } }) { id author { name } editor { name } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ updatePostsSingle: { id: 1, author: { name: 'Alice' }, editor: { name: 'Bob' } } });
  });

  it('eagerLoadRelations: false — an insert resolves the to-one relations', async () => {
    const result = await run(
      false,
      `mutation { createPostsSingle(values: { id: 100, title: "n", authorId: 2, editorId: 3, published: true }) { id author { name } editor { name } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createPostsSingle: { id: 100, author: { name: 'Bob' }, editor: { name: 'Carol' } } });
  });

  it('eagerLoadRelations: false — a batch update resolves them for every row', async () => {
    const result = await run(
      false,
      `mutation { updatePostsMany(updates: [{ where: { id: { eq: 1 } }, set: { title: "p" } }, { where: { id: { eq: 4 } }, set: { title: "q" } }]) { id author { name } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.updatePostsMany).toEqual([
      { id: 1, author: { name: 'Alice' } },
      { id: 4, author: { name: 'Bob' } },
    ]);
  });

  it("the README's opt-out (Users.posts) returns the posts, not an empty list", async () => {
    const result = await run(
      (t: string, r: string) => !(t === 'Users' && r === 'posts'),
      `mutation { updateUsersSingle(set: { name: "B" }, where: { id: { eq: 2 } }) { name posts { id } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ updateUsersSingle: { name: 'B', posts: [{ id: 4 }, { id: 5 }] } });
  });

  it('an opted-out relation nested inside the eager re-fetch resolves', async () => {
    const result = await run(
      (t: string, r: string) => !(t === 'Posts' && r === 'author'),
      `mutation { updateUsersSingle(set: { name: "B" }, where: { id: { eq: 2 } }) { id posts(orderBy: { id: { direction: asc, priority: 0 } }) { id author { name } } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.updateUsersSingle.posts).toEqual([
      { id: 4, author: { name: 'B' } },
      { id: 5, author: { name: 'B' } },
    ]);
  });
});

describe('the mutation re-fetch with relation-aware relation arguments', () => {
  it.each([
    ['a relation filter', `posts(where: { tags: { some: { name: { eq: "z" } } } }) { id }`, [{ id: 2 }]],
    [
      'a relation orderBy',
      `posts(orderBy: { editor: { name: { direction: asc, priority: 0 } } }) { id }`,
      [{ id: 1 }, { id: 2 }],
    ],
  ])('%s runs in the re-fetch, without the fallback warning', async (_label, field, posts) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await run(
      undefined,
      `mutation { updateUsersSingle(set: { name: "Al" }, where: { id: { eq: 1 } }) { id ${field} } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.updateUsersSingle).toEqual({ id: 1, posts });
    expect(warn).not.toHaveBeenCalled();
  });
});
