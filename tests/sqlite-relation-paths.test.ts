import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// SQLite counterpart of tests/pglite/relation-paths-agree.test.ts: the lazy relation resolver
// and `<relation>Aggregate` read through a `.through()` junction and honour a relation's own
// `where`, agreeing with the eager path.

const Users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Roles = sqliteTable('roles', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const UsersToRoles = sqliteTable(
  'users_to_roles',
  { userId: integer('user_id').notNull(), roleId: integer('role_id').notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  published: integer('published', { mode: 'boolean' }).notNull(),
});

const tables = { Users, Roles, UsersToRoles, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    roles: r.many.Roles({
      from: r.Users.id.through(r.UsersToRoles.userId),
      to: r.Roles.id.through(r.UsersToRoles.roleId),
    }),
    publishedPosts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId, where: { published: true } }),
  },
});

let client: Client;
let db: any;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL)`);
  await db.run(sql`CREATE TABLE roles (id integer PRIMARY KEY, name text NOT NULL)`);
  await db.run(
    sql`CREATE TABLE users_to_roles (user_id integer NOT NULL, role_id integer NOT NULL, PRIMARY KEY (user_id, role_id))`,
  );
  await db.run(
    sql`CREATE TABLE posts (id integer PRIMARY KEY, author_id integer NOT NULL, published integer NOT NULL)`,
  );

  await db.insert(Users).values([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Carol' },
  ]);
  await db.insert(Roles).values([
    { id: 1, name: 'admin' },
    { id: 2, name: 'editor' },
    { id: 3, name: 'viewer' },
  ]);
  await db.insert(UsersToRoles).values([
    { userId: 1, roleId: 1 },
    { userId: 1, roleId: 2 },
    { userId: 2, roleId: 2 },
  ]);
  await db.insert(Posts).values([
    { id: 1, authorId: 1, published: true },
    { id: 2, authorId: 1, published: false },
    { id: 3, authorId: 2, published: false },
  ]);
});

afterAll(() => {
  client?.close();
});

const QUERY = `{
  users(orderBy: { id: { direction: asc, priority: 1 } }) {
    id
    roles(orderBy: { id: { direction: asc, priority: 1 } }) { id }
    pagedRoles: roles(limit: 1, orderBy: { id: { direction: desc, priority: 1 } }) { id }
    rolesAggregate { count }
    publishedPosts { id }
    publishedPostsAggregate { count }
  }
}`;

const EXPECTED = [
  { id: 1, roles: [1, 2], pagedRoles: [2], rolesCount: 2, publishedPosts: [1], publishedCount: 1 },
  { id: 2, roles: [2], pagedRoles: [2], rolesCount: 1, publishedPosts: [], publishedCount: 0 },
  { id: 3, roles: [], pagedRoles: [], rolesCount: 0, publishedPosts: [], publishedCount: 0 },
];

const summarise = (users: any[]) =>
  users.map((u) => ({
    id: u.id,
    roles: u.roles.map((x: any) => x.id),
    pagedRoles: u.pagedRoles.map((x: any) => x.id),
    rolesCount: u.rolesAggregate.count,
    publishedPosts: u.publishedPosts.map((x: any) => x.id),
    publishedCount: u.publishedPostsAggregate.count,
  }));

describe.sequential('SQLite relation read paths agree', () => {
  it.each([
    ['eager', true],
    ['lazy', false],
  ])('%s relation fields and aggregates return the same rows', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const result = await graphql({ schema, source: QUERY, contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(summarise((result.data as any).users)).toEqual(EXPECTED);
  });

  // A position in the request's own `inArray` list cannot be encoded into a cursor, so the
  // field resolves to null under `matchFilterOrder`, as it does on the root list.
  it.each([
    ['eager', true],
    ['lazy', false],
  ])('%s: a relation cursor under matchFilterOrder resolves to null', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const result = await graphql({
      schema,
      source: `{ users(where: { id: { eq: 1 } }) {
        roles(where: { id: { inArray: [2, 1] } }, orderBy: { id: { direction: asc, priority: 1, matchFilterOrder: true } }) { id cursor }
      } }`,
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).users[0].roles).toEqual([
      { id: 2, cursor: null },
      { id: 1, cursor: null },
    ]);
  });
});
