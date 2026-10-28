// drizzle-orm rc.4 keeps the tables' own Column objects in a relation's `sourceColumns` /
// `targetColumns`; the rc.5 snapshots keep `RelationsBuilderColumn` descriptors there instead
// (issue #179). Matching those by identity found nothing, so relation aggregates and
// nested-write inputs vanished without a word. CI runs on rc.4, so these rebuild rc.5's shape
// by wrapping a real relation's columns, and pin that the schema comes out identical.

import { createClient } from '@libsql/client';
import { buildRelations, type Column, createRelationsHelper, entityKind, getColumns, type Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, type GraphQLObjectType, printSchema } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/index';
import {
  buildNamedRelations,
  extractFilters,
  relationColumns,
  relationFilterCtx,
  unwrapRelationColumn,
} from '@/util/builders/common';

const Authors = sqliteTable('authors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});
const Tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});
const PostsToTags = sqliteTable(
  'posts_to_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);
const tables = { Authors, Posts, Tags, PostsToTags };

/** Fresh relation objects per call, since the rc.5 simulation rewrites them in place. */
const makeRelations = () => {
  const r = createRelationsHelper(tables);
  return buildRelations(tables, {
    Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
    Posts: {
      author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }),
      tags: r.many.Tags({ from: r.Posts.id.through(r.PostsToTags.postId), to: r.Tags.id.through(r.PostsToTags.tagId) }),
    },
    Tags: {
      posts: r.many.Posts({
        from: r.Tags.id.through(r.PostsToTags.tagId),
        to: r.Posts.id.through(r.PostsToTags.postId),
      }),
    },
  });
};

/** Mirrors drizzle-orm rc.5's `RelationsBuilderColumn`: an entity holding `_.column`. */
class FakeRelationsBuilderColumn {
  static readonly [entityKind] = 'RelationsBuilderColumn';
  _: { tableName: string; column: Column; key: string };
  constructor(column: Column, tableName: string, key: string) {
    this._ = { tableName, column, key };
  }
}

// Idempotent, so the file also runs unchanged against an rc.5 install that already wraps them.
const wrap = (entry: unknown): FakeRelationsBuilderColumn => {
  const column = unwrapRelationColumn(entry)!;
  for (const [tableName, table] of Object.entries(tables)) {
    for (const [key, candidate] of Object.entries(getColumns(table as Table))) {
      if (candidate === column) {
        return new FakeRelationsBuilderColumn(column, tableName, key);
      }
    }
  }
  throw new Error(`column ${column.name} belongs to no test table`);
};

/** Rewrites every relation's join columns into rc.5's shape, as rc.5 itself stores them. */
const toRc5Shape = (relations: ReturnType<typeof makeRelations>) => {
  for (const config of Object.values(relations)) {
    for (const relation of Object.values((config as any).relations) as any[]) {
      relation.sourceColumns = relation.sourceColumns.map(wrap);
      relation.targetColumns = relation.targetColumns.map(wrap);
    }
  }
  return relations;
};

const dbWith = (relations: ReturnType<typeof makeRelations>) =>
  (drizzle as any)({ client: createClient({ url: ':memory:' }), schema: { ...tables, relations }, relations });

