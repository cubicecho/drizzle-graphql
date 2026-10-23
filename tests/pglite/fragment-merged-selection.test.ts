// A relation field and a relation aggregate memoize what they derive from their own field — the
// parsed selection, the column list, the loader key — once per request. A named fragment's field
// node is the first node at every site the fragment is spread, but one site can merge a sibling
// selection into the same response field, so the merged selection differs per site. These pin
// that each site reads its own merged selection rather than whichever site resolved first.

import { PGlite } from '@electric-sql/pglite';
import { defineRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  managerId: integer('manager_id'),
});
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title').notNull(),
  views: integer('views'),
});
const relations = defineRelations({ Users, Posts }, (r) => ({
  Users: {
    posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }),
    manager: r.one.Users({ from: r.Users.managerId, to: r.Users.id, alias: 'manager' }),
    reports: r.many.Users({ from: r.Users.id, to: r.Users.managerId, alias: 'manager' }),
  },
  Posts: { author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id }) },
}));

let client: PGlite;
let db: any;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, relations } as any);
  await db.execute(sql`CREATE TABLE users (id integer primary key, name text not null, manager_id integer)`);
  await db.execute(
    sql`CREATE TABLE posts (id integer primary key, author_id integer not null, title text not null, views integer)`,
  );
  await db.insert(Users).values([
    { id: 1, name: 'Alice', managerId: null },
    { id: 2, name: 'Bob', managerId: 1 },
    { id: 3, name: 'Cara', managerId: 2 },
    { id: 4, name: 'Dan', managerId: 2 },
  ]);
  await db.insert(Posts).values([
    { id: 10, authorId: 1, title: 'hello', views: 5 },
    { id: 11, authorId: 1, title: 'again', views: 50 },
  ]);
});

afterAll(async () => {
  await client.close();
});

const run = (schema: any, source: string) => graphql({ schema, source, contextValue: {} }) as Promise<any>;

describe.each([false, true])('a fragment spread at two sites (eagerLoadRelations: %s)', (eagerLoadRelations) => {
  it('a relation field reads the selection merged at its own site', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const result = await run(
      schema,
      `fragment F on Users { posts { id } }
       { a: users(where: { id: { eq: 1 } }) { ...F } b: users(where: { id: { eq: 1 } }) { ...F posts { title } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.a).toEqual([{ posts: [{ id: 10 }, { id: 11 }] }]);
    expect(result.data.b).toEqual([
      {
        posts: [
          { id: 10, title: 'hello' },
          { id: 11, title: 'again' },
        ],
      },
    ]);
  });

  it('a nested non-null column merged at one level is not dropped', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const result = await run(
      schema,
      `fragment F on Users { id manager { id } }
       { users(where: { id: { eq: 2 } }) { ...F reports { ...F manager { name } } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.users[0].reports).toEqual([
      { id: 3, manager: { id: 2, name: 'Bob' } },
      { id: 4, manager: { id: 2, name: 'Bob' } },
    ]);
  });

  it('a relation aggregate computes the aggregates merged at its own site', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const result = await run(
      schema,
      `fragment F on Users { postsAggregate { count } }
       { a: users(where: { id: { eq: 1 } }) { id ...F } b: users(where: { id: { eq: 1 } }) { id ...F postsAggregate { sum { views } } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.a).toEqual([{ id: 1, postsAggregate: { count: 2 } }]);
    expect(result.data.b).toEqual([{ id: 1, postsAggregate: { count: 2, sum: { views: 55 } } }]);
  });
});
