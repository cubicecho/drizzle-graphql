import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql, printSchema } from 'graphql';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, type NestedWriteInputInfo, type NestedWritesSwitch } from '@/index';

// `features.nestedWrites` as a predicate: asked once per relation input at build time, it can
// only take inputs away from what the relation's shape and the target's own switches offer.
//
// authors.posts   to-many, FK on the child, nullable  → create/connect/disconnect/set
// posts.author    to-one, FK on the parent, nullable  → create/connect/disconnect
// posts.comments  to-many, FK on the child, NOT NULL  → create/connect
// comments.post   to-one, FK on the parent, NOT NULL  → create/connect
// posts.tags      many-to-many through posts_to_tags  → connect/disconnect/set
const Authors = pgTable('authors', { id: serial('id').primaryKey(), name: text('name').notNull() });
const Posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});
const Comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  postId: integer('post_id').notNull(),
  body: text('body').notNull(),
});
const Tags = pgTable('tags', { id: serial('id').primaryKey(), name: text('name').notNull() });
const PostsToTags = pgTable(
  'posts_to_tags',
  { postId: integer('post_id').notNull(), tagId: integer('tag_id').notNull() },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);
const tables = { Authors, Posts, Comments, Tags, PostsToTags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
  Posts: {
    author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }),
    comments: r.many.Comments({ from: r.Posts.id, to: r.Comments.postId }),
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostsToTags.postId), to: r.Tags.id.through(r.PostsToTags.tagId) }),
  },
  Comments: { post: r.one.Posts({ from: r.Comments.postId, to: r.Posts.id }) },
});

