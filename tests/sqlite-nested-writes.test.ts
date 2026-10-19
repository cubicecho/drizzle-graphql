import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, type WriteHookPayload } from '@/index';

const Authors = sqliteTable('authors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});

const Tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});
const PostsToTags = sqliteTable(
  'posts_to_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);

const r = createRelationsHelper({ Authors, Posts, Tags, PostsToTags });
const relations = buildRelations(
  { Authors, Posts, Tags, PostsToTags },
  {
    Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
    Posts: {
      author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }),
      tags: r.many.Tags({ from: r.Posts.id.through(r.PostsToTags.postId), to: r.Tags.id.through(r.PostsToTags.tagId) }),
    },
    Tags: {
      posts: r.many.Posts({
        from: r.Tags.id.through(r.PostsToTags.tagId),
        to: r.Posts.id.through(r.PostsToTags.postId),
      }),
    },
  },
);
const schema = { Authors, Posts, Tags, PostsToTags, relations };

let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });
const posts = () => db.select().from(Posts).orderBy(Posts.id);
const authors = () => db.select().from(Authors).orderBy(Authors.id);
const links = async () =>
  (await db.select().from(PostsToTags).orderBy(PostsToTags.postId, PostsToTags.tagId)).map(
    (row: any) => `${row.postId}:${row.tagId}`,
  );

beforeAll(async () => {
  // Shared cache rather than a plain `:memory:`: a nested write runs its statements on a
  // transaction, which libsql serves from a second connection — one that would otherwise
  // open an empty database of its own.
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "authors" (
		"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
		"name" text NOT NULL
	);`);
  await db.run(sql`CREATE TABLE "posts" (
		"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
		"author_id" integer,
		"title" text NOT NULL
	);`);
  await db.run(sql`CREATE TABLE "tags" (
		"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
		"name" text NOT NULL
	);`);
  await db.run(sql`CREATE TABLE "posts_to_tags" (
		"post_id" integer NOT NULL,
		"tag_id" integer NOT NULL,
		PRIMARY KEY ("post_id", "tag_id")
	);`);

  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "posts_to_tags"`);
  await db.run(sql`DELETE FROM "posts"`);
  await db.run(sql`DELETE FROM "tags"`);
  await db.run(sql`DELETE FROM "authors"`);
  await db.run(sql`DELETE FROM "sqlite_sequence"`);
});

