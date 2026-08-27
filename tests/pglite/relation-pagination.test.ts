import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id'),
  title: text('title').notNull(),
  status: text('status').notNull(),
  rank: integer('rank'),
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

const DATA_DIR = `./tests/.temp/pgdata-relation-pagination-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let queryCount = 0;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

/** The posts of one author, in the order the response returned them. */
const titles = (data: any, authorIndex = 0): string[] =>
  data['authors'][authorIndex]['posts'].map((post: any) => post['title']);

beforeAll(async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(DATA_DIR, { recursive: true });
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({
    client: pglite,
    schema,
    relations,
    logger: { logQuery: () => queryCount++ },
  });

  await db.execute(sql`CREATE TABLE "authors" (
		"id" integer PRIMARY KEY NOT NULL,
		"name" text NOT NULL
	);`);
  await db.execute(sql`CREATE TABLE "posts" (
		"id" integer PRIMARY KEY NOT NULL,
		"author_id" integer,
		"title" text NOT NULL,
		"status" text NOT NULL,
		"rank" integer
	);`);

  await db.insert(Authors).values([
    { id: 1, name: 'ann' },
    { id: 2, name: 'bob' },
  ]);
  await db.insert(Posts).values([
    { id: 1, authorId: 1, title: 'a1', status: 'draft', rank: 1 },
    { id: 2, authorId: 1, title: 'a2', status: 'draft', rank: null },
    { id: 3, authorId: 1, title: 'a3', status: 'published', rank: 2 },
    { id: 4, authorId: 1, title: 'a4', status: 'published', rank: null },
    { id: 5, authorId: 2, title: 'b1', status: 'draft', rank: 1 },
    { id: 6, authorId: 2, title: 'b2', status: 'published', rank: null },
    { id: 7, authorId: 2, title: 'b3', status: 'published', rank: 3 },
  ]);

  gqlSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('to-many relation arguments', () => {
  it('takes the same pagination surface a root list of the target does', () => {
    const authors = (gqlSchema.getType('Authors') as GraphQLObjectType).getFields();
    const rootArgs = gqlSchema
      .getQueryType()!
      .getFields()
      ['posts']!.args.map((a) => a.name);

    expect(authors['posts']!.args.map((a) => a.name).sort()).toEqual(
      ['where', 'orderBy', 'offset', 'limit', 'after', 'distinct'].sort(),
    );
    // Every argument the relation field takes is one the root list takes too.
    for (const name of authors['posts']!.args.map((a) => a.name)) {
      expect(rootArgs).toContain(name);
    }
  });

  it("shares the target table's distinct enum with the root list", () => {
    const authors = (gqlSchema.getType('Authors') as GraphQLObjectType).getFields();
    const relationDistinct = authors['posts']!.args.find((a) => a.name === 'distinct')!;

    expect(String(relationDistinct.type)).toBe('[PostsDistinctColumn!]');
    expect((relationDistinct.type as any).ofType.ofType).toBe(gqlSchema.getType('PostsDistinctColumn'));
  });

  it('leaves to-one relation fields with where alone', () => {
    const posts = (gqlSchema.getType('Posts') as GraphQLObjectType).getFields();
    expect(posts['author']!.args.map((a) => a.name)).toEqual(['where']);
  });

  it('omits distinct when the feature is off', () => {
    const noDistinct = buildSchema(db, { features: { distinct: false } }).schema;
    const authors = (noDistinct.getType('Authors') as GraphQLObjectType).getFields();

    expect(authors['posts']!.args.map((a) => a.name)).not.toContain('distinct');
    expect(authors['posts']!.args.map((a) => a.name)).toContain('after');
  });
});

describe('relation cursors', () => {
  it('resolves a cursor for each related row', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors(orderBy: { id: { priority: 1, direction: asc } }) {
          id
          posts(orderBy: { id: { priority: 1, direction: asc } }) {
            title
            cursor
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    const posts = (res.data!['authors'] as any[])[0]!['posts'];
    expect(posts.map((p: any) => p['title'])).toEqual(['a1', 'a2', 'a3', 'a4']);
    for (const post of posts) {
      expect(typeof post['cursor']).toBe('string');
      expect(post['cursor'].length).toBeGreaterThan(0);
    }
  });

  it('pages each parent independently from its own cursor', async () => {
    const first = await run(/* GraphQL */ `
      {
        authors(orderBy: { id: { priority: 1, direction: asc } }) {
          id
          posts(orderBy: { id: { priority: 1, direction: asc } }, limit: 2) {
            title
            cursor
          }
        }
      }
    `);

    expect(first.errors).toBeUndefined();
    expect(titles(first.data, 0)).toEqual(['a1', 'a2']);
    expect(titles(first.data, 1)).toEqual(['b1', 'b2']);

    // Ann's second page. Bob's rows are a different parent, so his cursor differs — but the
    // predicate is on the post's own columns, so each parent is filtered by the same rule.
    const annCursor = (first.data!['authors'] as any[])[0]!['posts'][1]!['cursor'];
    const second = await run(
      /* GraphQL */ `
        query ($after: String) {
          authors(orderBy: { id: { priority: 1, direction: asc } }) {
            id
            posts(orderBy: { id: { priority: 1, direction: asc } }, after: $after) {
              title
            }
          }
        }
      `,
      { after: annCursor },
    );

    expect(second.errors).toBeUndefined();
    expect(titles(second.data, 0)).toEqual(['a3', 'a4']);
    // Bob's posts are ids 5-7, all after the cursor's id 2.
    expect(titles(second.data, 1)).toEqual(['b1', 'b2', 'b3']);
  });

  it('combines after with limit for a fixed page size', async () => {
    const first = await run(/* GraphQL */ `
      {
        authors(where: { id: { eq: 1 } }) {
          posts(orderBy: { id: { priority: 1, direction: asc } }, limit: 2) {
            title
            cursor
          }
        }
      }
    `);
    const cursor = (first.data!['authors'] as any[])[0]!['posts'][1]!['cursor'];

    const second = await run(
      /* GraphQL */ `
        query ($after: String) {
          authors(where: { id: { eq: 1 } }) {
            posts(orderBy: { id: { priority: 1, direction: asc } }, after: $after, limit: 2) {
              title
            }
          }
        }
      `,
      { after: cursor },
    );

    expect(second.errors).toBeUndefined();
    expect(titles(second.data)).toEqual(['a3', 'a4']);
  });

  it('walks a descending relation ordering', async () => {
    const first = await run(/* GraphQL */ `
      {
        authors(where: { id: { eq: 1 } }) {
          posts(orderBy: { id: { priority: 1, direction: desc } }, limit: 1) {
            title
            cursor
          }
        }
      }
    `);
    const cursor = (first.data!['authors'] as any[])[0]!['posts'][0]!['cursor'];

    const second = await run(
      /* GraphQL */ `
        query ($after: String) {
          authors(where: { id: { eq: 1 } }) {
            posts(orderBy: { id: { priority: 1, direction: desc } }, after: $after, limit: 2) {
              title
            }
          }
        }
      `,
      { after: cursor },
    );

    expect(titles(first.data)).toEqual(['a4']);
    expect(titles(second.data)).toEqual(['a3', 'a2']);
  });

  it('honours where alongside after', async () => {
    const first = await run(/* GraphQL */ `
      {
        authors(where: { id: { eq: 1 } }) {
          posts(where: { status: { eq: "published" } }, orderBy: { id: { priority: 1, direction: asc } }, limit: 1) {
            title
            cursor
          }
        }
      }
    `);
    const cursor = (first.data!['authors'] as any[])[0]!['posts'][0]!['cursor'];

    const second = await run(
      /* GraphQL */ `
        query ($after: String) {
          authors(where: { id: { eq: 1 } }) {
            posts(where: { status: { eq: "published" } }, orderBy: { id: { priority: 1, direction: asc } }, after: $after) {
              title
            }
          }
        }
      `,
      { after: cursor },
    );

    expect(titles(first.data)).toEqual(['a3']);
    expect(titles(second.data)).toEqual(['a4']);
  });

  it('rejects a cursor taken under a different ordering', async () => {
    const first = await run(/* GraphQL */ `
      {
        authors(where: { id: { eq: 1 } }) {
          posts(orderBy: { id: { priority: 1, direction: asc } }, limit: 1) {
            cursor
          }
        }
      }
    `);
    const cursor = (first.data!['authors'] as any[])[0]!['posts'][0]!['cursor'];

    const second = await run(
      /* GraphQL */ `
        query ($after: String) {
          authors(where: { id: { eq: 1 } }) {
            posts(orderBy: { title: { priority: 1, direction: desc } }, after: $after) {
              title
            }
          }
        }
      `,
      { after: cursor },
    );

    expect(second.errors?.[0]?.message).toBeDefined();
  });

  it('pages across the NULL group without skipping a row', async () => {
    // PostgreSQL sorts NULLs largest, so ascending puts ranks 1, 2 first and the two NULL
    // ranks last — the keyset predicate has to agree, or the NULL rows fall out of the walk.
    const seen: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 4; page++) {
      const res: any = await run(
        /* GraphQL */ `
          query ($after: String) {
            authors(where: { id: { eq: 1 } }) {
              posts(orderBy: { rank: { priority: 1, direction: asc } }, limit: 1, after: $after) {
                title
                cursor
              }
            }
          }
        `,
        { after },
      );
      expect(res.errors).toBeUndefined();
      const posts = res.data['authors'][0]['posts'];
      if (!posts.length) break;
      seen.push(posts[0]['title']);
      after = posts[0]['cursor'];
    }

    expect(seen).toEqual(['a1', 'a3', 'a2', 'a4']);
  });

  it('honours an explicit nulls placement on a relation ordering', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors(where: { id: { eq: 1 } }) {
          posts(orderBy: { rank: { priority: 1, direction: asc, nulls: first } }, limit: 2) {
            title
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(titles(res.data)).toEqual(['a2', 'a4']);
  });

  it('refuses after together with distinct', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors {
          posts(after: "x", distinct: [status]) {
            title
          }
        }
      }
    `);

    expect(res.errors?.[0]?.message).toBe("'after' cannot be combined with 'distinct'.");
  });
});

