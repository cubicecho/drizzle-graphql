import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, schema, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-cursor-pagination-${Date.now()}`;

const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5250, DATA_DIR);
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

/**
 * Pages through a list query by feeding each page's last `cursor` back as `after`,
 * until an empty page comes back. Returns the pages of rows.
 */
const collectPages = async (buildQuery: (afterArg: string) => string): Promise<any[][]> => {
  const pages: any[][] = [];
  let after: string | null = null;

  for (let i = 0; i < 25; i++) {
    const res = await ctx.gql.queryGql(buildQuery(after === null ? '' : `after: "${after}", `));
    expect(res.errors).toBeUndefined();
    const rows = Object.values(res.data as Record<string, any[]>)[0]!;
    if (!rows.length) {
      return pages;
    }
    pages.push(rows);
    const lastCursor = rows[rows.length - 1].cursor;
    expect(typeof lastCursor).toBe('string');
    after = lastCursor;
  }

  throw new Error('cursor pagination did not terminate');
};

describe.sequential('Cursor (keyset) pagination', () => {
  it('pages through the whole table in default PK order with no duplicates or gaps', async () => {
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				posts(${afterArg}limit: 2) {
					id
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('every row of a page carries its own distinct cursor', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 3) {
					id
					cursor
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    const cursors = res.data.posts.map((row: any) => row.cursor);
    expect(cursors).toHaveLength(3);
    for (const cursor of cursors) {
      expect(typeof cursor).toBe('string');
      expect(cursor.length).toBeGreaterThan(0);
    }
    expect(new Set(cursors).size).toBe(3);
  });

  it('pages under a custom ascending orderBy, tiebroken by primary key', async () => {
    // content asc; '1MESSAGE' and '2MESSAGE' each appear twice, so the PK tiebreak decides.
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				posts(${afterArg}limit: 2, orderBy: { content: { priority: 1, direction: asc } }) {
					id
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });

  it('pages under a custom descending orderBy, tiebroken by primary key', async () => {
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				posts(${afterArg}limit: 2, orderBy: { content: { priority: 1, direction: desc } }) {
					id
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([
      [6, 3],
      [2, 5],
      [1, 4],
    ]);
  });

  it('pages under a mixed-direction orderBy (asc + desc)', async () => {
    // content asc, then authorId desc, then the PK tiebreak — the expanded lexicographic
    // predicate has to flip its comparison per key.
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				posts(${afterArg}limit: 2, orderBy: {
					content: { priority: 2, direction: asc }
					authorId: { priority: 1, direction: desc }
				}) {
					id
					authorId
					content
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([
      [4, 1],
      [5, 2],
      [3, 6],
    ]);
  });

  it('a row inserted mid-scroll does not shift the window', async () => {
    const firstPage = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 2) {
					id
					cursor
				}
			}
		`);
    expect(firstPage.errors).toBeUndefined();
    expect(firstPage.data.posts.map((row: any) => row.id)).toStrictEqual([1, 2]);
    const after = firstPage.data.posts[1].cursor;

    // A row landing before the current position: offset pagination would now re-serve id 2.
    await ctx.db.insert(schema.Posts).values([{ id: 0, authorId: 1, content: '0MESSAGE' }]);

    const secondPage = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(after: "${after}", limit: 2) {
					id
					cursor
				}
			}
		`);
    expect(secondPage.errors).toBeUndefined();
    expect(secondPage.data.posts.map((row: any) => row.id)).toStrictEqual([3, 4]);
  });

  it('round-trips date values through the cursor', async () => {
    // All users share createdAt, so the cursor carries a timestamp AND relies on the PK
    // tiebreak to make progress — a lossy date encoding would repeat or skip rows.
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				users(${afterArg}limit: 1, orderBy: { createdAt: { priority: 1, direction: asc } }) {
					id
					createdAt
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([[1], [2], [5]]);
    expect(pages[0]![0]!.createdAt).toBe('2024-04-02T06:44:41.785Z');
  });

  it('pages across NULL values in the ordered column', async () => {
    // email is NULL for users 2 and 5. In PostgreSQL, DESC puts NULLs first, so the scan
    // starts inside the NULL group and has to cross into the non-NULL rows.
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				users(${afterArg}limit: 1, orderBy: { email: { priority: 1, direction: desc } }) {
					id
					email
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([[2], [5], [1]]);
  });

  it('pages under a nulls: last override, crossing from non-NULL into the NULL group', async () => {
    // PostgreSQL DESC natively puts NULLs first; the override flips them to the end, so the
    // keyset predicate has to agree with the overridden placement or rows repeat/vanish.
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				users(${afterArg}limit: 1, orderBy: { email: { priority: 1, direction: desc, nulls: last } }) {
					id
					email
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([[1], [2], [5]]);
  });

  it('rejects a cursor issued under a different nulls placement', async () => {
    const firstPage = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(limit: 1, orderBy: { email: { priority: 1, direction: desc } }) {
					id
					cursor
				}
			}
		`);
    expect(firstPage.errors).toBeUndefined();
    const after = firstPage.data.users[0].cursor;

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(after: "${after}", limit: 1, orderBy: { email: { priority: 1, direction: desc, nulls: last } }) {
					id
				}
			}
		`);

    expect(res.data ?? undefined).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('different ordering');
  });

  it('rejects after combined with an orderBy through a relation', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(after: "anything", limit: 2, orderBy: { author: { name: { direction: asc, priority: 1 } } }) {
					id
				}
			}
		`);

    expect(res.data ?? undefined).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('orders through a relation');
  });

  it('resolves cursor to null under a relation orderBy while the ordering still applies', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(orderBy: {
					author: { name: { direction: asc, priority: 2 } }
					id: { direction: asc, priority: 1 }
				}) {
					id
					cursor
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    // Same ordering as the plain relation-orderBy case: FifthUser's posts first.
    expect(res.data?.posts.map((row: any) => row.id)).toStrictEqual([4, 5, 1, 2, 3, 6]);
    expect(res.data?.posts.every((row: any) => row.cursor === null)).toBe(true);
  });

  it('rejects a malformed cursor with a GraphQL error', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(after: "not-a-real-cursor!!!", limit: 2) {
					id
				}
			}
		`);

    expect(res.data ?? undefined).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('Invalid cursor');
  });

  it('rejects a syntactically valid cursor whose payload is not a cursor', async () => {
    const bogus = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64url');
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(after: "${bogus}", limit: 2) {
					id
				}
			}
		`);

    expect(res.data ?? undefined).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('Invalid cursor');
  });

  it('rejects a cursor issued under a different orderBy', async () => {
    const firstPage = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 1) {
					id
					cursor
				}
			}
		`);
    expect(firstPage.errors).toBeUndefined();
    const after = firstPage.data.posts[0].cursor;

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(after: "${after}", limit: 1, orderBy: { content: { priority: 1, direction: asc } }) {
					id
				}
			}
		`);

    expect(res.data ?? undefined).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain('different ordering');
  });

  it('rejects combining after with distinct', async () => {
    const firstPage = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 1) {
					id
					cursor
				}
			}
		`);
    expect(firstPage.errors).toBeUndefined();
    const after = firstPage.data.posts[0].cursor;

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(after: "${after}", distinct: [content]) {
					id
				}
			}
		`);

    expect(res.data ?? undefined).toBeUndefined();
    expect(res.errors?.[0]?.message).toContain("'after' cannot be combined with 'distinct'");
  });

  it('cursor pagination composes with where filters', async () => {
    const pages = await collectPages(
      (afterArg) => /* GraphQL */ `
			{
				posts(${afterArg}limit: 2, where: { authorId: { eq: 1 } }) {
					id
					cursor
				}
			}
		`,
    );

    expect(pages.map((page) => page.map((row) => row.id))).toStrictEqual([
      [1, 2],
      [3, 6],
    ]);
  });
});
