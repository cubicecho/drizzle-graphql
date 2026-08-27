import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql, isScalarType } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  deletedAt: timestamp('deleted_at'),
});

const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title').notNull(),
  views: integer('views').notNull(),
});

const tables = { Users, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: { posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }) },
  Posts: { author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id, optional: false }) },
});

const DATA_DIR = `./tests/.temp/pgdata-type-naming-${Date.now()}`;
let pglite: PGlite;
let db: any;
let prefixed: GraphQLSchema;

const run = (schema: GraphQLSchema, source: string) => graphql({ schema, source, contextValue: {} });

/** Every type the build produced that is not a scalar, a root, or introspection. */
const generatedNames = (schema: GraphQLSchema) =>
  Object.entries(schema.getTypeMap())
    .filter(([name, type]) => !name.startsWith('__') && !isScalarType(type))
    .map(([name]) => name)
    .filter((name) => name !== 'Query' && name !== 'Mutation');

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema: { ...tables, relations }, relations });

  await db.execute(sql`CREATE TABLE "users" (
    "id" integer PRIMARY KEY,
    "name" text NOT NULL,
    "deleted_at" timestamp
  );`);
  await db.execute(sql`CREATE TABLE "posts" (
    "id" integer PRIMARY KEY,
    "author_id" integer NOT NULL,
    "title" text NOT NULL,
    "views" integer NOT NULL
  );`);

  prefixed = buildSchema(db, {
    typeNamePrefix: 'Shop',
    softDelete: { Users: 'deletedAt' },
    features: { upsert: true, fieldUpdateOperations: true },
  }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "users", "posts";`);
  await db.execute(sql`INSERT INTO "users" VALUES (1, 'ada', NULL), (2, 'bob', NULL);`);
  await db.execute(sql`INSERT INTO "posts" VALUES
    (1, 1, 'first', 10),
    (2, 1, 'second', 4),
    (3, 2, 'third', 7);`);
});

describe.sequential('generated type names', () => {
  it('leaves a default build alone', () => {
    const bare = buildSchema(db).schema;
    expect(bare.getTypeMap()['Users']).toBeDefined();
    expect(bare.getTypeMap()['UsersFilters']).toBeDefined();
    expect(bare.getTypeMap()['ShopUsers']).toBeUndefined();
  });

  it('prefixes every type it generates, not just the tables', () => {
    const unprefixed = generatedNames(prefixed).filter((name) => !name.startsWith('Shop'));
    expect(unprefixed).toEqual([]);

    // The derived types issue #93 named, spelled out rather than only counted.
    for (const name of [
      'ShopUsers',
      'ShopUsersFilters',
      'ShopUsersOrderBy',
      'ShopUsersAggregate',
      'ShopUsersGroupBy',
      'ShopUsersHaving',
      'ShopCreateUsersInput',
      'ShopUpdateUsersInput',
      'ShopUsersDistinctColumn',
      'ShopPostsListRelationFilter',
      'ShopStringFilter',
      'ShopInnerOrder',
      'ShopOrderNulls',
      'ShopDeletedFilter',
    ]) {
      expect(prefixed.getTypeMap()[name], name).toBeDefined();
    }
  });

  it('still reads rows, relations and aggregates through the renamed types', async () => {
    const res = await run(
      prefixed,
      `{
        users(orderBy: { id: { priority: 1, direction: asc } }) {
          id
          name
          posts(orderBy: { id: { priority: 1, direction: asc } }) { title }
        }
        usersSingle(where: { name: { eq: "bob" } }) { id }
        postsAggregate { count sum { views } max { views } }
      }`,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['users']).toEqual([
      { id: 1, name: 'ada', posts: [{ title: 'first' }, { title: 'second' }] },
      { id: 2, name: 'bob', posts: [{ title: 'third' }] },
    ]);
    expect(res.data?.['usersSingle']).toEqual({ id: 2 });
    expect(res.data?.['postsAggregate']).toEqual({ count: 3, sum: { views: 21 }, max: { views: 10 } });
  });

  it('still groups through the renamed types', async () => {
    const res = await run(prefixed, `{ postsGroupBy(groupBy: [authorId]) { group { authorId } count } }`);

    expect(res.errors).toBeUndefined();
    expect(
      [...((res.data?.['postsGroupBy'] as any[]) ?? [])].sort((a, b) => a.group.authorId - b.group.authorId),
    ).toEqual([
      { group: { authorId: 1 }, count: 2 },
      { group: { authorId: 2 }, count: 1 },
    ]);
  });

  it('still writes through the renamed types', async () => {
    const created = await run(
      prefixed,
      `mutation { createPostsSingle(values: { id: 9, authorId: 1, title: "new", views: 0 }) {
        id
        author { name }
      } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data?.['createPostsSingle']).toEqual({ id: 9, author: { name: 'ada' } });

    const updated = await run(
      prefixed,
      `mutation { updatePostsSingle(where: { id: { eq: 9 } }, set: { views: { increment: 5 } }) { views } }`,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.['updatePostsSingle']).toEqual({ views: 5 });

    const deleted = await run(prefixed, `mutation { deleteUsersSingle(where: { id: { eq: 2 } }) { id name } }`);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data?.['deleteUsersSingle']).toEqual({ id: 2, name: 'bob' });

    const remaining = await run(prefixed, `{ users { id } }`);
    expect(remaining.data?.['users']).toEqual([{ id: 1 }]);

    const restored = await run(prefixed, `mutation { restoreUsersSingle(where: { id: { eq: 2 } }) { id } }`);
    expect(restored.errors).toBeUndefined();
    expect(restored.data?.['restoreUsersSingle']).toEqual({ id: 2 });
  });

  it('suffixes instead, when that is what the caller asked for', () => {
    const suffixed = buildSchema(db, { typeNameSuffix: '_v2' }).schema;

    expect(suffixed.getTypeMap()['Users_v2']).toBeDefined();
    expect(suffixed.getTypeMap()['UsersFilters_v2']).toBeDefined();
    expect(suffixed.getTypeMap()['InnerOrder_v2']).toBeDefined();
    expect(generatedNames(suffixed).filter((name) => !name.endsWith('_v2'))).toEqual([]);
  });

  it('lets a mapper answer for one kind and decline for the rest', () => {
    const mapped = buildSchema(db, {
      typeNamePrefix: 'Shop',
      derivedTypeNameMapper: (info) => (info.kind === 'filter' ? `${info.table}Where` : undefined),
    }).schema;

    // The mapper's answer is taken verbatim — the prefix is the fallback, not a wrapper.
    expect(mapped.getTypeMap()['UsersWhere']).toBeDefined();
    expect(mapped.getTypeMap()['ShopUsersWhere']).toBeUndefined();
    expect(mapped.getTypeMap()['ShopUsersFilters']).toBeUndefined();
    // Everything it declined still follows the prefix.
    expect(mapped.getTypeMap()['ShopUsers']).toBeDefined();
    expect(mapped.getTypeMap()['ShopUsersOrderBy']).toBeDefined();
  });

  it('rejects an affix that is not a usable name fragment', () => {
    expect(() => buildSchema(db, { typeNamePrefix: '1Shop' })).toThrow(/typeNamePrefix/);
    expect(() => buildSchema(db, { typeNameSuffix: 'v 2' })).toThrow(/typeNameSuffix/);
  });
});
