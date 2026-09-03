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

// An empty candidate list is a normal state for a caller building a filter from a variable,
// so it answers the question rather than erroring. Seeded users are 1, 2 and 5.
describe.sequential('Empty-list filter operators', () => {
  it('inArray with an empty list matches nothing', async () => {
    const res = await ctx.gql.queryGql(`{ users(where: { id: { inArray: [] } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.users).toStrictEqual([]);
  });

  it('notInArray with an empty list matches everything', async () => {
    const res = await ctx.gql.queryGql(`{ users(where: { id: { notInArray: [] } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.users).toHaveLength(3);
  });

  it('inArray with an empty list matches nothing on a relation field', async () => {
    const res = await ctx.gql.queryGql(`{
      users { id posts(where: { id: { inArray: [] } }) { id } }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.users.every((user: any) => user.posts.length === 0)).toBe(true);
  });

  it('still narrows when combined with a sibling operator', async () => {
    const res = await ctx.gql.queryGql(`{ users(where: { id: { notInArray: [], eq: 1 } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.users).toStrictEqual([{ id: 1 }]);
  });
});

describe.sequential('Mutation input validation errors', () => {
  it('update with empty set object returns a GraphQL error', async () => {
    const res = await ctx.gql.queryGql(`
      mutation { updateUsers(set: {}, where: { id: { eq: 1 } }) { id } }
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
