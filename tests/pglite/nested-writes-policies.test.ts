import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
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
