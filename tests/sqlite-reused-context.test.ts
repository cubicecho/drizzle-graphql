import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { execute, parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Per-request state belongs to one execution, not to the context object or the document: a
// host may reuse a context, and a parser cache hands every execution the same AST. Each
// execution below shares both with the one before it and changes only the variables.

const Posts = sqliteTable('posts', { id: integer('id').primaryKey(), title: text('title').notNull() });
const Comments = sqliteTable('comments', {
  id: integer('id').primaryKey(),
  postId: integer('post_id').notNull(),
  body: text('body').notNull(),
});
const tables = { Posts, Comments };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Posts: { comments: r.many.Comments({ from: r.Posts.id, to: r.Comments.postId }) },
  Comments: { post: r.one.Posts({ from: r.Comments.postId, to: r.Posts.id }) },
});

let client: Client;
let db: any;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE posts (id integer PRIMARY KEY, title text NOT NULL)`);
  await db.run(sql`CREATE TABLE comments (id integer PRIMARY KEY, post_id integer NOT NULL, body text NOT NULL)`);
  await db.insert(Posts).values([
    { id: 10, title: 'a' },
    { id: 11, title: 'b' },
  ]);
  await db.insert(Comments).values([
    { id: 100, postId: 10, body: 'x' },
    { id: 101, postId: 10, body: 'y' },
    { id: 102, postId: 11, body: 'z' },
  ]);
});
afterAll(() => client?.close());

const BY_ID = '{ id: { direction: asc, priority: 1 } }';

describe('a context object and a parsed document reused across executions', () => {
  it('a lazy relation field reads each execution its own variables', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations: false });
    const document = parse(
      `query($w: CommentsFilters) { posts(orderBy: ${BY_ID}) { id comments(where: $w, orderBy: ${BY_ID}) { id } } }`,
    );
    const contextValue = {};
    const first: any = await execute({ schema, document, contextValue, variableValues: { w: { id: { eq: 100 } } } });
    const second: any = await execute({ schema, document, contextValue, variableValues: { w: { id: { eq: 101 } } } });

    expect(first.errors).toBeUndefined();
    expect(second.errors).toBeUndefined();
    expect(first.data.posts[0].comments).toEqual([{ id: 100 }]);
    expect(second.data.posts[0].comments).toEqual([{ id: 101 }]);
  });

  it('a relation aggregate reads each execution its own variables', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations: false });
    const document = parse(
      `query($w: CommentsFilters) { posts(orderBy: ${BY_ID}) { id commentsAggregate(where: $w) { count } } }`,
    );
    const contextValue = {};
    const first: any = await execute({ schema, document, contextValue, variableValues: { w: { id: { eq: 100 } } } });
    const second: any = await execute({ schema, document, contextValue, variableValues: { w: { id: { gt: 0 } } } });

    expect(first.errors).toBeUndefined();
    expect(second.errors).toBeUndefined();
    expect(first.data.posts.map((post: any) => post.commentsAggregate.count)).toEqual([1, 0]);
    expect(second.data.posts.map((post: any) => post.commentsAggregate.count)).toEqual([2, 1]);
  });
});
