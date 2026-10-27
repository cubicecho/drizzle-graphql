import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, type WriteHookPayload } from '@/index';

// Issue #219: an upsert's relation fields offer what an update's do, so one upsert can save a
// form whose row may or may not exist yet.
//
// authors.posts    to-many, FK on the child, nullable  → create/connect/disconnect/set
// posts.author     to-one, FK on the parent, nullable  → create/connect/disconnect
// posts.tags       many-to-many through posts_to_tags  → connect/disconnect/set
// shownPosts       to-many with a `where` on the target
const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  deletedAt: timestamp('deleted_at'),
});
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id'),
  title: text('title').notNull(),
});
const Tags = pgTable('tags', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const PostsToTags = pgTable(
  'posts_to_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);
const Notes = pgTable('notes', {
  id: integer('id').primaryKey(),
  pinnedId: integer('pinned_id'),
  body: text('body').notNull(),
});
const Pins = pgTable('pins', {
  id: integer('id').primaryKey(),
  visible: integer('visible').notNull(),
});

const r = createRelationsHelper({ Authors, Posts, Tags, PostsToTags, Notes, Pins });
const relations = buildRelations(
  { Authors, Posts, Tags, PostsToTags, Notes, Pins },
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
    // A parent-side to-one whose `where` filters the target.
    Notes: { pin: r.one.Pins({ from: r.Notes.pinnedId, to: r.Pins.id, where: { visible: 1 } }) },
  },
);
const schema = { Authors, Posts, Tags, PostsToTags, Notes, Pins, relations };

const DATA_DIR = `./tests/.temp/pgdata-nested-writes-upsert-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>, target: GraphQLSchema = gqlSchema) =>
  graphql({ schema: target, source, variableValues, contextValue: {} });

const inFields = (typeName: string, target: GraphQLSchema = gqlSchema) =>
  (target.getType(typeName) as GraphQLInputObjectType).getFields();
const posts = () => db.select().from(Posts).orderBy(Posts.id);
const links = async () =>
  (await db.select().from(PostsToTags).orderBy(PostsToTags.postId, PostsToTags.tagId)).map(
    (row: any) => `${row.postId}:${row.tagId}`,
  );

const config = {
  features: { nestedWrites: true, upsert: true },
  softDelete: { Authors: 'deletedAt' },
} as const;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL, "deleted_at" timestamp);`,
  );
  await db.execute(
    sql`CREATE TABLE "posts" ("id" integer PRIMARY KEY NOT NULL, "author_id" integer, "title" text NOT NULL);`,
  );
  await db.execute(sql`CREATE TABLE "tags" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "posts_to_tags" (
    "post_id" integer NOT NULL,
    "tag_id" integer NOT NULL,
    PRIMARY KEY ("post_id", "tag_id")
  );`);
  await db.execute(
    sql`CREATE TABLE "notes" ("id" integer PRIMARY KEY NOT NULL, "pinned_id" integer, "body" text NOT NULL);`,
  );
  await db.execute(sql`CREATE TABLE "pins" ("id" integer PRIMARY KEY NOT NULL, "visible" integer NOT NULL);`);

  gqlSchema = buildSchema(db, config as any).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "authors", "posts", "tags", "posts_to_tags", "notes", "pins"`);
  await db.insert(Tags).values([
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ]);
});

describe.sequential('nested upsert: generated surface', () => {
  it('types the upsert with its own input, carrying the update operations', () => {
    const upsert = gqlSchema.getMutationType()!.getFields()['upsertPostsSingle']!;
    expect(String(upsert.args.find((arg) => arg.name === 'values')!.type)).toBe('UpsertPostsInput!');

    const fields = inFields('UpsertPostsInput');
    // The create input's columns…
    expect(Object.keys(inFields('CreatePostsInput')).every((name) => name in fields)).toBe(true);
    // …with relation fields that can detach and replace.
    expect(String(fields['tags']!.type)).toBe('PostsTagsNestedUpsertInput');
    expect(Object.keys(inFields('PostsTagsNestedUpsertInput')).sort()).toEqual(['connect', 'disconnect', 'set']);
    expect(Object.keys(inFields('PostsAuthorNestedUpsertInput')).sort()).toEqual(['connect', 'create', 'disconnect']);
    expect(Object.keys(inFields('AuthorsPostsNestedUpsertInput')).sort()).toEqual([
      'connect',
      'create',
      'disconnect',
      'set',
    ]);
  });

  it('leaves the create input as it was', () => {
    expect(Object.keys(inFields('PostsTagsNestedCreateInput')).sort()).toEqual(['connect']);
    const create = gqlSchema.getMutationType()!.getFields()['createPostsSingle'];
    expect(String(create!.args.find((arg) => arg.name === 'values')!.type)).toBe('CreatePostsInput!');
  });

  it('keeps the create input on a table with no writable relation', () => {
    const upsert = gqlSchema.getMutationType()!.getFields()['upsertPinsSingle']!;
    expect(String(upsert.args.find((arg) => arg.name === 'values')!.type)).toBe('CreatePinsInput!');
    expect(gqlSchema.getType('UpsertPinsInput')).toBeUndefined();
  });

  it('offers a parent-side disconnect through a relation whose where filters the target', () => {
    expect(Object.keys(inFields('NotesPinNestedUpsertInput')).sort()).toEqual(['connect', 'disconnect']);
  });

  it('generates no upsert input without nested writes', () => {
    const plain = buildSchema(db, { features: { upsert: true } }).schema;
    const upsert = plain.getMutationType()!.getFields()['upsertPostsSingle']!;
    expect(String(upsert.args.find((arg) => arg.name === 'values')!.type)).toBe('CreatePostsInput!');
    expect(plain.getType('UpsertPostsInput')).toBeUndefined();
  });

  it('can be renamed through derivedTypeNameMapper', () => {
    const renamed = buildSchema(db, {
      ...(config as any),
      derivedTypeNameMapper: ({ kind, table }: any) => (kind === 'upsertInput' ? `${table}Save` : undefined),
    }).schema;
    const upsert = renamed.getMutationType()!.getFields()['upsertPostsSingle']!;
    expect(String(upsert.args.find((arg) => arg.name === 'values')!.type)).toBe('PostsSave!');
  });
});

const SAVE = `mutation ($values: UpsertPostsInput!) { upsertPostsSingle(values: $values) { id title tags { id } } }`;

describe.sequential('nested upsert: insert branch', () => {
  it('treats set as connect on a new row', async () => {
    const res = await run(SAVE, { values: { id: 1, title: 'new', tags: { set: [{ id: { inArray: [1, 2] } }] } } });

    expect(res.errors).toBeUndefined();
    expect(await links()).toEqual(['1:1', '1:2']);
  });

  it('ignores disconnect on a new row', async () => {
    const res = await run(SAVE, {
      values: { id: 1, title: 'new', tags: { disconnect: [{ id: { eq: 1 } }], connect: [{ id: { eq: 2 } }] } },
    });

    expect(res.errors).toBeUndefined();
    expect(await links()).toEqual(['1:2']);
  });

  it('creates and attaches child rows, replacing nothing', async () => {
    await db.insert(Posts).values({ id: 9, authorId: null, title: 'loose' });
    const res = await run(
      `mutation { upsertAuthorsSingle(values: { id: 1, name: "ann", posts: { set: [{ id: { eq: 9 } }], create: [{ id: 10, title: "made" }] } }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((await posts()).map((row: any) => [row.id, row.authorId])).toEqual([
      [9, 1],
      [10, 1],
    ]);
  });
});

