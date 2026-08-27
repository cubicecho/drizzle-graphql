import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';
import * as schema from '../schema/pg';
import { setupTables, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-tenancy-${Date.now()}`;
let pglite: PGlite;
let db: any;

const typeNameMapper = (name: string) =>
  (
    ({
      Users: { singular: 'user', plural: 'users' },
      Posts: { singular: 'post', plural: 'posts' },
      Customers: { singular: 'customer', plural: 'customers' },
      Tags: { singular: 'tag', plural: 'tags' },
    }) as Record<string, { singular: string; plural: string }>
  )[name];

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, {
    typeNameMapper,
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
    ...config,
  }).schema;

// A fresh context object per call so the request-scoped relation batch loaders behave as
// they would in a real request. `contextValue` is what the scope hooks read.
const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue: { ...contextValue } });

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations: schema.relations, logger: !!process.env['LOG_SQL'] });
  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

beforeEach(async () => {
  await setupTables({ db } as any);
});
afterEach(async () => {
  await teardownTables({ db } as any);
});

// Seed recap: users 1, 2 and 5. Posts 1, 2, 3 and 6 belong to user 1; posts 4 and 5 to user 5.
// Customers 1 and 2 belong to users 1 and 2.
describe.sequential('row scope', () => {
  // The canonical shape from the issue: a predicate built from the table the statement runs
  // against, so it stays correct under the aliases a relational read introduces.
  const ownPosts: Partial<BuildSchemaConfig> = {
    scope: { Posts: (ctx: any, table: any) => eq(table.authorId, ctx.userId) },
  };

  it('confines a list query to the scope', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(gqlSchema, `{ posts { id } }`, { userId: 1 });

    expect(res.errors).toBeUndefined();
    expect((res.data?.['posts'] as any[]).map((post) => post.id).sort()).toEqual([1, 2, 3, 6]);
  });

  it('narrows, and is never widened by, a client filter', async () => {
    const gqlSchema = buildWith(ownPosts);
    // Post 4 exists and matches the filter, but belongs to user 5.
    const res = await run(gqlSchema, `{ posts(where: { id: { inArray: [3, 4] } }) { id } }`, { userId: 1 });

    expect(res.errors).toBeUndefined();
    expect(res.data?.['posts']).toEqual([{ id: 3 }]);
  });

  it('hides an out-of-scope row from the single query', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(gqlSchema, `{ post(where: { id: { eq: 4 } }) { id } }`, { userId: 1 });

    expect(res.errors).toBeUndefined();
    expect(res.data?.['post']).toBeNull();
  });

  it('applies to aggregates and groupBy', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(gqlSchema, `{ postsAggregate { count } postsGroupBy(groupBy: [authorId]) { count } }`, {
      userId: 1,
    });

    expect(res.errors).toBeUndefined();
    expect(res.data?.['postsAggregate']).toEqual({ count: 4 });
    expect(res.data?.['postsGroupBy']).toEqual([{ count: 4 }]);
  });

  it('applies to a relation field on the eager path', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(
      gqlSchema,
      `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id posts { id } } }`,
      {
        userId: 1,
      },
    );

    expect(res.errors).toBeUndefined();
    // User 5 owns posts 4 and 5, but the request's scope is user 1's — the relation is empty
    // for every parent but the one whose rows are in scope.
    expect(res.data?.['users']).toEqual([
      { id: 1, posts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }] },
      { id: 2, posts: [] },
      { id: 5, posts: [] },
    ]);
  });

  it('applies to a relation field on the batch-loader path', async () => {
    const gqlSchema = buildWith({ ...ownPosts, eagerLoadRelations: false });
    const res = await run(
      gqlSchema,
      `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id posts { id } } }`,
      {
        userId: 1,
      },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['users']).toEqual([
      { id: 1, posts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }] },
      { id: 2, posts: [] },
      { id: 5, posts: [] },
    ]);
  });

  it('applies to a relation aggregate', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(
      gqlSchema,
      `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id postsAggregate { count } } }`,
      { userId: 1 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['users']).toEqual([
      { id: 1, postsAggregate: { count: 4 } },
      { id: 2, postsAggregate: { count: 0 } },
      { id: 5, postsAggregate: { count: 0 } },
    ]);
  });

  it('accepts a filter object, including one that scopes through a relation', async () => {
    // The ownership column lives on another table — the join-table variant of the issue.
    const gqlSchema = buildWith({
      scope: { Posts: (ctx: any) => ({ author: { name: { eq: ctx.userName } } }) },
    });
    const res = await run(gqlSchema, `{ posts { id } }`, { userName: 'FifthUser' });

    expect(res.errors).toBeUndefined();
    expect((res.data?.['posts'] as any[]).map((post) => post.id).sort()).toEqual([4, 5]);
  });

  it('treats an undefined return as no restriction', async () => {
    const gqlSchema = buildWith({
      scope: { Posts: (ctx: any, table: any) => (ctx.admin ? undefined : eq(table.authorId, ctx.userId)) },
    });

    const scoped = await run(gqlSchema, `{ postsAggregate { count } }`, { userId: 1 });
    const admin = await run(gqlSchema, `{ postsAggregate { count } }`, { admin: true });

    expect(scoped.data?.['postsAggregate']).toEqual({ count: 4 });
    expect(admin.data?.['postsAggregate']).toEqual({ count: 6 });
  });

  it('leaves an unscoped table alone', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(gqlSchema, `{ usersAggregate { count } }`, { userId: 1 });

    expect(res.errors).toBeUndefined();
    expect(res.data?.['usersAggregate']).toEqual({ count: 3 });
  });

  it('stops an update from reaching an out-of-scope row', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(
      gqlSchema,
      `mutation { updatePost(where: { id: { eq: 4 } }, set: { content: "TAKEN" }) { id } }`,
      {
        userId: 1,
      },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updatePost']).toEqual([]);
    const [row] = await db.select().from(schema.Posts).where(eq(schema.Posts.id, 4));
    expect(row.content).toBe('1MESSAGE');
  });

  it('stops a batch update from reaching an out-of-scope row', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(
      gqlSchema,
      `mutation {
        updatePostsMany(updates: [
          { where: { id: { eq: 3 } }, set: { content: "MINE" } },
          { where: { id: { eq: 4 } }, set: { content: "TAKEN" } }
        ]) { id content }
      }`,
      { userId: 1 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updatePostsMany']).toEqual([{ id: 3, content: 'MINE' }, null]);
  });

  it('stops a delete from reaching an out-of-scope row', async () => {
    const gqlSchema = buildWith(ownPosts);
    const res = await run(gqlSchema, `mutation { deletePost(where: { id: { eq: 4 } }) { id } }`, { userId: 1 });

    expect(res.errors).toBeUndefined();
    expect(res.data?.['deletePost']).toEqual([]);
    const rows = await db.select().from(schema.Posts).where(eq(schema.Posts.id, 4));
    expect(rows).toHaveLength(1);
  });

  it("stops an upsert's conflict branch from taking over an out-of-scope row", async () => {
    const gqlSchema = buildWith({ ...ownPosts, features: { upsert: true } });
    // Post 4 belongs to user 5. Colliding on its primary key must not rewrite it.
    const res = await run(
      gqlSchema,
      `mutation { upsertPost(values: { id: 4, authorId: 1, content: "TAKEN" }) { id } }`,
      {
        userId: 1,
      },
    );

    expect(res.errors).toBeUndefined();
    const [row] = await db.select().from(schema.Posts).where(eq(schema.Posts.id, 4));
    expect(row.content).toBe('1MESSAGE');
    expect(row.authorId).toBe(5);

    // Control: the same statement against an in-scope row still updates it, so the scope is
    // what blocked the write above rather than the conflict handling itself.
    const own = await run(
      gqlSchema,
      `mutation { upsertPost(values: { id: 3, authorId: 1, content: "MINE" }) { id } }`,
      {
        userId: 1,
      },
    );
    expect(own.errors).toBeUndefined();
    const [mine] = await db.select().from(schema.Posts).where(eq(schema.Posts.id, 3));
    expect(mine.content).toBe('MINE');
  });

  it('confines the rows a nested connect may attach', async () => {
    const gqlSchema = buildWith({ ...ownPosts, features: { nestedWrites: true } });
    // Post 4 is user 5's, so user 2 cannot pull it in under user 1's scope.
    const res = await run(
      gqlSchema,
      `mutation { updateUserSingle(where: { id: { eq: 2 } }, set: { posts: { connect: [{ id: { eq: 4 } }] } }) { id } }`,
      { userId: 1 },
    );

    expect(res.errors).toBeUndefined();
    const [row] = await db.select().from(schema.Posts).where(eq(schema.Posts.id, 4));
    expect(row.authorId).toBe(5);

    // Control: an in-scope post connects, so the filter is what the scope narrowed.
    const own = await run(
      gqlSchema,
      `mutation { updateUserSingle(where: { id: { eq: 2 } }, set: { posts: { connect: [{ id: { eq: 3 } }] } }) { id } }`,
      { userId: 1 },
    );
    expect(own.errors).toBeUndefined();
    const [connected] = await db.select().from(schema.Posts).where(eq(schema.Posts.id, 3));
    expect(connected.authorId).toBe(2);
  });
});

describe.sequential('context-derived column values', () => {
  const stamped: Partial<BuildSchemaConfig> = {
    contextValues: { Posts: { authorId: (ctx: any) => ctx.userId } },
  };

  it('removes the column from the insert and update inputs', () => {
    const gqlSchema = buildWith(stamped);
    const insert = gqlSchema.getType('CreatePostInput') as GraphQLInputObjectType;
    const update = gqlSchema.getType('UpdatePostInput') as GraphQLInputObjectType;

    expect(Object.keys(insert.getFields())).not.toContain('authorId');
    expect(Object.keys(update.getFields())).not.toContain('authorId');
    // The column is still readable — it is server-owned, not hidden.
    expect(Object.keys((gqlSchema.getType('Post') as any).getFields())).toContain('authorId');
  });

  it('stamps the column on every insert', async () => {
    const gqlSchema = buildWith(stamped);
    const res = await run(
      gqlSchema,
      `mutation { createPosts(values: [{ id: 9001, content: "A" }, { id: 9002, content: "B" }]) { id authorId } }`,
      { userId: 5 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['createPosts']).toEqual([
      { id: 9001, authorId: 5 },
      { id: 9002, authorId: 5 },
    ]);
  });

  it('stamps the column on a single insert and an upsert', async () => {
    const gqlSchema = buildWith({ ...stamped, features: { upsert: true } });
    const single = await run(gqlSchema, `mutation { createPost(values: { id: 9003, content: "C" }) { authorId } }`, {
      userId: 2,
    });
    const upsert = await run(gqlSchema, `mutation { upsertPost(values: { id: 9004, content: "D" }) { authorId } }`, {
      userId: 2,
    });

    expect(single.errors).toBeUndefined();
    expect(single.data?.['createPost']).toEqual({ authorId: 2 });
    expect(upsert.errors).toBeUndefined();
    expect(upsert.data?.['upsertPost']).toEqual({ authorId: 2 });
  });

  it('leaves the column untouched by an update', async () => {
    const gqlSchema = buildWith(stamped);
    const res = await run(
      gqlSchema,
      `mutation { updatePost(where: { id: { eq: 4 } }, set: { content: "EDITED" }) { id authorId content } }`,
      { userId: 1 },
    );

    expect(res.errors).toBeUndefined();
    // The row keeps its original owner even though the request's context names another.
    expect(res.data?.['updatePost']).toEqual([{ id: 4, authorId: 5, content: 'EDITED' }]);
  });

  it('stamps the column on a nested create', async () => {
    // A column the nested link does not write, so the stamp is what fills it in.
    const gqlSchema = buildWith({
      contextValues: { Posts: { content: (ctx: any) => `by:${ctx.userId}` } },
      features: { nestedWrites: true },
    });
    const res = await run(
      gqlSchema,
      `mutation { createUser(values: { id: 9100, name: "Nested", posts: { create: [{ id: 9101 }] } }) { id } }`,
      { userId: 7 },
    );

    expect(res.errors).toBeUndefined();
    const [row] = await db.select().from(schema.Posts).where(eq(schema.Posts.id, 9101));
    expect(row.content).toBe('by:7');
    expect(row.authorId).toBe(9100);
  });
});

describe.sequential('policy validation', () => {
  it('rejects a scope naming a table that is not in the schema', () => {
    expect(() => buildWith({ scope: { Nope: () => undefined } })).toThrow(/not a table in the Drizzle schema/);
  });

  it('rejects context values naming a column the table does not have', () => {
    expect(() => buildWith({ contextValues: { Posts: { nope: () => 1 } } })).toThrow(/not a column of that table/);
  });

  it('rejects a scope that returns something that is neither a filter nor an expression', async () => {
    const gqlSchema = buildWith({ scope: { Posts: () => 'nope' as any } });
    const res = await run(gqlSchema, `{ posts { id } }`);

    expect(res.errors?.[0]?.message).toMatch(/scope for 'Posts' returned a string/);
  });
});
