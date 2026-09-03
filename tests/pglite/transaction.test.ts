import { eq } from 'drizzle-orm';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const DATA_DIR = `./tests/.temp/pgdata-transaction-${Date.now()}`;
const ctx: MinimalContext = createMinimalCtx();

// The same schema shape as ctx.schema, but with relations resolved lazily through the
// request batch loader instead of an eager lateral join, so both paths get covered.
let lazySchema: GraphQLSchema;

const runOn = (gqlSchema: GraphQLSchema, source: string, executor?: unknown) =>
  graphql({
    schema: gqlSchema,
    source,
    contextValue: executor ? { [drizzleExecutorKey]: executor } : {},
  });

const run = (source: string, executor?: unknown) => runOn(ctx.schema, source, executor);

/**
 * Records every property read off the executor so we can prove a resolver went through the
 * context executor rather than the build-time `db`. Methods are bound to the real target so
 * drizzle's builders keep working.
 */
const recordingExecutor = <T extends object>(target: T, reads: string[]): T =>
  new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'string') {
        reads.push(prop);
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });

beforeAll(async () => {
  await setupMinimal(ctx, DATA_DIR);
  await ctx.db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin','user'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  lazySchema = buildSchema(ctx.db, {
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
    eagerLoadRelations: false,
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

describe.sequential('context executor routing', () => {
  it('runs list queries on the context executor', async () => {
    const reads: string[] = [];
    const result = await run(`{ users { id name } }`, recordingExecutor(ctx.db, reads));

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toHaveLength(3);
    expect(reads).toContain('query');
  });

  it('runs single queries on the context executor', async () => {
    const reads: string[] = [];
    const result = await run(`{ user(where: { id: { eq: 1 } }) { id name } }`, recordingExecutor(ctx.db, reads));

    expect(result.errors).toBeUndefined();
    expect(result.data?.['user']).toMatchObject({ id: 1, name: 'FirstUser' });
    expect(reads).toContain('query');
  });

  it('runs lazy relation field resolvers on the context executor', async () => {
    const reads: string[] = [];
    // eagerLoadRelations: false, so `posts` goes through the request batch loader, which
    // issues its own select and has to pick up the executor at resolve time.
    const result = await runOn(lazySchema, `{ users { id posts { id content } } }`, recordingExecutor(ctx.db, reads));

    expect(result.errors).toBeUndefined();
    expect((result.data?.['users'] as any[])?.find((u) => u.id === 1)?.posts).toHaveLength(4);
    expect(reads).toContain('select');
  });

  it('runs aggregate queries on the context executor', async () => {
    const reads: string[] = [];
    const result = await run(`{ usersAggregate { count } }`, recordingExecutor(ctx.db, reads));

    expect(result.errors).toBeUndefined();
    expect(result.data?.['usersAggregate']).toMatchObject({ count: 3 });
    expect(reads).toContain('select');
  });

  it('runs relation aggregates on the context executor', async () => {
    const reads: string[] = [];
    const result = await run(`{ users { id postsAggregate { count } } }`, recordingExecutor(ctx.db, reads));

    expect(result.errors).toBeUndefined();
    expect(reads).toContain('select');
  });

  it('runs insert, update and delete mutations on the context executor', async () => {
    const inserts: string[] = [];
    const insert = await run(
      `mutation { createUser(values: { id: 100, name: "TxUser" }) { id name } }`,
      recordingExecutor(ctx.db, inserts),
    );
    expect(insert.errors).toBeUndefined();
    expect(inserts).toContain('insert');

    const updates: string[] = [];
    const update = await run(
      `mutation { updateUsers(set: { name: "Renamed" }, where: { id: { eq: 100 } }) { id name } }`,
      recordingExecutor(ctx.db, updates),
    );
    expect(update.errors).toBeUndefined();
    expect(updates).toContain('update');

    const deletes: string[] = [];
    const del = await run(
      `mutation { deleteUsers(where: { id: { eq: 100 } }) { id } }`,
      recordingExecutor(ctx.db, deletes),
    );
    expect(del.errors).toBeUndefined();
    expect(deletes).toContain('delete');
  });

  it('falls back to the build-time db when the context carries no executor', async () => {
    const result = await run(`{ users { id name } }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toHaveLength(3);
  });
});

describe.sequential('transactions', () => {
  it('rolls back mutations executed on a transaction', async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        const insert = await run(`mutation { createUser(values: { id: 101, name: "RolledBack" }) { id name } }`, tx);
        expect(insert.errors).toBeUndefined();

        // The uncommitted row is visible to queries running on the same transaction.
        const inside = await run(`{ user(where: { id: { eq: 101 } }) { id name } }`, tx);
        expect(inside.data?.['user']).toMatchObject({ id: 101, name: 'RolledBack' });

        throw new Error('rollback please');
      }),
    ).rejects.toThrow('rollback please');

    const rows = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 101));
    expect(rows).toHaveLength(0);
  });

  it('commits several mutations as one unit', async () => {
    await ctx.db.transaction(async (tx) => {
      const first = await run(`mutation { createUser(values: { id: 102, name: "CommittedOne" }) { id } }`, tx);
      const second = await run(`mutation { createUser(values: { id: 103, name: "CommittedTwo" }) { id } }`, tx);

      expect(first.errors).toBeUndefined();
      expect(second.errors).toBeUndefined();
    });

    const rows = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 102));
    expect(rows).toHaveLength(1);
    const others = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 103));
    expect(others).toHaveLength(1);
  });

  it('rolls back every mutation in the batch when a later one fails', async () => {
    await expect(
      ctx.db.transaction(async (tx) => {
        const ok = await run(`mutation { createUser(values: { id: 104, name: "First" }) { id } }`, tx);
        expect(ok.errors).toBeUndefined();

        // Duplicate primary key: the resolver surfaces the error, and re-throwing it aborts
        // the transaction the way a caller batching mutations would.
        const conflict = await run(`mutation { createUser(values: { id: 104, name: "Duplicate" }) { id } }`, tx);
        expect(conflict.errors).toBeDefined();
        throw new Error('aborting batch');
      }),
    ).rejects.toThrow();

    const rows = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 104));
    expect(rows).toHaveLength(0);
  });
});
