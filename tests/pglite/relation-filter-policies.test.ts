// Relation filters and ordering through a relation compile to correlated subqueries over the
// relation's target table. Those subqueries have to apply the target's `scope` and `softDelete`
// exactly as the relation field does — otherwise a filter is an existence oracle on rows the
// caller cannot read, and a sort leaks their values through the order it produces.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  orgId: integer('org_id').notNull(),
  deletedAt: text('deleted_at'),
});
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  orgId: integer('org_id').notNull(),
  secret: text('secret'),
  deletedAt: text('deleted_at'),
});
const Tags = pgTable('tags', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  orgId: integer('org_id').notNull(),
});
const PostTags = pgTable(
  'post_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);

const r = createRelationsHelper({ Users, Posts, Tags, PostTags });
const relations = buildRelations(
  { Users, Posts, Tags, PostTags },
  {
    Users: { posts: r.many.Posts({ from: r.Users.id, to: r.Posts.userId }) },
    Posts: {
      author: r.one.Users({ from: r.Posts.userId, to: r.Users.id }),
      tags: r.many.Tags({
        from: r.Posts.id.through(r.PostTags.postId),
        to: r.Tags.id.through(r.PostTags.tagId),
      }),
    },
  },
);

let pglite: PGlite;
let db: any;

const run = async (schema: GraphQLSchema, source: string, contextValue: any = {}) => {
  const res = await graphql({ schema, source, contextValue });
  expect(res.errors).toBeUndefined();
  return res.data as any;
};
const ids = (rows: { id: number }[]) => rows.map((row) => row.id);

const orgScope = (ctx: any, t: any) => eq(t.orgId, ctx.orgId);
/** Posts and Tags scoped to the caller's org; posts and junction rows soft-deleting. */
const policyBuild = () =>
  buildSchema(db, {
    scope: { Posts: orgScope, Tags: orgScope },
    softDelete: { Posts: 'deletedAt', PostTags: 'deletedAt' },
  }).schema;
const plainBuild = () => buildSchema(db).schema;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(
    sql`CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, org_id integer NOT NULL, deleted_at text)`,
  );
  await db.execute(
    sql`CREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL, org_id integer NOT NULL, secret text, deleted_at text)`,
  );
  await db.execute(sql`CREATE TABLE tags (id integer PRIMARY KEY, name text NOT NULL, org_id integer NOT NULL)`);
  await db.execute(
    sql`CREATE TABLE post_tags (post_id integer NOT NULL, tag_id integer NOT NULL, deleted_at text, PRIMARY KEY (post_id, tag_id))`,
  );
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE post_tags, tags, posts, users`);
  await db.insert(Users).values([
    { id: 1, name: 'a', orgId: 1 },
    { id: 2, name: 'b', orgId: 2 },
    { id: 3, name: 'c', orgId: 1 },
    { id: 4, name: 'd', orgId: 1 },
  ]);
  await db.insert(Posts).values([
    { id: 1, userId: 1, orgId: 1, secret: 'one' },
    { id: 2, userId: 2, orgId: 2, secret: 'two' }, // org 2 — out of scope for org 1
    { id: 3, userId: 3, orgId: 1, secret: 'three', deletedAt: '2024-01-01' }, // soft-deleted
  ]);
  await db.insert(Tags).values([
    { id: 1, name: 'red', orgId: 1 },
    { id: 2, name: 'blue', orgId: 2 }, // org 2 — out of scope for org 1
    { id: 3, name: 'green', orgId: 1 },
  ]);
  await db.insert(PostTags).values([
    { postId: 1, tagId: 1 },
    { postId: 1, tagId: 2 },
    { postId: 1, tagId: 3, deletedAt: '2024-01-01' }, // junction row soft-deleted
  ]);
});

afterAll(async () => {
  await pglite.close();
});

describe.sequential('relation filters apply the target table scope', () => {
  it('a `some` filter cannot match an out-of-scope row', async () => {
    const source = `{ users(where: { posts: { some: { secret: { eq: "two" } } } }) { id } }`;
    // Control: without a scope the filter matches user 2.
    expect(ids((await run(plainBuild(), source)).users)).toEqual([2]);
    expect((await run(policyBuild(), source, { orgId: 1 })).users).toEqual([]);
    expect(ids((await run(policyBuild(), source, { orgId: 2 })).users)).toEqual([2]);
  });

  it('root aggregates and groupBy cannot count through an out-of-scope row', async () => {
    const data = await run(
      policyBuild(),
      `{
        usersAggregate(where: { posts: { some: { secret: { eq: "two" } } } }) { count }
        usersGroupBy(groupBy: [orgId], where: { posts: { some: { secret: { eq: "two" } } } }) { count }
      }`,
      { orgId: 1 },
    );
    expect(data.usersAggregate).toEqual({ count: 0 });
    expect(data.usersGroupBy).toEqual([]);
  });

  it('`none` and `every` only consider the rows the caller can see', async () => {
    const schema = policyBuild();
    // User 2's post is out of scope and user 3's is deleted, so neither has a visible post.
    const none = await run(
      schema,
      `{ users(where: { posts: { none: {} } }, orderBy: { id: { direction: asc, priority: 0 } }) { id } }`,
      { orgId: 1 },
    );
    expect(ids(none.users)).toEqual([2, 3, 4]);
    // Vacuously true for every user without a visible post that fails it.
    const every = await run(
      schema,
      `{ users(where: { posts: { every: { secret: { eq: "one" } } } }, orderBy: { id: { direction: asc, priority: 0 } }) { id } }`,
      { orgId: 1 },
    );
    expect(ids(every.users)).toEqual([1, 2, 3, 4]);
  });

  it('a to-one filter cannot match an out-of-scope target', async () => {
    const schema = buildSchema(db, { scope: { Users: orgScope } }).schema;
    const data = await run(schema, `{ posts(where: { author: { name: { eq: "b" } } }) { id } }`, { orgId: 1 });
    expect(data.posts).toEqual([]);
  });

  it('a `.through()` filter applies the target scope', async () => {
    const source = `{ posts(where: { tags: { some: { name: { eq: "blue" } } } }) { id } }`;
    expect(ids((await run(plainBuild(), source)).posts)).toEqual([1]);
    expect((await run(policyBuild(), source, { orgId: 1 })).posts).toEqual([]);
  });

  it('a `.through()` filter skips a soft-deleted junction row', async () => {
    const source = `{ posts(where: { tags: { some: { name: { eq: "green" } } } }) { id } }`;
    expect(ids((await run(plainBuild(), source)).posts)).toEqual([1]);
    expect((await run(policyBuild(), source, { orgId: 1 })).posts).toEqual([]);
  });

  it('a nested relation filter applies the scope at every level', async () => {
    const data = await run(
      policyBuild(),
      `{ users(where: { posts: { some: { tags: { some: { name: { eq: "blue" } } } } } }) { id } }`,
      { orgId: 1 },
    );
    expect(data.users).toEqual([]);
  });

  it("a relation field's where applies the scope inside its own relation filters", async () => {
    const data = await run(
      policyBuild(),
      `{ users(where: { id: { eq: 1 } }) { id posts(where: { tags: { some: { name: { eq: "blue" } } } }) { id } } }`,
      { orgId: 1 },
    );
    expect(data.users).toEqual([{ id: 1, posts: [] }]);
  });

  it('update and delete cannot select rows through an out-of-scope relation', async () => {
    const schema = policyBuild();
    const updated = await run(
      schema,
      `mutation { updateUsers(where: { posts: { some: { secret: { eq: "two" } } } }, set: { name: "x" }) { id } }`,
      { orgId: 1 },
    );
    expect(updated.updateUsers).toEqual([]);
    const deleted = await run(
      schema,
      `mutation { deleteUsers(where: { posts: { some: { secret: { eq: "two" } } } }) { id } }`,
      { orgId: 1 },
    );
    expect(deleted.deleteUsers).toEqual([]);
  });
});

describe.sequential('relation filters apply the target table soft delete', () => {
  it('a soft-deleted post does not satisfy `some: {}`', async () => {
    const schema = buildSchema(db, { softDelete: { Posts: 'deletedAt' } }).schema;
    const data = await run(
      schema,
      `{ users(where: { posts: { some: {} } }, orderBy: { id: { direction: asc, priority: 0 } }) { id posts { id } } }`,
    );
    expect(data.users).toEqual([
      { id: 1, posts: [{ id: 1 }] },
      { id: 2, posts: [{ id: 2 }] },
    ]);
  });

  it('a soft-deleted post does not block `none: {}`', async () => {
    const schema = buildSchema(db, { softDelete: { Posts: 'deletedAt' } }).schema;
    const data = await run(
      schema,
      `{ users(where: { posts: { none: {} } }, orderBy: { id: { direction: asc, priority: 0 } }) { id } }`,
    );
    expect(ids(data.users)).toEqual([3, 4]);
  });

  it("follows the relation field's default: a `scope: 'root'` soft delete still matches", async () => {
    const schema = buildSchema(db, { softDelete: { Posts: { column: 'deletedAt', scope: 'root' } } }).schema;
    const data = await run(schema, `{ users(where: { posts: { some: { secret: { eq: "three" } } } }) { id } }`);
    expect(ids(data.users)).toEqual([3]);
  });
});

describe.sequential('ordering through a to-one relation', () => {
  const source = `{ posts(orderBy: { author: { name: { direction: DIR, priority: 1 } }, id: { direction: asc, priority: 0 } }) { id } }`;

  it('sorts an out-of-scope target as NULL', async () => {
    const schema = buildSchema(db, { scope: { Users: orgScope } }).schema;
    // Postgres sorts NULL largest, so the hidden author (post 2) comes first in desc.
    const data = await run(schema, source.replace('DIR', 'desc'), { orgId: 1 });
    expect(ids(data.posts)).toEqual([2, 3, 1]);
  });

  it('sorts a soft-deleted target as NULL', async () => {
    await db.update(Users).set({ deletedAt: '2024-01-01' }).where(eq(Users.id, 1));
    const schema = buildSchema(db, { softDelete: { Users: 'deletedAt' } }).schema;
    const data = await run(schema, source.replace('DIR', 'asc'));
    expect(ids(data.posts)).toEqual([2, 3, 1]);
  });
});
