import { GraphQLInputObjectType } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, schema, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-safe-string-operators-${Date.now()}`;

const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5210, DATA_DIR);
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

/** Rows whose names contain LIKE special characters — the injection cases. */
const insertSpecialNames = async () => {
  await ctx.db.insert(schema.Users).values([
    { id: 10, name: '100% real' },
    { id: 11, name: '100x real' },
    { id: 12, name: 'user_name' },
    { id: 13, name: 'userXname' },
    { id: 14, name: 'back\\slash' },
    { id: 15, name: 'backslash' },
  ]);
};

describe.sequential('Safe string operator tests', () => {
  it('startsWith matches literal prefixes', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { startsWith: "Fi" } }, orderBy: { id: { priority: 0, direction: asc } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          { id: 1, name: 'FirstUser' },
          { id: 5, name: 'FifthUser' },
        ],
      },
    });
  });

  it('endsWith matches literal suffixes', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { endsWith: "ondUser" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [{ id: 2, name: 'SecondUser' }],
      },
    });
  });

  it('contains matches literal substrings', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { contains: "cond" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [{ id: 2, name: 'SecondUser' }],
      },
    });
  });

  it('startsWith is case-sensitive on Postgres', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { startsWith: "first" } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [],
      },
    });
  });

  it('a literal % in the search term is not a wildcard', async () => {
    await insertSpecialNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { contains: "100%" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [{ id: 10, name: '100% real' }],
      },
    });
  });

  it('a literal _ in the search term is not a wildcard', async () => {
    await insertSpecialNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { contains: "r_n" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [{ id: 12, name: 'user_name' }],
      },
    });
  });

  it('a literal backslash in the search term matches literally', async () => {
    await insertSpecialNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { contains: "back\\\\sl" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [{ id: 14, name: 'back\\slash' }],
      },
    });
  });

  it('startsWith and endsWith escape wildcards too', async () => {
    await insertSpecialNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				startsWithUnderscore: users(where: { name: { startsWith: "user_" } }) {
					id
					name
				}
				endsWithPercent: users(where: { name: { endsWith: "% real" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        startsWithUnderscore: [{ id: 12, name: 'user_name' }],
        endsWithPercent: [{ id: 10, name: '100% real' }],
      },
    });
  });

  it('iStartsWith, iEndsWith and iContains match case-insensitively', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				iStartsWith: users(where: { name: { iStartsWith: "first" } }) {
					id
					name
				}
				iEndsWith: users(where: { name: { iEndsWith: "ONDUSER" } }) {
					id
					name
				}
				iContains: users(where: { name: { iContains: "SECOND" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        iStartsWith: [{ id: 1, name: 'FirstUser' }],
        iEndsWith: [{ id: 2, name: 'SecondUser' }],
        iContains: [{ id: 2, name: 'SecondUser' }],
      },
    });
  });

  it('case-insensitive variants still escape wildcards', async () => {
    await insertSpecialNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { iContains: "100%" } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [{ id: 10, name: '100% real' }],
      },
    });
  });

  it('safe operators work inside OR', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { name: { OR: [{ startsWith: "First" }, { endsWith: "ondUser" }] } }
					orderBy: { id: { priority: 0, direction: asc } }
				) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          { id: 1, name: 'FirstUser' },
          { id: 2, name: 'SecondUser' },
        ],
      },
    });
  });

  it('safe operators work in relation field filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { id: { eq: 5 } }) {
					id
					posts(where: { content: { startsWith: "2" } }) {
						id
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            id: 5,
            posts: [{ id: 5, content: '2MESSAGE' }],
          },
        ],
      },
    });
  });

  it('raw like keeps its wildcard semantics', async () => {
    await insertSpecialNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { like: "100_ real" } }, orderBy: { id: { priority: 0, direction: asc } }) {
					id
					name
				}
			}
		`);

    // With raw like, _ is a wildcard: both '100%' and '100x' match.
    expect(res).toStrictEqual({
      data: {
        users: [
          { id: 10, name: '100% real' },
          { id: 11, name: '100x real' },
        ],
      },
    });
  });

  it('exposes the safe operators on string filters but not id filters', () => {
    const safeOps = ['startsWith', 'endsWith', 'contains', 'iStartsWith', 'iEndsWith', 'iContains'];

    const stringFilter = ctx.schema.getType('StringFilter');
    expect(stringFilter).toBeInstanceOf(GraphQLInputObjectType);
    const stringFields = Object.keys((stringFilter as GraphQLInputObjectType).getFields());
    for (const op of safeOps) {
      expect(stringFields).toContain(op);
    }

    // The recursive filter tree reuses the filter type itself for OR branches, so the
    // safe operators are available inside OR too.
    const orBranch = (stringFilter as GraphQLInputObjectType).getFields()['OR']!.type as any;
    expect(orBranch.ofType.ofType).toBe(stringFilter);

    const idFilter = ctx.schema.getType('IdFilter');
    expect(idFilter).toBeInstanceOf(GraphQLInputObjectType);
    const idFields = Object.keys((idFilter as GraphQLInputObjectType).getFields());
    for (const op of safeOps) {
      expect(idFields).not.toContain(op);
    }
  });
});
