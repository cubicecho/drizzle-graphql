import type { GraphQLInputObjectType } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, schema, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-case-insensitive-${Date.now()}`;

const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5260, DATA_DIR);
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

/** Rows whose names differ only by case, plus one carrying LIKE wildcards. */
const insertMixedCaseNames = async () => {
  await ctx.db.insert(schema.Users).values([
    { id: 20, name: 'Dan@Example.com' },
    { id: 21, name: 'dan@example.com' },
    { id: 22, name: 'SAM' },
    { id: 23, name: 'Alex' },
    { id: 24, name: '100%_OFF' },
  ]);
};

describe.sequential('Case-insensitive filter tests', () => {
  it('eq folds case when insensitive is set', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { name: { eq: "DAN@EXAMPLE.COM", insensitive: true } }
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
          { id: 20, name: 'Dan@Example.com' },
          { id: 21, name: 'dan@example.com' },
        ],
      },
    });
  });

  it('eq stays case-sensitive without the flag', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { eq: "DAN@EXAMPLE.COM" } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [] } });
  });

  it('insensitive: false leaves the comparison alone', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { eq: "dan@example.com", insensitive: false } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [{ id: 21 }] } });
  });

  it('ne folds case, excluding every casing of the operand', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { id: { gte: 20 }, name: { ne: "dan@example.com", insensitive: true } }
					orderBy: { id: { priority: 0, direction: asc } }
				) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [{ id: 22 }, { id: 23 }, { id: 24 }] } });
  });

  it('inArray matches every candidate regardless of case', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { name: { inArray: ["dan@example.com", "sam", "ALEX"], insensitive: true } }
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
          { id: 20, name: 'Dan@Example.com' },
          { id: 21, name: 'dan@example.com' },
          { id: 22, name: 'SAM' },
          { id: 23, name: 'Alex' },
        ],
      },
    });
  });

  it('notInArray excludes every casing of every candidate', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { id: { gte: 20 }, name: { notInArray: ["DAN@EXAMPLE.COM", "sam"], insensitive: true } }
					orderBy: { id: { priority: 0, direction: asc } }
				) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [{ id: 23 }, { id: 24 }] } });
  });

  it('an empty inArray list still resolves to no rows', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { inArray: [], insensitive: true } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [] } });
  });

  it('the operand keeps its LIKE wildcards literal — insensitive is not ilike', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { name: { eq: "100%_off", insensitive: true } }) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [{ id: 24, name: '100%_OFF' }] } });
  });

  it('ordering comparisons fold case too', async () => {
    await ctx.db.insert(schema.Users).values([
      { id: 30, name: 'apple' },
      { id: 31, name: 'Zebra' },
    ]);

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { id: { gte: 30 }, name: { lt: "b", insensitive: true } }
					orderBy: { id: { priority: 0, direction: asc } }
				) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [{ id: 30, name: 'apple' }] } });
  });

  it('the safe substring operators fold case under the flag', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { name: { startsWith: "dan", insensitive: true } }
					orderBy: { id: { priority: 0, direction: asc } }
				) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [{ id: 20 }, { id: 21 }] } });
  });

  it('like folds case under the flag, keeping its wildcards', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { name: { like: "dan@%", insensitive: true } }
					orderBy: { id: { priority: 0, direction: asc } }
				) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { users: [{ id: 20 }, { id: 21 }] } });
  });

  it('applies to the operators beside it only, not to nested branches', async () => {
    await insertMixedCaseNames();

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(
					where: { name: { insensitive: true, OR: [{ eq: "SAM" }, { eq: "alex", insensitive: true }] } }
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
          { id: 22, name: 'SAM' },
          { id: 23, name: 'Alex' },
        ],
      },
    });
  });

  it('exposes the flag on string filters and withholds it from numeric ones', async () => {
    const stringFilter = ctx.schema.getType('StringFilter') as GraphQLInputObjectType;
    expect(Object.keys(stringFilter.getFields())).toContain('insensitive');

    const intFilter = ctx.schema.getType('IntFilter') as GraphQLInputObjectType;
    expect(Object.keys(intFilter.getFields())).not.toContain('insensitive');
  });
});
