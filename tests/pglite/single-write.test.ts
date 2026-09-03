import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { GraphQLClient } from '../util/query';
import type { Context } from './common';
import { createCtx, schema, setupServer, setupTables, sql, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-single-write-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5240, DATA_DIR);
});

afterAll(async () => {
  await teardownServer(ctx, DATA_DIR);
});

beforeEach(async () => {
  await setupTables(ctx);
});

afterEach(async () => {
  await teardownTables(ctx);
});

describe.sequential('updateSingle / deleteSingle mutations', () => {
  it('generates the Single variants with a non-null where and a single nullable return type', () => {
    const mutationFields = ctx.schema.getMutationType()!.getFields();

    for (const fieldName of ['updateUser', 'deleteUser', 'updatePost', 'deletePost']) {
      const field = mutationFields[fieldName];
      expect(field).toBeDefined();
      const whereArg = field!.args.find((arg) => arg.name === 'where');
      expect(whereArg).toBeDefined();
      expect(whereArg!.type).toBeInstanceOf(GraphQLNonNull);
      // Single (nullable) row out — not a list.
      expect(field!.type).toBeInstanceOf(GraphQLObjectType);
      expect(field!.type).not.toBeInstanceOf(GraphQLList);
      expect(field!.type).not.toBeInstanceOf(GraphQLNonNull);
    }
  });

  it('keeps where nullable on the plural update/delete mutations by default', () => {
    const mutationFields = ctx.schema.getMutationType()!.getFields();

    for (const fieldName of ['updateUsers', 'deleteUsers']) {
      const whereArg = mutationFields[fieldName]!.args.find((arg) => arg.name === 'where');
      expect(whereArg).toBeDefined();
      expect(whereArg!.type).not.toBeInstanceOf(GraphQLNonNull);
    }
  });

  it('exposes the Single variants on entities.mutations', () => {
    const mutations = ctx.entities.mutations as Record<string, any>;
    expect(mutations['updateUser']).toBeDefined();
    expect(mutations['deleteUser']).toBeDefined();
  });

  it('updateSingle updates and returns the one matched row', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateUser(where: { id: { eq: 2 } }, set: { name: "UpdatedSecondUser" }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateUser: {
          id: 2,
          name: 'UpdatedSecondUser',
        },
      },
    });

    // Only the matched row was touched.
    const names = (await ctx.db.select({ id: schema.Users.id, name: schema.Users.name }).from(schema.Users)).sort(
      (a, b) => a.id - b.id,
    );
    expect(names).toStrictEqual([
      { id: 1, name: 'FirstUser' },
      { id: 2, name: 'UpdatedSecondUser' },
      { id: 5, name: 'FifthUser' },
    ]);
  });

  it('updateSingle returns null when nothing matches', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateUser(where: { id: { eq: 999 } }, set: { name: "Nobody" }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({ data: { updateUser: null } });
  });

  it('updateSingle throws and writes nothing when where matches more than one row', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updatePost(where: { authorId: { eq: 1 } }, set: { content: "OVERWRITTEN" }) {
					id
					content
				}
			}
		`);

    // The field is nullable, so the error surfaces alongside a null field value.
    expect(res.data?.updatePost ?? null).toBeNull();
    expect(res.errors?.[0]?.message).toContain('matched more than one row');

    const overwritten = await ctx.db.select().from(schema.Posts).where(eq(schema.Posts.content, 'OVERWRITTEN'));
    expect(overwritten).toHaveLength(0);
  });

  it('updateSingle without where is rejected by validation', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateUser(set: { name: "Nobody" }) {
					id
				}
			}
		`);

    expect(res.errors).toBeDefined();

    const renamed = await ctx.db.select().from(schema.Users).where(eq(schema.Users.name, 'Nobody'));
    expect(renamed).toHaveLength(0);
  });

  it('updateSingle rejects a where with no filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateUser(where: {}, set: { name: "Nobody" }) {
					id
				}
			}
		`);

    expect(res.data?.updateUser ?? null).toBeNull();
    expect(res.errors?.[0]?.message).toContain('at least one filter');

    const renamed = await ctx.db.select().from(schema.Users).where(eq(schema.Users.name, 'Nobody'));
    expect(renamed).toHaveLength(0);
  });

  it('deleteSingle deletes and returns the one matched row', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePost(where: { id: { eq: 6 } }) {
					id
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deletePost: {
          id: 6,
          content: '4MESSAGE',
        },
      },
    });

    const remaining = await ctx.db.select({ id: schema.Posts.id }).from(schema.Posts);
    expect(remaining).toHaveLength(5);
    expect(remaining.map((post) => post.id)).not.toContain(6);
  });

  it('deleteSingle returns null when nothing matches', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePost(where: { id: { eq: 999 } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { deletePost: null } });

    const remaining = await ctx.db.select({ id: schema.Posts.id }).from(schema.Posts);
    expect(remaining).toHaveLength(6);
  });

  it('deleteSingle throws and deletes nothing when where matches more than one row', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePost(where: { authorId: { eq: 5 } }) {
					id
				}
			}
		`);

    expect(res.data?.deletePost ?? null).toBeNull();
    expect(res.errors?.[0]?.message).toContain('matched more than one row');

    const remaining = await ctx.db.select({ id: schema.Posts.id }).from(schema.Posts);
    expect(remaining).toHaveLength(6);
  });

  it('deleteSingle without where is rejected by validation', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePost {
					id
				}
			}
		`);

    expect(res.errors).toBeDefined();

    const remaining = await ctx.db.select({ id: schema.Posts.id }).from(schema.Posts);
    expect(remaining).toHaveLength(6);
  });

  it('deleteSingle rejects a where with no filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePost(where: {}) {
					id
				}
			}
		`);

    expect(res.data?.deletePost ?? null).toBeNull();
    expect(res.errors?.[0]?.message).toContain('at least one filter');

    const remaining = await ctx.db.select({ id: schema.Posts.id }).from(schema.Posts);
    expect(remaining).toHaveLength(6);
  });
});

