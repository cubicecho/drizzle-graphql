import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-groupby-${Date.now()}`;
const ctx: Context = createCtx();

// Seeded posts: author 1 has ids 1, 2, 3, 6 — author 5 has ids 4, 5.
const byAuthor = (rows: any[]) => [...rows].sort((a, b) => a.group.authorId - b.group.authorId);

beforeAll(async () => {
  await setupServer(ctx, 4023, DATA_DIR);
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

describe.sequential('group by queries', () => {
  it('counts rows per group', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId]) { group { authorId } count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(byAuthor(result.data?.postsGroupBy)).toEqual([
      { group: { authorId: 1 }, count: 4 },
      { group: { authorId: 5 }, count: 2 },
    ]);
  });

  it('computes the same aggregates the aggregate query does, per group', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId]) {
        group { authorId }
        count
        avg { id }
        sum { id }
        min { id }
        max { id }
        countNonNull { content }
        countDistinct { content }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(byAuthor(result.data?.postsGroupBy)).toEqual([
      {
        group: { authorId: 1 },
        count: 4,
        avg: { id: 3 },
        sum: { id: 12 },
        min: { id: 1 },
        max: { id: 6 },
        countNonNull: { content: 4 },
        countDistinct: { content: 4 },
      },
      {
        group: { authorId: 5 },
        count: 2,
        avg: { id: 4.5 },
        sum: { id: 9 },
        min: { id: 4 },
        max: { id: 5 },
        countNonNull: { content: 2 },
        countDistinct: { content: 2 },
      },
    ]);
  });

  it('groups by more than one column', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId, content]) { group { authorId content } count }
    }`);

    expect(result.errors).toBeUndefined();
    // Every (author, content) pair in the seed is unique, so each group holds one row.
    expect(result.data?.postsGroupBy).toHaveLength(6);
    expect(result.data?.postsGroupBy.every((row: any) => row.count === 1)).toBe(true);
  });

  it('leaves a key the query did not group by null', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId]) { group { authorId content } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(byAuthor(result.data?.postsGroupBy)).toEqual([
      { group: { authorId: 1, content: null } },
      { group: { authorId: 5, content: null } },
    ]);
  });

  it('filters rows before grouping with where', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId], where: { authorId: { eq: 1 } }) { group { authorId } count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsGroupBy).toEqual([{ group: { authorId: 1 }, count: 4 }]);
  });

  it('filters groups by their row count with having', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId], having: { count: { gt: 3 } }) { group { authorId } count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsGroupBy).toEqual([{ group: { authorId: 1 }, count: 4 }]);
  });

  it('filters groups by an aggregated column value', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId], having: { min: { id: { gte: 4 } } }) { group { authorId } min { id } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsGroupBy).toEqual([{ group: { authorId: 5 }, min: { id: 4 } }]);
  });

  it('ands several having entries together', async () => {
    const both = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId], having: { count: { gte: 2 }, sum: { id: { lt: 10 } } }) {
        group { authorId }
      }
    }`);

    expect(both.errors).toBeUndefined();
    // Author 1 passes the count but its ids sum to 12, so only author 5 satisfies both.
    expect(both.data?.postsGroupBy).toEqual([{ group: { authorId: 5 } }]);

    const contradictory = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId], having: { count: { gt: 3 }, count2: { lt: 1 } }) { count }
    }`);

    // `count2` is not a field of the having input — a validation error, not a silent pass.
    expect(contradictory.errors).toBeDefined();
  });

  it('combines where and having', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(
        groupBy: [authorId]
        where: { id: { lt: 4 } }
        having: { count: { gte: 3 } }
      ) { group { authorId } count }
    }`);

    expect(result.errors).toBeUndefined();
    // Rows 1-3 all belong to author 1, so it is the only group and it survives having.
    expect(result.data?.postsGroupBy).toEqual([{ group: { authorId: 1 }, count: 3 }]);
  });

  it('groups by a boolean column, nulls included', async () => {
    const result = await ctx.gql.queryGql(`{
      usersGroupBy(groupBy: [isConfirmed]) { group { isConfirmed } count }
    }`);

    expect(result.errors).toBeUndefined();
    const rows = [...(result.data?.usersGroupBy ?? [])].sort((a: any, b: any) =>
      String(a.group.isConfirmed).localeCompare(String(b.group.isConfirmed)),
    );
    // Two seeded users have no value there, and SQL collects them into one NULL group — which
    // reads the same as a key the query did not group by.
    expect(rows).toEqual([
      { group: { isConfirmed: null }, count: 2 },
      { group: { isConfirmed: true }, count: 1 },
    ]);
  });

  it('rejects an empty groupBy', async () => {
    const result = await ctx.gql.queryGql(`{ postsGroupBy(groupBy: []) { count } }`);

    expect(result.errors?.[0]?.message).toStrictEqual('At least one column to group by is required!');
  });

  it('returns nothing when no row survives the filter', async () => {
    const result = await ctx.gql.queryGql(`{
      postsGroupBy(groupBy: [authorId], where: { authorId: { eq: 9999 } }) { group { authorId } count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.postsGroupBy).toEqual([]);
  });
});
