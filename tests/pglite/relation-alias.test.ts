import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import * as schema from '../schema/pg';
import { setupTables } from './common';

// The `with:` clause is keyed by relation name, so a relation selected twice under different
// aliases cannot be represented on the eager path. These tests pin the fallback: such a
// relation drops out of `with:` and every alias resolves through the batch loader, which keys
// its loader by args and so stays per-alias correct.
const DATA_DIR = `./tests/.temp/pgdata-relation-alias-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const typeNameMapper = (name: string) =>
  (
    ({
      Users: { singular: 'user', plural: 'users' },
      Posts: { singular: 'post', plural: 'posts' },
      Customers: { singular: 'customer', plural: 'customers' },
      Tags: { singular: 'tag', plural: 'tags' },
    }) as Record<string, { singular: string; plural: string }>
  )[name];

const runCapturing = async (source: string) => {
  const orig = pglite.query.bind(pglite);
  const sqls: string[] = [];
  (pglite as any).query = (text: string, ...rest: any[]) => {
    sqls.push(text.replace(/\s+/g, ' '));
    return orig(text, ...rest);
  };
  try {
    // A shared context object lets the request-scoped batch loaders batch sibling calls.
    const result = await graphql({ schema: gqlSchema, source, contextValue: {} });
    return { result, sqls };
  } finally {
    (pglite as any).query = orig;
  }
};

// A root users query that eager-loads posts uses a lateral join on "posts".
const isEagerPostsJoin = (q: string) => /from "users".*left join lateral.*"posts"/i.test(q);
// The lazy batch loader fetches posts with a standalone IN query.
const isPostsBatch = (q: string) => /from "posts" where .*"author_id" in/i.test(q);

const ASC = (field: string) => `orderBy: { ${field}: { direction: asc, priority: 1 } }`;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations: schema.relations, logger: !!process.env['LOG_SQL'] });
  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  await setupTables({ db } as any);
  gqlSchema = buildSchema(db, {
    typeNameMapper,
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
  }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

// Seed recap: user 1 (FirstUser) wrote posts 1,2,3,6; user 5 (FifthUser) wrote posts 4,5;
// user 2 (SecondUser) wrote none.
describe.sequential('aliased duplicate relation selections', () => {
  it('keeps differently-paginated aliases of the same relation independent', async () => {
    const { result, sqls } = await runCapturing(`{
      users(where: { id: { eq: 1 } }) {
        id
        all: posts(${ASC('id')}) { id }
        recent: posts(${ASC('id')}, limit: 2) { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.users).toEqual([
      {
        id: 1,
        all: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }],
        recent: [{ id: 1 }, { id: 2 }],
      },
    ]);

    // The collision must take both aliases off the eager path, not just the losing one.
    expect(sqls.filter(isEagerPostsJoin)).toHaveLength(0);
    expect(sqls.filter(isPostsBatch).length).toBeGreaterThanOrEqual(2);
  });

  it('honors each aliases own column selection', async () => {
    const { result } = await runCapturing(`{
      users(where: { id: { eq: 1 } }) {
        idsOnly: posts(${ASC('id')}) { id }
        withContent: posts(${ASC('id')}) { id content }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const user = (result.data as any)?.users?.[0];
    expect(user.idsOnly).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }]);
    expect(user.withContent).toEqual([
      { id: 1, content: '1MESSAGE' },
      { id: 2, content: '2MESSAGE' },
      { id: 3, content: '3MESSAGE' },
      { id: 6, content: '4MESSAGE' },
    ]);
  });

  it('keeps differently-filtered aliases of the same relation independent', async () => {
    const { result } = await runCapturing(`{
      users(where: { id: { eq: 1 } }) {
        ones: posts(where: { content: { eq: "1MESSAGE" } }) { id }
        twos: posts(where: { content: { eq: "2MESSAGE" } }) { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.users?.[0]).toEqual({
      ones: [{ id: 1 }],
      twos: [{ id: 2 }],
    });
  });

  it('batches aliased relations across many parents (no N+1)', async () => {
    const { result, sqls } = await runCapturing(`{
      users(${ASC('id')}) {
        id
        all: posts(${ASC('id')}) { id }
        firstOnly: posts(${ASC('id')}, limit: 1) { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.users).toEqual([
      { id: 1, all: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }], firstOnly: [{ id: 1 }] },
      { id: 2, all: [], firstOnly: [] },
      { id: 5, all: [{ id: 4 }, { id: 5 }], firstOnly: [{ id: 4 }] },
    ]);

    // Three parents, two aliases: one batched query per alias, not one per parent.
    expect(sqls.filter(isPostsBatch)).toHaveLength(2);
  });

  it('applies the fallback to nested relations too', async () => {
    const { result } = await runCapturing(`{
      users(where: { id: { eq: 1 } }) {
        customer {
          firstPost: posts(${ASC('id')}, limit: 1) { id }
          allPosts: posts(${ASC('id')}) { id }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.users?.[0]?.customer).toEqual({
      firstPost: [{ id: 1 }],
      allPosts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }],
    });
  });

  it('handles aliases with identical args', async () => {
    const { result } = await runCapturing(`{
      users(where: { id: { eq: 1 } }) {
        a: posts(${ASC('id')}) { id }
        b: posts(${ASC('id')}) { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const user = (result.data as any)?.users?.[0];
    expect(user.a).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }]);
    expect(user.b).toEqual(user.a);
  });

  it('still eager-loads a relation selected once under an alias', async () => {
    const { result, sqls } = await runCapturing(`{
      users(where: { id: { eq: 1 } }) {
        mine: posts(${ASC('id')}) { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.users?.[0]?.mine).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }]);

    // A single aliased selection has no collision — the eager path must be preserved.
    expect(sqls.filter(isEagerPostsJoin)).toHaveLength(1);
    expect(sqls.filter(isPostsBatch)).toHaveLength(0);
  });

  it('still eager-loads when the relation is selected once unaliased', async () => {
    const { result, sqls } = await runCapturing(`{
      users(where: { id: { eq: 1 } }) {
        posts(${ASC('id')}) { id }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.users?.[0]?.posts).toHaveLength(4);
    expect(sqls.filter(isEagerPostsJoin)).toHaveLength(1);
    expect(sqls.filter(isPostsBatch)).toHaveLength(0);
  });
});
