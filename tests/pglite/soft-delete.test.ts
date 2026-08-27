import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';

// ── A schema with both shapes of the convention ──────────────────────────────
// `Articles.deletedAt` is the nullable-timestamp form; `Flags.isArchived` is the NOT NULL
// boolean form. `Authors` declares nothing, so it keeps a real DELETE throughout.
const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Articles = pgTable('articles', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
  deletedAt: timestamp('deleted_at'),
});
const Flags = pgTable('flags', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
  isArchived: boolean('is_archived').notNull().default(false),
});
// The third shape: a *nullable* boolean marker, which is what a column added to an existing
// table without a backfill looks like. NULL there means "never marked", not "deleted".
const Docs = pgTable('docs', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  isDeleted: boolean('is_deleted').default(false),
});

// A soft-deleting lookup table reached through relations: `Items.kind` is *required*, so
// hiding a marked kind there can only produce "Cannot return null for non-nullable field";
// `Items.altKind` is the nullable version of the same shape.
const Kinds = pgTable('kinds', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
  isRetired: boolean('is_retired').notNull().default(false),
});
const Items = pgTable('items', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  kindId: integer('kind_id').notNull(),
  altKindId: integer('alt_kind_id'),
});

const r = createRelationsHelper({ Authors, Articles, Flags, Docs, Kinds, Items });
const relations = buildRelations(
  { Authors, Articles, Flags, Docs, Kinds, Items },
  {
    Authors: { articles: r.many.Articles({ from: r.Authors.id, to: r.Articles.authorId }) },
    Articles: { author: r.one.Authors({ from: r.Articles.authorId, to: r.Authors.id }) },
    Kinds: { items: r.many.Items({ from: r.Kinds.id, to: r.Items.kindId }) },
    Items: {
      kind: r.one.Kinds({ from: r.Items.kindId, to: r.Kinds.id, optional: false }),
      altKind: r.one.Kinds({ from: r.Items.altKindId, to: r.Kinds.id }),
    },
  },
);
const schema = { Authors, Articles, Flags, Docs, Kinds, Items, relations };

const DATA_DIR = `./tests/.temp/pgdata-soft-delete-${Date.now()}`;
let pglite: PGlite;
let db: any;

const softDelete: Partial<BuildSchemaConfig> = {
  softDelete: {
    Articles: 'deletedAt',
    Flags: { column: 'isArchived', deletedValue: true, restoredValue: false },
    Docs: { column: 'isDeleted', deletedValue: true, restoredValue: false },
    Kinds: { column: 'isRetired', deletedValue: true, restoredValue: false },
  },
};

/** The same declaration, with the lookup table scoped to its own root fields. */
const rootScoped: Partial<BuildSchemaConfig> = {
  softDelete: {
    ...(softDelete.softDelete as Record<string, any>),
    Kinds: { column: 'isRetired', deletedValue: true, restoredValue: false, scope: 'root' },
  },
};

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error) => error as Error, ...config }).schema;

// A fresh context object per call so the request-scoped relation batch loaders behave as they
// would in a real request.
const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue: { ...contextValue } });

