import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-error-context-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5270, DATA_DIR);
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

/**
 * The errors these resolvers raise carry their context as data: `extensions.code` classifies
 * the failure and `extensions.drizzle` says which table, operation and generated field it came
 * from. A schema that republishes these fields under other names needs both — the generated
 * name is deliberately absent from the prose, since `path` already names the published field.
 */
describe.sequential('Error extensions', () => {
  it('classifies a multi-row refusal and names the table, operation and generated field', async () => {
    const res = await ctx.gql.queryGql(`
      mutation { updateUser(where: { id: { gt: 0 } }, set: { name: "X" }) { id } }
    `);

    expect(res.errors).toBeDefined();
    const error = res.errors![0]!;
    expect(error.message).toMatch(/matched more than one row/);
    expect(error.extensions).toStrictEqual({
      code: 'DRIZZLE_MULTI_ROW_MATCH',
      drizzle: { table: 'Users', operation: 'update', field: 'updateUser' },
    });
  });

  it('keeps the generated field name out of the message, where a rename cannot reach it', async () => {
    const res = await ctx.gql.queryGql(`
      mutation { updateUser(where: { id: { gt: 0 } }, set: { name: "X" }) { id } }
    `);

    expect(res.errors![0]!.message).not.toContain('updateUser');
    // The name the client asked for is in `path`, already correct under any rename.
    expect(res.errors![0]!.path).toStrictEqual(['updateUser']);
  });

  it('marks an empty insert as a no-values write', async () => {
    const res = await ctx.gql.queryGql(`mutation { createUsers(values: []) { id } }`);

    expect(res.errors![0]!.extensions).toStrictEqual({
      code: 'DRIZZLE_NO_VALUES',
      drizzle: { table: 'Users', operation: 'insert', field: 'createUsers' },
    });
  });

  it('marks an empty update set as a no-values write', async () => {
    const res = await ctx.gql.queryGql(`
      mutation { updateUsers(set: {}, where: { id: { eq: 1 } }) { id } }
    `);

    expect(res.errors![0]!.extensions).toStrictEqual({
      code: 'DRIZZLE_NO_VALUES',
      drizzle: { table: 'Users', operation: 'update', field: 'updateUsers' },
    });
  });

  // The cursor is decoded deep inside the select path, which knows nothing about the field
  // that called it — the context is attached as the error leaves the resolver.
  it('gives a select-path error the field that raised it', async () => {
    const res = await ctx.gql.queryGql(
      `{ users(after: "not-a-cursor", orderBy: { id: { priority: 1, direction: asc } }) { id } }`,
    );

    expect(res.errors![0]!.message).toMatch(/Invalid cursor/);
    expect(res.errors![0]!.extensions).toStrictEqual({
      code: 'DRIZZLE_INVALID_CURSOR',
      drizzle: { table: 'Users', operation: 'select', field: 'users' },
    });
  });

  it('names the relation on a relation-field error', async () => {
    const res = await ctx.gql.queryGql(`{
      users { id posts(after: "not-a-cursor", orderBy: { id: { priority: 1, direction: asc } }) { id } }
    }`);

    expect(res.errors![0]!.extensions).toStrictEqual({
      code: 'DRIZZLE_INVALID_CURSOR',
      drizzle: { table: 'Posts', operation: 'relation', relation: 'posts' },
    });
  });

  it('classifies an empty groupBy', async () => {
    const res = await ctx.gql.queryGql(`{ usersGroupBy(groupBy: []) { count } }`);

    expect(res.errors![0]!.extensions).toStrictEqual({
      code: 'DRIZZLE_INVALID_GROUP_BY',
      drizzle: { table: 'Users', operation: 'groupBy', field: 'usersGroupBy' },
    });
  });

  it('leaves a database error alone — it is masked, not classified', async () => {
    // User 1 is seeded, so this fails on the primary key inside the driver rather than in a
    // generated resolver: no drizzle code to classify, and nothing to attach context to.
    const res = await ctx.gql.queryGql(`
      mutation { createUsers(values: [{ id: 1, name: "Duplicate" }]) { id } }
    `);

    expect(res.errors).toBeDefined();
    expect(res.errors![0]!.extensions?.['drizzle']).toBeUndefined();
    expect(res.errors![0]!.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');
  });
});
