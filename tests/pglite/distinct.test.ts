import type { GraphQLEnumType, GraphQLObjectType } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-distinct-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 4020, DATA_DIR);
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

// Seed recap: posts 1/2/3/6 belong to user 1 with contents 1/2/3/4MESSAGE, posts 4/5 belong to
// user 5 with contents 1/2MESSAGE. So `content` has 4 distinct values and `authorId` has 2.
describe.sequential('distinct', () => {
  it('keeps the first row of each distinct value', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(distinct: [content]) { id content }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([
      { id: 1, content: '1MESSAGE' },
      { id: 2, content: '2MESSAGE' },
      { id: 3, content: '3MESSAGE' },
      { id: 6, content: '4MESSAGE' },
    ]);
  });

  it('picks the first row according to the requested order', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(distinct: [content], orderBy: { id: { direction: desc, priority: 1 } }) { id content }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([
      { id: 6, content: '4MESSAGE' },
      { id: 5, content: '2MESSAGE' },
      { id: 4, content: '1MESSAGE' },
      { id: 3, content: '3MESSAGE' },
    ]);
  });

  it('treats several columns as one combined key', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(distinct: [content, authorId]) { id }
    }`);

    expect(result.errors).toBeUndefined();
    // Every (content, authorId) pair in the seed is unique, so nothing is dropped.
    expect(result.data?.posts).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]);
  });

  it('collapses rows that share a value', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(distinct: [authorId]) { id authorId }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([
      { id: 1, authorId: 1 },
      { id: 4, authorId: 5 },
    ]);
  });

  it('applies limit and offset after the rows are made distinct', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(distinct: [content], limit: 2, offset: 1) { id content }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([
      { id: 2, content: '2MESSAGE' },
      { id: 3, content: '3MESSAGE' },
    ]);
  });

  it('filters before making rows distinct', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(where: { authorId: { eq: 5 } }, distinct: [content]) { id content }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([
      { id: 4, content: '1MESSAGE' },
      { id: 5, content: '2MESSAGE' },
    ]);
  });

  it('accepts a relation filter alongside distinct', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(where: { author: { name: { eq: "FifthUser" } } }, distinct: [content]) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([{ id: 4 }, { id: 5 }]);
  });

  it('returns an empty list when the filter matches nothing', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(where: { content: { eq: "NOPE" } }, distinct: [content]) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([]);
  });

  it('eagerly loads relations of the surviving rows', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(distinct: [authorId]) {
        id
        author { name }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([
      { id: 1, author: { name: 'FirstUser' } },
      { id: 4, author: { name: 'FifthUser' } },
    ]);
  });

  it('aggregates relations of the surviving rows', async () => {
    const result = await ctx.gql.queryGql(`{
      users(distinct: [id]) {
        id
        postsAggregate { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      { id: 1, postsAggregate: { count: 4 } },
      { id: 2, postsAggregate: { count: 0 } },
      { id: 5, postsAggregate: { count: 2 } },
    ]);
  });

  it('is ignored when the list is empty', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(distinct: []) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toHaveLength(6);
  });

  describe('schema shape', () => {
    const queries = () => ctx.entities.queries as unknown as Record<string, { args: Record<string, { type: any }> }>;

    it('exposes distinct on list queries only', () => {
      expect(queries()['posts']!.args['distinct']).toBeDefined();
      expect(queries()['post']!.args['distinct']).toBeUndefined();
      expect(queries()['postsAggregate']!.args['distinct']).toBeUndefined();
    });

    it('takes a list of the table column enum', () => {
      const listType = queries()['posts']!.args['distinct']!.type;
      const enumType = listType.ofType.ofType as GraphQLEnumType;

      const postFields = (ctx.entities.types as unknown as Record<string, GraphQLObjectType>)['Post']!.getFields();

      expect(enumType.name).toBe('PostDistinctColumn');
      // Every column, and only columns — relation fields are not distinctable.
      expect(enumType.getValues().map((value) => value.name)).toEqual(['id', 'content', 'authorId']);
      expect(Object.keys(postFields)).toContain('author');
    });
  });
});
