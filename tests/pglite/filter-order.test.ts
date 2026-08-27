import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import * as schema from '../schema/pg';
import { setupTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-filter-order-${Date.now()}`;
let pglite: PGlite;
let db: any;

const typeNameMapper = (name: string) =>
  (
    ({
      Users: { singular: 'user', plural: 'users' },
      Posts: { singular: 'post', plural: 'posts' },
      Customers: { singular: 'customer', plural: 'customers' },
      Tags: { singular: 'tag', plural: 'tags' },
    }) as Record<string, { singular: string; plural: string }>
  )[name];

const buildWith = (eagerLoadRelations?: boolean): GraphQLSchema =>
  buildSchema(db, {
    typeNameMapper,
    suffixes: { single: '', list: '' },
    ...(eagerLoadRelations === undefined ? {} : { eagerLoadRelations }),
  }).schema;

// A fresh context per call so the request-scoped relation batch loaders behave as they would
// in a real request.
const run = (gqlSchema: GraphQLSchema, source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations: schema.relations, logger: !!process.env['LOG_SQL'] });
  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  await setupTables({ db } as any);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

// Seed recap: users 1, 2 and 5; posts 1,2,3,6 belong to user 1 and posts 4,5 to user 5.
describe.sequential('matchFilterOrder', () => {
  const ORDER = (extra = '') => `orderBy: { id: { direction: asc, priority: 1, matchFilterOrder: true${extra} } }`;

  it('returns the rows in the order the inArray list gave them', async () => {
    const gqlSchema = buildWith();
    const res = await run(gqlSchema, `{ posts(where: { id: { inArray: [3, 1, 6] } }, ${ORDER()}) { id } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data as any).posts.map((row: any) => row.id)).toStrictEqual([3, 1, 6]);
  });

  it('falls back to the column order without the flag', async () => {
    // The same query, minus `matchFilterOrder` — this is what the flag is there to change.
    const gqlSchema = buildWith();
    const res = await run(
      gqlSchema,
      `{ posts(where: { id: { inArray: [3, 1, 6] } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).posts.map((row: any) => row.id)).toStrictEqual([1, 3, 6]);
  });

  it('reverses the list under `desc`', async () => {
    const gqlSchema = buildWith();
    const res = await run(
      gqlSchema,
      `{ posts(where: { id: { inArray: [3, 1, 6] } },
               orderBy: { id: { direction: desc, priority: 1, matchFilterOrder: true } }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).posts.map((row: any) => row.id)).toStrictEqual([6, 1, 3]);
  });

  it('takes the list through a variable', async () => {
    const gqlSchema = buildWith();
    const res = await run(
      gqlSchema,
      `query ($ids: [Int!]) { posts(where: { id: { inArray: $ids } }, ${ORDER()}) { id } }`,
      { ids: [6, 2, 4] },
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).posts.map((row: any) => row.id)).toStrictEqual([6, 2, 4]);
  });

  it('interleaves with the other ordering keys by priority', async () => {
    // authorId ordered by its own list first, then id ascending inside each group.
    const gqlSchema = buildWith();
    const res = await run(
      gqlSchema,
      `{ posts(where: { authorId: { inArray: [5, 1] } },
               orderBy: {
                 authorId: { direction: asc, priority: 2, matchFilterOrder: true },
                 id: { direction: asc, priority: 1 }
               }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).posts.map((row: any) => row.id)).toStrictEqual([4, 5, 1, 2, 3, 6]);
  });

  it('offsets and limits the list order rather than the column order', async () => {
    const gqlSchema = buildWith();
    const res = await run(
      gqlSchema,
      `{ posts(where: { id: { inArray: [3, 1, 6, 2] } }, ${ORDER()}, limit: 2) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).posts.map((row: any) => row.id)).toStrictEqual([3, 1]);
  });

  for (const [label, eager] of [
    ['eagerly loaded', true],
    ['lazily resolved', false],
  ] as const) {
    it(`orders a relation field by its own list when ${label}`, async () => {
      const gqlSchema = buildWith(eager);
      const res = await run(
        gqlSchema,
        `{ user(where: { id: { eq: 1 } }) {
             id
             posts(where: { id: { inArray: [6, 2, 3] } }, ${ORDER()}) { id }
           } }`,
      );

      expect(res.errors).toBeUndefined();
      expect((res.data as any).user.posts.map((row: any) => row.id)).toStrictEqual([6, 2, 3]);
    });

    it(`orders a paginated relation field by its own list when ${label}`, async () => {
      // The per-parent slice goes through a window function, which builds its own ORDER BY.
      const gqlSchema = buildWith(eager);
      const res = await run(
        gqlSchema,
        `{ user(where: { id: { eq: 1 } }) {
             id
             posts(where: { id: { inArray: [6, 2, 3] } }, ${ORDER()}, limit: 2) { id }
           } }`,
      );

      expect(res.errors).toBeUndefined();
      expect((res.data as any).user.posts.map((row: any) => row.id)).toStrictEqual([6, 2]);
    });
  }

  describe('what it refuses', () => {
    it('needs an inArray filter on the same column', async () => {
      const gqlSchema = buildWith();
      const res = await run(gqlSchema, `{ posts(where: { id: { gt: 0 } }, ${ORDER()}) { id } }`);

      expect(res.errors?.[0]?.message).toMatch(
        /ORDER BY id: 'matchFilterOrder' needs an 'inArray' filter on the same column/,
      );
    });

    it('cannot be paged with a cursor', async () => {
      const gqlSchema = buildWith();
      const res = await run(
        gqlSchema,
        `{ posts(where: { id: { inArray: [3, 1] } }, ${ORDER()}, after: "whatever") { id } }`,
      );

      expect(res.errors?.[0]?.message).toMatch(/'after' cannot be combined with 'matchFilterOrder'/);
    });

    it('resolves the cursor field to null instead of failing the query', async () => {
      const gqlSchema = buildWith();
      const res = await run(gqlSchema, `{ posts(where: { id: { inArray: [3, 1] } }, ${ORDER()}) { id cursor } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toEqual([
        { id: 3, cursor: null },
        { id: 1, cursor: null },
      ]);
    });

    it('cannot be combined with distinct', async () => {
      const gqlSchema = buildWith();
      const res = await run(
        gqlSchema,
        `{ posts(where: { id: { inArray: [3, 1] } }, ${ORDER()}, distinct: [authorId]) { id } }`,
      );

      expect(res.errors?.[0]?.message).toMatch(/ORDER BY id: 'matchFilterOrder' is not supported in this query/);
    });

    it('cannot order through a relation', async () => {
      const gqlSchema = buildWith();
      const res = await run(
        gqlSchema,
        `{ posts(where: { id: { inArray: [3, 1] } },
                 orderBy: { author: { id: { direction: asc, priority: 1, matchFilterOrder: true } } }) { id } }`,
      );

      expect(res.errors?.[0]?.message).toMatch(/ORDER BY id: 'matchFilterOrder' is not supported through a relation/);
    });
  });
});