const rowsOf = async (table: any) => await db.select().from(table);

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "articles" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer, "deleted_at" timestamp);`,
  );
  await db.execute(
    sql`CREATE TABLE "flags" ("id" integer PRIMARY KEY NOT NULL, "label" text NOT NULL, "is_archived" boolean NOT NULL DEFAULT false);`,
  );
  await db.execute(
    sql`CREATE TABLE "docs" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "is_deleted" boolean DEFAULT false);`,
  );
  await db.execute(
    sql`CREATE TABLE "kinds" ("id" integer PRIMARY KEY NOT NULL, "label" text NOT NULL, "is_retired" boolean NOT NULL DEFAULT false);`,
  );
  await db.execute(
    sql`CREATE TABLE "items" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL, "kind_id" integer NOT NULL, "alt_kind_id" integer);`,
  );
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

// Articles 1 and 2 belong to author 1, article 3 to author 2. Article 3 starts out marked.
beforeEach(async () => {
  await db.delete(Articles);
  await db.delete(Authors);
  await db.delete(Flags);
  await db.delete(Docs);
  await db.delete(Items);
  await db.delete(Kinds);
  await db.insert(Authors).values([
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
  ]);
  await db.insert(Articles).values([
    { id: 1, title: 'first', authorId: 1, deletedAt: null },
    { id: 2, title: 'second', authorId: 1, deletedAt: null },
    { id: 3, title: 'third', authorId: 2, deletedAt: new Date('2020-01-01T00:00:00Z') },
  ]);
  await db.insert(Flags).values([
    { id: 1, label: 'live', isArchived: false },
    { id: 2, label: 'archived', isArchived: true },
  ]);
  await db.insert(Docs).values([
    { id: 1, title: 'live', isDeleted: false },
    { id: 2, title: 'gone', isDeleted: true },
    // The un-backfilled row: the column was added after this one was written.
    { id: 3, title: 'never marked', isDeleted: null },
  ]);
  // Kind 2 is retired; item 2 is a live row that still points at it.
  await db.insert(Kinds).values([
    { id: 1, label: 'current', isRetired: false },
    { id: 2, label: 'retired', isRetired: true },
  ]);
  await db.insert(Items).values([
    { id: 1, name: 'one', kindId: 1, altKindId: 1 },
    { id: 2, name: 'two', kindId: 2, altKindId: 2 },
  ]);
});

describe.sequential('soft delete', () => {
  it('marks the row instead of removing it, and returns it as it now stands', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(gqlSchema, `mutation { deleteArticles(where: { id: { eq: 1 } }) { id deletedAt } }`);

    expect(res.errors).toBeUndefined();
    const deleted = res.data?.['deleteArticles'] as any[];
    expect(deleted).toHaveLength(1);
    expect(deleted[0].id).toBe(1);
    // The payload is the post-write row: the marker is set, not the null it had going in.
    expect(deleted[0].deletedAt).not.toBeNull();

    // And the row is still there.
    const rows = await rowsOf(Articles);
    expect(rows).toHaveLength(3);
    expect(rows.find((row: any) => row.id === 1).deletedAt).not.toBeNull();
  });

  it('hides marked rows from a list query, and from a single query', async () => {
    const gqlSchema = buildWith(softDelete);
    const list = await run(gqlSchema, `{ articles { id } }`);
    expect(list.errors).toBeUndefined();
    expect((list.data?.['articles'] as any[]).map((a) => a.id)).toEqual([1, 2]);

    const single = await run(gqlSchema, `{ articlesSingle(where: { id: { eq: 3 } }) { id } }`);
    expect(single.errors).toBeUndefined();
    expect(single.data?.['articlesSingle']).toBeNull();
  });

  it('a client filter cannot reach a marked row', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(gqlSchema, `{ articles(where: { id: { inArray: [2, 3] } }) { id } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data?.['articles'] as any[]).map((a) => a.id)).toEqual([2]);
  });

  it('deleted: INCLUDE returns both, ONLY returns just the marked ones', async () => {
    const gqlSchema = buildWith(softDelete);
    const included = await run(gqlSchema, `{ articles(deleted: INCLUDE) { id } }`);
    expect(included.errors).toBeUndefined();
    expect((included.data?.['articles'] as any[]).map((a) => a.id)).toEqual([1, 2, 3]);

    // The trash view the issue asks for: no second hand-written field needed.
    const only = await run(gqlSchema, `{ articles(deleted: ONLY) { id } }`);
    expect(only.errors).toBeUndefined();
    expect((only.data?.['articles'] as any[]).map((a) => a.id)).toEqual([3]);

    const single = await run(gqlSchema, `{ articlesSingle(where: { id: { eq: 3 } }, deleted: ONLY) { id } }`);
    expect(single.errors).toBeUndefined();
    expect((single.data?.['articlesSingle'] as any).id).toBe(3);
  });

  it('excludes marked rows from aggregates and groupBy, and honours the argument there too', async () => {
    const gqlSchema = buildWith(softDelete);
    const excluded = await run(gqlSchema, `{ articlesAggregate { count } }`);
    expect(excluded.errors).toBeUndefined();
    expect((excluded.data?.['articlesAggregate'] as any).count).toBe(2);

    const included = await run(gqlSchema, `{ articlesAggregate(deleted: INCLUDE) { count } }`);
    expect((included.data?.['articlesAggregate'] as any).count).toBe(3);

    const grouped = await run(gqlSchema, `{ articlesGroupBy(groupBy: [authorId]) { group { authorId } count } }`);
    expect(grouped.errors).toBeUndefined();
    // Author 2's only article is marked, so its group is gone entirely.
    expect(grouped.data?.['articlesGroupBy']).toEqual([{ group: { authorId: 1 }, count: 2 }]);

    const groupedAll = await run(
      gqlSchema,
      `{ articlesGroupBy(groupBy: [authorId], deleted: INCLUDE) { group { authorId } count } }`,
    );
    expect((groupedAll.data?.['articlesGroupBy'] as any[]).length).toBe(2);
  });

  it('hides marked rows inside a relation field — the case a client argument cannot cover', async () => {
    const gqlSchema = buildWith(softDelete);
    // Author 2's single article is marked: the relation comes back empty rather than leaking it.
    const res = await run(gqlSchema, `{ authors { id articles { id } } }`);

    expect(res.errors).toBeUndefined();
    const authors = res.data?.['authors'] as any[];
    expect(authors.find((a) => a.id === 1).articles.map((a: any) => a.id)).toEqual([1, 2]);
    expect(authors.find((a) => a.id === 2).articles).toEqual([]);

    const included = await run(gqlSchema, `{ authors { id articles(deleted: INCLUDE) { id } } }`);
    expect(included.errors).toBeUndefined();
    expect((included.data?.['authors'] as any[]).find((a) => a.id === 2).articles.map((a: any) => a.id)).toEqual([3]);
  });

  it('hides them on the batch-loader path too', async () => {
    // eagerLoadRelations: false forces every relation through the field resolver's loader,
    // which is the other half of the read path.
    const gqlSchema = buildWith({ ...softDelete, eagerLoadRelations: false });
    const res = await run(gqlSchema, `{ authors { id articles { id } } }`);

    expect(res.errors).toBeUndefined();
    const authors = res.data?.['authors'] as any[];
    expect(authors.find((a) => a.id === 1).articles.map((a: any) => a.id)).toEqual([1, 2]);
    expect(authors.find((a) => a.id === 2).articles).toEqual([]);

    const only = await run(gqlSchema, `{ authors { id articles(deleted: ONLY) { id } } }`);
    expect(only.errors).toBeUndefined();
    expect((only.data?.['authors'] as any[]).find((a) => a.id === 2).articles.map((a: any) => a.id)).toEqual([3]);
  });

  it('counts only unmarked rows in a relation aggregate', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(gqlSchema, `{ authors { id articlesAggregate { count } } }`);

    expect(res.errors).toBeUndefined();
    const authors = res.data?.['authors'] as any[];
    expect(authors.find((a) => a.id === 1).articlesAggregate.count).toBe(2);
    expect(authors.find((a) => a.id === 2).articlesAggregate.count).toBe(0);

    const included = await run(gqlSchema, `{ authors { id articlesAggregate(deleted: INCLUDE) { count } } }`);
    expect((included.data?.['authors'] as any[]).find((a) => a.id === 2).articlesAggregate.count).toBe(1);
  });

  it('keeps a write from reaching a marked row', async () => {
    const gqlSchema = buildWith(softDelete);
    const updated = await run(
      gqlSchema,
      `mutation { updateArticles(set: { title: "rewritten" }, where: { id: { eq: 3 } }) { id } }`,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.['updateArticles']).toEqual([]);

    // A second delete of an already-marked row matches nothing rather than re-stamping it.
    const deletedAgain = await run(gqlSchema, `mutation { deleteArticles(where: { id: { eq: 3 } }) { id } }`);
    expect(deletedAgain.errors).toBeUndefined();
    expect(deletedAgain.data?.['deleteArticles']).toEqual([]);

    const row = (await rowsOf(Articles)).find((a: any) => a.id === 3);
    expect(row.title).toBe('third');
    expect(row.deletedAt).toEqual(new Date('2020-01-01T00:00:00Z'));
  });

  it('restores a marked row, and only a marked row', async () => {
    const gqlSchema = buildWith(softDelete);
    const restored = await run(
      gqlSchema,
      `mutation { restoreArticlesSingle(where: { id: { eq: 3 } }) { id deletedAt } }`,
    );

    expect(restored.errors).toBeUndefined();
    expect((restored.data?.['restoreArticlesSingle'] as any).deletedAt).toBeNull();

    const list = await run(gqlSchema, `{ articles { id } }`);
    expect((list.data?.['articles'] as any[]).map((a) => a.id)).toEqual([1, 2, 3]);

    // Article 1 was never marked, so there is nothing for restore to match.
    const noop = await run(gqlSchema, `mutation { restoreArticlesSingle(where: { id: { eq: 1 } }) { id } }`);
    expect(noop.errors).toBeUndefined();
    expect(noop.data?.['restoreArticlesSingle']).toBeNull();
  });

  it('takes the marker column out of the write inputs but leaves it readable', async () => {
    const gqlSchema = buildWith(softDelete);
    const createInput = gqlSchema.getType('CreateArticlesInput') as GraphQLInputObjectType;
    const updateInput = gqlSchema.getType('UpdateArticlesInput') as GraphQLInputObjectType;
    const objectType = gqlSchema.getType('Articles') as GraphQLObjectType;

    expect(Object.keys(createInput.getFields())).not.toContain('deletedAt');
    expect(Object.keys(updateInput.getFields())).not.toContain('deletedAt');
    expect(Object.keys(objectType.getFields())).toContain('deletedAt');
    // And it stays filterable, so `deleted: ONLY` is not the only way to ask about it.
    expect(Object.keys((gqlSchema.getType('ArticlesFilters') as GraphQLInputObjectType).getFields())).toContain(
      'deletedAt',
    );
  });

  it('works the same way for a NOT NULL boolean marker', async () => {
    const gqlSchema = buildWith(softDelete);
    const list = await run(gqlSchema, `{ flags { id } }`);
    expect(list.errors).toBeUndefined();
    expect((list.data?.['flags'] as any[]).map((f) => f.id)).toEqual([1]);

    const deleted = await run(gqlSchema, `mutation { deleteFlags(where: { id: { eq: 1 } }) { id isArchived } }`);
    expect(deleted.errors).toBeUndefined();
    expect((deleted.data?.['deleteFlags'] as any[])[0].isArchived).toBe(true);
    expect(await rowsOf(Flags)).toHaveLength(2);

    const only = await run(gqlSchema, `{ flags(deleted: ONLY) { id } }`);
    expect((only.data?.['flags'] as any[]).map((f) => f.id).sort()).toEqual([1, 2]);

    const restored = await run(gqlSchema, `mutation { restoreFlags(where: { id: { eq: 1 } }) { id isArchived } }`);
    expect((restored.data?.['restoreFlags'] as any[])[0].isArchived).toBe(false);
  });

  it('honours an explicit deletedValue on a nullable marker column', async () => {
    const gqlSchema = buildWith(softDelete);

    // The live row and the un-backfilled NULL row are both alive; only the marked one is not.
    const list = await run(gqlSchema, `{ docs { id } }`);
    expect(list.errors).toBeUndefined();
    expect((list.data?.['docs'] as any[]).map((d) => d.id).sort()).toEqual([1, 3]);

    const included = await run(gqlSchema, `{ docs(deleted: INCLUDE) { id } }`);
    expect((included.data?.['docs'] as any[]).map((d) => d.id).sort()).toEqual([1, 2, 3]);

    // The trash view is the marked row alone — not every row, which is what reading the
    // column as NULL-means-alive would have given.
    const only = await run(gqlSchema, `{ docs(deleted: ONLY) { id } }`);
    expect((only.data?.['docs'] as any[]).map((d) => d.id)).toEqual([2]);
  });

  it('writes the configured values on a nullable marker column', async () => {
    const gqlSchema = buildWith(softDelete);

    const deleted = await run(gqlSchema, `mutation { deleteDocs(where: { id: { eq: 1 } }) { id isDeleted } }`);
    expect(deleted.errors).toBeUndefined();
    expect((deleted.data?.['deleteDocs'] as any[])[0].isDeleted).toBe(true);
    expect(await rowsOf(Docs)).toHaveLength(3);

    const restored = await run(gqlSchema, `mutation { restoreDocs(where: { id: { eq: 1 } }) { id isDeleted } }`);
    expect((restored.data?.['restoreDocs'] as any[])[0].isDeleted).toBe(false);
  });

  it('keeps the NULL-means-alive reading when no deletedValue is configured', async () => {
    // `Articles.deletedAt` is the timestamp form: nothing configured, so holding a value at
    // all is what marks the row.
    const gqlSchema = buildWith({ softDelete: { Articles: 'deletedAt' } });
    const only = await run(gqlSchema, `{ articles(deleted: ONLY) { id } }`);
    expect((only.data?.['articles'] as any[]).map((a) => a.id)).toEqual([3]);
  });

  it('reads a marked row through a required to-one relation rather than losing the parent', async () => {
    const gqlSchema = buildWith(softDelete);

    // Item 2 is live and points at the retired kind. Hiding it there could only produce
    // "Cannot return null for non-nullable field Items.kind" and take the whole item with it.
    const res = await run(gqlSchema, `{ items { id kind { id label } } }`);
    expect(res.errors).toBeUndefined();
    const items = res.data?.['items'] as any[];
    expect(items.find((i) => i.id === 2).kind).toEqual({ id: 2, label: 'retired' });

    // The root fields still hide it — the exception is the relation, not the table.
    const kinds = await run(gqlSchema, `{ kinds { id } }`);
    expect((kinds.data?.['kinds'] as any[]).map((k) => k.id)).toEqual([1]);
  });

  it('applies the required-to-one exception on the batch-loader path too', async () => {
    const gqlSchema = buildWith({ ...softDelete, eagerLoadRelations: false });
    const res = await run(gqlSchema, `{ items { id kind { id } } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data?.['items'] as any[]).find((i) => i.id === 2).kind).toEqual({ id: 2 });
  });

  it('still hides a marked row behind a nullable relation by default', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(gqlSchema, `{ items { id altKind { id } } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data?.['items'] as any[]).find((i) => i.id === 2).altKind).toBeNull();

    // And the argument still reaches it.
    const included = await run(gqlSchema, `{ items { id altKind(deleted: INCLUDE) { id } } }`);
    expect((included.data?.['items'] as any[]).find((i) => i.id === 2).altKind).toEqual({ id: 2 });
  });

  it("scope: 'root' leaves every relation field unscoped", async () => {
    const gqlSchema = buildWith(rootScoped);

    // Nullable to-one, to-many and the relation aggregate all read the retired row.
    const res = await run(
      gqlSchema,
      `{ items { id altKind { id } } kinds(deleted: INCLUDE) { id items { id } itemsAggregate { count } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect((res.data?.['items'] as any[]).find((i) => i.id === 2).altKind).toEqual({ id: 2 });
    const retired = (res.data?.['kinds'] as any[]).find((k) => k.id === 2);
    expect(retired.items.map((i: any) => i.id)).toEqual([2]);
    expect(retired.itemsAggregate.count).toBe(1);

    // The root fields are scoped exactly as before.
    const roots = await run(gqlSchema, `{ kinds { id } kindsAggregate { count } }`);
    expect((roots.data?.['kinds'] as any[]).map((k) => k.id)).toEqual([1]);
    expect((roots.data?.['kindsAggregate'] as any).count).toBe(1);
  });

  it("scope: 'root' keeps the argument on relation fields, so either default can be overridden", async () => {
    const gqlSchema = buildWith({ ...rootScoped, eagerLoadRelations: false });
    const res = await run(gqlSchema, `{ items { id altKind(deleted: EXCLUDE) { id } } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data?.['items'] as any[]).find((i) => i.id === 2).altKind).toBeNull();
  });

  it('leaves a table that declares nothing alone', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(gqlSchema, `mutation { deleteAuthors(where: { id: { eq: 2 } }) { id } }`);

    expect(res.errors).toBeUndefined();
    // A real DELETE — the row is gone, not marked.
    expect(await rowsOf(Authors)).toHaveLength(1);

    const mutationFields = Object.keys(gqlSchema.getMutationType()!.getFields());
    expect(mutationFields).not.toContain('restoreAuthors');
    expect(mutationFields).toContain('restoreArticles');
    // And no `deleted` argument where there is nothing to hide.
    const authorsField = gqlSchema.getQueryType()!.getFields()['authors']!;
    expect(authorsField.args.map((arg) => arg.name)).not.toContain('deleted');
  });

  it('accepts a rule applied across the schema', async () => {
    // The convention form from the issue: every table with the column gets the behaviour.
    const gqlSchema = buildWith({
      softDelete: (table: any) => ('deletedAt' in table ? 'deletedAt' : undefined),
    });

    const res = await run(gqlSchema, `{ articles { id } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data?.['articles'] as any[]).map((a) => a.id)).toEqual([1, 2]);
    // Flags has no `deletedAt`, so the rule passes over it.
    expect(Object.keys(gqlSchema.getMutationType()!.getFields())).not.toContain('restoreFlags');
  });

  it('composes with a row scope: both predicates narrow the same read', async () => {
    const gqlSchema = buildWith({
      ...softDelete,
      scope: { Articles: (ctx: any, table: any) => eq(table.authorId, ctx.authorId) },
    });

    // Author 1 owns 1 and 2; nothing of theirs is marked.
    const mine = await run(gqlSchema, `{ articles { id } }`, { authorId: 1 });
    expect(mine.errors).toBeUndefined();
    expect((mine.data?.['articles'] as any[]).map((a) => a.id)).toEqual([1, 2]);

    // Author 2 owns only the marked article, so even INCLUDE stays inside the scope.
    const theirs = await run(gqlSchema, `{ articles(deleted: INCLUDE) { id } }`, { authorId: 2 });
    expect((theirs.data?.['articles'] as any[]).map((a) => a.id)).toEqual([3]);
    const theirsDefault = await run(gqlSchema, `{ articles { id } }`, { authorId: 2 });
    expect(theirsDefault.data?.['articles']).toEqual([]);
  });

  it('rejects a declaration that does not match the schema', () => {
    expect(() => buildWith({ softDelete: { Nope: 'deletedAt' } })).toThrow(/not a table in the Drizzle schema/);
    expect(() => buildWith({ softDelete: { Articles: 'goneAt' } })).toThrow(/not a column of that table/);
    // A NOT NULL column has no "absent" state, so both values have to be spelled out.
    // A NOT NULL boolean is the one shape that needs no values spelled out: true means
    // deleted, false means live. Anything else has to say both.
    expect(() => buildWith({ softDelete: { Flags: 'label' } })).toThrow(/must be a constant that means deleted/);
    expect(() => buildWith({ softDelete: { Flags: { column: 'label', deletedValue: () => 'gone' } } })).toThrow(
      /must be a constant that means deleted/,
    );
    expect(() => buildWith({ softDelete: { Flags: { column: 'label', deletedValue: 'gone' } } })).toThrow(
      /must say what restoring writes back/,
    );
    expect(() => buildWith({ softDelete: { Articles: { column: 'deletedAt', scope: 'relations' as any } } })).toThrow(
      /scope must be 'root' or 'all'/,
    );
  });
});
