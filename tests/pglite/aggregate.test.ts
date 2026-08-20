import type { GraphQLObjectType } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-aggregate-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 4017, DATA_DIR);
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

describe.sequential('aggregate queries', () => {
  it('counts all rows', async () => {
    const result = await ctx.gql.queryGql(`{ usersAggregate { count } }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.usersAggregate).toEqual({ count: 3 });
  });

  it('counts rows matching a where filter', async () => {
    const result = await ctx.gql.queryGql(`{
      postsAggregate(where: { authorId: { eq: 1 } }) { count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsAggregate).toEqual({ count: 4 });
  });

  it('computes avg, sum, min, and max on numeric columns', async () => {
    const result = await ctx.gql.queryGql(`{
      postsAggregate {
        count
        avg { id }
        sum { id }
        min { id }
        max { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsAggregate).toEqual({
      count: 6,
      avg: { id: 3.5 },
      sum: { id: 21 },
      min: { id: 1 },
      max: { id: 6 },
    });
  });

  it('applies the where filter to all aggregations', async () => {
    const result = await ctx.gql.queryGql(`{
      postsAggregate(where: { authorId: { eq: 5 } }) {
        count
        sum { id }
        min { id }
        max { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsAggregate).toEqual({
      count: 2,
      sum: { id: 9 },
      min: { id: 4 },
      max: { id: 5 },
    });
  });

  it('computes min and max on text and timestamp columns', async () => {
    const result = await ctx.gql.queryGql(`{
      usersAggregate {
        min { name createdAt }
        max { name createdAt }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.usersAggregate).toEqual({
      min: { name: 'FifthUser', createdAt: '2024-04-02T06:44:41.785Z' },
      max: { name: 'SecondUser', createdAt: '2024-04-02T06:44:41.785Z' },
    });
  });

  it('returns zero count and null aggregates for an empty table', async () => {
    const result = await ctx.gql.queryGql(`{
      tagsAggregate {
        count
        avg { id }
        sum { id }
        min { name }
        max { name }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.tagsAggregate).toEqual({
      count: 0,
      avg: { id: null },
      sum: { id: null },
      min: { name: null },
      max: { name: null },
    });
  });

  it('returns null aggregates when the where filter matches no rows', async () => {
    const result = await ctx.gql.queryGql(`{
      usersAggregate(where: { name: { eq: "Nobody" } }) {
        count
        avg { id }
        min { name }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.usersAggregate).toEqual({
      count: 0,
      avg: { id: null },
      min: { name: null },
    });
  });

  it('supports field aliases', async () => {
    const result = await ctx.gql.queryGql(`{
      postsAggregate {
        total: count
        highest: max { postId: id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsAggregate).toEqual({
      total: 6,
      highest: { postId: 6 },
    });
  });

  it('only exposes numeric columns on avg/sum and orderable columns on min/max', () => {
    const avgType = ctx.schema.getType('UserAvgAggregate') as GraphQLObjectType;
    expect(Object.keys(avgType.getFields())).toEqual(['id']);

    const minType = ctx.schema.getType('UserMinAggregate') as GraphQLObjectType;
    const minFields = Object.keys(minType.getFields());
    expect(minFields).toContain('name');
    expect(minFields).toContain('createdAt');
    expect(minFields).toContain('id');
    // Booleans, arrays, geometry, and vector columns are not orderable.
    expect(minFields).not.toContain('isConfirmed');
    expect(minFields).not.toContain('a');
    expect(minFields).not.toContain('vector');
    expect(minFields).not.toContain('geoXy');
    expect(minFields).not.toContain('geoTuple');
  });

  it('rejects unknown aggregate columns at validation time', async () => {
    const result = await ctx.gql.queryGql(`{
      usersAggregate { avg { name } }
    }`);

    expect(result.errors).toBeDefined();
  });
});
