import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A plural update with a nested op reads the written parent rows back by primary key — to
// check an inherited relation `where` (`parentHidden`), and to refresh rows a self-referencing
// write may have changed (`refreshed`). Matched as one flat `a OR b OR c …`, that is past
// SQLite's 1,000-level expression depth for a composite key, or a parent-side check, over
// ~1,000 rows.

const ROWS = 1_500;

const Users = sqliteTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id'),
  published: integer('published', { mode: 'boolean' }).notNull(),
});
const Nodes = sqliteTable(
  'nodes',
  { id: integer('id').notNull(), tenant: integer('tenant').notNull(), parentId: integer('parent_id') },
  (t) => [primaryKey({ columns: [t.id, t.tenant] })],
);
const tables = { Users, Posts, Nodes };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    publishedPosts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId, where: { published: true }, alias: 'pub' }),
  },
  Posts: { publishedAuthor: r.one.Users({ alias: 'pub' }) },
  Nodes: { children: r.many.Nodes({ from: r.Nodes.id, to: r.Nodes.parentId }) },
});

const rootMessage = (e: any): string => {
  let cur = e;
  while (cur?.originalError ?? cur?.cause) cur = cur.originalError ?? cur.cause;
  return String(cur?.message ?? cur).slice(0, 200);
};

const setup = async () => {
  const client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE users (id integer primary key, name text not null)`);
  await db.run(sql`CREATE TABLE posts (id integer primary key, author_id integer, published integer not null)`);
  await db.run(
    sql`CREATE TABLE nodes (id integer not null, tenant integer not null, parent_id integer, primary key (id, tenant))`,
  );
  await db.insert(Users).values([{ id: 1, name: 'a' }]);
  await db.run(
    sql.raw(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO posts (id, published) SELECT i, 1 FROM n`,
    ),
  );
  await db.run(
    sql.raw(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO nodes (id, tenant) SELECT i, 1 FROM n`,
    ),
  );
  const { schema } = buildSchema(db, { features: { nestedWrites: true }, onError: (e: any) => e as Error });
  return { client, schema };
};

describe('nested writes on a plural update over more than 1,000 rows', () => {
  it('checks an inherited relation `where` on every written row', async () => {
    const { client, schema } = await setup();
    const res: any = await graphql({
      schema,
      contextValue: {},
      source:
        'mutation { updatePosts(where: { published: { eq: true } }, set: { publishedAuthor: { connect: { id: { eq: 1 } } } }) { id authorId } }',
    });
    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data.updatePosts).toHaveLength(ROWS);
    expect(res.data.updatePosts.every((p: any) => p.authorId === 1)).toBe(true);
    client.close();
  });

  it('reads back a composite-keyed self-referencing write', async () => {
    const { client, schema } = await setup();
    const res: any = await graphql({
      schema,
      contextValue: {},
      source:
        'mutation { updateNodes(where: { tenant: { eq: 1 } }, set: { children: { disconnect: [{ id: { eq: -1 } }] } }) { id tenant } }',
    });
    expect(res.errors?.map(rootMessage)).toBeUndefined();
    expect(res.data.updateNodes).toHaveLength(ROWS);
    client.close();
  });
});
