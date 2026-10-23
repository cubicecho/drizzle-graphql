import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { boolean, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Nested writes against the policies and relation shapes that constrain them: contextValues,
// scope and soft delete, a relation's own `where`, multi-column joins, to-one cardinality,
// and what a mutation returns or leaves behind. Each block builds its own schema on an
// in-memory PGlite.

const fixture = (schema: Record<string, unknown>, ddl: string[], config: any) => {
  const state = {} as { db: any; gqlSchema: GraphQLSchema; pglite: PGlite };
  beforeAll(async () => {
    state.pglite = new PGlite();
    await state.pglite.waitReady;
    state.db = (drizzle as any)({ client: state.pglite, schema, relations: schema['relations'] });
    for (const statement of ddl) {
      await state.db.execute(sql.raw(statement));
    }
    state.gqlSchema = buildSchema(state.db, config).schema;
  });
  afterAll(async () => {
    await state.pglite?.close();
  });
  const run = (source: string, contextValue: any = {}) => graphql({ schema: state.gqlSchema, source, contextValue });
  const inFields = (typeName: string) =>
    Object.keys((state.gqlSchema.getType(typeName) as GraphQLInputObjectType | undefined)?.getFields() ?? {});
  return { state, run, inFields };
};

describe.sequential('a relation whose foreign key is a contextValues column', () => {
  const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
  const Posts = pgTable('posts', {
    id: integer('id').primaryKey(),
    title: text('title').notNull(),
    authorId: integer('author_id'),
  });
  const tables = { Users, Posts };
  const r = createRelationsHelper(tables);
  const relations = buildRelations(tables, {
    Users: { posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }) },
    Posts: { author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id }) },
  });
  const { state, run, inFields } = fixture(
    { ...tables, relations },
    [
      'CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL)',
      'CREATE TABLE posts (id integer PRIMARY KEY, title text NOT NULL, author_id integer)',
    ],
    { features: { nestedWrites: true }, contextValues: { Posts: { authorId: (ctx: any) => ctx.userId } } },
  );
  const caller = { userId: 2 };
  const authorOf = async (id: number) => (await state.db.select().from(Posts).where(eq(Posts.id, id)))[0]?.authorId;

  beforeEach(async () => {
    await state.db.execute(sql`TRUNCATE users, posts`);
    await state.db.insert(Users).values([
      { id: 1, name: 'victim' },
      { id: 2, name: 'caller' },
    ]);
    await state.db.insert(Posts).values({ id: 1, title: "victim's post", authorId: 1 });
  });

  it('offers neither side of the relation as a nested input', () => {
    expect(inFields('CreatePostsInput')).not.toContain('author');
    expect(inFields('UpdatePostsInput')).not.toContain('author');
    expect(inFields('CreateUsersInput')).not.toContain('posts');
    expect(inFields('UpdateUsersInput')).not.toContain('posts');
  });

  it('createPostsSingle cannot pick the author through author.connect', async () => {
    const res = await run(
      'mutation { createPostsSingle(values: { id: 5, title: "x", author: { connect: { id: { eq: 1 } } } }) { id } }',
      caller,
    );
    expect(res.errors).toBeDefined();
    expect(await authorOf(5)).toBeUndefined();
  });

  it('updatePostsSingle cannot reassign the owner through author.connect', async () => {
    const res = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { author: { connect: { id: { eq: 2 } } } }) { id } }',
      caller,
    );
    expect(res.errors).toBeDefined();
    expect(await authorOf(1)).toBe(1);
  });

  it("users.posts cannot take another user's post, or create one under another user", async () => {
    const connect = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 2 } }, set: { posts: { connect: [{ id: { eq: 1 } }] } }) { id } }',
      caller,
    );
    expect(connect.errors).toBeDefined();
    expect(await authorOf(1)).toBe(1);

    const create = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { posts: { create: [{ id: 6, title: "y" }] } }) { id } }',
      caller,
    );
    expect(create.errors).toBeDefined();
    expect(await authorOf(6)).toBeUndefined();
  });

  it('a plain create still stamps the context value', async () => {
    const res = await run('mutation { createPostsSingle(values: { id: 7, title: "z" }) { id } }', caller);
    expect(res.errors).toBeUndefined();
    expect(await authorOf(7)).toBe(2);
  });
});

