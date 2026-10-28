import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, type WriteHook, type WriteHookPayload } from '@/index';

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
const Tags = pgTable('tags', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const ArticleTags = pgTable(
  'article_tags',
  {
    articleId: integer('article_id').notNull(),
    tagId: integer('tag_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.tagId] })],
);

const r = createRelationsHelper({ Authors, Articles, Tags, ArticleTags });
const relations = buildRelations(
  { Authors, Articles, Tags, ArticleTags },
  {
    Authors: { articles: r.many.Articles({ from: r.Authors.id, to: r.Articles.authorId }) },
    Articles: {
      author: r.one.Authors({ from: r.Articles.authorId, to: r.Authors.id }),
      tags: r.many.Tags({
        from: r.Articles.id.through(r.ArticleTags.articleId),
        to: r.Tags.id.through(r.ArticleTags.tagId),
      }),
    },
  },
);
const schema = { Authors, Articles, Tags, ArticleTags, relations };

let pglite: PGlite;
let db: any;

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error) => error as Error, ...config }).schema;

const run = async (gqlSchema: GraphQLSchema, source: string) => {
  const res = await graphql({ schema: gqlSchema, source, contextValue: {} });
  expect(res.errors).toBeUndefined();
  return res;
};

/** What ran, in order: `tag:table:operation:position`, plus the nested op when there is one. */
let calls: string[] = [];
const log =
  (tag: string): WriteHook =>
  (payload: WriteHookPayload) => {
    const nested = payload.nested ? `:${payload.nested.op}` : '';
    calls.push(`${tag}:${payload.table}:${payload.operation}:${payload.position}${nested}`);
  };
