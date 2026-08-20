import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-arguments-${Date.now()}`;

const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 4011, DATA_DIR);
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

describe.sequential('Arguments tests', async () => {
  it('Order by', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(
					orderBy: { authorId: { priority: 1, direction: desc }, content: { priority: 0, direction: asc } }
				) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        posts: [
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },

          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
          },
        ],
      },
    });
  });

  it('Order by on single', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				post(
					orderBy: { authorId: { priority: 1, direction: desc }, content: { priority: 0, direction: asc } }
				) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        post: {
          id: 4,
          authorId: 5,
          content: '1MESSAGE',
        },
      },
    });
  });

  it('Offset & limit', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(offset: 1, limit: 2) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        posts: [
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
        ],
      },
    });
  });

  it('Offset on single', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				post(offset: 1) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        post: {
          id: 2,
          authorId: 1,
          content: '2MESSAGE',
        },
      },
    });
  });

  it('Defaults an unordered paginated query to primary key order', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 3) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { posts: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
  });

  it('Defaults an unordered single query to primary key order', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				post {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { post: { id: 1 } } });
  });

  it('Keeps an explicit orderBy over the primary key default', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 3, orderBy: { id: { direction: desc, priority: 1 } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { posts: [{ id: 6 }, { id: 5 }, { id: 4 }] } });
  });

  it('Filters - top level AND', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(where: { id: { inArray: [2, 3, 4, 5, 6] }, authorId: { ne: 5 }, content: { ne: "3MESSAGE" } }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        posts: [
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
          },
        ],
      },
    });
  });

  it('Filters - top level OR', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        posts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
        ],
      },
    });
  });

  it('Update filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updatePost(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }, set: { content: "UPDATED" }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updatePost: [
          {
            id: 1,
            authorId: 1,
            content: 'UPDATED',
          },
          {
            id: 2,
            authorId: 1,
            content: 'UPDATED',
          },
          {
            id: 3,
            authorId: 1,
            content: 'UPDATED',
          },
          {
            id: 4,
            authorId: 5,
            content: 'UPDATED',
          },
          {
            id: 5,
            authorId: 5,
            content: 'UPDATED',
          },
        ],
      },
    });
  });

  it('Delete filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePost(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deletePost: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
        ],
      },
    });
  });

  it('Relations orderBy', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					id
					posts(orderBy: { id: { priority: 1, direction: desc } }) {
						id
						authorId
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            id: 1,
            posts: [
              {
                id: 6,
                authorId: 1,
                content: '4MESSAGE',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
              },
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
              {
                id: 1,
                authorId: 1,
                content: '1MESSAGE',
              },
            ],
          },
          {
            id: 2,
            posts: [],
          },
          {
            id: 5,
            posts: [
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
              {
                id: 4,
                authorId: 5,
                content: '1MESSAGE',
              },
            ],
          },
        ],
      },
    });
  });

  it('Relations offset & limit', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					id
					posts(offset: 1, limit: 2) {
						id
						authorId
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            id: 1,
            posts: [
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
              },
            ],
          },
          {
            id: 2,
            posts: [],
          },
          {
            id: 5,
            posts: [
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
            ],
          },
        ],
      },
    });
  });

  it('Relations filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					id
					posts(where: { content: { ilike: "2%" } }) {
						id
						authorId
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            id: 1,
            posts: [
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
            ],
          },
          {
            id: 2,
            posts: [],
          },
          {
            id: 5,
            posts: [
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
            ],
          },
        ],
      },
    });
  });
});
