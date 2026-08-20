import type { GraphQLInputObjectType } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-relation-filters-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 4018, DATA_DIR);
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
// user 2 (SecondUser) wrote none. Customers 1 and 2 belong to users 1 and 2.
describe.sequential('relation filters', () => {
  it('filters a table by a to-many relation with `some`', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { posts: { some: { content: { eq: "3MESSAGE" } } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
        id
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }]);
  });

  it('filters a table by a to-many relation with `none`', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { posts: { none: {} } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 2 }]);
  });

  it('filters a table by a to-many relation with `every`', async () => {
    // Users 1 and 5 both have posts that are not "1MESSAGE"; user 2 matches vacuously.
    const result = await ctx.gql.queryGql(`{
      users(where: { posts: { every: { content: { eq: "1MESSAGE" } } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 2 }]);
  });

  it('combines several match modes on one relation', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: {
        posts: {
          some: { content: { eq: "1MESSAGE" } }
          none: { content: { eq: "3MESSAGE" } }
        }
      }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 5 }]);
  });

  it('filters a table by a to-one relation', async () => {
    const result = await ctx.gql.queryGql(`{
      posts(where: { author: { name: { eq: "FifthUser" } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
        id
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.posts).toEqual([{ id: 4 }, { id: 5 }]);
  });

  it('filters through nested relations', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { posts: { some: { author: { name: { eq: "FirstUser" } } } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }]);
  });

  it('ANDs a relation filter with column filters', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { name: { like: "F%" }, posts: { some: { content: { eq: "2MESSAGE" } } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
        id
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 5 }]);
  });

  it('supports relation filters inside OR', async () => {
    const result = await ctx.gql.queryGql(`{
      users(
        where: { OR: [{ name: { eq: "SecondUser" } }, { posts: { some: { content: { eq: "3MESSAGE" } } } }] }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('applies relation filters to single queries', async () => {
    const result = await ctx.gql.queryGql(`{
      customer(where: { user: { name: { eq: "SecondUser" } } }) { id address }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.customer).toEqual({ id: 2, address: 'AdTwo' });
  });

  it('applies relation filters to aggregate queries', async () => {
    const result = await ctx.gql.queryGql(`{
      usersAggregate(where: { posts: { some: {} } }) { count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.usersAggregate).toEqual({ count: 2 });
  });

  it('applies relation filters to a relation field argument', async () => {
    const result = await ctx.gql.queryGql(`{
      user(where: { id: { eq: 1 } }) {
        id
        posts(where: { author: { name: { eq: "SecondUser" } } }) { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.user).toEqual({ id: 1, posts: [] });
  });

  it('applies relation filters to delete mutations', async () => {
    const result = await ctx.gql.queryGql(`mutation {
      deletePost(where: { author: { name: { eq: "FifthUser" } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.deletePost).toEqual([{ id: 4 }, { id: 5 }]);

    const remaining = await ctx.gql.queryGql(`{ postsAggregate { count } }`);
    expect(remaining.data?.postsAggregate).toEqual({ count: 4 });
  });

  it('applies relation filters to update mutations', async () => {
    const result = await ctx.gql.queryGql(`mutation {
      updatePost(set: { content: "UPDATED" }, where: { author: { name: { eq: "FifthUser" } } }) { id content }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.updatePost).toEqual([
      { id: 4, content: 'UPDATED' },
      { id: 5, content: 'UPDATED' },
    ]);
  });

  it('an empty relation filter does not restrict the result', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { posts: { some: {} } }, orderBy: { id: { direction: asc, priority: 1 } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ id: 1 }, { id: 5 }]);
  });

  describe('schema shape', () => {
    // `entities.inputs` is keyed by the real GraphQL type name, which the typeNameMapper
    // singularises — the static type can't know that, so index it as a plain record.
    const input = (name: string) => (ctx.entities.inputs as unknown as Record<string, GraphQLInputObjectType>)[name]!;

    it('exposes to-many relations as a some/none/every wrapper', () => {
      const fields = input('UserFilters').getFields();

      expect(fields['posts']).toBeDefined();
      const postsFilter = fields['posts']!.type as GraphQLInputObjectType;
      expect(postsFilter.name).toBe('PostListRelationFilter');
      expect(Object.keys(postsFilter.getFields())).toEqual(['some', 'none', 'every']);
      expect(postsFilter.getFields()['some']!.type).toBe(input('PostFilters'));
    });

    it('exposes to-one relations as the target filter input directly', () => {
      const fields = input('PostFilters').getFields();

      expect(fields['author']!.type).toBe(input('UserFilters'));
      expect(fields['customer']!.type).toBe(input('CustomerFilters'));
    });

    it('leaves relation fields off tables that have no relations', () => {
      const fields = input('TagFilters').getFields();

      expect(Object.keys(fields).sort()).toEqual(['OR', 'description', 'id', 'name']);
    });

    it('offers relation filters in the OR variant too', () => {
      const orField = input('UserFilters').getFields()['OR']!;
      const orType = (orField.type as any).ofType.ofType as GraphQLInputObjectType;

      expect(orType.name).toBe('UserFiltersOr');
      expect(orType.getFields()['posts']).toBeDefined();
    });
  });
});
