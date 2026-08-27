import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── A schema with a relation of every writable shape ──────────────────────────
// authors.posts     to-many, FK on the child, nullable  → create/connect/disconnect/set
// posts.author      to-one, FK on the parent, nullable  → create/connect/disconnect
// authors.profile   1:1, FK on the child, NOT NULL      → create/connect only
// posts.comments    to-many, FK on the child, NOT NULL  → create/connect only
// comments.post     to-one, FK on the parent, NOT NULL  → create/connect only
const Authors = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});
const Posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});
const Profiles = pgTable('profiles', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().unique(),
  bio: text('bio'),
});
const Comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  postId: integer('post_id').notNull(),
  body: text('body').notNull(),
});

const r = createRelationsHelper({ Authors, Posts, Profiles, Comments });
const relations = buildRelations(
  { Authors, Posts, Profiles, Comments },
  {
    Authors: {
      posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }),
      profile: r.one.Profiles({ from: r.Authors.id, to: r.Profiles.authorId }),
    },
    Posts: {
      author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }),
      comments: r.many.Comments({ from: r.Posts.id, to: r.Comments.postId }),
    },
    Profiles: { author: r.one.Authors({ from: r.Profiles.authorId, to: r.Authors.id }) },
    Comments: { post: r.one.Posts({ from: r.Comments.postId, to: r.Posts.id }) },
  },
);
const schema = { Authors, Posts, Profiles, Comments, relations };

