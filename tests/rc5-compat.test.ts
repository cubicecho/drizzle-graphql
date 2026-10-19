// drizzle-orm rc.5 snapshots changed three things the library reads or writes (issue #186):
// a relational query config with a `where` key set to `undefined` now throws; a relation's
// `isReversed` flag is now `isFilterReversed`; and a relation's `where` defaults to the
// `EmptyFilter` sentinel instead of `undefined`. CI runs on rc.4, so these pin the behaviour
// that keeps both versions working: no generated config carries an undefined key, and the
// relation helpers read both shapes. The file also passes unchanged on an rc.5 install.

import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, type SQL, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/index';
import { buildNamedRelations, extractFilters, extractOrderBy, relationFilterCtx } from '@/util/builders/common';
import { isRelationFilterReversed, relationOwnWhere } from '@/util/builders/common/relations.ts';
import { omitUndefinedKeys } from '@/util/builders/common/rqb-config.ts';

const EMPTY_FILTER = Symbol.for('drizzle:EmptyFilter');

const Authors = sqliteTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});
const Tags = sqliteTable('tags', {
  id: integer('id').primaryKey(),
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

/**
 * `Posts.author` declares neither `from`/`to` nor `where`, so drizzle derives it from
 * `Authors.posts` and inherits that relation's `where` — which is written against `posts`, the
 * new relation's *source*. That is the case the reversed flag exists for.
 */
const makeRelations = () => {
  const r = createRelationsHelper(tables);
  return buildRelations(tables, {
    Authors: {
      posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId, where: { title: { like: 'pub%' } } }),
    },
    Posts: {
      author: r.one.Authors(),
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

/** Rewrites relations the way rc.5 builds them: `isFilterReversed`, and `EmptyFilter` for no `where`. */
const toRc5Shape = (relations: ReturnType<typeof makeRelations>) => {
  for (const config of Object.values(relations)) {
    for (const relation of Object.values((config as any).relations) as any[]) {
      if ('isReversed' in relation) {
        relation.isFilterReversed = relation.isReversed;
        delete relation.isReversed;
      }
      relation.where ??= EMPTY_FILTER;
    }
  }
  return relations;
};

const dbWith = (relations: ReturnType<typeof makeRelations>) =>
  (drizzle as any)({ client: createClient({ url: ':memory:' }), relations });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('omitUndefinedKeys', () => {
  it('drops keys whose value is undefined and keeps every other value', () => {
    const raw = () => undefined;
    const out = omitUndefinedKeys({
      columns: { id: true },
      where: undefined,
      orderBy: undefined,
      limit: 0,
      offset: null,
      with: { posts: { columns: { id: true } } },
      extras: raw,
    });
    expect(out).toEqual({
      columns: { id: true },
      limit: 0,
      offset: null,
      with: { posts: { columns: { id: true } } },
      extras: raw,
    });
    expect('where' in out).toBe(false);
    expect('orderBy' in out).toBe(false);
  });
});

describe('relation helpers across rc.4 and rc.5 shapes', () => {
  it('relationOwnWhere treats undefined, null and the EmptyFilter sentinel as no filter', () => {
    const where = { title: { eq: 'x' } };
    expect(relationOwnWhere({ where })).toBe(where);
    expect(relationOwnWhere({ where: undefined })).toBeUndefined();
    expect(relationOwnWhere({ where: null })).toBeUndefined();
    expect(relationOwnWhere({ where: EMPTY_FILTER })).toBeUndefined();
    expect(relationOwnWhere({})).toBeUndefined();
    expect(relationOwnWhere(undefined)).toBeUndefined();
  });

  it('isRelationFilterReversed reads rc.4 `isReversed` and rc.5 `isFilterReversed`', () => {
    expect(isRelationFilterReversed({ isReversed: true })).toBe(true);
    expect(isRelationFilterReversed({ isReversed: false })).toBe(false);
    expect(isRelationFilterReversed({ isFilterReversed: true })).toBe(true);
    expect(isRelationFilterReversed({ isFilterReversed: false })).toBe(false);
    expect(isRelationFilterReversed({})).toBe(false);
    expect(isRelationFilterReversed(undefined)).toBe(false);
  });

  it('the fixture really has a reversed, inherited relation where', () => {
    const relation = makeRelations().Posts.relations.author;
    expect(isRelationFilterReversed(relation)).toBe(true);
    expect(relationOwnWhere(relation)).toEqual({ title: { like: 'pub%' } });
    expect(relationOwnWhere(makeRelations().Tags.relations.posts)).toBeUndefined();
  });

  it('relation filters and relation ordering compile to the same SQL in both shapes', () => {
    const compile = (relations: ReturnType<typeof makeRelations>, build: (ctx: any) => SQL | undefined) => {
      const db = dbWith(relations);
      const relationMap = buildNamedRelations(db._.relations, Object.entries(tables));
      return db.dialect.sqlToQuery(build(relationFilterCtx({ tables, relationMap, uniqueKeys: {} }, 'Posts'))!);
    };
    const filter = (ctx: any) => extractFilters(Posts, 'Posts', { author: { name: { eq: 'x' } } } as any, ctx);
    const order = (ctx: any) =>
      sql.join(extractOrderBy(Posts, { author: { name: { direction: 'asc', priority: 1 } } } as any, ctx), sql`, `);
    const tagFilter = (ctx: any) =>
      extractFilters(Posts, 'Posts', { tags: { some: { name: { eq: 'x' } } } } as any, ctx);

    for (const build of [filter, order, tagFilter]) {
      expect(compile(toRc5Shape(makeRelations()), build)).toEqual(compile(makeRelations(), build));
    }
    // The inherited `where` is on `posts`, so it has to reference the outer table, not the
    // aliased `authors` the subquery reads.
    expect(compile(makeRelations(), filter).sql).toMatch(/"posts"\."title" like/);
  });
});

describe('relational query configs', () => {
  /** Every path inside a findMany/findFirst config, `with:` entries included, that holds `undefined`. */
  const undefinedPaths = (config: unknown, path = ''): string[] => {
    if (!config || typeof config !== 'object') {
      return [];
    }
    const found: string[] = [];
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) {
        found.push(`${path}${key}`);
      }
    }
    const withTree = (config as any).with;
    if (withTree && typeof withTree === 'object') {
      for (const [relation, entry] of Object.entries(withTree)) {
        found.push(...undefinedPaths(entry, `${path}with.${relation}.`));
      }
    }
    return found;
  };

  it('never carry a key set to undefined (rc.5 throws on `where: undefined`)', async () => {
    const db = dbWith(makeRelations());
    await db.$client.executeMultiple(`
      create table authors (id integer primary key, name text not null);
      create table posts (id integer primary key, author_id integer, title text not null);
      create table tags (id integer primary key, name text not null);
      create table posts_to_tags (post_id integer not null, tag_id integer not null, primary key (post_id, tag_id));
      insert into authors values (1, 'a');
      insert into posts values (1, 1, 'pub one');
      insert into tags values (1, 't');
      insert into posts_to_tags values (1, 1);
    `);
    const { schema } = buildSchema(db);

    const configs: unknown[] = [];
    for (const table of Object.keys(tables)) {
      for (const method of ['findMany', 'findFirst'] as const) {
        const original = db.query[table][method].bind(db.query[table]);
        vi.spyOn(db.query[table], method).mockImplementation((config: unknown) => {
          configs.push(config);
          return original(config);
        });
      }
    }

    const queries = [
      '{ authors { id name } }',
      '{ authors(where: { name: { eq: "a" } }, limit: 5, offset: 0) { id posts { id title tags { id name } } } }',
      '{ authors { id posts(where: { title: { like: "pub%" } }, orderBy: { id: { direction: desc, priority: 1 } }) { id } } }',
      '{ authorsSingle { id posts(limit: 1) { id author { id } } } }',
      '{ posts(orderBy: { author: { name: { direction: asc, priority: 1 } } }) { id author { name } tags { id } } }',
      '{ postsSingle(where: { author: { name: { eq: "a" } } }) { id } }',
    ];
    for (const source of queries) {
      const result = await graphql({ schema, source, contextValue: {} });
      expect(result.errors, source).toBeUndefined();
    }

    expect(configs.length).toBeGreaterThanOrEqual(queries.length);
    expect(configs.flatMap((config) => undefinedPaths(config))).toEqual([]);
  });
});