// ── features.requireWhere ─────────────────────────────────────────────────────

describe.sequential('features.requireWhere', () => {
  const dataDir = `./tests/.temp/pgdata-require-where-${Date.now()}`;
  const rwCtx: { pglite: PGlite; db: any; server: Server; gql: GraphQLClient; schema: any } = {} as any;

  beforeAll(async () => {
    rwCtx.pglite = new PGlite(dataDir);
    await rwCtx.pglite.waitReady;
    rwCtx.db = drizzle({ client: rwCtx.pglite, relations: schema.relations });
    await rwCtx.db.execute(
      sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin','user'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
    );

    const { schema: gqlSchema } = buildSchema(rwCtx.db, { features: { requireWhere: true } });
    rwCtx.schema = gqlSchema;
    const yoga = createYoga({ schema: gqlSchema });
    rwCtx.server = createServer(yoga);
    rwCtx.server.listen(5241);
    rwCtx.gql = new GraphQLClient('http://localhost:5241/graphql');
  });

  afterAll(async () => {
    await rwCtx.pglite?.close().catch(console.error);
    await rm(dataDir, { recursive: true, force: true }).catch(console.error);
    await new Promise<void>((resolve) => rwCtx.server?.close(() => resolve()));
  });

  beforeEach(async () => {
    await setupTables(rwCtx as any);
  });

  afterEach(async () => {
    await teardownTables(rwCtx as any);
  });

  it('makes where non-null on the plural update/delete mutations', () => {
    const mutationFields = rwCtx.schema.getMutationType()!.getFields();

    for (const fieldName of ['updateUsers', 'deleteUsers', 'updateUsersSingle', 'deleteUsersSingle']) {
      const whereArg = mutationFields[fieldName]!.args.find((arg: any) => arg.name === 'where');
      expect(whereArg).toBeDefined();
      expect(whereArg!.type).toBeInstanceOf(GraphQLNonNull);
    }
  });

  it('rejects a plural update without where at validation time', async () => {
    const res = await rwCtx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateUsers(set: { name: "Nobody" }) {
					id
				}
			}
		`);

    expect(res.errors).toBeDefined();

    const renamed = await rwCtx.db.select().from(schema.Users).where(eq(schema.Users.name, 'Nobody'));
    expect(renamed).toHaveLength(0);
  });

  it('rejects a plural delete without where at validation time', async () => {
    const res = await rwCtx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePosts {
					id
				}
			}
		`);

    expect(res.errors).toBeDefined();

    const remaining = await rwCtx.db.select({ id: schema.Posts.id }).from(schema.Posts);
    expect(remaining).toHaveLength(6);
  });

  it('rejects a plural update/delete whose where has no filters', async () => {
    const update = await rwCtx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateUsers(where: {}, set: { name: "Nobody" }) {
					id
				}
			}
		`);
    expect(update.data).toBeFalsy();
    expect(update.errors?.[0]?.message).toContain('at least one filter');

    const remove = await rwCtx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePosts(where: {}) {
					id
				}
			}
		`);
    expect(remove.data).toBeFalsy();
    expect(remove.errors?.[0]?.message).toContain('at least one filter');

    const remaining = await rwCtx.db.select({ id: schema.Posts.id }).from(schema.Posts);
    expect(remaining).toHaveLength(6);
  });

  it('still runs plural update/delete normally with a real where', async () => {
    const update = await rwCtx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateUsers(where: { id: { eq: 1 } }, set: { name: "RenamedFirstUser" }) {
					id
					name
				}
			}
		`);

    expect(update).toStrictEqual({
      data: {
        updateUsers: [{ id: 1, name: 'RenamedFirstUser' }],
      },
    });

    const remove = await rwCtx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePosts(where: { authorId: { eq: 5 } }) {
					id
				}
			}
		`);

    expect(remove.errors).toBeUndefined();
    expect(remove.data?.deletePosts).toHaveLength(2);
  });
});
