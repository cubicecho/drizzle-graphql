import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { boolean, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A relation's rows can be read three ways: eagerly with the parent (`with:`), lazily through
// the batched field resolver (`eagerLoadRelations: false`), and summarised by
// `<relation>Aggregate`. All three have to agree on which rows the relation holds — including
// for `.through()` junctions, self-referencing junctions, and a relation's own `where`.

const Users = pgTable('users', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  name: text('name').notNull(),
});
const Roles = pgTable('roles', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  name: text('name').notNull(),
});
const UsersToRoles = pgTable(
  'users_to_roles',
  { userId: integer('user_id').notNull(), roleId: integer('role_id').notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);
const Friendships = pgTable(
  'friendships',
  { userId: integer('user_id').notNull(), friendId: integer('friend_id').notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.friendId] })],
);
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  published: boolean('published').notNull(),
});

const tables = { Users, Roles, UsersToRoles, Friendships, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    roles: r.many.Roles({
      from: r.Users.id.through(r.UsersToRoles.userId),
      to: r.Roles.id.through(r.UsersToRoles.roleId),
    }),
    friends: r.many.Users({
      from: r.Users.id.through(r.Friendships.userId),
      to: r.Users.id.through(r.Friendships.friendId),
      alias: 'friends',
    }),
    posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }),
    publishedPosts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId, where: { published: true } }),
    orgOnePosts: r.many.Posts({ alias: 'orgOne' }),
  },
  Roles: {
    users: r.many.Users({
      from: r.Roles.id.through(r.UsersToRoles.roleId),
      to: r.Users.id.through(r.UsersToRoles.userId),
    }),
  },
  Posts: {
    author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id }),
    // Its `where` is written against Users; the reverse `Users.orgOnePosts` inherits it.
    orgOneAuthor: r.one.Users({ from: r.Posts.authorId, to: r.Users.id, where: { orgId: 1 }, alias: 'orgOne' }),
  },
});

const DATA_DIR = `./tests/.temp/pgdata-relation-paths-agree-${Date.now()}`;
let pglite: PGlite;
let db: any;