const build = (relations: ReturnType<typeof makeRelations>) =>
  buildSchema(dbWith(relations), { features: { nestedWrites: true } }).schema;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unwrapRelationColumn', () => {
  it('returns a plain column as is (rc.4 sourceColumns / targetColumns)', () => {
    expect(unwrapRelationColumn(Posts.authorId)).toBe(Posts.authorId);
  });

  it('unwraps a RelationsBuilderColumn (rc.5 sourceColumns / targetColumns, every version’s through)', () => {
    expect(unwrapRelationColumn(new FakeRelationsBuilderColumn(Posts.authorId, 'Posts', 'authorId'))).toBe(
      Posts.authorId,
    );
    expect(unwrapRelationColumn({ _: { column: Tags.id, key: 'id', tableName: 'Tags' } })).toBe(Tags.id);
  });

  it('returns undefined for anything that is not a column in either shape', () => {
    expect(unwrapRelationColumn(undefined)).toBeUndefined();
    expect(unwrapRelationColumn(null)).toBeUndefined();
    expect(unwrapRelationColumn({})).toBeUndefined();
    expect(unwrapRelationColumn({ _: { column: 'author_id' } })).toBeUndefined();
  });

  it('relationColumns reads both shapes and refuses a list with an unreadable entry', () => {
    const plain = makeRelations().Authors.relations.posts;
    expect(relationColumns(plain, 'source')).toEqual([Authors.id]);
    expect(relationColumns(plain, 'target')).toEqual([Posts.authorId]);

    const wrapped = toRc5Shape(makeRelations()).Authors.relations.posts;
    expect(relationColumns(wrapped, 'source')![0]).toBe(Authors.id);
    expect(relationColumns(wrapped, 'target')![0]).toBe(Posts.authorId);

    expect(relationColumns({ sourceColumns: [Authors.id, { _: {} }] }, 'source')).toBeUndefined();
    expect(relationColumns({ sourceColumns: [] }, 'source')).toBeUndefined();
  });
});

describe('relations in drizzle-orm rc.5 shape', () => {
  it('generate the same schema as rc.4, aggregates and nested-write inputs included', () => {
    const warn = vi.spyOn(console, 'warn');
    const rc4 = build(makeRelations());
    const rc5 = build(toRc5Shape(makeRelations()));

    expect(printSchema(rc5)).toBe(printSchema(rc4));

    const author = rc5.getType('Authors') as GraphQLObjectType;
    expect(author.getFields()['postsAggregate']).toBeDefined();
    const post = rc5.getType('Posts') as GraphQLObjectType;
    expect(post.getFields()['tagsAggregate']).toBeDefined();

    const createAuthor = rc5.getType('CreateAuthorsInput') as GraphQLInputObjectType;
    expect(createAuthor.getFields()['posts']).toBeDefined();
    const createPost = rc5.getType('CreatePostsInput') as GraphQLInputObjectType;
    expect(createPost.getFields()['author']).toBeDefined();
    expect(createPost.getFields()['tags']).toBeDefined();

    expect(warn.mock.calls.filter(([message]) => String(message).includes('join columns'))).toEqual([]);
  });

  it('compile relation filters, direct and through a junction, to the same SQL', () => {
    const sqlFor = (relations: ReturnType<typeof makeRelations>, table: 'Authors' | 'Posts', filter: any) => {
      const db = dbWith(relations);
      const namedRelations = buildNamedRelations(db._.relations, Object.entries(tables));
      const ctx = relationFilterCtx({ tables, namedRelations, uniqueKeys: {} }, table);
      return db.dialect.sqlToQuery(extractFilters(tables[table], table, filter, ctx)!);
    };

    const direct = { posts: { some: { title: { eq: 'x' } } } };
    expect(sqlFor(toRc5Shape(makeRelations()), 'Authors', direct)).toEqual(sqlFor(makeRelations(), 'Authors', direct));

    const through = { tags: { some: { name: { eq: 'x' } } } };
    expect(sqlFor(toRc5Shape(makeRelations()), 'Posts', through)).toEqual(sqlFor(makeRelations(), 'Posts', through));
  });
});

describe('a relation whose join columns cannot be matched', () => {
  it('warns at build time instead of silently dropping its aggregate and nested-write input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const relations = makeRelations();
    // Columns the relation declares, but of a table it does not join: nothing can match them.
    (relations.Authors.relations.posts as any).sourceColumns = [Tags.id];

    const schema = build(relations);

    const author = schema.getType('Authors') as GraphQLObjectType;
    expect(author.getFields()['postsAggregate']).toBeUndefined();
    const messages = warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('join columns'));
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.startsWith("Drizzle-GraphQL Warning: relation 'Authors.posts'"))).toBe(true);
    expect(messages.some((m) => m.includes("'postsAggregate' field"))).toBe(true);
    expect(messages.some((m) => m.includes('nested-write'))).toBe(true);
  });

  it('does not warn for relations that build normally', () => {
    const warn = vi.spyOn(console, 'warn');
    build(makeRelations());
    expect(warn.mock.calls.filter(([message]) => String(message).includes('join columns'))).toEqual([]);
  });
});
