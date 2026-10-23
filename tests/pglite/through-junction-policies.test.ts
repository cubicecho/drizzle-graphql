// A `.through()` relation links only through the junction rows the junction's own `scope` and
// soft delete keep. A relation filter has always applied them; these pin that the relation field
// (eager, batched, paginated, distinct), `<relation>Aggregate` and a mutation payload apply them
// too, so every path agrees on which rows are related. The junction is read at EXCLUDE whatever
// the relation's `deleted` argument (which is about the target) or the junction's own
// `softDelete.scope` says.

import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Posts = pgTable('posts', { id: integer('id').primaryKey(), title: text('title').notNull() });
const Tags = pgTable('tags', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  deletedAt: text('deleted_at'),
});
const PostTags = pgTable(
  'post_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
    orgId: integer('org_id').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);

// A junction joined on two columns per side, which the batch loader cannot express.
const Shelves = pgTable('shelves', { a: integer('a').notNull(), b: integer('b').notNull() }, (t) => [
  primaryKey({ columns: [t.a, t.b] }),
]);
const Books = pgTable('books', { id: integer('id').notNull(), copy: integer('copy').notNull() }, (t) => [
  primaryKey({ columns: [t.id, t.copy] }),
]);
const ShelfBooks = pgTable('shelf_books', {
  shelfA: integer('shelf_a').notNull(),
  shelfB: integer('shelf_b').notNull(),
  bookId: integer('book_id').notNull(),
  bookCopy: integer('book_copy').notNull(),
  deletedAt: text('deleted_at'),
});

const tables = { Posts, Tags, PostTags, Shelves, Books, ShelfBooks };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Posts: {
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostTags.postId), to: r.Tags.id.through(r.PostTags.tagId) }),
  },
  Tags: {
    posts: r.many.Posts({ from: r.Tags.id.through(r.PostTags.tagId), to: r.Posts.id.through(r.PostTags.postId) }),
  },
  Shelves: {
    books: r.many.Books({
      from: [r.Shelves.a.through(r.ShelfBooks.shelfA), r.Shelves.b.through(r.ShelfBooks.shelfB)],
      to: [r.Books.id.through(r.ShelfBooks.bookId), r.Books.copy.through(r.ShelfBooks.bookCopy)],
    }),
  },
});

let client: PGlite;
let db: any;

beforeAll(async () => {
  client = new PGlite();
  db = (drizzle as any)({ client, relations });
  await client.exec(`
    CREATE TABLE posts (id integer PRIMARY KEY, title text NOT NULL);
    CREATE TABLE tags (id integer PRIMARY KEY, name text NOT NULL, deleted_at text);
    CREATE TABLE post_tags (post_id integer NOT NULL, tag_id integer NOT NULL, org_id integer NOT NULL, deleted_at text, PRIMARY KEY (post_id, tag_id));
    CREATE TABLE shelves (a integer NOT NULL, b integer NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE books (id integer NOT NULL, copy integer NOT NULL, PRIMARY KEY (id, copy));
    CREATE TABLE shelf_books (shelf_a integer NOT NULL, shelf_b integer NOT NULL, book_id integer NOT NULL, book_copy integer NOT NULL, deleted_at text);
    INSERT INTO posts VALUES (1, 'p1'), (2, 'p2');
    INSERT INTO tags VALUES (1, 'red', NULL), (2, 'green', NULL), (3, 'blue', NULL), (4, 'gray', '2024-01-01');
    INSERT INTO post_tags VALUES
      (1, 1, 1, NULL),          -- live, org 1
      (1, 2, 1, '2024-01-01'),  -- link soft-deleted
      (1, 3, 2, NULL),          -- live, org 2: outside org 1's scope
      (1, 4, 1, NULL),          -- live link to a soft-deleted tag
      (2, 1, 1, NULL);
    INSERT INTO shelves VALUES (1, 1);
    INSERT INTO books VALUES (1, 1);
    INSERT INTO shelf_books VALUES (1, 1, 1, 1, NULL);
  `);
});

afterAll(async () => {
  await client.close();
});

type Config = Record<string, unknown>;

const POLICIES: Config = {
  softDelete: { PostTags: 'deletedAt', Tags: 'deletedAt' },
  scope: { PostTags: (ctx: any, t: any) => eq(t.orgId, ctx.orgId) },
};

const run = async (config: Config, source: string, contextValue: any = { orgId: 1 }) => {
  const result: any = await graphql({ schema: buildSchema(db, config as any).schema, source, contextValue });
  expect(result.errors).toBeUndefined();
  return result.data;
};