describe.sequential('many-to-many set under scope and soft delete', () => {
  const Posts = pgTable('posts', { id: integer('id').primaryKey(), title: text('title').notNull() });
  const Tags = pgTable('tags', {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    orgId: integer('org_id'),
    deletedAt: timestamp('deleted_at'),
  });
  const PostsToTags = pgTable(
    'posts_to_tags',
    { postId: integer('post_id').notNull(), tagId: integer('tag_id').notNull() },
    (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
  );
  const tables = { Posts, Tags, PostsToTags };
  const r = createRelationsHelper(tables);
  const relations = buildRelations(tables, {
    Posts: {
      tags: r.many.Tags({ from: r.Posts.id.through(r.PostsToTags.postId), to: r.Tags.id.through(r.PostsToTags.tagId) }),
    },
  });
  const { state, run } = fixture(
    { ...tables, relations },
    [
      'CREATE TABLE posts (id integer PRIMARY KEY, title text NOT NULL)',
      'CREATE TABLE tags (id integer PRIMARY KEY, name text NOT NULL, org_id integer, deleted_at timestamp)',
      'CREATE TABLE posts_to_tags (post_id integer NOT NULL, tag_id integer NOT NULL, PRIMARY KEY (post_id, tag_id))',
    ],
    {
      features: { nestedWrites: true },
      scope: { Tags: (ctx: any, t: any) => eq(t.orgId, ctx.orgId) },
      softDelete: { Tags: { column: 'deletedAt' } },
    },
  );
  const linkedTags = async () =>
    (await state.db.select().from(PostsToTags).where(eq(PostsToTags.postId, 1))).map((x: any) => x.tagId).sort();

  beforeEach(async () => {
    await state.db.execute(sql`TRUNCATE posts, tags, posts_to_tags`);
    await state.db.insert(Posts).values({ id: 1, title: 'p' });
    await state.db.insert(Tags).values([
      { id: 10, name: 'mine', orgId: 1 },
      { id: 11, name: 'mine, trashed', orgId: 1, deletedAt: new Date() },
      { id: 12, name: 'mine, unlinked', orgId: 1 },
      { id: 99, name: 'other org', orgId: 2 },
    ]);
    await state.db.insert(PostsToTags).values([
      { postId: 1, tagId: 10 },
      { postId: 1, tagId: 11 },
      { postId: 1, tagId: 99 },
    ]);
  });

  it('replaces only the in-scope, unmarked links', async () => {
    const res = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { set: [{ id: { eq: 12 } }] } }) { id } }',
      { orgId: 1 },
    );
    expect(res.errors).toBeUndefined();
    expect(await linkedTags()).toEqual([11, 12, 99]);
  });

  it('set: [] keeps the links to out-of-scope and soft-deleted tags', async () => {
    const res = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { tags: { set: [] } }) { id } }',
      { orgId: 1 },
    );
    expect(res.errors).toBeUndefined();
    expect(await linkedTags()).toEqual([11, 99]);
  });
});