let db: any;
beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(sql`create table authors (id serial primary key, name text not null)`);
  await db.execute(sql`create table posts (id serial primary key, author_id int, title text not null)`);
  await db.execute(sql`create table comments (id serial primary key, post_id int not null, body text not null)`);
  await db.execute(sql`create table tags (id serial primary key, name text not null)`);
  await db.execute(
    sql`create table posts_to_tags (post_id int not null, tag_id int not null, primary key (post_id, tag_id))`,
  );
});
beforeEach(async () => {
  await db.execute(sql`truncate authors, posts, comments, tags, posts_to_tags restart identity`);
  await db.execute(sql`insert into authors (name) values ('Ada')`);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const build = (nestedWrites: NestedWritesSwitch, features: Record<string, any> = {}) =>
  buildSchema(db, { features: { nestedWrites, ...features } }).schema;
const run = (schema: GraphQLSchema, source: string) => graphql({ schema, source, contextValue: {} });
const fields = (schema: GraphQLSchema, name: string) =>
  (schema.getType(name) as GraphQLInputObjectType | undefined)?.getFields();
const fieldNames = (schema: GraphQLSchema, name: string) => Object.keys(fields(schema, name) ?? {}).sort();

describe('nestedWrites predicate: what it is asked', () => {
  it('is asked once per relation input the shape allows, naming the far side of a junction', () => {
    const asked: NestedWriteInputInfo[] = [];
    build((input) => {
      asked.push(input);
      return true;
    });

    const keys = asked.map(({ table, relation, target, op }) => `${table}.${relation}->${target}:${op}`).sort();
    expect(keys).toEqual(
      [
        'Authors.posts->Posts:create',
        'Authors.posts->Posts:connect',
        'Authors.posts->Posts:disconnect',
        'Authors.posts->Posts:set',
        'Posts.author->Authors:create',
        'Posts.author->Authors:connect',
        'Posts.author->Authors:disconnect',
        'Posts.comments->Comments:create',
        'Posts.comments->Comments:connect',
        'Comments.post->Posts:create',
        'Comments.post->Posts:connect',
        'Posts.tags->Tags:connect',
        'Posts.tags->Tags:disconnect',
        'Posts.tags->Tags:set',
      ].sort(),
    );
  });

  it('builds the same schema as `true` when it allows everything', () => {
    expect(printSchema(build(() => true))).toEqual(printSchema(build(true)));
  });
});

describe('nestedWrites predicate: narrowing per relation', () => {
  it('takes a relation off other tables while the target keeps its own CRUD', () => {
    // Comments are written only through their own mutations.
    const schema = build(({ target }) => target !== 'Comments');

    expect(fields(schema, 'CreatePostsInput')?.['comments']).toBeUndefined();
    expect(fields(schema, 'UpdatePostsInput')?.['comments']).toBeUndefined();
    expect(fields(schema, 'CreatePostsInput')?.['author']).toBeDefined();
    expect(fields(schema, 'CreateCommentsInput')?.['post']).toBeDefined();
    const mutations = Object.keys(schema.getMutationType()!.getFields());
    expect(mutations).toEqual(expect.arrayContaining(['createCommentsSingle', 'updateComments', 'deleteComments']));
  });

  it('drops a single input and keeps the rest of the relation', async () => {
    // Link existing authors, never create one underneath a post.
    const schema = build(({ target, op }) => !(target === 'Authors' && op === 'create'));

    expect(fieldNames(schema, 'PostsAuthorNestedCreateInput')).toEqual(['connect']);
    expect(fieldNames(schema, 'PostsAuthorNestedUpdateInput')).toEqual(['connect', 'disconnect']);
    // The other direction is a different relation, and keeps its create.
    expect(fieldNames(schema, 'AuthorsPostsNestedCreateInput')).toEqual(['connect', 'create']);

    const linked = await run(
      schema,
      'mutation { createPostsSingle(values: { title: "p", author: { connect: { id: { eq: 1 } } } }) { id authorId } }',
    );
    expect(linked.errors).toBeUndefined();
    expect(linked.data?.['createPostsSingle']).toEqual({ id: 1, authorId: 1 });

    const created = await run(
      schema,
      'mutation { createPostsSingle(values: { title: "q", author: { create: { name: "Hedy" } } }) { id } }',
    );
    expect(created.errors).toHaveLength(1);
    expect(await db.select().from(Authors)).toHaveLength(1);
    expect(await db.select().from(Posts)).toHaveLength(1);
  });

  it('narrows a many-to-many by its far side', () => {
    const schema = build(({ relation, op }) => !(relation === 'tags' && op !== 'connect'));

    expect(fieldNames(schema, 'PostsTagsNestedCreateInput')).toEqual(['connect']);
    expect(fieldNames(schema, 'PostsTagsNestedUpdateInput')).toEqual(['connect']);
  });

  it('makes a parent-side key required again once nothing on the relation can fill it in', () => {
    const relaxed = build(true);
    expect(String(fields(relaxed, 'CreateCommentsInput')?.['postId']?.type)).toBe('Int');

    const schema = build(({ table, relation }) => !(table === 'Comments' && relation === 'post'));
    expect(fields(schema, 'CreateCommentsInput')?.['post']).toBeUndefined();
    expect(String(fields(schema, 'CreateCommentsInput')?.['postId']?.type)).toBe('Int!');
  });

  it('applies to the upsert input too', () => {
    const schema = build(({ target, op }) => !(target === 'Authors' && op === 'create'), { upsert: true });

    expect(fieldNames(schema, 'PostsAuthorNestedUpsertInput')).toEqual(['connect', 'disconnect']);
  });

  it('leaves nested writes out entirely when it allows nothing', () => {
    const schema = build(() => false);

    expect(fields(schema, 'CreatePostsInput')?.['author']).toBeUndefined();
    expect(printSchema(schema)).not.toMatch(/Nested(Create|Update)Input/);
  });
});

describe('nestedWrites predicate: the boolean form', () => {
  it('still turns the whole feature on or off', () => {
    expect(fieldNames(build(true), 'PostsCommentsNestedCreateInput')).toEqual(['connect', 'create']);
    expect(fields(build(false), 'CreatePostsInput')?.['comments']).toBeUndefined();
  });
});

describe("nestedWrites predicate: the target table's own switches", () => {
  it('cannot offer an input the target has turned off', () => {
    const schema = build(() => true, { insert: (table: string) => table !== 'Comments' });

    expect(fieldNames(schema, 'PostsCommentsNestedCreateInput')).toEqual(['connect']);
  });

  it('warns only about the inputs the switches took away, not the ones it turned down', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = build(({ relation, op }) => !(relation === 'comments' && op === 'connect'), {
      insert: (table: string) => table !== 'Comments',
    });

    // The predicate removed connect and the switch removed create: nothing is left.
    expect(fields(schema, 'CreatePostsInput')?.['comments']).toBeUndefined();
    const notes = warn.mock.calls.map(([message]) => String(message)).filter((message) => /nestedWrites/.test(message));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Posts.comments.create');
    expect(notes[0]).not.toContain('Posts.comments.connect');
  });
});
