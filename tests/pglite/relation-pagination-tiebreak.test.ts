// A paginated to-many relation field appends the target's primary key to its ordering as a
// tiebreak, so the per-parent slice is deterministic when the ordering has ties. These pin that
// the eager `with:` path (a query, and the mutation re-fetch) picks the same slice as the batched
// resolver: with a non-unique client orderBy, with a non-unique default ordering, and with
// `orderBy: {}`. The rows are inserted in the reverse of key order, so an untiebroken slice
// follows the heap and differs.

import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { boolean, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  published: boolean('published').notNull(),
});
const relations = defineRelations({ Users, Posts }, (r) => ({
  Users: { posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }) },
}));

let client: PGlite;
let db: any;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, relations } as any);
  await client.exec(`
    CREATE TABLE users (id int primary key, name text not null);
    CREATE TABLE posts (id int primary key, author_id int not null, published boolean not null);
    INSERT INTO users VALUES (1, 'Tie');
    INSERT INTO posts VALUES (30, 1, true);
    INSERT INTO posts VALUES (20, 1, true);
    INSERT INTO posts VALUES (10, 1, true);
  `);
});

afterAll(async () => {
  await client.close();
});

const BY_PUBLISHED = 'orderBy: { published: { direction: asc, priority: 0 } }';

const postIds = async (config: Record<string, unknown>, source: string) => {
  const result: any = await graphql({ schema: buildSchema(db, config as any).schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  const root = Object.values(result.data)[0] as any;
  return (Array.isArray(root) ? root[0] : root).posts.map((post: any) => post.id);
};

describe.each([true, false])('relation pagination tiebreak (eagerLoadRelations: %s)', (eagerLoadRelations) => {
  it.each([
    ['a non-unique orderBy with limit', `${BY_PUBLISHED}, limit: 1`, [10]],
    ['a non-unique orderBy with offset', `${BY_PUBLISHED}, limit: 1, offset: 2`, [30]],
    ['orderBy: {} with limit', 'orderBy: {}, limit: 2', [10, 20]],
  ])('%s takes the slice in primary-key order', async (_label, args, expected) => {
    expect(await postIds({ eagerLoadRelations }, `{ users { posts(${args}) { id } } }`)).toEqual(expected);
  });

  it('a non-unique default ordering with limit takes the slice in primary-key order', async () => {
    const config = { eagerLoadRelations, defaults: { Posts: { orderBy: { published: 'asc' } } } };
    expect(await postIds(config, '{ users { posts(limit: 2) { id } } }')).toEqual([10, 20]);
  });

  it('the mutation re-fetch takes the same slice', async () => {
    expect(
      await postIds(
        { eagerLoadRelations },
        `mutation { updateUsersSingle(set: { name: "Tie" }, where: { id: { eq: 1 } }) { posts(${BY_PUBLISHED}, limit: 2) { id } } }`,
      ),
    ).toEqual([10, 20]);
  });
});