describe.sequential('nested upsert: conflict branch', () => {
  beforeEach(async () => {
    await db.insert(Posts).values({ id: 1, authorId: null, title: 'old' });
    await db.insert(PostsToTags).values([
      { postId: 1, tagId: 1 },
      { postId: 1, tagId: 2 },
    ]);
  });

  it('replaces the whole set, as update does', async () => {
    const res = await run(SAVE, { values: { id: 1, title: 'edited', tags: { set: [{ id: { eq: 3 } }] } } });

    expect(res.errors).toBeUndefined();
    expect((res.data as any).upsertPostsSingle).toEqual({ id: 1, title: 'edited', tags: [{ id: 3 }] });
    expect(await links()).toEqual(['1:3']);
  });

  it('clears the relation with set: []', async () => {
    const res = await run(SAVE, { values: { id: 1, title: 'edited', tags: { set: [] } } });

    expect(res.errors).toBeUndefined();
    expect(await links()).toEqual([]);
  });

  it('disconnects the rows it names', async () => {
    const res = await run(SAVE, { values: { id: 1, title: 'edited', tags: { disconnect: [{ id: { eq: 1 } }] } } });

    expect(res.errors).toBeUndefined();
    expect(await links()).toEqual(['1:2']);
  });

  it('detaches child rows of a to-many', async () => {
    await db.insert(Authors).values({ id: 1, name: 'ann' });
    await db.update(Posts).set({ authorId: 1 }).where(eq(Posts.id, 1));
    await db.insert(Posts).values({ id: 2, authorId: 1, title: 'second' });

    const res = await run(
      `mutation { upsertAuthorsSingle(values: { id: 1, name: "ann", posts: { disconnect: [{ id: { eq: 1 } }] } }) { id posts { id } } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).upsertAuthorsSingle).toEqual({ id: 1, posts: [{ id: 2 }] });
  });

  it('disconnects a parent-side to-one', async () => {
    await db.insert(Authors).values({ id: 1, name: 'ann' });
    await db.update(Posts).set({ authorId: 1 }).where(eq(Posts.id, 1));

    const res = await run(
      `mutation { upsertPostsSingle(values: { id: 1, title: "edited", author: { disconnect: true } }) { id authorId } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).upsertPostsSingle).toEqual({ id: 1, authorId: null });
  });

  it('refuses a parent-side disconnect the conflict branch does not write', async () => {
    await db.insert(Authors).values({ id: 1, name: 'ann' });
    await db.update(Posts).set({ authorId: 1 }).where(eq(Posts.id, 1));

    const res = await run(
      `mutation { upsertPostsSingle(values: { id: 1, title: "edited", author: { disconnect: true } }, onConflict: { update: [title] }) { id } }`,
    );

    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect((await posts())[0]).toMatchObject({ authorId: 1, title: 'old' });
  });

  it('rolls the row back when a nested operation fails', async () => {
    const res = await run(SAVE, { values: { id: 1, title: 'edited', tags: { set: [{}] } } });

    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect((await posts())[0]).toMatchObject({ title: 'old' });
    expect(await links()).toEqual(['1:1', '1:2']);
  });

  it('applies each entry of a batch to its own branch', async () => {
    const res = await run(
      `mutation { upsertPosts(values: [
        { id: 1, title: "edited", tags: { set: [{ id: { eq: 3 } }] } },
        { id: 2, title: "fresh", tags: { set: [{ id: { eq: 1 } }] } }
      ]) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(await links()).toEqual(['1:3', '2:1']);
  });
});

// Issue #222: the conflict branch writes a parent-side key the way update<Table> does, so a
// key pointing at a row the relation's own `where` hides is kept rather than replaced.
describe.sequential("nested upsert: a parent-side relation's own where", () => {
  const notes = () => db.select().from(Notes).orderBy(Notes.id);
  const UPSERT_NOTE = 'mutation ($values: UpsertNotesInput!) { upsertNotesSingle(values: $values) { id pinnedId } }';

  beforeEach(async () => {
    await db.insert(Pins).values([
      { id: 1, visible: 0 },
      { id: 2, visible: 1 },
      { id: 3, visible: 1 },
    ]);
  });

  it('refuses a connect that would replace a hidden key, and rolls back', async () => {
    await db.insert(Notes).values({ id: 1, pinnedId: 1, body: 'old' });

    const res = await run(UPSERT_NOTE, { values: { id: 1, body: 'new', pin: { connect: { id: { eq: 2 } } } } });

    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(res.errors?.[0]?.message).toMatch(/hides/);
    expect(await notes()).toEqual([{ id: 1, pinnedId: 1, body: 'old' }]);
  });

  it('replaces a key the where shows', async () => {
    await db.insert(Notes).values({ id: 1, pinnedId: 2, body: 'old' });

    const res = await run(UPSERT_NOTE, { values: { id: 1, body: 'new', pin: { connect: { id: { eq: 3 } } } } });

    expect(res.errors).toBeUndefined();
    expect((res.data as any).upsertNotesSingle).toEqual({ id: 1, pinnedId: 3 });
  });

  it('connects on the insert branch', async () => {
    const res = await run(UPSERT_NOTE, { values: { id: 1, body: 'new', pin: { connect: { id: { eq: 2 } } } } });

    expect(res.errors).toBeUndefined();
    expect((res.data as any).upsertNotesSingle).toEqual({ id: 1, pinnedId: 2 });
  });

  it('leaves a hidden key in place on disconnect, as update does', async () => {
    await db.insert(Notes).values({ id: 1, pinnedId: 1, body: 'old' });

    const res = await run(UPSERT_NOTE, { values: { id: 1, body: 'new', pin: { disconnect: true } } });

    expect(res.errors).toBeUndefined();
    expect(await notes()).toEqual([{ id: 1, pinnedId: 1, body: 'new' }]);
  });

  it('clears a shown key on disconnect', async () => {
    await db.insert(Notes).values({ id: 1, pinnedId: 2, body: 'old' });

    const res = await run(UPSERT_NOTE, { values: { id: 1, body: 'new', pin: { disconnect: true } } });

    expect(res.errors).toBeUndefined();
    expect((res.data as any).upsertNotesSingle).toEqual({ id: 1, pinnedId: null });
  });

  it('still refuses a conflict branch that does not write the key', async () => {
    await db.insert(Notes).values({ id: 1, pinnedId: 2, body: 'old' });

    const res = await run(
      'mutation { upsertNotesSingle(values: { id: 1, body: "new", pin: { disconnect: true } }, onConflict: { update: [body] }) { id } }',
    );

    expect(res.errors?.[0]?.message).toMatch(/onConflict\.update/);
    expect(await notes()).toEqual([{ id: 1, pinnedId: 2, body: 'old' }]);
  });
});

describe.sequential('nested upsert: hooks and soft delete', () => {
  it("fires the junction's onWrite hooks for the nested statements", async () => {
    await db.insert(Posts).values({ id: 1, authorId: null, title: 'old' });
    await db.insert(PostsToTags).values({ postId: 1, tagId: 1 });

    const calls: Pick<WriteHookPayload, 'table' | 'operation' | 'nested'>[] = [];
    const hook = async (payload: WriteHookPayload) => {
      if (payload.nested) {
        calls.push({ table: payload.table, operation: payload.operation, nested: payload.nested });
      }
    };
    const hooked = buildSchema(db, { ...(config as any), onWrite: { PostsToTags: { after: hook } } }).schema;

    const res = await run(SAVE, { values: { id: 1, title: 'edited', tags: { set: [{ id: { eq: 2 } }] } } }, hooked);

    expect(res.errors).toBeUndefined();
    expect(calls).toEqual([
      { table: 'PostsToTags', operation: 'delete', nested: { parentTable: 'Posts', relation: 'tags', op: 'set' } },
      { table: 'PostsToTags', operation: 'insert', nested: { parentTable: 'Posts', relation: 'tags', op: 'set' } },
    ]);
  });

  it('leaves a soft-deleted row and its relations alone, as update does', async () => {
    await db.insert(Authors).values({ id: 1, name: 'gone', deletedAt: new Date() });
    await db.insert(Posts).values({ id: 1, authorId: 1, title: 'kept' });

    const res = await run(
      `mutation { upsertAuthorsSingle(values: { id: 1, name: "back", posts: { set: [] } }) { id } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).upsertAuthorsSingle).toBeNull();
    expect((await db.select().from(Authors))[0]).toMatchObject({ name: 'gone' });
    expect((await posts())[0]).toMatchObject({ authorId: 1 });
  });
});
