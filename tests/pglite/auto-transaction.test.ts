import { eq } from 'drizzle-orm';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, drizzleExecutorKey } from '@/index';
import {
  createMinimalCtx,
  type MinimalContext,
  schema,
  setupMinimal,
  setupTables,
  sql,
  teardownMinimal,
  teardownTables,
} from './common';

const DATA_DIR = `./tests/.temp/pgdata-autotx-${Date.now()}`;
const ctx: MinimalContext = createMinimalCtx();

// Same schema shape as ctx.schema but built with transactions: 'auto', so multi-mutation
// requests are wrapped in a single library-opened transaction.
let autoSchema: GraphQLSchema;

const run = (source: string, contextValue: object = {}) => graphql({ schema: autoSchema, source, contextValue });

const userRow = (id: number) => ctx.db.select().from(schema.Users).where(eq(schema.Users.id, id));

beforeAll(async () => {
  await setupMinimal(ctx, DATA_DIR);
  await ctx.db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin','user'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  autoSchema = buildSchema(ctx.db, {
    typeNameMapper: (name) =>
      (
        ({
          Users: { singular: 'user', plural: 'users' },
          Posts: { singular: 'post', plural: 'posts' },
          Customers: { singular: 'customer', plural: 'customers' },
          Tags: { singular: 'tag', plural: 'tags' },
        }) as Record<string, { singular: string; plural: string }>
      )[name],
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
    transactions: 'auto',
  }).schema;
});
afterAll(async () => {
  await teardownMinimal(ctx, DATA_DIR);
});
beforeEach(async () => {
  await setupTables(ctx);
});
afterEach(async () => {
  await teardownTables(ctx);
});

describe.sequential('automatic multi-mutation transactions', () => {
  it('rolls back earlier mutations when a later one in the same request fails', async () => {
    // The second insert reuses seeded primary key 1, so it fails after the first insert
    // already ran. With transactions: 'auto' the first insert must not survive.
    const result = await run(`mutation {
      first: createUser(values: { id: 200, name: "AutoTxOne" }) { id }
      second: createUser(values: { id: 1, name: "Duplicate" }) { id }
    }`);

    expect(result.errors).toBeDefined();
    expect(await userRow(200)).toHaveLength(0);
    expect(await userRow(1)).toHaveLength(1);
  });

  it('commits all mutations of a request when every one succeeds', async () => {
    const result = await run(`mutation {
      first: createUser(values: { id: 201, name: "AutoTxOne" }) { id name }
      second: createUser(values: { id: 202, name: "AutoTxTwo" }) { id name }
      renamed: updateUsers(set: { name: "AutoTxOneRenamed" }, where: { id: { eq: 201 } }) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await userRow(201)).toMatchObject([{ name: 'AutoTxOneRenamed' }]);
    expect(await userRow(202)).toMatchObject([{ name: 'AutoTxTwo' }]);
  });

  it('does not open a transaction for a single-mutation request', async () => {
    const spy = vi.spyOn(ctx.db, 'transaction');
    try {
      const result = await run(`mutation { only: createUser(values: { id: 203, name: "Solo" }) { id } }`);

      expect(result.errors).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      expect(await userRow(203)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('never nests inside a caller-supplied executor and lets the caller roll everything back', async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        // If the library tried to open its own transaction it would either nest through the
        // caller's tx or open a fresh one on the build-time db; assert it does neither.
        const nested = vi.spyOn(tx, 'transaction');
        const fresh = vi.spyOn(ctx.db, 'transaction');

        const result = await run(
          `mutation {
            first: createUser(values: { id: 204, name: "CallerTxOne" }) { id }
            second: createUser(values: { id: 205, name: "CallerTxTwo" }) { id }
          }`,
          { [drizzleExecutorKey]: tx },
        );

        expect(result.errors).toBeUndefined();
        expect(nested).not.toHaveBeenCalled();
        expect(fresh).not.toHaveBeenCalled();
        fresh.mockRestore();

        // Both rows are visible inside the caller's transaction...
        const inside = await tx.select().from(schema.Users).where(eq(schema.Users.id, 204));
        expect(inside).toHaveLength(1);

        throw new Error('caller rollback');
      }),
    ).rejects.toThrow('caller rollback');

    // ...and gone once the caller rolls back.
    expect(await userRow(204)).toHaveLength(0);
    expect(await userRow(205)).toHaveLength(0);
  });
});
