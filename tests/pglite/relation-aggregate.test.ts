import type { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-relation-aggregate-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 4019, DATA_DIR);
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
describe.sequential('relation aggregates', () => {
  it('counts related rows per parent', async () => {
    const result = await ctx.gql.queryGql(`{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
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

  it('computes the full aggregate set per parent', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { id: { eq: 1 } }) {
        id
        postsAggregate {
          count
          avg { id }
          sum { id }
          min { id content }
          max { id content }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      {
        id: 1,
        postsAggregate: {
          count: 4,
          avg: { id: 3 },
          sum: { id: 12 },
          min: { id: 1, content: '1MESSAGE' },
          max: { id: 6, content: '4MESSAGE' },
        },
      },
    ]);
  });

  it('returns count 0 and null aggregates for a parent with no related rows', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { id: { eq: 2 } }) {
        postsAggregate {
          count
          avg { id }
          min { content }
          max { content }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      {
        postsAggregate: {
          count: 0,
          avg: { id: null },
          min: { content: null },
          max: { content: null },
        },
      },
    ]);
  });

  it('applies the where argument to the related rows only', async () => {
    const result = await ctx.gql.queryGql(`{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        postsAggregate(where: { content: { eq: "1MESSAGE" } }) { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      { id: 1, postsAggregate: { count: 1 } },
      { id: 2, postsAggregate: { count: 0 } },
      { id: 5, postsAggregate: { count: 1 } },
    ]);
  });

  it('accepts relation filters inside the where argument', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { id: { eq: 1 } }) {
        postsAggregate(where: { author: { name: { eq: "SecondUser" } } }) { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ postsAggregate: { count: 0 } }]);
  });

  it('keeps differently-filtered aliases of the same field independent', async () => {
    const result = await ctx.gql.queryGql(`{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        all: postsAggregate { count }
        firstMessage: postsAggregate(where: { content: { eq: "1MESSAGE" } }) { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      { id: 1, all: { count: 4 }, firstMessage: { count: 1 } },
      { id: 2, all: { count: 0 }, firstMessage: { count: 0 } },
      { id: 5, all: { count: 2 }, firstMessage: { count: 1 } },
    ]);
  });

  it('works alongside the relation itself being selected', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { id: { eq: 5 } }) {
        posts(orderBy: { id: { direction: asc, priority: 1 } }) { id }
        postsAggregate { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      {
        posts: [{ id: 4 }, { id: 5 }],
        postsAggregate: { count: 2 },
      },
    ]);
  });

  it('aggregates a to-many relation reached through another table', async () => {
    const result = await ctx.gql.queryGql(`{
      customers(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        postsAggregate { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.customers).toEqual([
      { id: 1, postsAggregate: { count: 4 } },
      { id: 2, postsAggregate: { count: 0 } },
    ]);
  });

  it('exposes the per-column counts on a relation aggregate', async () => {
    const result = await ctx.gql.queryGql(`{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        postsAggregate {
          countNonNull { content }
          countDistinct { content }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      { id: 1, postsAggregate: { countNonNull: { content: 4 }, countDistinct: { content: 4 } } },
      { id: 2, postsAggregate: { countNonNull: { content: 0 }, countDistinct: { content: 0 } } },
      { id: 5, postsAggregate: { countNonNull: { content: 2 }, countDistinct: { content: 2 } } },
    ]);
  });

  it('aggregates relations on a delete mutation payload', async () => {
    // `Posts.authorId` has no foreign key, so the posts outlive the deleted author.
    const result = await ctx.gql.queryGql(`mutation {
      deleteUsers(where: { id: { eq: 5 } }) {
        id
        postsAggregate { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.deleteUsers).toEqual([{ id: 5, postsAggregate: { count: 2 } }]);
  });

  // The parsed selection and the batch key are derived once per field per request, so two
  // aliases of the same relation aggregate must stay apart: they are separate fields, with
  // separate args and separate selections, even though they name one relation.
  it('keeps aliases of the same aggregate apart when their filters differ', async () => {
    const result = await ctx.gql.queryGql(`{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        all: postsAggregate { count }
        early: postsAggregate(where: { id: { lt: 4 } }) { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([
      { id: 1, all: { count: 4 }, early: { count: 3 } },
      { id: 2, all: { count: 0 }, early: { count: 0 } },
      { id: 5, all: { count: 2 }, early: { count: 0 } },
    ]);
  });

  it('keeps aliases of the same aggregate apart when their selections differ', async () => {
    const result = await ctx.gql.queryGql(`{
      users(where: { id: { eq: 1 } }) {
        counted: postsAggregate { count }
        summed: postsAggregate { sum { id } }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.users).toEqual([{ counted: { count: 4 }, summed: { sum: { id: 12 } } }]);
  });

  describe('schema shape', () => {
    const type = (name: string) => (ctx.entities.types as unknown as Record<string, GraphQLObjectType>)[name]!;

    it('adds an aggregate field for to-many relations only', () => {
      const fields = type('User').getFields();

      expect(fields['postsAggregate']).toBeDefined();
      // `customer` is a to-one relation — nothing to aggregate over.
      expect(fields['customerAggregate']).toBeUndefined();
    });

    it('reuses the target table root aggregate type', () => {
      const field = type('User').getFields()['postsAggregate']!;
      const fieldType = (field.type as GraphQLNonNull<GraphQLObjectType>).ofType;

      expect(fieldType).toBe(type('PostAggregate'));
      expect(field.args.map((arg) => arg.name)).toEqual(['where']);
    });
  });
});