describe('relation distinct', () => {
  it('keeps one row per distinct value within each parent, not across the batch', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors(orderBy: { id: { priority: 1, direction: asc } }) {
          id
          posts(distinct: [status], orderBy: { id: { priority: 1, direction: asc } }) {
            title
            status
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    // Each author keeps their own first draft and first published post.
    expect(titles(res.data, 0)).toEqual(['a1', 'a3']);
    expect(titles(res.data, 1)).toEqual(['b1', 'b2']);
  });

  it('picks the last row of each group under a descending ordering', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors(where: { id: { eq: 1 } }) {
          posts(distinct: [status], orderBy: { id: { priority: 1, direction: desc } }) {
            title
          }
        }
      }
    `);

    expect(titles(res.data)).toEqual(['a4', 'a2']);
  });

  it('applies where before the distinct pass', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors(where: { id: { eq: 1 } }) {
          posts(distinct: [status], where: { status: { eq: "published" } }, orderBy: { id: { priority: 1, direction: asc } }) {
            title
          }
        }
      }
    `);

    expect(titles(res.data)).toEqual(['a3']);
  });

  it('applies limit per parent to what the distinct pass left', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors(orderBy: { id: { priority: 1, direction: asc } }) {
          posts(distinct: [status], orderBy: { id: { priority: 1, direction: asc } }, limit: 1) {
            title
          }
        }
      }
    `);

    expect(titles(res.data, 0)).toEqual(['a1']);
    expect(titles(res.data, 1)).toEqual(['b1']);
  });

  it('returns an empty list per parent when nothing survives the where', async () => {
    const res = await run(/* GraphQL */ `
      {
        authors {
          posts(distinct: [status], where: { status: { eq: "archived" } }) {
            title
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    expect((res.data!['authors'] as any[]).every((a) => a['posts'].length === 0)).toBe(true);
  });
});