const DATA_DIR = `./tests/.temp/pgdata-nested-writes-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const posts = () => db.select().from(Posts).orderBy(Posts.id);
const authors = () => db.select().from(Authors).orderBy(Authors.id);
const inFields = (typeName: string) => (gqlSchema.getType(typeName) as GraphQLInputObjectType).getFields();

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "authors" ("id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "posts" (
		"id" serial PRIMARY KEY NOT NULL,
		"author_id" integer,
		"title" text NOT NULL
	);`);
  await db.execute(sql`CREATE TABLE "profiles" (
		"id" serial PRIMARY KEY NOT NULL,
		"author_id" integer NOT NULL UNIQUE,
		"bio" text
	);`);
  await db.execute(sql`CREATE TABLE "comments" (
		"id" serial PRIMARY KEY NOT NULL,
		"post_id" integer NOT NULL,
		"body" text NOT NULL
	);`);

  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "authors", "posts", "profiles", "comments" RESTART IDENTITY`);
});

describe.sequential('nested writes: generated surface', () => {
  it('adds nothing unless the feature is switched on', () => {
    const defaults = buildSchema(db).schema;

    expect((defaults.getType('CreateAuthorsInput') as GraphQLInputObjectType).getFields()['posts']).toBeUndefined();
    expect((defaults.getType('UpdatePostsInput') as GraphQLInputObjectType).getFields()['author']).toBeUndefined();
    expect(defaults.getType('AuthorsPostsNestedCreateInput')).toBeUndefined();
  });

  it('offers create and connect on the create input, and nothing that detaches', () => {
    const nested = inFields('CreateAuthorsInput')['posts']!;
    expect(String(nested.type)).toBe('AuthorsPostsNestedCreateInput');

    const ops = inFields('AuthorsPostsNestedCreateInput');
    expect(Object.keys(ops).sort()).toEqual(['connect', 'create']);
    expect(String(ops['create']!.type)).toBe('[AuthorsPostsNestedCreatePayloadInput!]');
    expect(String(ops['connect']!.type)).toBe('[PostsFilters!]');
  });

  it('offers disconnect and set on the update input when the join column is nullable', () => {
    const ops = inFields('AuthorsPostsNestedUpdateInput');

    expect(Object.keys(ops).sort()).toEqual(['connect', 'create', 'disconnect', 'set']);
    expect(String(ops['set']!.type)).toBe('[PostsFilters!]');
  });

  it('offers neither when the join column is NOT NULL, since nothing can be detached', () => {
    // profiles.author_id and comments.post_id are both NOT NULL.
    expect(Object.keys(inFields('AuthorsProfileNestedUpdateInput')).sort()).toEqual(['connect', 'create']);
    expect(Object.keys(inFields('PostsCommentsNestedUpdateInput')).sort()).toEqual(['connect', 'create']);
  });

  it('takes a single row, not a list, for a to-one relation', () => {
    const ops = inFields('PostsAuthorNestedUpdateInput');

    expect(String(ops['create']!.type)).toBe('PostsAuthorNestedCreatePayloadInput');
    expect(String(ops['connect']!.type)).toBe('AuthorsFilters');
    expect(String(ops['disconnect']!.type)).toBe('Boolean');
  });

  it('leaves the join column out of the payload the child side inserts', () => {
    // The row is attached to the parent being written, so pointing it elsewhere by hand
    // would contradict the write it is part of.
    expect(inFields('AuthorsPostsNestedCreatePayloadInput')['authorId']).toBeUndefined();
    expect(inFields('AuthorsPostsNestedCreatePayloadInput')['title']).toBeDefined();
  });

  it('keeps the join column on a parent-side payload, which writes a different table', () => {
    expect(inFields('PostsAuthorNestedCreatePayloadInput')['name']).toBeDefined();
    expect(inFields('PostsAuthorNestedCreatePayloadInput')['id']).toBeDefined();
  });

  it('keeps the payload out of the root input namespace', () => {
    // `item.type` used to spell `CreateItemTypeInput`, which is also the create input of a
    // sibling table named `itemType` — two types of one name, and a schema that cannot be
    // built. `nestedWrites` is a whole-schema flag, so one such pair made it unusable.
    const ItemType = pgTable('item_type', {
      id: text('id').primaryKey(),
      label: text('label').notNull(),
    });
    const Item = pgTable('item', {
      id: text('id').primaryKey(),
      typeId: text('type_id').notNull(),
    });
    const rel = createRelationsHelper({ Item, ItemType });
    const collidingRelations = buildRelations(
      { Item, ItemType },
      {
        ItemType: { items: rel.many.Item({ from: rel.ItemType.id, to: rel.Item.typeId }) },
        Item: { type: rel.one.ItemType({ from: rel.Item.typeId, to: rel.ItemType.id, optional: false }) },
      },
    );
    const collidingSchema = { Item, ItemType, relations: collidingRelations };
    const collidingDb = (drizzle as any)({ client: pglite, schema: collidingSchema, relations: collidingRelations });

    const built = buildSchema(collidingDb, { features: { nestedWrites: true } }).schema;

    expect(built.getType('ItemTypeNestedCreatePayloadInput')).toBeDefined();
    // The table's own create input is a different type, and still its own.
    const rootInput = built.getType('CreateItemTypeInput') as GraphQLInputObjectType;
    expect(Object.keys(rootInput.getFields()).sort()).toEqual(['id', 'items', 'label']);
  });

  it('relaxes a required join column the relation can fill in instead', () => {
    // comments.post_id is NOT NULL, but `post: { create: … }` supplies it.
    expect(String(inFields('CreateCommentsInput')['postId']!.type)).toBe('Int');
    expect(String(inFields('CreateCommentsInput')['body']!.type)).toBe('String!');
    // A column no relation writes keeps its NOT NULL.
    expect(String(inFields('CreatePostsInput')['title']!.type)).toBe('String!');
  });
});

describe.sequential('nested writes: create', () => {
  it('inserts the children of a new row and attaches them', async () => {
    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { create: [{ title: "First" }, { title: "Second" }] } }) {
        id name
      }
    }`);

    expect(result.errors).toBeUndefined();
    const authorId = (result.data as any).createAuthorsSingle.id;
    expect(await posts()).toEqual([
      { id: 1, authorId, title: 'First' },
      { id: 2, authorId, title: 'Second' },
    ]);
  });

  it('attaches existing rows a connect filter matches', async () => {
    await db.insert(Posts).values([{ title: 'Orphan A' }, { title: 'Orphan B' }, { title: 'Untouched' }]);

    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { connect: [{ title: { like: "Orphan%" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    const authorId = (result.data as any).createAuthorsSingle.id;
    expect((await posts()).map((p: any) => p.authorId)).toEqual([authorId, authorId, null]);
  });

  it('writes the parent side first and points the new row at it', async () => {
    const result = await run(`mutation {
      createPostsSingle(values: { title: "Hello", author: { create: { name: "Grace" } } }) { id authorId }
    }`);

    expect(result.errors).toBeUndefined();
    const [author] = await authors();
    expect((result.data as any).createPostsSingle.authorId).toBe(author.id);
  });

  it('connects the parent side to an existing row', async () => {
    await db.insert(Authors).values([{ name: 'Grace' }, { name: 'Ada' }]);

    const result = await run(`mutation {
      createPostsSingle(values: { title: "Hello", author: { connect: { name: { eq: "Ada" } } } }) { authorId }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).createPostsSingle.authorId).toBe(2);
  });

  it('rejects a to-one connect that does not match exactly one row', async () => {
    await db.insert(Authors).values([{ name: 'Ada' }, { name: 'Ada' }]);

    const result = await run(`mutation {
      createPostsSingle(values: { title: "Hello", author: { connect: { name: { eq: "Ada" } } } }) { id }
    }`);

    expect(result.errors?.[0]?.message).toMatch(/matched 2 rows/);
    expect(await posts()).toHaveLength(0);
  });

  it('rejects a filter that would match everything', async () => {
    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { connect: [{}] } }) { id }
    }`);

    expect(result.errors?.[0]?.message).toMatch(/matches everything/);
    expect(await authors()).toHaveLength(0);
  });

  it('rolls the whole write back when a nested insert fails', async () => {
    // `title` is NOT NULL in the database; the payload type lets the second row omit it only
    // because the failure has to come from the write itself for this to prove anything.
    const result = await run(`mutation ($v: CreateAuthorsInput!) { createAuthorsSingle(values: $v) { id } }`, {
      v: { name: 'Ada', posts: { create: [{ title: 'ok' }, { title: null }] } },
    });

    expect(result.errors).toBeDefined();
    expect(await authors()).toHaveLength(0);
    expect(await posts()).toHaveLength(0);
  });

  it('writes each row of a batch with its own children', async () => {
    const result = await run(`mutation {
      createAuthors(values: [
        { name: "Ada", posts: { create: [{ title: "A1" }] } },
        { name: "Grace", posts: { create: [{ title: "G1" }, { title: "G2" }] } }
      ]) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    const rows = await posts();
    expect(rows.map((p: any) => p.title)).toEqual(['A1', 'G1', 'G2']);
    expect(rows[0].authorId).toBe(1);
    expect(rows[1].authorId).toBe(2);
    expect(rows[2].authorId).toBe(2);
  });

  it('leaves the plain batch path alone when nothing is nested', async () => {
    const result = await run(`mutation {
      createAuthors(values: [{ name: "Ada" }, { name: "Grace" }]) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).createAuthors).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]);
  });
});

