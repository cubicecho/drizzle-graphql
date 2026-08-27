import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, type WriteHookPayload } from '@/index';

const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Articles = pgTable('articles', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
  deletedAt: text('deleted_at'),
});
// Written only by hooks, so its contents are the record of what ran and what committed.
const Audit = pgTable('audit', {
  id: serial('id').primaryKey(),
  tableName: text('table_name').notNull(),
  operation: text('operation').notNull(),
  position: text('position').notNull(),
  detail: text('detail'),
});

const r = createRelationsHelper({ Authors, Articles, Audit });
const relations = buildRelations(
  { Authors, Articles, Audit },
  {
    Authors: { articles: r.many.Articles({ from: r.Authors.id, to: r.Articles.authorId }) },
    Articles: { author: r.one.Authors({ from: r.Articles.authorId, to: r.Authors.id }) },
  },
);
const schema = { Authors, Articles, Audit, relations };

const DATA_DIR = `./tests/.temp/pgdata-on-write-${Date.now()}`;
let pglite: PGlite;
let db: any;

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error) => error as Error, ...config }).schema;

const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue: { ...contextValue } });

const auditRows = async () => await db.select().from(Audit).orderBy(Audit.id);
const articleRows = async () => await db.select().from(Articles).orderBy(Articles.id);