describe.sequential('a relation joined on two columns', () => {
  const Orders = pgTable(
    'orders',
    { tenantId: integer('tenant_id').notNull(), id: integer('id').notNull(), label: text('label') },
    (t) => [primaryKey({ columns: [t.tenantId, t.id] })],
  );
  const Items = pgTable('items', {
    id: integer('id').primaryKey(),
    tenantId: integer('tenant_id'),
    orderId: integer('order_id'),
  });
  const tables = { Orders, Items };
  const r = createRelationsHelper(tables);
  const relations = buildRelations(tables, {
    Orders: {
      items: r.many.Items({ from: [r.Orders.id, r.Orders.tenantId], to: [r.Items.orderId, r.Items.tenantId] }),
    },
    Items: {
      order: r.one.Orders({ from: [r.Items.orderId, r.Items.tenantId], to: [r.Orders.id, r.Orders.tenantId] }),
    },
  });
  const { state, run, inFields } = fixture(
    { ...tables, relations },
    [
      'CREATE TABLE orders (tenant_id integer NOT NULL, id integer NOT NULL, label text, PRIMARY KEY (tenant_id, id))',
      'CREATE TABLE items (id integer PRIMARY KEY, tenant_id integer, order_id integer)',
    ],
    { features: { nestedWrites: true } },
  );
  const item = async (id: number) => (await state.db.select().from(Items).where(eq(Items.id, id)))[0];

  beforeEach(async () => {
    await state.db.execute(sql`TRUNCATE orders, items`);
    await state.db.insert(Orders).values([
      { tenantId: 1, id: 1, label: 't1 order 1' },
      { tenantId: 2, id: 1, label: 't2 order 1' },
    ]);
    await state.db.insert(Items).values([
      { id: 1, tenantId: 1, orderId: 1 },
      { id: 2, tenantId: 2, orderId: 1 },
    ]);
  });

  it('is not offered as a nested input from either side', () => {
    expect(inFields('UpdateOrdersInput')).not.toContain('items');
    expect(inFields('CreateItemsInput')).not.toContain('order');
  });

  it("cannot detach another tenant's item", async () => {
    const res = await run(
      'mutation { updateOrdersSingle(where: { tenantId: { eq: 1 }, id: { eq: 1 } }, set: { items: { set: [] } }) { id } }',
    );
    expect(res.errors).toBeDefined();
    expect(await item(2)).toEqual({ id: 2, tenantId: 2, orderId: 1 });
  });
});

