import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── A many-to-many schema, plus a junction that cannot be written through ─────
// posts.tags / tags.posts   through posts_to_tags, whose only columns are the two keys
// posts.stamps              through post_stamps, which also has a NOT NULL `note`
const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
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
const Stamps = pgTable('stamps', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});
const PostStamps = pgTable(
  'post_stamps',
  {
    postId: integer('post_id').notNull(),
    stampId: integer('stamp_id').notNull(),
    note: text('note').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.stampId] })],
);

const r = createRelationsHelper({ Posts, Tags, PostsToTags, Stamps, PostStamps });
const relations = buildRelations(
  { Posts, Tags, PostsToTags, Stamps, PostStamps },
  {
    Posts: {
      tags: r.many.Tags({
        from: r.Posts.id.through(r.PostsToTags.postId),
        to: r.Tags.id.through(r.PostsToTags.tagId),
      }),
      stamps: r.many.Stamps({
        from: r.Posts.id.through(r.PostStamps.postId),
        to: r.Stamps.id.through(r.PostStamps.stampId),
      }),
    },
    Tags: {
      posts: r.many.Posts({
        from: r.Tags.id.through(r.PostsToTags.tagId),
        to: r.Posts.id.through(r.PostsToTags.postId),
      }),
    },
  },
);
const schema = { Posts, Tags, PostsToTags, Stamps, PostStamps, relations };