const POST_1 = 'posts(where: { id: { eq: 1 } })';
const BY_ID = 'orderBy: { id: { direction: asc, priority: 0 } }';
const tagIdsOf = (data: any) => data.posts[0].tags.map((tag: any) => tag.id);

describe.each([true, false])('junction policies on a relation (eagerLoadRelations: %s)', (eagerLoadRelations) => {
  const config = { ...POLICIES, eagerLoadRelations };

  it('the relation filter is the reference: only the live, in-scope link matches', async () => {
    const data = await run(
      config,
      `{ red: posts(where: { tags: { some: { name: { eq: "red" } } } }) { id }
         green: posts(where: { tags: { some: { name: { eq: "green" } } } }) { id }
         blue: posts(where: { tags: { some: { name: { eq: "blue" } } } }) { id } }`,
    );
    expect(data).toEqual({ red: [{ id: 1 }, { id: 2 }], green: [], blue: [] });
  });

  it('the relation field returns the same links', async () => {
    expect(tagIdsOf(await run(config, `{ ${POST_1} { tags(${BY_ID}) { id } } }`))).toEqual([1]);
  });

  it('a paginated relation field returns the same links', async () => {
    expect(tagIdsOf(await run(config, `{ ${POST_1} { tags(${BY_ID}, limit: 5) { id } } }`))).toEqual([1]);
  });

  it('a distinct relation field returns the same links', async () => {
    expect(tagIdsOf(await run(config, `{ ${POST_1} { tags(distinct: [name]) { id } } }`))).toEqual([1]);
  });

  it('the other direction applies the junction too', async () => {
    const data = await run(config, `{ tags(${BY_ID}) { id posts(${BY_ID}) { id } } }`);
    expect(data.tags).toEqual([
      { id: 1, posts: [{ id: 1 }, { id: 2 }] },
      { id: 2, posts: [] },
      { id: 3, posts: [] },
    ]);
  });

  it('the relation aggregate counts the same links', async () => {
    const data = await run(config, `{ ${POST_1} { tagsAggregate { count } } }`);
    expect(data.posts[0].tagsAggregate).toEqual({ count: 1 });
  });

  it("`deleted` reads the target's marked rows, never the junction's", async () => {
    const data = await run(
      config,
      `{ ${POST_1} { tags(${BY_ID}, deleted: INCLUDE) { id } tagsAggregate(deleted: INCLUDE) { count } } }`,
    );
    expect(tagIdsOf(data)).toEqual([1, 4]);
    expect(data.posts[0].tagsAggregate).toEqual({ count: 2 });
  });

  it('another scope sees its own links', async () => {
    const data = await run(config, `{ ${POST_1} { tags(${BY_ID}) { id } tagsAggregate { count } } }`, { orgId: 2 });
    expect(data.posts[0]).toEqual({ tags: [{ id: 3 }], tagsAggregate: { count: 1 } });
  });

  it("the junction's softDelete scope: 'root' does not resurrect a marked link", async () => {
    const data = await run(
      { eagerLoadRelations, softDelete: { PostTags: { column: 'deletedAt', scope: 'root' } } },
      `{ ${POST_1} { tags(${BY_ID}) { id } tagsAggregate { count } } }`,
    );
    expect(data.posts[0]).toEqual({ tags: [{ id: 1 }, { id: 3 }, { id: 4 }], tagsAggregate: { count: 3 } });
  });

  it('a mutation payload returns the same links', async () => {
    const data = await run(
      config,
      `mutation { updatePostsSingle(set: { title: "p1" }, where: { id: { eq: 1 } }) { id tags(${BY_ID}) { id } } }`,
    );
    expect(data.updatePostsSingle).toEqual({ id: 1, tags: [{ id: 1 }] });
  });
});

describe('a junction with no policy', () => {
  it('stays on the eager path and returns every link', async () => {
    const data = await run({}, `{ ${POST_1} { tags(${BY_ID}) { id } } }`);
    expect(tagIdsOf(data)).toEqual([1, 2, 3, 4]);
  });
});

describe('a composite junction with a policy', () => {
  it('is refused rather than read without the policy', async () => {
    const result: any = await graphql({
      schema: buildSchema(db, { softDelete: { ShelfBooks: 'deletedAt' } } as any).schema,
      source: '{ shelves { books { id } } }',
      contextValue: {},
    });
    expect(result.errors?.[0]?.extensions?.code).toBe('DRIZZLE_UNSUPPORTED_RELATION');
  });

  it('is still eager-loaded when the junction has no policy', async () => {
    expect(await run({}, '{ shelves { books { id } } }')).toEqual({ shelves: [{ books: [{ id: 1 }] }] });
  });
});
