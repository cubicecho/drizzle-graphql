import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, type DefaultsConfig } from '@/index';
import * as schema from '../schema/pg';
import { setupTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-default-order-by-${Date.now()}`;
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

const buildWith = (defaults?: DefaultsConfig, eagerLoadRelations?: boolean): GraphQLSchema =>
  buildSchema(db, {
    typeNameMapper,
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
    ...(defaults ? { defaults } : {}),
    ...(eagerLoadRelations === undefined ? {} : { eagerLoadRelations }),
  }).schema;

// A fresh context object per call so the request-scoped relation batch loaders behave as they
// would in a real request.
const run = (gqlSchema: GraphQLSchema, source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });

const ids = (rows: any) => (rows as any[]).map((row) => row.id);

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
});

// Seed recap: posts 1..6, contents 1MESSAGE, 2MESSAGE, 3MESSAGE, 1MESSAGE, 2MESSAGE, 4MESSAGE;
// posts 1, 2, 3 and 6 belong to user 1, posts 4 and 5 to user 5, and user 2 has none.
describe.sequential('default orderBy', () => {
  const postsDesc: DefaultsConfig = { Posts: { orderBy: { id: 'desc' } } };

  describe('root queries', () => {
    it('orders a list that asked for no ordering', async () => {
      const res = await run(buildWith(postsDesc), `{ posts { id } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).posts)).toEqual([6, 5, 4, 3, 2, 1]);
    });

    it('leaves a list alone when the table has no default', async () => {
      // Only Posts is configured, so the users list is emitted exactly as it was before.
      const res = await run(buildWith(postsDesc), `{ users { id } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).users).sort()).toEqual([1, 2, 5]);
    });

    it("is replaced outright by the request's own orderBy", async () => {
      const res = await run(buildWith(postsDesc), `{ posts(orderBy: { id: { direction: asc, priority: 1 } }) { id } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).posts)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('is suppressed by an empty orderBy', async () => {
      // `orderBy: {}` is still an argument, so the default does not apply — what is left is the
      // primary-key tiebreak every paginated query gets.
      const res = await run(buildWith(postsDesc), `{ posts(orderBy: {}, limit: 3) { id } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).posts)).toEqual([1, 2, 3]);
    });

    it('orders a single query', async () => {
      const res = await run(buildWith(postsDesc), `{ post { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).post.id).toBe(6);
    });

    it('lets a single query override it', async () => {
      const res = await run(buildWith(postsDesc), `{ post(orderBy: { id: { direction: asc, priority: 1 } }) { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).post.id).toBe(1);
    });

    it('composes with where and offset', async () => {
      const res = await run(buildWith(postsDesc), `{ posts(where: { authorId: { eq: 1 } }, offset: 1) { id } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).posts)).toEqual([3, 2, 1]);
    });
  });

  describe('multiple columns', () => {
    const multi: DefaultsConfig = { Posts: { orderBy: { content: 'asc', id: 'desc' } } };

    it('sorts by the shorthand entries in the order they are written', async () => {
      const res = await run(buildWith(multi), `{ posts { id content } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).posts)).toEqual([4, 1, 5, 2, 3, 6]);
    });

    it('sorts by explicit priority, highest first', async () => {
      const withPriority: DefaultsConfig = {
        Posts: {
          orderBy: {
            id: { direction: 'desc', priority: 1 },
            content: { direction: 'asc', priority: 2 },
          },
        },
      };
      const res = await run(buildWith(withPriority), `{ posts { id content } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).posts)).toEqual([4, 1, 5, 2, 3, 6]);
    });
  });

  describe('relation fields', () => {
    it('orders a to-many relation on the eager path', async () => {
      const res = await run(buildWith(postsDesc), `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id posts { id } } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).users[0].posts)).toEqual([6, 3, 2, 1]);
      expect(ids((res.data as any).users[2].posts)).toEqual([5, 4]);
    });

    it('orders a to-many relation on the lazy path', async () => {
      const gqlSchema = buildWith(postsDesc, false);
      const res = await run(gqlSchema, `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id posts { id } } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).users[0].posts)).toEqual([6, 3, 2, 1]);
      expect(ids((res.data as any).users[2].posts)).toEqual([5, 4]);
    });

    it("takes the default of the table it reads, not its parent's", async () => {
      // Users is ordered ascending; its posts still take the Posts default, descending.
      const both: DefaultsConfig = { Posts: { orderBy: { id: 'desc' } }, Users: { orderBy: { id: 'asc' } } };
      const res = await run(buildWith(both), `{ users { id posts { id } } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).users)).toEqual([1, 2, 5]);
      expect(ids((res.data as any).users[0].posts)).toEqual([6, 3, 2, 1]);
    });

    it('lets a relation argument override it', async () => {
      const res = await run(
        buildWith(postsDesc),
        `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { posts(orderBy: { id: { direction: asc, priority: 1 } }) { id } } }`,
      );

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).users[0].posts)).toEqual([1, 2, 3, 6]);
    });

    it('leaves a to-one relation alone', async () => {
      // A to-one relation is a single row and takes no orderBy argument at all.
      const usersDesc: DefaultsConfig = { Users: { orderBy: { id: 'desc' } } };
      const res = await run(buildWith(usersDesc), `{ posts(orderBy: { id: { direction: asc, priority: 1 } }) { id author { id } } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts[0]).toEqual({ id: 1, author: { id: 1 } });
    });

    it('orders a paginated relation slice', async () => {
      const res = await run(
        buildWith(postsDesc),
        `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id posts(limit: 2) { id } } }`,
      );

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).users[0].posts)).toEqual([6, 3]);
    });
  });

  describe('cursor pagination', () => {
    it('pages through the default ordering without the client restating it', async () => {
      const gqlSchema = buildWith(postsDesc);
      const first = await run(gqlSchema, `{ posts(limit: 2) { id cursor } }`);

      expect(first.errors).toBeUndefined();
      expect(ids((first.data as any).posts)).toEqual([6, 5]);

      const after = (first.data as any).posts[1].cursor;
      const second = await run(gqlSchema, `{ posts(limit: 2, after: ${JSON.stringify(after)}) { id } }`);

      expect(second.errors).toBeUndefined();
      expect(ids((second.data as any).posts)).toEqual([4, 3]);
    });
  });

  describe('build-time validation', () => {
    it('rejects an unknown table', () => {
      expect(() => buildWith({ Nope: { orderBy: { id: 'asc' } } } as any)).toThrow(
        /config\.defaults names 'Nope', which is not a table/,
      );
    });

    it('rejects an unknown column', () => {
      expect(() => buildWith({ Posts: { orderBy: { nope: 'asc' } } } as any)).toThrow(
        /config\.defaults\.Posts\.orderBy names 'nope', which is not a column of 'Posts'/,
      );
    });

    it('rejects a direction that is neither asc nor desc', () => {
      expect(() => buildWith({ Posts: { orderBy: { id: 'sideways' } } } as any)).toThrow(
        /config\.defaults\.Posts\.orderBy\.id must be 'asc', 'desc', or \{ direction, priority\? \}/,
      );
    });

    it('rejects a non-integer priority', () => {
      expect(() => buildWith({ Posts: { orderBy: { id: { direction: 'asc', priority: 1.5 } } } } as any)).toThrow(
        /config\.defaults\.Posts\.orderBy\.id\.priority must be an integer/,
      );
    });

    it('accepts an empty orderBy for a table', () => {
      const res = buildWith({ Posts: { orderBy: {} } });

      expect(res).toBeDefined();
    });
  });

  describe('without a defaults config', () => {
    it('leaves an unpaginated list unordered', async () => {
      const res = await run(buildWith(), `{ posts { id } }`);

      expect(res.errors).toBeUndefined();
      expect(ids((res.data as any).posts).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});