const DATA_DIR = `./tests/.temp/pgdata-nested-writes-through-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const inFields = (typeName: string) => (gqlSchema.getType(typeName) as GraphQLInputObjectType).getFields();

/** Every link as a readable `postId:tagId` pair, so assertions read like the data. */
const links = async () =>
  (await db.select().from(PostsToTags).orderBy(PostsToTags.postId, PostsToTags.tagId)).map(
    (row: any) => `${row.postId}:${row.tagId}`,
  );

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "posts" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "tags" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "posts_to_tags" (
		"post_id" integer NOT NULL,
		"tag_id" integer NOT NULL,
		PRIMARY KEY ("post_id", "tag_id")
	);`);
  await db.execute(sql`CREATE TABLE "stamps" ("id" integer PRIMARY KEY NOT NULL, "label" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "post_stamps" (
		"post_id" integer NOT NULL,
		"stamp_id" integer NOT NULL,
		"note" text NOT NULL,
		PRIMARY KEY ("post_id", "stamp_id")
	);`);

  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "posts", "tags", "posts_to_tags", "stamps", "post_stamps"`);
  await db.insert(Posts).values([
    { id: 1, title: 'First' },
    { id: 2, title: 'Second' },
  ]);
  await db.insert(Tags).values([
    { id: 10, name: 'news' },
    { id: 20, name: 'draft' },
    { id: 30, name: 'archive' },
  ]);
});

describe.sequential('nested writes through a junction table: generated surface', () => {
  it('adds nothing unless the feature is switched on', () => {
    const defaults = buildSchema(db).schema;

    expect((defaults.getType('CreatePostsInput') as GraphQLInputObjectType).getFields()['tags']).toBeUndefined();
    expect(defaults.getType('PostsTagsNestedUpdateInput')).toBeUndefined();
  });

  it('offers only connect on the create input', () => {
    expect(String(inFields('CreatePostsInput')['tags']!.type)).toBe('PostsTagsNestedCreateInput');

    const ops = inFields('PostsTagsNestedCreateInput');
    expect(Object.keys(ops)).toEqual(['connect']);
    expect(String(ops['connect']!.type)).toBe('[TagsFilters!]');
  });

  it('offers connect, disconnect and set on the update input', () => {
    // No nullable-foreign-key question to ask: unlinking deletes a junction row rather than
    // writing NULL into a column that may be NOT NULL.
    const ops = inFields('PostsTagsNestedUpdateInput');

    expect(Object.keys(ops).sort()).toEqual(['connect', 'disconnect', 'set']);
    expect(String(ops['set']!.type)).toBe('[TagsFilters!]');
    expect(String(ops['disconnect']!.type)).toBe('[TagsFilters!]');
  });

  it('offers no create, and so generates no row payload for the relation', () => {
    expect(inFields('PostsTagsNestedUpdateInput')['create']).toBeUndefined();
    expect(gqlSchema.getType('CreatePostsTagsInput')).toBeUndefined();
  });

  it('offers the relation from both ends', () => {
    expect(Object.keys(inFields('TagsPostsNestedUpdateInput')).sort()).toEqual(['connect', 'disconnect', 'set']);
    expect(String(inFields('TagsPostsNestedUpdateInput')['connect']!.type)).toBe('[PostsFilters!]');
  });

  it('leaves out a relation whose junction needs a column no operand could supply', () => {
    // post_stamps.note is NOT NULL with no default, so a link cannot be made from a filter
    // alone — the field is absent rather than failing at runtime.
    expect(inFields('UpdatePostsInput')['stamps']).toBeUndefined();
    expect(gqlSchema.getType('PostsStampsNestedUpdateInput')).toBeUndefined();
  });
});

describe.sequential('nested writes through a junction table: connect', () => {
  it('links the rows a filter matches when the parent row is created', async () => {
    const result = await run(`mutation {
      createPostsSingle(values: { id: 3, title: "Third", tags: { connect: [{ name: { eq: "news" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['3:10']);
  });

  it('links every row across several operands, leaving both tables alone', async () => {
    const result = await run(`mutation {
      updatePostsSingle(
        where: { id: { eq: 1 } }
        set: { tags: { connect: [{ name: { eq: "news" } }, { name: { eq: "draft" } }] } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:10', '1:20']);
    expect(await db.select().from(Tags)).toHaveLength(3);
    expect(await db.select().from(Posts)).toHaveLength(2);
  });

  it('links every row one filter matches, not just the first', async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { connect: [{ id: { gt: 10 } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:20', '1:30']);
  });

  it('leaves an existing link alone instead of failing on the duplicate', async () => {
    await db.insert(PostsToTags).values({ postId: 1, tagId: 10 });

    const result = await run(`mutation {
      updatePostsSingle(
        where: { id: { eq: 1 } }
        set: { tags: { connect: [{ name: { eq: "news" } }, { name: { eq: "draft" } }] } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:10', '1:20']);
  });

  it('links from the other end of the relation', async () => {
    const result = await run(`mutation {
      updateTagsSingle(where: { id: { eq: 10 } }, set: { posts: { connect: [{ title: { eq: "Second" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['2:10']);
  });

  it('applies the operation to every row the update matched', async () => {
    const result = await run(`mutation {
      updatePosts(where: { id: { gt: 0 } }, set: { tags: { connect: [{ name: { eq: "news" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:10', '2:10']);
  });

  it('shows the links through the relation field they were written for', async () => {
    await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { connect: [{ name: { eq: "news" } }] } }) { id }
    }`);

    const result = await run(`{ posts(where: { id: { eq: 1 } }) { title tags { name } } }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).posts).toEqual([{ title: 'First', tags: [{ name: 'news' }] }]);
  });
});

describe.sequential('nested writes through a junction table: disconnect and set', () => {
  beforeEach(async () => {
    await db.insert(PostsToTags).values([
      { postId: 1, tagId: 10 },
      { postId: 1, tagId: 20 },
      { postId: 2, tagId: 10 },
    ]);
  });

  it(`deletes only the matching links, and only this row's`, async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { disconnect: [{ name: { eq: "news" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:20', '2:10']);
  });

  it('leaves the unlinked rows themselves in place', async () => {
    await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { disconnect: [{ id: { gt: 0 } }] } }) { id }
    }`);

    expect(await links()).toEqual(['2:10']);
    expect(await db.select().from(Tags)).toHaveLength(3);
  });

  it('replaces the whole set', async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { set: [{ name: { eq: "archive" } }] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:30', '2:10']);
  });

  it('clears the relation when set is given an empty list', async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { set: [] } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['2:10']);
  });

  it('applies set before connect, so the two read as one description of the result', async () => {
    const result = await run(`mutation {
      updatePostsSingle(
        where: { id: { eq: 1 } }
        set: { tags: { set: [{ name: { eq: "archive" } }], connect: [{ name: { eq: "news" } }] } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(await links()).toEqual(['1:10', '1:30', '2:10']);
  });

  it(`still writes the parent row's own columns alongside the link operations`, async () => {
    const result = await run(`mutation {
      updatePostsSingle(where: { id: { eq: 1 } }, set: { title: "Renamed", tags: { set: [] } }) { title }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any).updatePostsSingle.title).toBe('Renamed');
    expect(await links()).toEqual(['2:10']);
  });
});

describe.sequential('nested writes through a junction table: failures', () => {
  it('rejects an operand that would match every row', async () => {
    const result = await run(`mutation {
      createPostsSingle(values: { id: 3, title: "Third", tags: { connect: [{}] } }) { id }
    }`);

    expect(result.errors?.[0]?.message).toMatch(/matches everything/);
    expect(await db.select().from(Posts)).toHaveLength(2);
    expect(await links()).toEqual([]);
  });

  it('rolls the parent row and the earlier links back when a later operand fails', async () => {
    const result = await run(`mutation {
      createPostsSingle(
        values: { id: 3, title: "Third", tags: { connect: [{ name: { eq: "news" } }, {}] } }
      ) { id }
    }`);

    expect(result.errors).toBeDefined();
    expect(await db.select().from(Posts)).toHaveLength(2);
    expect(await links()).toEqual([]);
  });
});