describe.sequential("a relation's own where", () => {
  const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
  const Posts = pgTable('posts', {
    id: integer('id').primaryKey(),
    title: text('title').notNull(),
    authorId: integer('author_id'),
    published: boolean('published').notNull().default(false),
  });
  const Tags = pgTable('tags', { id: integer('id').primaryKey(), visible: boolean('visible').notNull() });
  const PostsToTags = pgTable(
    'posts_to_tags',
    { postId: integer('post_id').notNull(), tagId: integer('tag_id').notNull() },
    (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
  );
  const tables = { Users, Posts, Tags, PostsToTags };
  const r = createRelationsHelper(tables);
  const relations = buildRelations(tables, {
    Users: {
      publishedPosts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId, where: { published: true } }),
      // No `where` of its own: it inherits publishedAuthor's, which then filters the user.
      shownPosts: r.many.Posts({ alias: 'shown' }),
    },
    Posts: {
      publishedAuthor: r.one.Users({
        from: r.Posts.authorId,
        to: r.Users.id,
        where: { name: { ne: 'hidden' } },
        alias: 'shown',
      }),
      visibleTags: r.many.Tags({
        from: r.Posts.id.through(r.PostsToTags.postId),
        to: r.Tags.id.through(r.PostsToTags.tagId),
        where: { visible: true },
      }),
    },
  });
  const { state, run, inFields } = fixture(
    { ...tables, relations },
    [
      'CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL)',
      'CREATE TABLE posts (id integer PRIMARY KEY, title text NOT NULL, author_id integer, published boolean NOT NULL DEFAULT false)',
      'CREATE TABLE tags (id integer PRIMARY KEY, visible boolean NOT NULL)',
      'CREATE TABLE posts_to_tags (post_id integer NOT NULL, tag_id integer NOT NULL, PRIMARY KEY (post_id, tag_id))',
    ],
    { features: { nestedWrites: true } },
  );
  const post = async (id: number) => (await state.db.select().from(Posts).where(eq(Posts.id, id)))[0];

  beforeEach(async () => {
    await state.db.execute(sql`TRUNCATE users, posts, tags, posts_to_tags`);
    await state.db.insert(Users).values([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'hidden' },
    ]);
    await state.db.insert(Posts).values([
      { id: 1, title: 'published', authorId: 1, published: true },
      { id: 2, title: 'draft', authorId: 1, published: false },
      { id: 3, title: 'unowned draft', authorId: null, published: false },
      { id: 4, title: 'unowned published', authorId: null, published: true },
    ]);
    await state.db.insert(Tags).values([
      { id: 1, visible: true },
      { id: 2, visible: false },
      { id: 3, visible: true },
    ]);
    await state.db.insert(PostsToTags).values([
      { postId: 1, tagId: 1 },
      { postId: 1, tagId: 2 },
    ]);
  });

  it('offers no create, whose row might not satisfy the where', () => {
    expect(inFields('UsersPublishedPostsNestedUpdateInput')).not.toContain('create');
    expect(inFields('PostsPublishedAuthorNestedCreateInput')).not.toContain('create');
    expect(inFields('UsersPublishedPostsNestedUpdateInput')).toEqual(
      expect.arrayContaining(['connect', 'disconnect', 'set']),
    );
  });

  it('set: [] detaches only the rows the relation shows', async () => {
    const res = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { publishedPosts: { set: [] } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    expect((await post(1)).authorId).toBeNull();
    expect((await post(2)).authorId).toBe(1);
  });

  it('disconnect leaves a row the relation hides', async () => {
    const res = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { publishedPosts: { disconnect: [{ id: { inArray: [1, 2] } }] } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    expect((await post(1)).authorId).toBeNull();
    expect((await post(2)).authorId).toBe(1);
  });

  it('connect attaches only rows the relation would show', async () => {
    const res = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 2 } }, set: { publishedPosts: { connect: [{ id: { inArray: [3, 4] } }] } }) { id publishedPosts { id } } }',
    );
    expect(res.errors).toBeUndefined();
    expect((await post(3)).authorId).toBeNull();
    expect((await post(4)).authorId).toBe(2);
    expect((res.data as any).updateUsersSingle.publishedPosts).toEqual([{ id: 4 }]);
  });

  it('a parent-side connect must match a row the relation would show', async () => {
    const res = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 3 } }, set: { publishedAuthor: { connect: { id: { eq: 3 } } } }) { id } }',
    );
    expect(res.errors?.[0]?.message).toMatch(/exactly one/);
    expect((await post(3)).authorId).toBeNull();
  });

  it('an inherited where refuses a write on a parent the relation is hidden for', async () => {
    const hidden = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 3 } }, set: { shownPosts: { connect: [{ id: { eq: 3 } }] } }) { id } }',
    );
    expect(hidden.errors?.[0]?.message).toMatch(/hides the relation/);
    expect((await post(3)).authorId).toBeNull();

    const shown = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 2 } }, set: { shownPosts: { connect: [{ id: { eq: 3 } }] } }) { id shownPosts { id } } }',
    );
    expect(shown.errors).toBeUndefined();
    expect((shown.data as any).updateUsersSingle.shownPosts).toEqual([{ id: 3 }]);
  });

  it('many-to-many set: [] keeps the link the relation hides', async () => {
    const res = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 1 } }, set: { visibleTags: { set: [] } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    expect((await state.db.select().from(PostsToTags)).map((x: any) => x.tagId)).toEqual([2]);
  });

  it('many-to-many connect links only rows the relation would show', async () => {
    const res = await run(
      'mutation { updatePostsSingle(where: { id: { eq: 2 } }, set: { visibleTags: { connect: [{ id: { inArray: [2, 3] } }] } }) { id } }',
    );
    expect(res.errors).toBeUndefined();
    const linked = await state.db.select().from(PostsToTags).where(eq(PostsToTags.postId, 2));
    expect(linked.map((x: any) => x.tagId)).toEqual([3]);
  });
});
