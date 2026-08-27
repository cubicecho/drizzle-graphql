import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, type LimitsConfig } from '@/index';
import * as schema from '../schema/pg';
import { setupTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-limit-policy-${Date.now()}`;
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

const buildWith = (limits?: LimitsConfig, eagerLoadRelations?: boolean): GraphQLSchema =>
  buildSchema(db, {
    typeNameMapper,
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
    ...(limits ? { limits } : {}),
    ...(eagerLoadRelations === undefined ? {} : { eagerLoadRelations }),
  }).schema;

// A fresh context object per call so the request-scoped relation batch loaders behave as
// they would in a real request.
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
describe.sequential('limit policy', () => {
  describe('without a policy', () => {
    it('leaves every list unbounded', async () => {
      const gqlSchema = buildWith();
      const res = await run(gqlSchema, `{ posts { id } users { id posts { id } } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(6);
      expect((res.data as any).users).toHaveLength(3);
      expect((res.data as any).users[0].posts).toHaveLength(4);
    });
  });

  describe('defaultLimit', () => {
    it('bounds a root list that asked for no limit', async () => {
      const gqlSchema = buildWith({ defaultLimit: 2 });
      const res = await run(gqlSchema, `{ posts(orderBy: { id: { direction: asc, priority: 1 } }) { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('leaves an explicit limit alone', async () => {
      const gqlSchema = buildWith({ defaultLimit: 2 });
      const res = await run(gqlSchema, `{ posts(limit: 5) { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(5);
    });

    it('is capped by maxLimit when the two disagree', async () => {
      // A misconfigured policy is the operator's problem — it clamps rather than erroring.
      const gqlSchema = buildWith({ defaultLimit: 5, maxLimit: 2 });
      const res = await run(gqlSchema, `{ posts { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(2);
    });
  });

  describe('maxLimit', () => {
    it('rejects a limit above the maximum', async () => {
      const gqlSchema = buildWith({ maxLimit: 3 });
      const res = await run(gqlSchema, `{ posts(limit: 5) { id } }`);

      expect(res.errors?.[0]?.message).toBe("'limit' of 5 exceeds the maximum of 3.");
      // The field is data rather than prose, so a schema that republishes it under another
      // name is not telling the client about a field it has never heard of.
      expect(res.errors?.[0]?.extensions).toStrictEqual({
        code: 'DRIZZLE_LIMIT_EXCEEDED',
        drizzle: { table: 'Posts', operation: 'select', field: 'posts' },
      });
    });

    it('allows a limit at the maximum', async () => {
      const gqlSchema = buildWith({ maxLimit: 3 });
      const res = await run(gqlSchema, `{ posts(limit: 3) { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(3);
    });

    it('bounds a request that passed no limit at all', async () => {
      // No limit means every row, which is above any maximum.
      const gqlSchema = buildWith({ maxLimit: 3 });
      const res = await run(gqlSchema, `{ posts { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(3);
    });

    it('clamps instead of rejecting under clampToMax', async () => {
      const gqlSchema = buildWith({ maxLimit: 3, clampToMax: true });
      const res = await run(gqlSchema, `{ posts(limit: 5) { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(3);
    });
  });

  describe('per-table overrides', () => {
    it('takes the table policy over the global one', async () => {
      const gqlSchema = buildWith({ defaultLimit: 1, tables: { Posts: { defaultLimit: 3 } } });
      const res = await run(gqlSchema, `{ posts { id } users { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(3);
      expect((res.data as any).users).toHaveLength(1);
    });

    it('bounds only the tables it names when there is no global policy', async () => {
      const gqlSchema = buildWith({ tables: { Posts: { maxLimit: 2 } } });
      const res = await run(gqlSchema, `{ posts { id } users { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(2);
      expect((res.data as any).users).toHaveLength(3);
    });

    it('merges clampToMax from the global policy', async () => {
      const gqlSchema = buildWith({ clampToMax: true, tables: { Posts: { maxLimit: 2 } } });
      const res = await run(gqlSchema, `{ posts(limit: 5) { id } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).posts).toHaveLength(2);
    });
  });

  describe('relation fields', () => {
    // A relation takes the policy of the table it reads, not of its parent.
    const limits: LimitsConfig = { tables: { Posts: { defaultLimit: 2, maxLimit: 3 } } };

    for (const [label, eager] of [
      ['eagerly loaded', true],
      ['lazily resolved', false],
    ] as const) {
      it(`applies the target table's default when ${label}`, async () => {
        const gqlSchema = buildWith(limits, eager);
        const res = await run(
          gqlSchema,
          `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id posts { id } } }`,
        );

        expect(res.errors).toBeUndefined();
        const users = (res.data as any).users;
        expect(users).toHaveLength(3);
        expect(users[0].posts).toHaveLength(2); // user 1 has four
        expect(users[1].posts).toHaveLength(0); // user 2 has none
        expect(users[2].posts).toHaveLength(2); // user 5 has two
      });

      it(`rejects a relation limit above the maximum when ${label}`, async () => {
        const gqlSchema = buildWith(limits, eager);
        const res = await run(gqlSchema, `{ users { id posts(limit: 4) { id } } }`);

        expect(res.errors?.[0]?.message).toBe("'limit' of 4 exceeds the maximum of 3.");
        // The relation path the policy is keyed by, as data: the table it reads and the
        // relation it was reached through. The eager path runs inside the parent's resolver,
        // so it also carries the root field the request came through.
        expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_LIMIT_EXCEEDED');
        expect(res.errors?.[0]?.extensions?.['drizzle']).toMatchObject({
          table: 'Posts',
          operation: 'relation',
          relation: 'posts',
        });
      });

      it(`clamps a relation limit under clampToMax when ${label}`, async () => {
        const gqlSchema = buildWith({ tables: { Posts: { maxLimit: 3, clampToMax: true } } }, eager);
        const res = await run(gqlSchema, `{ users(where: { id: { eq: 1 } }) { id posts(limit: 4) { id } } }`);

        expect(res.errors).toBeUndefined();
        expect((res.data as any).users[0].posts).toHaveLength(3);
      });

      it(`leaves a to-one relation alone when ${label}`, async () => {
        const gqlSchema = buildWith({ defaultLimit: 1 }, eager);
        const res = await run(
          gqlSchema,
          `{ posts(orderBy: { id: { direction: asc, priority: 1 } }, limit: 3) { id author { id } } }`,
        );

        expect(res.errors).toBeUndefined();
        expect((res.data as any).posts).toEqual([
          { id: 1, author: { id: 1 } },
          { id: 2, author: { id: 1 } },
          { id: 3, author: { id: 1 } },
        ]);
      });
    }

    it('bounds a relation selected on a mutation payload', async () => {
      const gqlSchema = buildWith({ tables: { Posts: { defaultLimit: 2 } } });
      const res = await run(
        gqlSchema,
        `mutation { updateUser(set: { profession: "changed" }, where: { id: { eq: 1 } }) { id posts { id } } }`,
      );

      expect(res.errors).toBeUndefined();
      expect((res.data as any).updateUser[0].posts).toHaveLength(2); // user 1 has four
    });
  });

  describe('what a policy does not touch', () => {
    it('leaves single queries alone', async () => {
      const gqlSchema = buildWith({ defaultLimit: 1, maxLimit: 1 });
      const res = await run(gqlSchema, `{ user(where: { id: { eq: 5 } }) { id name } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).user).toEqual({ id: 5, name: 'FifthUser' });
    });

    it('leaves aggregates counting every row', async () => {
      const gqlSchema = buildWith({ defaultLimit: 2 });
      const res = await run(gqlSchema, `{ postsAggregate { count } users { id postsAggregate { count } } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).postsAggregate.count).toBe(6);
      expect((res.data as any).users[0].postsAggregate.count).toBe(4);
    });
  });

  describe('cursor pagination', () => {
    it('pages at the default limit and keeps the cursors usable', async () => {
      const gqlSchema = buildWith({ tables: { Posts: { defaultLimit: 2 } } });
      const order = `orderBy: { id: { direction: asc, priority: 1 } }`;

      const first = await run(gqlSchema, `{ posts(${order}) { id cursor } }`);
      expect(first.errors).toBeUndefined();
      const firstPage = (first.data as any).posts;
      expect(firstPage.map((r: any) => r.id)).toEqual([1, 2]);

      const second = await run(gqlSchema, `query ($after: String) { posts(${order}, after: $after) { id } }`, {
        after: firstPage[1].cursor,
      });
      expect(second.errors).toBeUndefined();
      expect((second.data as any).posts.map((r: any) => r.id)).toEqual([3, 4]);
    });
  });

  describe('cost hints', () => {
    it('prices an unlimited list at the policy default rather than the estimator guess', () => {
      const gqlSchema = buildWith({ tables: { Posts: { defaultLimit: 4, maxLimit: 5 } } });
      const estimator = (gqlSchema.getQueryType()!.getFields()['posts'] as any).extensions.complexity;

      expect(estimator({ args: {}, childComplexity: 1 })).toBe(4);
      expect(estimator({ args: { limit: 2 }, childComplexity: 1 })).toBe(2);
      // Never priced above what the policy would actually let through.
      expect(estimator({ args: { limit: 100 }, childComplexity: 1 })).toBe(5);
    });
  });

  describe('config validation', () => {
    it('rejects a non-positive limit', () => {
      expect(() => buildWith({ maxLimit: 0 })).toThrow(/config\.limits\.maxLimit must be a positive integer/);
      expect(() => buildWith({ tables: { Posts: { defaultLimit: 1.5 } } })).toThrow(
        /config\.limits\.tables\.Posts\.defaultLimit must be a positive integer/,
      );
    });
  });
});