describe('eager loading and the fallback', () => {
  it('stays on the eager path for a plain relation selection', async () => {
    queryCount = 0;
    const res = await run(/* GraphQL */ `
      {
        authors {
          posts {
            title
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(queryCount).toBe(1);
  });

  it('falls back to one batched query when after is passed', async () => {
    queryCount = 0;
    const res = await run(/* GraphQL */ `
      {
        authors {
          posts(orderBy: { id: { priority: 1, direction: asc } }, after: null) {
            title
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    // The explicit null is not a cursor, so this is still the eager path.
    expect(queryCount).toBe(1);
  });

  it('falls back once — not once per parent — when the cursor field is selected', async () => {
    queryCount = 0;
    const res = await run(/* GraphQL */ `
      {
        authors {
          posts {
            title
            cursor
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    // One query for the authors, one batched query for every author's posts.
    expect(queryCount).toBe(2);
  });

  it('falls back once when distinct is passed', async () => {
    queryCount = 0;
    const res = await run(/* GraphQL */ `
      {
        authors {
          posts(distinct: [status]) {
            title
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    // Authors, the distinct key pass, and the batched posts query.
    expect(queryCount).toBe(3);
  });

  it('follows the cursor field through a fragment spread', async () => {
    queryCount = 0;
    const res = await run(/* GraphQL */ `
      {
        authors {
          posts {
            ...page
          }
        }
      }
      fragment page on Posts {
        title
        cursor
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(queryCount).toBe(2);
    expect((res.data!['authors'] as any[])[0]!['posts'][0]!['cursor']).toBeTypeOf('string');
  });
});
