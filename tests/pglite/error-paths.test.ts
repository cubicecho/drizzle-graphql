import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-error-paths-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 4360, DATA_DIR);
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

describe.sequential('Filter extraction errors', () => {
  it('inArray with empty array returns a GraphQL error', async () => {
    const res = await ctx.gql.queryGql(`{ users(where: { id: { inArray: [] } }) { id } }`);
    expect(res.errors).toBeDefined();
    expect(res.errors![0]!.message).toMatch(/Unable to use operator inArray with an empty array/);
  });

  it('notInArray with empty array returns a GraphQL error', async () => {
    const res = await ctx.gql.queryGql(`{ users(where: { id: { notInArray: [] } }) { id } }`);
    expect(res.errors).toBeDefined();
    expect(res.errors![0]!.message).toMatch(/Unable to use operator notInArray with an empty array/);
  });

  it('inArray on a relation field with empty array returns a GraphQL error', async () => {
    const res = await ctx.gql.queryGql(`{
      users { id posts(where: { id: { inArray: [] } }) { id } }
    }`);
    expect(res.errors).toBeDefined();
    expect(res.errors![0]!.message).toMatch(/Unable to use operator inArray with an empty array/);
  });
});

describe.sequential('Mutation input validation errors', () => {
  it('update with empty set object returns a GraphQL error', async () => {
    const res = await ctx.gql.queryGql(`
      mutation { updateUser(set: {}, where: { id: { eq: 1 } }) { id } }
    `);
    expect(res.errors).toBeDefined();
    expect(res.errors![0]!.message).toMatch(/Unable to update with no values specified/);
  });

  it('insert with empty values array returns a GraphQL error', async () => {
    const res = await ctx.gql.queryGql(`
      mutation { createUsers(values: []) { id } }
    `);
    expect(res.errors).toBeDefined();
    expect(res.errors![0]!.message).toMatch(/No values were provided/);
  });
});

describe('buildSchema config validation errors', () => {
  it('throws when list and single suffixes are equal (regardless of relationsDepthLimit)', () => {
    expect(() => buildSchema(ctx.db, { suffixes: { list: 'X', single: 'X' } })).toThrow(
      /List and single query suffixes cannot be the same/,
    );
  });

  it('throws when relationsDepthLimit is negative', () => {
    expect(() => buildSchema(ctx.db, { relationsDepthLimit: -1 })).toThrow(/nonnegative integer/);
  });

  it('throws when relationsDepthLimit is a non-integer', () => {
    expect(() => buildSchema(ctx.db, { relationsDepthLimit: 1.5 })).toThrow(/nonnegative integer/);
  });
});
