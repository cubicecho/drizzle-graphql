import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import * as schema from '../schema/pg';
import { setupTables } from './common';

// A db whose query method we can spy on to count the SQL actually issued.
const DATA_DIR = `./tests/.temp/pgdata-eager-optout-${Date.now()}`;
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

const buildWith = (eagerLoadRelations: any): GraphQLSchema =>
  buildSchema(db, {
    typeNameMapper,
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
    eagerLoadRelations,
  }).schema;

// Run a query while capturing the SQL the driver sees.
const runCapturing = async (gqlSchema: GraphQLSchema, source: string) => {
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

describe.sequential('eagerLoadRelations opt-out', () => {
  const QUERY = `{ users { id posts { id } } }`;
  // A root users query that eager-loads posts uses a lateral join on "posts".
  const isEagerPostsJoin = (q: string) => /from "users".*left join lateral.*"posts"/i.test(q);
  // The lazy batch loader fetches posts with a standalone IN query.
  const isPostsBatch = (q: string) => /from "posts" where "posts"\."author_id" in/i.test(q);

  it('default: relation is eager-loaded in the parent query (no separate posts query)', async () => {
    const gqlSchema = buildWith(undefined);
    const { result, sqls } = await runCapturing(gqlSchema, QUERY);

    expect(result.errors).toBeUndefined();
    const users = (result.data as any)?.users ?? [];
    expect(users.find((u: any) => u.id === 1)?.posts).toHaveLength(4);

    expect(sqls.filter(isEagerPostsJoin)).toHaveLength(1);
    expect(sqls.filter(isPostsBatch)).toHaveLength(0);
  });

  it('opted out: parent query does NOT fetch posts; they resolve via one batched query', async () => {
    const gqlSchema = buildWith((t: string, r: string) => !(t === 'Users' && r === 'posts'));
    const { result, sqls } = await runCapturing(gqlSchema, QUERY);

    // Same data — the field still resolves, just lazily.
    expect(result.errors).toBeUndefined();
    const users = (result.data as any)?.users ?? [];
    expect(users.find((u: any) => u.id === 1)?.posts).toHaveLength(4);
    expect(users.find((u: any) => u.id === 5)?.posts).toHaveLength(2);

    // No overfetch: the parent users query never joined posts...
    expect(sqls.filter(isEagerPostsJoin)).toHaveLength(0);
    // ...and posts came from a single batched IN query (not N+1).
    expect(sqls.filter(isPostsBatch)).toHaveLength(1);
  });

  it('eagerLoadRelations: false disables eager loading for every relation', async () => {
    const gqlSchema = buildWith(false);
    const { result, sqls } = await runCapturing(gqlSchema, QUERY);

    expect(result.errors).toBeUndefined();
    expect(sqls.filter(isEagerPostsJoin)).toHaveLength(0);
    expect(sqls.filter(isPostsBatch)).toHaveLength(1);
  });

  // The batch loader correlates on the parent's join column, so that column has to be
  // fetched even when the client never selected it — otherwise every parent reaches the
  // resolver with no key and the relation comes back empty.
  it('opted out: resolves the relation when the parent join column is not selected', async () => {
    const gqlSchema = buildWith(false);
    const { result, sqls } = await runCapturing(gqlSchema, `{ users { name posts { id } } }`);

    expect(result.errors).toBeUndefined();
    const users = (result.data as any)?.users ?? [];
    expect(users.find((u: any) => u.name === 'FirstUser')?.posts).toHaveLength(4);
    expect(users.find((u: any) => u.name === 'FifthUser')?.posts).toHaveLength(2);
    expect(sqls.filter(isPostsBatch)).toHaveLength(1);

    // The forced join column must not leak into the response.
    expect(users[0]).not.toHaveProperty('id');
  });

  // The lazy path narrows its SELECT the same way the root path does: the columns the
  // selection names, plus the key the batch groups on. `posts.content` is never asked for
  // here, so it is never read.
  describe('the lazy batch reads only the columns the selection needs', () => {
    const postsBatch = (sqls: string[]) => sqls.filter(isPostsBatch);
    const paginatedPostsBatch = (sqls: string[]) =>
      sqls.filter((q) => /row_number\(\) over/i.test(q) && q.includes('"posts"'));

    it('narrows the batched IN query', async () => {
      const gqlSchema = buildWith(false);
      const { result, sqls } = await runCapturing(gqlSchema, `{ users { id posts { id } } }`);

      expect(result.errors).toBeUndefined();
      const [batch] = postsBatch(sqls);
      expect(batch).toBeDefined();
      expect(batch).toContain('"author_id"');
      expect(batch).not.toContain('"content"');
    });

    it('narrows the paginated batch, keeping the row-number window', async () => {
      const gqlSchema = buildWith(false);
      const { result, sqls } = await runCapturing(gqlSchema, `{ users { id posts(limit: 1) { id } } }`);

      expect(result.errors).toBeUndefined();
      expect((result.data as any)?.users?.find((u: any) => u.id === 1)?.posts).toHaveLength(1);
      const [batch] = paginatedPostsBatch(sqls);
      expect(batch).toBeDefined();
      expect(batch).toContain('__drizzle_graphql_rn');
      expect(batch).not.toContain('"content"');
    });

    it('reads a column the selection does name', async () => {
      const gqlSchema = buildWith(false);
      const { result, sqls } = await runCapturing(gqlSchema, `{ users { id posts { content } } }`);

      expect(result.errors).toBeUndefined();
      expect((result.data as any)?.users?.find((u: any) => u.id === 1)?.posts?.[0]).toEqual({
        content: '1MESSAGE',
      });
      expect(postsBatch(sqls)[0]).toContain('"content"');
    });

    it('keeps the join column a relation under the lazy relation resolves from', async () => {
      const gqlSchema = buildWith(false);
      const { result, sqls } = await runCapturing(gqlSchema, `{ users { id posts { id author { name } } } }`);

      expect(result.errors).toBeUndefined();
      const posts = (result.data as any)?.users?.find((u: any) => u.id === 1)?.posts ?? [];
      expect(posts[0]?.author).toEqual({ name: 'FirstUser' });
      // `author_id` is the key both the batch and the nested `author` field correlate on, and
      // it stays out of the response either way.
      expect(posts[0]).not.toHaveProperty('authorId');
      expect(postsBatch(sqls)[0]).not.toContain('"content"');
    });
  });
});
