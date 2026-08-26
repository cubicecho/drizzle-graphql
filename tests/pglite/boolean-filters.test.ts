import { type GraphQLInputObjectType, GraphQLList, GraphQLNonNull } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-boolean-filters-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5200, DATA_DIR);
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

// Seed recap: user 1 (FirstUser) wrote posts 1,2,3,6; user 5 (FifthUser) wrote posts 4,5;
// user 2 (SecondUser) wrote none.
describe.sequential('boolean filter tree (table level)', () => {
  it('ANDs sibling fields with an OR group — A AND (B OR C)', async () => {
    const result = await ctx.gql.queryGql(`{
      users(
        where: { name: { like: "F%" }, OR: [{ id: { eq: 1 } }, { id: { eq: 2 } }] }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }]);
  });

  it('keeps OR-only filters working as before', async () => {
    const result = await ctx.gql.queryGql(`{
      users(
        where: { OR: [{ id: { eq: 1 } }, { id: { eq: 2 } }] }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('supports an explicit AND list', async () => {
    const result = await ctx.gql.queryGql(`{
      users(
        where: { AND: [{ id: { gte: 1 } }, { id: { lte: 2 } }] }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('supports NOT of a clause', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { NOT: { name: { like: "F%" } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 2 }]);
  });

  it('supports NOT over an OR (nested recursion)', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { NOT: { OR: [{ id: { eq: 1 } }, { id: { eq: 2 } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 5 }]);
  });

  it('nests AND, NOT and OR arbitrarily', async () => {
    const result = await ctx.gql.queryGql(`{
      users(
        where: {
          AND: [
            { NOT: { id: { eq: 2 } } }
            { OR: [{ name: { like: "Fir%" } }, { name: { like: "Fif%" } }] }
          ]
        }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 5 }]);
  });

  it('supports NOT of a relation filter', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { NOT: { posts: { some: {} } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 2 }]);
  });

  it('treats an empty NOT as no restriction', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { NOT: {} }, orderBy: { id: { direction: asc, priority: 1 } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 2 }, { id: 5 }]);
  });

  it('applies the boolean tree to mutations too', async () => {
    const result = await ctx.gql.queryGql(`mutation {
      deletePost(where: { authorId: { eq: 1 }, OR: [{ content: { eq: "1MESSAGE" } }, { content: { eq: "2MESSAGE" } }] }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.deletePost).toEqual([{ id: 1 }, { id: 2 }]);

    const remaining = await ctx.gql.queryGql(`{ postsAggregate { count } }`);
    expect(remaining.data?.postsAggregate).toEqual({ count: 4 });
  });
});

describe.sequential('boolean filter tree (column level)', () => {
  it('ANDs sibling operators with an OR group', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { id: { lte: 1, OR: [{ eq: 1 }, { eq: 2 }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }]);
  });

  it('supports an explicit AND list of operators', async () => {
    const result = await ctx.gql.queryGql(`{
      users(
        where: { id: { AND: [{ gte: 1 }, { lte: 2 }] } }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('supports NOT over an OR of operators', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { id: { NOT: { OR: [{ eq: 1 }, { eq: 2 }] } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 5 }]);
  });
});

describe('boolean filter tree schema shape', () => {
  const input = (name: string) => ctx.schema.getType(name) as GraphQLInputObjectType;

  it('exposes recursive AND, NOT and OR on table filter inputs', () => {
    const filters = input('UserFilters');
    const fields = filters.getFields();

    const orType = fields['OR']!.type as GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>;
    expect(orType).toBeInstanceOf(GraphQLList);
    expect(orType.ofType).toBeInstanceOf(GraphQLNonNull);
    expect(orType.ofType.ofType).toBe(filters);

    const andType = fields['AND']!.type as GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>;
    expect(andType).toBeInstanceOf(GraphQLList);
    expect(andType.ofType.ofType).toBe(filters);

    expect(fields['NOT']!.type).toBe(filters);
  });

  it('exposes recursive AND, NOT and OR on column filter inputs', () => {
    const filter = input('StringFilter');
    const fields = filter.getFields();

    expect((fields['OR']!.type as any).ofType.ofType).toBe(filter);
    expect((fields['AND']!.type as any).ofType.ofType).toBe(filter);
    expect(fields['NOT']!.type).toBe(filter);
  });

  it('no longer generates the parallel FiltersOr / FilterOr types', () => {
    expect(ctx.schema.getType('UserFiltersOr')).toBeUndefined();
    expect(ctx.schema.getType('PostFiltersOr')).toBeUndefined();
    expect(ctx.schema.getType('StringFilterOr')).toBeUndefined();
    expect(ctx.schema.getType('IdFilterOr')).toBeUndefined();
  });
});