// Records what ran, through the hook's own `tx` — so a row only survives if the mutation
// it rode along with committed.
const record =
  (extra?: (payload: WriteHookPayload) => string | undefined) =>
  async (payload: WriteHookPayload) => {
    await payload.tx.insert(Audit).values({
      tableName: payload.table,
      operation: payload.operation,
      position: payload.position,
      detail: extra ? extra(payload) : payload.rows.map((row: any) => row.id).join(','),
    });
  };

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "articles" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer, "deleted_at" text);`,
  );
  await db.execute(
    sql`CREATE TABLE "audit" ("id" serial PRIMARY KEY NOT NULL, "table_name" text NOT NULL, "operation" text NOT NULL, "position" text NOT NULL, "detail" text);`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

beforeEach(async () => {
  await db.delete(Audit);
  await db.delete(Articles);
  await db.delete(Authors);
  await db.insert(Authors).values([{ id: 1, name: 'Ada' }]);
  await db.insert(Articles).values([
    { id: 1, title: 'first', authorId: 1 },
    { id: 2, title: 'second', authorId: 1 },
  ]);
});

describe.sequential('onWrite', () => {
  it('runs after the write, sees the post-write rows, and commits with the mutation', async () => {
    const seen: WriteHookPayload[] = [];
    const gqlSchema = buildWith({
      onWrite: {
        Articles: async (payload) => {
          seen.push(payload);
          await record()(payload);
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);
    expect(res.errors).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.table).toBe('Articles');
    expect(seen[0]!.operation).toBe('insert');
    expect(seen[0]!.position).toBe('after');
    expect(seen[0]!.single).toBe(false);
    // Database-shaped rows, not the client-shaped output.
    expect(seen[0]!.rows).toEqual([{ id: 3 }]);
    expect(seen[0]!.args).toEqual({ values: [{ id: 3, title: 'third' }] });

    expect(await auditRows()).toEqual([
      expect.objectContaining({ tableName: 'Articles', operation: 'insert', position: 'after', detail: '3' }),
    ]);
  });

  it("throwing rolls the mutation back — even a single mutation field, which wouldn't have had a transaction", async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: async () => {
          throw new Error('audit failed');
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);
    expect(res.errors?.[0]?.message).toContain('audit failed');
    // The row the mutation wrote is gone with it.
    expect((await articleRows()).map((row: any) => row.id)).toEqual([1, 2]);
  });

  it("a failing mutation rolls the before hook's own write back", async () => {
    const gqlSchema = buildWith({
      onWrite: { Articles: { before: record(() => 'before') } },
    });

    // Duplicate primary key: the insert fails after the hook has already written.
    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 1, title: "dupe" }]) { id } }`);
    expect(res.errors).toBeDefined();
    expect(await auditRows()).toEqual([]);
  });

  it('the before hook reads inside the transaction, ahead of the statement', async () => {
    const order: string[] = [];
    const gqlSchema = buildWith({
      onWrite: {
        Articles: {
          before: async ({ args, tx }) => {
            order.push('before');
            // The row the mutation is about to write is not there yet.
            const rows = await tx.select().from(Articles).where(eq(Articles.id, 3));
            expect(rows).toEqual([]);
            expect(args.values[0].title).toBe('third');
          },
          after: async ({ tx }) => {
            order.push('after');
            // ...and here it is, uncommitted, visible on the same executor.
            const rows = await tx.select().from(Articles).where(eq(Articles.id, 3));
            expect(rows).toHaveLength(1);
          },
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(order).toEqual(['before', 'after']);
  });

  it('fires for every write operation, with the operation named', async () => {
    // Upsert is off by default, so this build turns it on to cover its hook too.
    const gqlSchema = buildWith({ features: { upsert: true }, onWrite: { Articles: record() } });

    const mutations: [string, string][] = [
      [`createArticlesSingle(values: { id: 3, title: "third" }) { id }`, 'insert'],
      [`updateArticles(set: { title: "x" }, where: { id: { eq: 1 } }) { id }`, 'update'],
      [`updateArticlesMany(updates: [{ set: { title: "y" }, where: { id: { eq: 2 } } }]) { id }`, 'updateMany'],
      [`upsertArticles(values: [{ id: 4, title: "fourth" }]) { id }`, 'upsert'],
      [`deleteArticles(where: { id: { eq: 4 } }) { id }`, 'delete'],
    ];
    for (const [field, _operation] of mutations) {
      const res = await run(gqlSchema, `mutation { ${field} }`);
      expect(res.errors).toBeUndefined();
    }

    expect((await auditRows()).map((row: any) => row.operation)).toEqual(mutations.map(([, operation]) => operation));
  });

  it('is registered per table — another table writes nothing', async () => {
    const gqlSchema = buildWith({ onWrite: { Articles: record() } });

    const res = await run(gqlSchema, `mutation { createAuthors(values: [{ id: 2, name: "Grace" }]) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });

  it('a bare function at the top level applies to every table', async () => {
    const gqlSchema = buildWith({ onWrite: record() });

    await run(gqlSchema, `mutation { createAuthors(values: [{ id: 2, name: "Grace" }]) { id } }`);
    await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);

    expect((await auditRows()).map((row: any) => row.tableName)).toEqual(['Authors', 'Articles']);
  });

  it('shares the request transaction when several mutations run in one document', async () => {
    const executors = new Set<any>();
    const gqlSchema = buildWith({
      transactions: 'auto',
      onWrite: {
        Articles: async (payload) => {
          executors.add(payload.tx);
          await record()(payload);
        },
      },
    });

    const res = await run(
      gqlSchema,
      `mutation {
         a: createArticlesSingle(values: { id: 3, title: "third" }) { id }
         b: createArticlesSingle(values: { id: 4, title: "fourth" }) { id }
       }`,
    );
    expect(res.errors).toBeUndefined();
    // One executor for both fields: the hook rode the request's shared transaction.
    expect(executors.size).toBe(1);
    expect(await auditRows()).toHaveLength(2);
  });

  it('rolls the whole document back when a hook on the second field throws', async () => {
    const gqlSchema = buildWith({
      transactions: 'auto',
      onWrite: {
        Articles: async ({ rows }) => {
          if (rows.some((row: any) => row.id === 4)) {
            throw new Error('second one failed');
          }
        },
      },
    });

    const res = await run(
      gqlSchema,
      `mutation {
         a: createArticlesSingle(values: { id: 3, title: "third" }) { id }
         b: createArticlesSingle(values: { id: 4, title: "fourth" }) { id }
       }`,
    );
    expect(res.errors).toBeDefined();
    expect((await articleRows()).map((row: any) => row.id)).toEqual([1, 2]);
  });

  it('names a soft-delete restore as its own operation', async () => {
    const gqlSchema = buildWith({
      softDelete: { Articles: 'deletedAt' },
      onWrite: { Articles: record() },
    });

    await run(gqlSchema, `mutation { deleteArticles(where: { id: { eq: 1 } }) { id } }`);
    await run(gqlSchema, `mutation { restoreArticles(where: { id: { eq: 1 } }) { id } }`);

    expect((await auditRows()).map((row: any) => row.operation)).toEqual(['delete', 'restore']);
    // The delete was an UPDATE, so the row is still there and unmarked again.
    expect((await articleRows()).map((row: any) => row.deletedAt)).toEqual([null, null]);
  });

  it('rejects a declaration that does not match the schema', () => {
    expect(() => buildWith({ onWrite: { Nope: async () => {} } })).toThrow(/not a table in the Drizzle schema/);
  });

  it('leaves a build without hooks exactly as it was', async () => {
    const gqlSchema = buildWith({});
    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });
});