const run = async (schema: GraphQLSchema, source: string, contextValue: object = {}) => {
  const result = await graphql({ schema, source, contextValue });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "users" ("id" integer PRIMARY KEY, "org_id" integer NOT NULL, "name" text NOT NULL)`,
  );
  await db.execute(
    sql`CREATE TABLE "roles" ("id" integer PRIMARY KEY, "org_id" integer NOT NULL, "name" text NOT NULL)`,
  );
  await db.execute(
    sql`CREATE TABLE "users_to_roles" ("user_id" integer NOT NULL, "role_id" integer NOT NULL, PRIMARY KEY ("user_id", "role_id"))`,
  );
  await db.execute(
    sql`CREATE TABLE "friendships" ("user_id" integer NOT NULL, "friend_id" integer NOT NULL, PRIMARY KEY ("user_id", "friend_id"))`,
  );
  await db.execute(
    sql`CREATE TABLE "posts" ("id" integer PRIMARY KEY, "author_id" integer NOT NULL, "published" boolean NOT NULL)`,
  );

  // Ids overlap across tables on purpose, so a join that skips the junction finds rows.
  await db.insert(Users).values([
    { id: 1, orgId: 1, name: 'Alice' },
    { id: 2, orgId: 1, name: 'Bob' },
    { id: 3, orgId: 2, name: 'Carol' },
    { id: 4, orgId: 2, name: 'Dave' },
  ]);
  await db.insert(Roles).values([
    { id: 1, orgId: 1, name: 'admin' },
    { id: 2, orgId: 1, name: 'editor' },
    { id: 3, orgId: 2, name: 'viewer' },
  ]);
  await db.insert(UsersToRoles).values([
    { userId: 1, roleId: 1 },
    { userId: 1, roleId: 2 },
    { userId: 1, roleId: 3 },
    { userId: 2, roleId: 2 },
    { userId: 3, roleId: 3 },
  ]);
  // Alice -> Bob, Carol, Dave; Bob -> Alice; nobody else has friends.
  await db.insert(Friendships).values([
    { userId: 1, friendId: 2 },
    { userId: 1, friendId: 3 },
    { userId: 1, friendId: 4 },
    { userId: 2, friendId: 1 },
  ]);
  // Alice: 3 posts, 1 published; Bob: 1 unpublished; Carol: 2 published.
  await db.insert(Posts).values([
    { id: 1, authorId: 1, published: true },
    { id: 2, authorId: 1, published: false },
    { id: 3, authorId: 1, published: false },
    { id: 4, authorId: 2, published: false },
    { id: 5, authorId: 3, published: true },
    { id: 6, authorId: 3, published: true },
  ]);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

const USERS_QUERY = `{
  users(orderBy: { id: { direction: asc, priority: 1 } }) {
    id
    roles(orderBy: { id: { direction: asc, priority: 1 } }) { id }
    rolesAggregate { count }
    friends(orderBy: { id: { direction: asc, priority: 1 } }) { id }
    friendsAggregate { count }
    publishedPosts(orderBy: { id: { direction: asc, priority: 1 } }) { id }
    publishedPostsAggregate { count }
  }
}`;

const EXPECTED = [
  { id: 1, roles: [1, 2, 3], friends: [2, 3, 4], publishedPosts: [1] },
  { id: 2, roles: [2], friends: [1], publishedPosts: [] },
  { id: 3, roles: [3], friends: [], publishedPosts: [5, 6] },
  { id: 4, roles: [], friends: [], publishedPosts: [] },
];

const summarise = (users: any[]) =>
  users.map((u) => ({
    id: u.id,
    roles: u.roles.map((x: any) => x.id),
    friends: u.friends.map((x: any) => x.id),
    publishedPosts: u.publishedPosts.map((x: any) => x.id),
  }));

const counts = (users: any[]) =>
  users.map((u) => [u.id, u.rolesAggregate.count, u.friendsAggregate.count, u.publishedPostsAggregate.count]);

const EXPECTED_COUNTS = EXPECTED.map((u) => [u.id, u.roles.length, u.friends.length, u.publishedPosts.length]);

describe.sequential('relation read paths agree', () => {
  it('eager relation fields return the related rows', async () => {
    const { schema } = buildSchema(db);
    const data = await run(schema, USERS_QUERY);
    expect(summarise(data.users)).toEqual(EXPECTED);
  });

  it('lazy (batched) relation fields return the same rows', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations: false });
    const data = await run(schema, USERS_QUERY);
    expect(summarise(data.users)).toEqual(EXPECTED);
  });

  it('relation aggregates count the same rows', async () => {
    const { schema } = buildSchema(db);
    const data = await run(schema, USERS_QUERY);
    expect(counts(data.users)).toEqual(EXPECTED_COUNTS);
  });

  it('a reversed relation `where` (written against the parent) agrees on every path', async () => {
    const query = `{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        orgOnePosts(orderBy: { id: { direction: asc, priority: 1 } }) { id }
        orgOnePostsAggregate { count }
      }
    }`;
    const eager = (await run(buildSchema(db).schema, query)).users;
    const lazy = (await run(buildSchema(db, { eagerLoadRelations: false }).schema, query)).users;

    const ids = (users: any[]) => users.map((u) => [u.id, u.orgOnePosts.map((p: any) => p.id)]);
    // Only org 1's users (Alice, Bob) see their posts through this relation.
    expect(ids(eager)).toEqual([
      [1, [1, 2, 3]],
      [2, [4]],
      [3, []],
      [4, []],
    ]);
    expect(ids(lazy)).toEqual(ids(eager));
    expect(eager.map((u: any) => u.orgOnePostsAggregate.count)).toEqual([3, 1, 0, 0]);
  });

  it('paginates a lazy many-to-many relation per parent', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations: false });
    const data = await run(
      schema,
      `{
        users(orderBy: { id: { direction: asc, priority: 1 } }) {
          id
          firstTwo: roles(limit: 2, orderBy: { id: { direction: asc, priority: 1 } }) { id }
          rest: roles(offset: 1, orderBy: { id: { direction: asc, priority: 1 } }) { id }
          editor: roles(where: { name: { eq: "editor" } }) { id }
        }
      }`,
    );
    expect(
      data.users.map((u: any) => [
        u.id,
        u.firstTwo.map((x: any) => x.id),
        u.rest.map((x: any) => x.id),
        u.editor.map((x: any) => x.id),
      ]),
    ).toEqual([
      [1, [1, 2], [2, 3], [2]],
      [2, [2], [], [2]],
      [3, [3], [], []],
      [4, [], [], []],
    ]);
  });

  it('a lazy many-to-many relation returns no helper column', async () => {
    const { entities } = buildSchema(db);
    const rows = await entities.fieldResolvers['Users']!['roles']!({ id: 2 }, {}, {}, undefined as any);
    expect(rows).toEqual([{ id: 2, orgId: 1, name: 'editor' }]);
  });

  it('applies distinct per parent on a many-to-many relation', async () => {
    // Alice holds roles 1, 2 (org 1) and 3 (org 2); Bob holds role 2. One role per org per
    // user, lowest id first — role 2 is dropped for Alice (role 1 wins org 1) but kept for Bob.
    const query = `{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        roles(distinct: [orgId], orderBy: { id: { direction: asc, priority: 1 } }) { id }
      }
    }`;
    const expected = [
      [1, [1, 3]],
      [2, [2]],
      [3, [3]],
      [4, []],
    ];
    for (const eagerLoadRelations of [true, false]) {
      const data = await run(buildSchema(db, { eagerLoadRelations }).schema, query);
      expect(data.users.map((u: any) => [u.id, u.roles.map((x: any) => x.id)])).toEqual(expected);
    }
  });

  it('a scoped target is scoped the same way on every path', async () => {
    const scope = { Roles: (ctx: any, table: any) => eq(table.orgId, ctx.orgId) };
    const ctx = { orgId: 1 };
    // Alice holds roles 1, 2 (org 1) and 3 (org 2); only org 1's are visible.
    const query = `{
      usersSingle(where: { id: { eq: 1 } }) {
        roles(orderBy: { id: { direction: asc, priority: 1 } }) { id }
        rolesAggregate { count }
      }
    }`;

    const eager = (await run(buildSchema(db, { scope }).schema, query, { ...ctx })).usersSingle;
    const lazy = (await run(buildSchema(db, { scope, eagerLoadRelations: false }).schema, query, { ...ctx }))
      .usersSingle;

    expect(eager.roles).toEqual([{ id: 1 }, { id: 2 }]);
    expect(lazy.roles).toEqual([{ id: 1 }, { id: 2 }]);
    expect(eager.rolesAggregate.count).toBe(2);
  });
});
