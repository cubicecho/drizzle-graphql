import type { GraphQLEnumType, GraphQLInputObjectType } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-order-by-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5230, DATA_DIR);
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

// Seed recap: user 1 (FirstUser, email set) wrote posts 1,2,3,6; user 5 (FifthUser, no
// email) wrote posts 4,5; user 2 (SecondUser, no email) wrote none. Post contents:
// 1/4 = 1MESSAGE, 2/5 = 2MESSAGE, 3 = 3MESSAGE, 6 = 4MESSAGE.
describe.sequential('orderBy through to-one relations and nulls first/last', () => {
  describe('SDL shape', () => {
    it('adds to-one relation fields to the OrderBy input, but not to-many ones', () => {
      const postOrder = ctx.schema.getType('PostOrderBy') as GraphQLInputObjectType;
      expect(postOrder).toBeDefined();

      const postOrderFields = postOrder.getFields();
      expect(postOrderFields['author']).toBeDefined();
      expect(postOrderFields['author']!.type.toString()).toBe('UserOrderBy');
      expect(postOrderFields['customer']).toBeDefined();
      expect(postOrderFields['customer']!.type.toString()).toBe('CustomerOrderBy');

      const userOrder = ctx.schema.getType('UserOrderBy') as GraphQLInputObjectType;
      const userOrderFields = userOrder.getFields();
      // To-one relation is present; the to-many `posts` relation must not be.
      expect(userOrderFields['customer']).toBeDefined();
      expect(userOrderFields['customer']!.type.toString()).toBe('CustomerOrderBy');
      expect(userOrderFields['posts']).toBeUndefined();
      // Columns keep their InnerOrder shape.
      expect(userOrderFields['name']!.type.toString()).toBe('InnerOrder');
    });

    it('adds an optional nulls field of enum OrderNulls to InnerOrder', () => {
      const innerOrder = ctx.schema.getType('InnerOrder') as GraphQLInputObjectType;
      const fields = innerOrder.getFields();

      expect(fields['direction']!.type.toString()).toBe('OrderDirection!');
      expect(fields['priority']!.type.toString()).toBe('Int!');
      expect(fields['nulls']).toBeDefined();
      expect(fields['nulls']!.type.toString()).toBe('OrderNulls');

      const orderNulls = ctx.schema.getType('OrderNulls') as GraphQLEnumType;
      expect(orderNulls.getValues().map((v) => v.name)).toEqual(['first', 'last']);
    });
  });

  describe('ordering by a to-one relation column', () => {
    it('orders a list by the related row ascending', async () => {
      const result = await ctx.gql.queryGql(`{
        posts(orderBy: {
          author: { name: { direction: asc, priority: 2 } }
          id: { direction: asc, priority: 1 }
        }) { id }
      }`);

      expect(result.errors).toBeUndefined();
      // FifthUser < FirstUser, so user 5's posts come first.
      expect(result.data?.posts).toEqual([{ id: 4 }, { id: 5 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }]);
    });

    it('orders a list by the related row descending', async () => {
      const result = await ctx.gql.queryGql(`{
        posts(orderBy: {
          author: { name: { direction: desc, priority: 2 } }
          id: { direction: asc, priority: 1 }
        }) { id }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data?.posts).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }, { id: 4 }, { id: 5 }]);
    });

    it('interleaves a relation column with a same-table column via priority', async () => {
      const result = await ctx.gql.queryGql(`{
        posts(orderBy: {
          content: { direction: desc, priority: 2 }
          author: { name: { direction: asc, priority: 1 } }
        }) { id }
      }`);

      expect(result.errors).toBeUndefined();
      // content desc groups: 4MESSAGE(6), 3MESSAGE(3), 2MESSAGE(2,5), 1MESSAGE(1,4);
      // ties break by author name asc (FifthUser before FirstUser).
      expect(result.data?.posts).toEqual([{ id: 6 }, { id: 3 }, { id: 5 }, { id: 2 }, { id: 4 }, { id: 1 }]);
    });

    it('works together with selecting the relation itself (eager RQB path)', async () => {
      const result = await ctx.gql.queryGql(`{
        posts(orderBy: {
          author: { name: { direction: asc, priority: 2 } }
          id: { direction: asc, priority: 1 }
        }) {
          id
          author { name }
        }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data?.posts).toEqual([
        { id: 4, author: { name: 'FifthUser' } },
        { id: 5, author: { name: 'FifthUser' } },
        { id: 1, author: { name: 'FirstUser' } },
        { id: 2, author: { name: 'FirstUser' } },
        { id: 3, author: { name: 'FirstUser' } },
        { id: 6, author: { name: 'FirstUser' } },
      ]);
    });

    it('supports nulls on a relation column', async () => {
      // FirstUser has an email; FifthUser does not — so the subquery value is NULL for
      // posts 4 and 5. nulls: first pulls them ahead of the non-null group.
      const result = await ctx.gql.queryGql(`{
        posts(orderBy: {
          author: { email: { direction: asc, priority: 2, nulls: first } }
          id: { direction: asc, priority: 1 }
        }) { id }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data?.posts).toEqual([{ id: 4 }, { id: 5 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }]);
    });

    it('rejects combining distinct with relation ordering instead of silently ignoring it', async () => {
      const result = await ctx.gql.queryGql(`{
        posts(distinct: [content], orderBy: { author: { name: { direction: asc, priority: 1 } } }) { id }
      }`);

      expect(result.errors).toBeDefined();
      expect(result.errors![0]!.message).toContain('ordering through a relation');
    });
  });

  describe('nulls first/last', () => {
    it('puts nulls first on an ascending optional column', async () => {
      // Postgres defaults to nulls LAST on asc — this only passes if NULLS FIRST is emitted.
      const result = await ctx.gql.queryGql(`{
        users(orderBy: {
          email: { direction: asc, priority: 2, nulls: first }
          id: { direction: asc, priority: 1 }
        }) { id email }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data?.users).toEqual([
        { id: 2, email: null },
        { id: 5, email: null },
        { id: 1, email: 'userOne@notmail.com' },
      ]);
    });

    it('puts nulls last on a descending optional column', async () => {
      // Postgres defaults to nulls FIRST on desc — this only passes if NULLS LAST is emitted.
      const result = await ctx.gql.queryGql(`{
        users(orderBy: {
          email: { direction: desc, priority: 2, nulls: last }
          id: { direction: asc, priority: 1 }
        }) { id email }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data?.users).toEqual([
        { id: 1, email: 'userOne@notmail.com' },
        { id: 2, email: null },
        { id: 5, email: null },
      ]);
    });

    it('applies nulls ordering inside a relation list argument', async () => {
      const result = await ctx.gql.queryGql(`{
        user(where: { id: { eq: 1 } }) {
          id
          posts(orderBy: { content: { direction: asc, priority: 1, nulls: first } }) { id }
        }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data?.user).toEqual({ id: 1, posts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }] });
    });
  });
});