describe.sequential('nested writes: update', () => {
  beforeEach(async () => {
    await db.insert(Authors).values([{ name: 'Ada' }, { name: 'Grace' }]);
    await db.insert(Posts).values([
      { title: 'A1', authorId: 1 },
      { title: 'A2', authorId: 1 },
      { title: 'Free', authorId: null },
    ]);
  });

  it('creates and attaches new children alongside a column change', async () => {
    const result = await run(`mutation {
      updateAuthorsSingle(where: { id: { eq: 1 } }, set: { name: "Ada L", posts: { create: [{ title: "A3" }] } }) {
        id name
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateAuthorsSingle.name).toBe('Ada L');
    expect((await posts()).map((p: any) => [p.title, p.authorId])).toEqual([
      ['A1', 1],
      ['A2', 1],
      ['Free', null],
      ['A3', 1],
    ]);
  });

  it('accepts a set that only writes through a relation', async () => {
    const result = await run(`mutation {
      updateAuthorsSingle(where: { id: { eq: 2 } }, set: { posts: { connect: [{ title: { eq: "Free" } }] } }) {
        id name
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateAuthorsSingle).toEqual({ id: 2, name: 'Grace' });
    expect((await posts())[2].authorId).toBe(2);
  });

  it('still rejects a set with neither columns nor relations', async () => {
    const result = await run(`mutation { updateAuthorsSingle(where: { id: { eq: 1 } }, set: {}) { id } }`);

    expect(result.errors?.[0]?.message).toMatch(/no values specified/);
  });

  it('detaches the rows disconnect matches and leaves them in place', async () => {
    const result = await run(`mutation {
      updateAuthorsSingle(where: { id: { eq: 1 } }, set: { posts: { disconnect: [{ title: { eq: "A1" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts()).map((p: any) => p.authorId)).toEqual([null, 1, null]);
  });

  it('replaces the whole set', async () => {
    const result = await run(`mutation {
      updateAuthorsSingle(where: { id: { eq: 1 } }, set: { posts: { set: [{ title: { eq: "Free" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts()).map((p: any) => p.authorId)).toEqual([null, null, 1]);
  });

  it('applies set before create, so a row created in the same write survives it', async () => {
    const result = await run(`mutation {
      updateAuthorsSingle(
        where: { id: { eq: 1 } }
        set: { posts: { set: [{ title: { eq: "Free" } }], create: [{ title: "New" }] } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts()).map((p: any) => [p.title, p.authorId])).toEqual([
      ['A1', null],
      ['A2', null],
      ['Free', 1],
      ['New', 1],
    ]);
  });

  it('disconnects a to-one relation with a boolean', async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { title: { eq: "A1" } }, set: { author: { disconnect: true } }) { id authorId }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).updatePostsSingle.authorId).toBeNull();
  });

  it('repoints a to-one relation at another row', async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { title: { eq: "A1" } }, set: { author: { connect: { name: { eq: "Grace" } } } }) {
        authorId
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).updatePostsSingle.authorId).toBe(2);
  });

  it('rejects two operations at once on a to-one relation', async () => {
    const result = await run(`mutation {
      updatePostsSingle(
        where: { title: { eq: "A1" } }
        set: { author: { connect: { name: { eq: "Grace" } }, disconnect: true } }
      ) { id }
    }`);

    expect(result.errors?.[0]?.message).toMatch(/one of connect, disconnect at a time/);
    expect((await posts())[0].authorId).toBe(1);
  });

  it('applies the operations to every row the where matched', async () => {
    const result = await run(`mutation {
      updatePosts(where: { authorId: { eq: 1 } }, set: { author: { connect: { name: { eq: "Grace" } } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts()).map((p: any) => p.authorId)).toEqual([2, 2, null]);
  });

  it('rolls back when a nested operation fails partway through', async () => {
    const result = await run(`mutation {
      updateAuthorsSingle(
        where: { id: { eq: 1 } }
        set: { name: "Renamed", posts: { connect: [{ title: { eq: "Free" } }, {}] } }
      ) { id }
    }`);

    expect(result.errors).toBeDefined();
    expect((await authors())[0].name).toBe('Ada');
    expect((await posts())[2].authorId).toBeNull();
  });
});

describe.sequential('nested writes: updateMany', () => {
  beforeEach(async () => {
    await db.insert(Authors).values([{ name: 'Ada' }, { name: 'Grace' }]);
    await db.insert(Posts).values([{ title: 'A1', authorId: 1 }, { title: 'Free' }]);
  });

  it('gives each entry its own nested operations', async () => {
    const result = await run(`mutation {
      updateAuthorsMany(updates: [
        { where: { id: { eq: 1 } }, set: { name: "Ada L" } },
        { where: { id: { eq: 2 } }, set: { posts: { connect: [{ title: { eq: "Free" } }] } } }
      ]) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateAuthorsMany).toEqual([
      { id: 1, name: 'Ada L' },
      { id: 2, name: 'Grace' },
    ]);
    expect((await posts())[1].authorId).toBe(2);
  });
});

describe.sequential('nested writes: relation output', () => {
  it('returns the children it just wrote', async () => {
    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { create: [{ title: "First" }] } }) {
        name
        posts { title }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createAuthorsSingle: { name: 'Ada', posts: [{ title: 'First' }] } });
  });
});
