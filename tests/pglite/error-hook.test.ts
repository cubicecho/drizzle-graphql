import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { GraphQLError, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Authors = pgTable('authors', { id: integer('id').primaryKey(), name: text('name') });
const Books = pgTable('books', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
});
const r = createRelationsHelper({ Authors, Books });
const relations = buildRelations(
  { Authors, Books },
  {
    Authors: { books: r.many.Books({ from: r.Authors.id, to: r.Books.authorId }) },
    Books: { author: r.one.Authors({ from: r.Books.authorId, to: r.Authors.id }) },
  },
);
const schema = { Authors, Books, relations };

const DATA_DIR = `./tests/.temp/pgdata-error-hook-${Date.now()}`;
let pglite: PGlite;
let db: any;

const run = (s: GraphQLSchema, source: string) => graphql({ schema: s, source, contextValue: {} });

// A unique-violation on the primary key. Drizzle rethrows driver errors with the full SQL
// and the bound parameters in the message, which is exactly what the default keeps out of a
// response.
const DUPLICATE = `mutation { createAuthorsSingle(values: { id: 1, name: "again" }) { id } }`;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text);`);
  await db.execute(
    sql`CREATE TABLE "books" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer);`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "books";`);
  await db.execute(sql`TRUNCATE "authors" CASCADE;`);
  await db.insert(Authors).values([{ id: 1, name: 'First' }]);
  await db.insert(Books).values([{ id: 1, title: 'A', authorId: 1 }]);
});

describe.sequential('default error handling', () => {
  it('replaces a database error with a generic message', async () => {
    const { schema: gqlSchema } = buildSchema(db);
    const res = await run(gqlSchema, DUPLICATE);

    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!.message).toBe('Internal server error');
    expect(res.errors![0]!.extensions['code']).toBe('INTERNAL_SERVER_ERROR');
    // Nothing about the table, the constraint, or the offending value survives.
    expect(JSON.stringify(res)).not.toMatch(/Failed query|insert into|params:/i);
  });

  it('keeps the original error reachable for server-side logging', async () => {
    const { schema: gqlSchema } = buildSchema(db);
    const res = await run(gqlSchema, DUPLICATE);

    // graphql-js locates the thrown error, so ours sits one level down.
    const masked = res.errors![0]!.originalError as GraphQLError;
    expect(masked.message).toBe('Internal server error');
    expect(masked.originalError?.message).toMatch(/Failed query: insert into "authors"/);
  });

  it("passes through drizzle-graphql's own errors unchanged", async () => {
    const { schema: gqlSchema } = buildSchema(db);
    const res = await run(gqlSchema, `mutation { updateAuthors(set: {}) { id } }`);

    expect(res.errors![0]!.message).toMatch(/Unable to update with no values specified/);
  });

  it('masks errors raised by a relation field resolver too', async () => {
    const { schema: gqlSchema } = buildSchema(db, { eagerLoadRelations: false });
    // The lazy relation loader queries "books" on its own — dropping it makes that query,
    // and only that query, fail.
    await db.execute(sql`DROP TABLE "books";`);
    try {
      const res = await run(gqlSchema, `{ authors { id books { id } } }`);
      expect(res.errors?.[0]?.message).toBe('Internal server error');
      expect(JSON.stringify(res)).not.toMatch(/does not exist/i);
    } finally {
      await db.execute(
        sql`CREATE TABLE "books" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer);`,
      );
    }
  });
});

describe.sequential('onError hook', () => {
  it('is called with the raw error and can be used purely for logging', async () => {
    const seen: unknown[] = [];
    const { schema: gqlSchema } = buildSchema(db, {
      onError: (error) => {
        seen.push(error);
      },
    });

    const res = await run(gqlSchema, DUPLICATE);

    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toMatch(/Failed query: insert into "authors"/);
    // Returning nothing falls through to the default.
    expect(res.errors![0]!.message).toBe('Internal server error');
  });

  it('surfaces an error it returns', async () => {
    const { schema: gqlSchema } = buildSchema(db, {
      onError: () => new GraphQLError('Something went wrong', { extensions: { code: 'DB_ERROR' } }),
    });

    const res = await run(gqlSchema, DUPLICATE);

    expect(res.errors![0]!.message).toBe('Something went wrong');
    expect(res.errors![0]!.extensions['code']).toBe('DB_ERROR');
  });

  it('can opt back into raw database messages', async () => {
    const { schema: gqlSchema } = buildSchema(db, { onError: (error) => error as Error });

    const res = await run(gqlSchema, DUPLICATE);

    expect(res.errors![0]!.message).toMatch(/Failed query: insert into "authors"/);
  });

  it("also sees drizzle-graphql's own errors", async () => {
    const seen: string[] = [];
    const { schema: gqlSchema } = buildSchema(db, {
      onError: (error) => {
        seen.push((error as Error).message);
      },
    });

    const res = await run(gqlSchema, `mutation { updateAuthors(set: {}) { id } }`);

    expect(seen).toEqual(['Unable to update with no values specified!']);
    // Still passed through by the default, not masked.
    expect(res.errors![0]!.message).toMatch(/Unable to update with no values specified/);
  });
});