describe.sequential('SQLite nested writes', () => {
  it('is opt-in', () => {
    const defaults = buildSchema(db).schema;

    expect((defaults.getType('CreateAuthorsInput') as GraphQLInputObjectType).getFields()['posts']).toBeUndefined();
  });

  it('adds the relation fields to the create and update inputs', () => {
    const create = (gqlSchema.getType('CreateAuthorsInput') as GraphQLInputObjectType).getFields();
    const update = (gqlSchema.getType('UpdateAuthorsInput') as GraphQLInputObjectType).getFields();

    expect(String(create['posts']!.type)).toBe('AuthorsPostsNestedCreateInput');
    expect(String(update['posts']!.type)).toBe('AuthorsPostsNestedUpdateInput');
  });

  it('creates and attaches children', async () => {
    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { create: [{ title: "First" }] } }) { id name posts { title } }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createAuthorsSingle: { id: 1, name: 'Ada', posts: [{ title: 'First' }] } });
    expect(await posts()).toEqual([{ id: 1, authorId: 1, title: 'First' }]);
  });

  it('writes the parent side first and points the new row at it', async () => {
    const result = await run(`mutation {
      createPostsSingle(values: { title: "Hello", author: { create: { name: "Grace" } } }) { authorId }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).createPostsSingle.authorId).toBe(1);
  });

  it('replaces the whole set on update', async () => {
    await db.insert(Authors).values({ name: 'Ada' });
    await db.insert(Posts).values([{ title: 'A1', authorId: 1 }, { title: 'Free' }]);

    const result = await run(`mutation {
      updateAuthorsSingle(where: { id: { eq: 1 } }, set: { posts: { set: [{ title: { eq: "Free" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts()).map((p: any) => p.authorId)).toEqual([null, 1]);
  });

  it('gives each entry of a batch update its own nested operations', async () => {
    await db.insert(Authors).values([{ name: 'Ada' }, { name: 'Grace' }]);
    await db.insert(Posts).values([{ title: 'Free' }]);

    const result = await run(`mutation {
      updateAuthorsMany(updates: [
        { where: { id: { eq: 1 } }, set: { name: "Ada L" } },
        { where: { id: { eq: 2 } }, set: { posts: { connect: [{ title: { eq: "Free" } }] } } }
      ]) { id name }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await posts())[0].authorId).toBe(2);
    expect((await authors())[0].name).toBe('Ada L');
  });

  it('rolls the whole write back when a nested operation fails', async () => {
    const result = await run(`mutation {
      createAuthorsSingle(values: { name: "Ada", posts: { connect: [{}] } }) { id }
    }`);

    expect(result.errors?.[0]?.message).toMatch(/matches everything/);
    expect(await authors()).toHaveLength(0);
  });
});

describe.sequential('SQLite nested writes through a junction table', () => {
  beforeEach(async () => {
    await db.insert(Posts).values([{ title: 'First' }, { title: 'Second' }]);
    await db.insert(Tags).values([{ name: 'news' }, { name: 'draft' }]);
  });

  it('offers connect, disconnect and set, and no create', () => {
    const ops = (gqlSchema.getType('PostsTagsNestedUpdateInput') as GraphQLInputObjectType).getFields();

    expect(Object.keys(ops).sort()).toEqual(['connect', 'disconnect', 'set']);
  });

  it('inserts junction rows for the rows a connect matched', async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { connect: [{ id: { gt: 0 } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:1', '1:2']);
  });

  it('skips a link that already exists rather than failing on the primary key', async () => {
    // SQLite has no shared upsert syntax with the other dialects, so the runtime reads the
    // existing links first and inserts only what is missing.
    await db.insert(PostsToTags).values({ postId: 1, tagId: 1 });

    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { connect: [{ id: { gt: 0 } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:1', '1:2']);
  });

  it(`replaces the set and deletes only this row's links`, async () => {
    await db.insert(PostsToTags).values([
      { postId: 1, tagId: 1 },
      { postId: 2, tagId: 1 },
    ]);

    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { set: [{ name: { eq: "draft" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:2', '2:1']);
  });

  it('rolls the links back with the rest of the write', async () => {
    const result = await run(`mutation {
      createPostsSingle(values: { title: "Third", tags: { connect: [{ name: { eq: "news" } }, {}] } }) { id }
    }`);

    expect(result.errors).toBeDefined();
    expect(await posts()).toHaveLength(2);
    expect(await links()).toEqual([]);
  });
});

// ── the child table's own write rules ────────────────────────────────────────

type HookCall = {
  table: string;
  operation: string;
  position: string;
  nested: WriteHookPayload['nested'];
  rows: any[];
};

/** A global hook that records every call, so a test can read what fired, where, and in what order. */
const recorder = () => {
  const calls: HookCall[] = [];
  const hook = (payload: WriteHookPayload) => {
    calls.push({
      table: payload.table,
      operation: payload.operation,
      position: payload.position,
      nested: payload.nested,
      rows: payload.rows,
    });
  };
  return { calls, onWrite: { before: hook, after: hook } };
};

const runOn = (target: GraphQLSchema, source: string) => graphql({ schema: target, source, contextValue: {} });
const fieldsOf = (target: GraphQLSchema, name: string) =>
  (target.getType(name) as GraphQLInputObjectType | undefined)?.getFields();

describe.sequential("SQLite nested writes run the child table's onWrite hooks", () => {
  it('fires the target table hooks for a nested create, with the nested origin', async () => {
    const { calls, onWrite } = recorder();
    const hooked = buildSchema(db, { features: { nestedWrites: true }, onWrite }).schema;

    const result = await runOn(
      hooked,
      `mutation { createAuthorsSingle(values: { name: "Ada", posts: { create: [{ title: "A" }, { title: "B" }] } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    const origin = { parentTable: 'Authors', relation: 'posts', op: 'create' };
    expect(calls).toEqual([
      { table: 'Authors', operation: 'insert', position: 'before', nested: undefined, rows: [] },
      { table: 'Posts', operation: 'insert', position: 'before', nested: origin, rows: [] },
      {
        table: 'Posts',
        operation: 'insert',
        position: 'after',
        nested: origin,
        // One call for the statement, with the target's key and join column on every row.
        rows: [
          { id: 1, authorId: 1 },
          { id: 2, authorId: 1 },
        ],
      },
      { table: 'Authors', operation: 'insert', position: 'after', nested: undefined, rows: [{ id: 1 }] },
    ]);
  });

  it('fires the target hooks for a parent-side create, ahead of the parent row', async () => {
    const { calls, onWrite } = recorder();
    const hooked = buildSchema(db, { features: { nestedWrites: true }, onWrite }).schema;

    const result = await runOn(
      hooked,
      `mutation { createPostsSingle(values: { title: "Hello", author: { create: { name: "Grace" } } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(calls.map((c) => `${c.table}.${c.operation}.${c.position}.${c.nested?.op ?? 'root'}`)).toEqual([
      'Posts.insert.before.root',
      'Authors.insert.before.create',
      'Authors.insert.after.create',
      'Posts.insert.after.root',
    ]);
    expect(calls[2]!.nested).toEqual({ parentTable: 'Posts', relation: 'author', op: 'create' });
    expect(calls[2]!.rows).toEqual([{ id: 1 }]);
  });

  it('reports connect, disconnect and set as updates of the target', async () => {
    await db.insert(Authors).values({ name: 'Ada' });
    await db.insert(Posts).values([{ title: 'Mine', authorId: 1 }, { title: 'Free' }, { title: 'Other' }]);
    const { calls, onWrite } = recorder();
    const hooked = buildSchema(db, { features: { nestedWrites: true }, onWrite }).schema;

    const result = await runOn(
      hooked,
      `mutation { updateAuthorsSingle(where: { id: { eq: 1 } }, set: { posts: {
        disconnect: [{ title: { eq: "Mine" } }], connect: [{ title: { eq: "Free" } }]
      } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    const nested = calls.filter((c) => c.nested);
    expect(nested.map((c) => `${c.table}.${c.operation}.${c.position}.${c.nested!.op}`)).toEqual([
      'Posts.update.before.disconnect',
      'Posts.update.before.connect',
      'Posts.update.after.disconnect',
      'Posts.update.after.connect',
    ]);
    expect(nested[2]!.rows).toEqual([{ id: 1, authorId: null }]);
    expect(nested[3]!.rows).toEqual([{ id: 2, authorId: 1 }]);

    calls.length = 0;
    const replaced = await runOn(
      hooked,
      `mutation { updateAuthorsSingle(where: { id: { eq: 1 } }, set: { posts: { set: [{ title: { eq: "Other" } }] } }) { id } }`,
    );
    expect(replaced.errors).toBeUndefined();
    // `set` detaches everything, then attaches what it matched — both are this one update.
    const setAfter = calls.find((c) => c.nested?.op === 'set' && c.position === 'after')!;
    expect(setAfter.operation).toBe('update');
    expect(setAfter.rows).toEqual([
      { id: 2, authorId: null },
      { id: 3, authorId: 1 },
    ]);
  });

  it("fires the junction table's insert and delete hooks for a many-to-many link and unlink", async () => {
    await db.insert(Posts).values([{ title: 'First' }]);
    await db.insert(Tags).values([{ name: 'news' }, { name: 'draft' }]);
    await db.insert(PostsToTags).values({ postId: 1, tagId: 1 });
    const { calls, onWrite } = recorder();
    const hooked = buildSchema(db, { features: { nestedWrites: true }, onWrite }).schema;

    const result = await runOn(
      hooked,
      `mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: {
        disconnect: [{ name: { eq: "news" } }], connect: [{ name: { eq: "draft" } }]
      } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    const nested = calls.filter((c) => c.nested && c.position === 'after');
    expect(nested).toEqual([
      {
        table: 'PostsToTags',
        operation: 'delete',
        position: 'after',
        nested: { parentTable: 'Posts', relation: 'tags', op: 'disconnect' },
        rows: [{ postId: 1, tagId: 1 }],
      },
      {
        table: 'PostsToTags',
        operation: 'insert',
        position: 'after',
        nested: { parentTable: 'Posts', relation: 'tags', op: 'connect' },
        rows: [{ postId: 1, tagId: 2 }],
      },
    ]);
    // The target rows themselves are not written by a link, so their hooks stay quiet.
    expect(calls.some((c) => c.table === 'Tags')).toBe(false);
  });

  it("adds the hook's columns to a nested statement's rows", async () => {
    const rows: any[][] = [];
    const hooked = buildSchema(db, {
      features: { nestedWrites: true },
      onWrite: { Posts: { after: (payload) => void rows.push(payload.rows), columns: ['title'] } },
    }).schema;

    const result = await runOn(
      hooked,
      `mutation { createAuthorsSingle(values: { name: "Ada", posts: { create: [{ title: "A" }] } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(rows).toEqual([[{ id: 1, authorId: 1, title: 'A' }]]);
  });

  it('rolls the parent row back when a child hook throws', async () => {
    const hooked = buildSchema(db, {
      features: { nestedWrites: true },
      // Unexpected errors are masked by default; pass them through to see which one it was.
      onError: (error: unknown) => error as Error,
      onWrite: {
        Posts: {
          after: ({ nested }) => {
            if (nested) {
              throw new Error('no nested posts');
            }
          },
        },
      },
    }).schema;

    const result = await runOn(
      hooked,
      `mutation { createAuthorsSingle(values: { name: "Ada", posts: { create: [{ title: "A" }] } }) { id } }`,
    );

    expect(result.errors?.[0]?.message).toMatch(/no nested posts/);
    expect(await authors()).toEqual([]);
    expect(await posts()).toEqual([]);
  });

  it('only hands a connect hook the rows inside the target scope', async () => {
    await db.insert(Authors).values({ name: 'Ada' });
    await db.insert(Posts).values([{ title: 'Open' }, { title: 'Secret' }]);
    const { calls, onWrite } = recorder();
    const hooked = buildSchema(db, {
      features: { nestedWrites: true },
      onWrite,
      scope: { Posts: () => ({ title: { ne: 'Secret' } }) },
    }).schema;

    const result = await runOn(
      hooked,
      `mutation { updateAuthorsSingle(where: { id: { eq: 1 } }, set: { posts: { connect: [{ id: { gt: 0 } }] } }) { id } }`,
    );

    expect(result.errors).toBeUndefined();
    expect((await posts()).map((p: any) => p.authorId)).toEqual([1, null]);
    expect(calls.find((c) => c.nested && c.position === 'after')!.rows).toEqual([{ id: 1, authorId: 1 }]);
  });
});

describe.sequential("SQLite nested inputs follow the target table's features", () => {
  it("drops create when the target's insert is off, and keeps connect", () => {
    const gated = buildSchema(db, { features: { nestedWrites: true, insert: (t) => t !== 'Posts' } }).schema;

    expect(Object.keys(fieldsOf(gated, 'AuthorsPostsNestedCreateInput')!)).toEqual(['connect']);
    expect(Object.keys(fieldsOf(gated, 'AuthorsPostsNestedUpdateInput')!).sort()).toEqual([
      'connect',
      'disconnect',
      'set',
    ]);
  });

  it("drops connect, disconnect and set when the target's update is off", () => {
    const gated = buildSchema(db, { features: { nestedWrites: true, update: (t) => t !== 'Posts' } }).schema;

    expect(Object.keys(fieldsOf(gated, 'AuthorsPostsNestedUpdateInput')!)).toEqual(['create']);
    // A parent-side connect only rewrites the parent's own column, so it needs nothing of the target.
    const author = Object.keys(fieldsOf(gated, 'PostsAuthorNestedCreateInput')!).sort();
    expect(author).toEqual(['connect', 'create']);
  });

  it('leaves the relation out when nothing is left on it', () => {
    const gated = buildSchema(db, {
      features: { nestedWrites: true, insert: (t) => t !== 'Posts', update: (t) => t !== 'Posts' },
    }).schema;

    expect(fieldsOf(gated, 'CreateAuthorsInput')!['posts']).toBeUndefined();
    expect(fieldsOf(gated, 'UpdateAuthorsInput')!['posts']).toBeUndefined();
    expect(gated.getType('AuthorsPostsNestedCreateInput')).toBeUndefined();
  });

  it("follows the junction table's insert and delete for a many-to-many", () => {
    const noInsert = buildSchema(db, { features: { nestedWrites: true, insert: (t) => t !== 'PostsToTags' } }).schema;
    expect(Object.keys(fieldsOf(noInsert, 'PostsTagsNestedUpdateInput')!)).toEqual(['disconnect']);
    expect(fieldsOf(noInsert, 'CreatePostsInput')!['tags']).toBeUndefined();

    const noDelete = buildSchema(db, { features: { nestedWrites: true, delete: (t) => t !== 'PostsToTags' } }).schema;
    expect(Object.keys(fieldsOf(noDelete, 'PostsTagsNestedUpdateInput')!)).toEqual(['connect']);

    const excluded = buildSchema(db, { features: { nestedWrites: true }, exclude: { tables: ['PostsToTags'] } }).schema;
    expect(fieldsOf(excluded, 'UpdatePostsInput')!['tags']).toBeUndefined();
  });

  it('says at build time which nested inputs it left out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      buildSchema(db, { features: { nestedWrites: true, insert: (t) => t !== 'Posts' } });
      const messages = warn.mock.calls.map((args) => String(args[0]));
      expect(messages.some((m) => m.includes('nestedWrites') && m.includes('Authors.posts.create'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