/** Records the keys of each `after` row, to show which columns a registration's rows carry. */
const rowKeys =
  (tag: string): WriteHook =>
  (payload: WriteHookPayload) => {
    calls.push(`${tag}:${payload.operation}:${payload.rows.map((row) => Object.keys(row).sort().join('+')).join(',')}`);
  };

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations });
  await db.execute(sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "articles" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer, "deleted_at" text);`,
  );
  await db.execute(sql`CREATE TABLE "tags" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "article_tags" ("article_id" integer NOT NULL, "tag_id" integer NOT NULL, PRIMARY KEY ("article_id", "tag_id"));`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

beforeEach(async () => {
  calls = [];
  await db.delete(ArticleTags);
  await db.delete(Tags);
  await db.delete(Articles);
  await db.delete(Authors);
  await db.insert(Authors).values([{ id: 1, name: 'Ada' }]);
  await db.insert(Articles).values([
    { id: 1, title: 'first', authorId: 1 },
    { id: 2, title: 'second', authorId: 1 },
  ]);
  await db.insert(Tags).values([{ id: 1, name: 'news' }]);
});

describe.sequential('onWrite per operation', () => {
  it('runs each operation key for that operation only', async () => {
    const gqlSchema = buildWith({
      features: { upsert: true },
      softDelete: { Articles: 'deletedAt' },
      onWrite: {
        Articles: {
          insert: log('insert'),
          update: log('update'),
          updateMany: log('updateMany'),
          upsert: log('upsert'),
          delete: log('delete'),
          restore: log('restore'),
        },
      },
    });

    await run(gqlSchema, `mutation { createArticlesSingle(values: { id: 3, title: "third" }) { id } }`);
    await run(gqlSchema, `mutation { updateArticles(set: { title: "x" }, where: { id: { eq: 1 } }) { id } }`);
    await run(
      gqlSchema,
      `mutation { updateArticlesMany(updates: [{ set: { title: "y" }, where: { id: { eq: 2 } } }]) { id } }`,
    );
    await run(gqlSchema, `mutation { upsertArticles(values: [{ id: 4, title: "fourth" }]) { id } }`);
    await run(gqlSchema, `mutation { deleteArticles(where: { id: { eq: 4 } }) { id } }`);
    await run(gqlSchema, `mutation { restoreArticles(where: { id: { eq: 4 } }) { id } }`);

    // A bare function under an operation key is that operation's `after` hook, and
    // `payload.operation` always matches the key it was registered under.
    expect(calls).toEqual([
      'insert:Articles:insert:after',
      'update:Articles:update:after',
      'updateMany:Articles:updateMany:after',
      'upsert:Articles:upsert:after',
      'delete:Articles:delete:after',
      'restore:Articles:restore:after',
    ]);
  });

  it('fires the count mutations under their update / delete keys', async () => {
    const gqlSchema = buildWith({
      features: { countMutations: true },
      onWrite: { Articles: { update: log('update'), delete: { before: log('delete') } } },
    });

    await run(gqlSchema, `mutation { updateArticlesCount(set: { title: "x" }, where: { id: { eq: 1 } }) }`);
    await run(gqlSchema, `mutation { deleteArticlesCount(where: { id: { eq: 2 } }) }`);

    expect(calls).toEqual(['update:Articles:update:after', 'delete:Articles:delete:before']);
  });

  it('leaves an operation without a key unhooked', async () => {
    const gqlSchema = buildWith({ onWrite: { Articles: { delete: log('delete') } } });

    await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);
    await run(gqlSchema, `mutation { updateArticles(set: { title: "x" }, where: { id: { eq: 1 } }) { id } }`);
    expect(calls).toEqual([]);

    await run(gqlSchema, `mutation { deleteArticles(where: { id: { eq: 3 } }) { id } }`);
    expect(calls).toEqual(['delete:Articles:delete:after']);
  });

  it('runs the every-operation positions and the operation key both, shared first', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: {
          before: log('shared'),
          after: log('shared'),
          delete: { before: log('own'), after: log('own') },
        },
      },
    });

    await run(gqlSchema, `mutation { deleteArticles(where: { id: { eq: 2 } }) { id } }`);
    await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);

    expect(calls).toEqual([
      'shared:Articles:delete:before',
      'own:Articles:delete:before',
      'shared:Articles:delete:after',
      'own:Articles:delete:after',
      'shared:Articles:insert:before',
      'shared:Articles:insert:after',
    ]);
  });

  it('rolls the write back when an operation hook throws after the shared one ran', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: {
          after: log('shared'),
          delete: () => {
            throw new Error('deletes are audited elsewhere');
          },
        },
      },
    });

    const res = await graphql({
      schema: gqlSchema,
      source: `mutation { deleteArticles(where: { id: { eq: 2 } }) { id } }`,
      contextValue: {},
    });

    expect(res.errors?.[0]?.message).toBe('deletes are audited elsewhere');
    expect(calls).toEqual(['shared:Articles:delete:after']);
    expect((await db.select().from(Articles)).map((row: any) => row.id).sort()).toEqual([1, 2]);
  });

  it('reads a top-level object of operation keys alone as the every-table form', async () => {
    const gqlSchema = buildWith({ onWrite: { delete: log('delete') } });

    await run(gqlSchema, `mutation { createAuthors(values: [{ id: 2, name: "Grace" }]) { id } }`);
    await run(gqlSchema, `mutation { deleteArticles(where: { id: { eq: 2 } }) { id } }`);
    await run(gqlSchema, `mutation { deleteAuthors(where: { id: { eq: 2 } }) { id } }`);

    expect(calls).toEqual(['delete:Articles:delete:after', 'delete:Authors:delete:after']);
  });

  it('combines every-table positions with every-table operation keys', async () => {
    const gqlSchema = buildWith({ onWrite: { after: log('shared'), insert: { before: log('own') } } });

    await run(gqlSchema, `mutation { createAuthors(values: [{ id: 2, name: "Grace" }]) { id } }`);
    await run(gqlSchema, `mutation { updateArticles(set: { title: "x" }, where: { id: { eq: 1 } }) { id } }`);

    expect(calls).toEqual(['own:Authors:insert:before', 'shared:Authors:insert:after', 'shared:Articles:update:after']);
  });

  it("adds an operation's columns to that operation's rows only", async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: {
          insert: rowKeys('insert'),
          update: { after: rowKeys('update'), columns: ['authorId'] },
        },
      },
    });

    const created = await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);
    const updated = await run(
      gqlSchema,
      `mutation { updateArticles(set: { title: "x" }, where: { id: { eq: 1 } }) { id } }`,
    );

    expect(calls).toEqual(['insert:insert:id', 'update:update:authorId+id']);
    // The hook-only column is taken back off before the client sees the rows.
    expect(created.data).toEqual({ createArticles: [{ id: 3 }] });
    expect(updated.data).toEqual({ updateArticles: [{ id: 1 }] });
  });

  it('hands both hooks the union of the shared and the operation columns', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Articles: {
          after: rowKeys('shared'),
          columns: ['title'],
          update: { after: rowKeys('own'), columns: ['authorId'] },
        },
      },
    });

    await run(gqlSchema, `mutation { updateArticles(set: { title: "x" }, where: { id: { eq: 1 } }) { id } }`);
    await run(gqlSchema, `mutation { createArticles(values: [{ id: 3, title: "third" }]) { id } }`);

    expect(calls).toEqual([
      'shared:update:authorId+id+title',
      'own:update:authorId+id+title',
      'shared:insert:id+title',
    ]);
  });

  it('fires a nested statement under the operation it performs on the target', async () => {
    const gqlSchema = buildWith({
      features: { nestedWrites: true },
      onWrite: {
        Authors: { insert: log('authors') },
        Articles: { insert: log('insert'), update: log('update') },
      },
    });

    await run(
      gqlSchema,
      `mutation { createAuthorsSingle(values: { id: 2, name: "Grace", articles: {
        create: [{ id: 3, title: "third" }], connect: [{ id: { eq: 2 } }]
      } }) { id } }`,
    );

    expect(calls).toEqual([
      'update:Articles:update:after:connect',
      'insert:Articles:insert:after:create',
      'authors:Authors:insert:after',
    ]);
  });

  it('looks up a parent-side nested create under insert', async () => {
    const gqlSchema = buildWith({
      features: { nestedWrites: true },
      onWrite: { Authors: { insert: log('insert'), update: log('update') } },
    });

    await run(
      gqlSchema,
      `mutation { createArticlesSingle(values: { id: 3, title: "third", author: { create: { id: 2, name: "Grace" } } }) { id } }`,
    );

    expect(calls).toEqual(['insert:Authors:insert:after:create']);
  });

  it('fires a junction link under insert and an unlink under delete', async () => {
    const gqlSchema = buildWith({
      features: { nestedWrites: true },
      onWrite: { ArticleTags: { insert: log('link'), delete: { before: log('unlink') } } },
    });

    await run(
      gqlSchema,
      `mutation { updateArticlesSingle(where: { id: { eq: 1 } }, set: { tags: { connect: [{ id: { eq: 1 } }] } }) { id } }`,
    );
    await run(
      gqlSchema,
      `mutation { updateArticlesSingle(where: { id: { eq: 1 } }, set: { tags: { disconnect: [{ id: { eq: 1 } }] } }) { id } }`,
    );

    expect(calls).toEqual(['link:ArticleTags:insert:after:connect', 'unlink:ArticleTags:delete:before:disconnect']);
  });
});

describe('onWrite per operation: build-time errors', () => {
  const fails = (onWrite: unknown, message: string, extra: Partial<BuildSchemaConfig> = {}) =>
    expect(() => buildWith({ ...extra, onWrite: onWrite as BuildSchemaConfig['onWrite'] })).toThrow(message);
  const hook = () => {};

  it('refuses a key that is neither a position nor an operation', () => {
    fails(
      { Articles: { delte: hook } },
      "config.onWrite.Articles has an unknown key 'delte'; it takes 'before', 'after' and 'columns' for every operation, or an operation key ('insert', 'update', 'updateMany', 'upsert', 'delete', 'restore') for one.",
    );
    fails({ after: hook, delte: hook }, "config.onWrite (on table 'Authors') has an unknown key 'delte'");
  });

  it('refuses operation keys nested inside an operation key', () => {
    fails(
      { Articles: { delete: { update: hook } } },
      "config.onWrite.Articles.delete has an unknown key 'update'; it takes 'before', 'after' and 'columns'. Operation keys do not nest",
    );
  });

  it('refuses an operation value that is not a function or a positions object', () => {
    fails(
      { Articles: { delete: 'audit' } },
      "config.onWrite.Articles.delete must be a function (the 'after' hook) or an object with 'before', 'after' and/or 'columns'.",
    );
    fails(
      { Articles: { update: { before: 1 } } },
      'config.onWrite.Articles.update.before must be a function, got number.',
    );
  });

  it('refuses columns without an after hook beside them', () => {
    fails(
      { Articles: { update: { before: hook, columns: ['id'] } } },
      "config.onWrite.Articles.update.columns only applies to an 'after' hook, and none is registered.",
    );
    // A table-level `columns` belongs to the table-level `after`, not to an operation's.
    fails(
      { Articles: { columns: ['id'], update: hook } },
      "config.onWrite.Articles.columns only applies to an 'after' hook, and none is registered.",
    );
  });

  it("refuses an operation's unknown column, naming the operation and, top level, the table", () => {
    fails(
      { Articles: { update: { after: hook, columns: ['nope'] } } },
      "config.onWrite.Articles.update.columns names 'nope', which is not a column of that table.",
    );
    fails(
      { update: { after: hook, columns: ['title'] } },
      "config.onWrite.update (on table 'Authors').columns names 'title', which is not a column of that table.",
    );
  });

  it('refuses an unknown table, and teaches where an operation key goes', () => {
    fails({ Nope: { delete: hook } }, "config.onWrite names 'Nope', which is not a table in the Drizzle schema.");
    fails(
      { Articles: hook, delete: hook },
      "config.onWrite names 'delete', which is not a table in the Drizzle schema. 'delete' is an operation: operation keys go inside a table's entry (config.onWrite.<table>.delete)",
    );
  });

  it('refuses an every-table form that also names a table', () => {
    fails(
      { after: hook, Articles: hook },
      "config.onWrite is the every-table form (it has 'before', 'after' or 'columns', or only operation keys), so it cannot also name table 'Articles'.",
    );
  });

  it('refuses a restore key on a table that does not soft-delete', () => {
    fails(
      { Authors: { restore: hook } },
      "config.onWrite.Authors.restore is registered, but 'Authors' does not soft-delete, so it has no restore to hook.",
    );
    expect(() =>
      buildWith({ softDelete: { Articles: 'deletedAt' }, onWrite: { Articles: { restore: hook } } }),
    ).not.toThrow();
    // The every-table form skips tables that cannot restore rather than refusing.
    expect(() => buildWith({ onWrite: { restore: hook } })).not.toThrow();
  });
});

describe('onWrite per operation: a table keyed like an operation', () => {
  it('keeps reading a top-level key that names a table as that table', async () => {
    const Update = pgTable('update_notes', { id: integer('id').primaryKey() });
    const client = new PGlite();
    try {
      const noteDb = (drizzle as any)({
        client,
        schema: { update: Update },
        relations: buildRelations({ update: Update }, {}),
      });
      await noteDb.execute(sql`CREATE TABLE "update_notes" ("id" integer PRIMARY KEY NOT NULL);`);
      const seen: string[] = [];
      const gqlSchema = buildSchema(noteDb, {
        onError: (error) => error as Error,
        onWrite: { update: (payload) => void seen.push(payload.operation) },
      }).schema;

      const res = await graphql({
        schema: gqlSchema,
        source: 'mutation { createUpdate(values: [{ id: 1 }]) { id } }',
        contextValue: {},
      });

      expect(res.errors).toBeUndefined();
      // The table's every-operation `after` hook, not an every-table `update` hook.
      expect(seen).toEqual(['insert']);
    } finally {
      await client.close();
    }
  });
});
