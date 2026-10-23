// SQLite reads that used to compile to SQL this dialect rejects or answers differently from
// PostgreSQL: `ilike`, `offset` without `limit`, whole-document JSON equality, JSON path reads
// of booleans, and the columns `orderBy` / `distinct` / `min` / `max` offer.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLEnumType, type GraphQLInputObjectType, type GraphQLObjectType, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  nickname: text('nickname'),
  role: text('role', { enum: ['admin', 'member', 'guest'] }).notNull(),
  meta: text('meta', { mode: 'json' }),
  amount: blob('amount', { mode: 'bigint' }),
});
const Posts = sqliteTable('posts', { id: integer('id').primaryKey(), authorId: integer('author_id').notNull() });
const Tags = sqliteTable('tags', { id: integer('id').primaryKey() });
const PostTags = sqliteTable(
  'post_tags',
  { postId: integer('post_id').notNull(), tagId: integer('tag_id').notNull() },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] })],
);

const tables = { Users, Posts, Tags, PostTags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: { posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }) },
  Posts: {
    author: r.one.Users({ from: r.Posts.authorId, to: r.Users.id }),
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostTags.postId), to: r.Tags.id.through(r.PostTags.tagId) }),
  },
});

let client: Client;
let db: any;
let schema: ReturnType<typeof buildSchema>['schema'];

const run = async (source: string, variableValues?: Record<string, any>) => {
  const res = await graphql({ schema, source, contextValue: {}, variableValues });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};
const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
const userIds = async (where: string) =>
  ids((await run(`{ users(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`)).users);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(
    sql`CREATE TABLE users (id integer PRIMARY KEY, nickname text, role text NOT NULL, meta text, amount blob)`,
  );
  await db.run(sql`CREATE TABLE posts (id integer PRIMARY KEY, author_id integer NOT NULL)`);
  await db.run(sql`CREATE TABLE tags (id integer PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE post_tags (post_id integer NOT NULL, tag_id integer NOT NULL, PRIMARY KEY (post_id, tag_id))`,
  );

  await db.insert(Users).values([
    { id: 1, nickname: 'al', role: 'admin', meta: { level: 1, profile: { city: 'berlin' } }, amount: 9n },
    { id: 2, nickname: null, role: 'member', meta: [1, 2, 3], amount: 10n },
    { id: 3, nickname: 'a_b', role: 'guest', meta: null, amount: null },
    { id: 4, nickname: 'aXb', role: 'member', meta: { level: true }, amount: 10n },
    { id: 5, nickname: 'zed', role: 'guest', meta: { level: '1' }, amount: null },
    { id: 6, nickname: 'x', role: 'member', meta: { level: false }, amount: null },
  ]);
  await db.insert(Posts).values([
    { id: 1, authorId: 1 },
    { id: 2, authorId: 1 },
    { id: 3, authorId: 1 },
    { id: 4, authorId: 2 },
  ]);
  await db.insert(Tags).values([{ id: 1 }, { id: 2 }, { id: 3 }]);
  await db.insert(PostTags).values([
    { postId: 1, tagId: 1 },
    { postId: 1, tagId: 2 },
    { postId: 1, tagId: 3 },
  ]);

  schema = buildSchema(db).schema;
});
afterAll(() => client.close());

describe('sqlite: ilike / notIlike', () => {
  it('ilike matches case-insensitively instead of failing on the missing keyword', async () => {
    expect(await userIds('{ nickname: { ilike: "A_B" } }')).toEqual([3, 4]);
  });

  it('notIlike excludes case-insensitively', async () => {
    expect(await userIds('{ nickname: { notIlike: "A%" } }')).toEqual([5, 6]);
  });
});

describe('sqlite: offset without limit', () => {
  const OB = 'orderBy: { id: { direction: asc, priority: 1 } }';

  it('on a root list', async () => {
    expect(ids((await run(`{ users(offset: 4, ${OB}) { id } }`)).users)).toEqual([5, 6]);
  });

  it('after a cursor', async () => {
    const first = await run(`{ users(limit: 2, ${OB}) { id cursor } }`);
    const after = first.users[1].cursor;
    const next = await run(`query($a: String) { users(after: $a, offset: 1, ${OB}) { id } }`, { a: after });
    expect(ids(next.users)).toEqual([4, 5, 6]);
  });

  it('with distinct', async () => {
    // distinct roles by lowest id: 1 admin, 2 member, 3 guest
    expect(ids((await run(`{ users(distinct: [role], offset: 1, ${OB}) { id } }`)).users)).toEqual([2, 3]);
  });

  it('on an eager to-many relation', async () => {
    const data = await run(`{ users(where: { id: { eq: 1 } }) { posts(offset: 1, ${OB}) { id } } }`);
    expect(ids(data.users[0].posts)).toEqual([2, 3]);
  });

  it('on a many-to-many relation through a junction', async () => {
    const data = await run(`{ posts(where: { id: { eq: 1 } }) { tags(offset: 2, ${OB}) { id } } }`);
    expect(ids(data.posts[0].tags)).toEqual([3]);
  });

  it('on a relation under a single-row query', async () => {
    const data = await run(`{ usersSingle(where: { id: { eq: 1 } }) { posts(offset: 2, ${OB}) { id } } }`);
    expect(ids(data.usersSingle.posts)).toEqual([3]);
  });
});

describe('sqlite: whole-document JSON eq / ne', () => {
  it('matches an equal object document', async () => {
    expect(await userIds('{ meta: { eq: { level: 1, profile: { city: "berlin" } } } }')).toEqual([1]);
  });

  it('does not depend on the key order of the operand', async () => {
    expect(await userIds('{ meta: { eq: { profile: { city: "berlin" }, level: 1 } } }')).toEqual([1]);
  });

  it('keeps array order significant', async () => {
    expect(await userIds('{ meta: { eq: [1, 2, 3] } }')).toEqual([2]);
    expect(await userIds('{ meta: { eq: [3, 2, 1] } }')).toEqual([]);
  });

  it('tells a JSON true apart from the number 1', async () => {
    expect(await userIds('{ meta: { eq: { level: true } } }')).toEqual([4]);
  });

  it('ne excludes the equal document and leaves SQL NULL out', async () => {
    expect(await userIds('{ meta: { ne: [1, 2, 3] } }')).toEqual([1, 4, 5, 6]);
  });
});

describe('sqlite: JSON path reads keep booleans apart from 1 / 0', () => {
  it('eq: true matches only the boolean true', async () => {
    expect(await userIds('{ meta: { path: { path: ["level"], eq: true } } }')).toEqual([4]);
  });

  it('eq: false matches only the boolean false', async () => {
    expect(await userIds('{ meta: { path: { path: ["level"], eq: false } } }')).toEqual([6]);
  });

  it('a number operand does not match a boolean', async () => {
    expect(await userIds('{ meta: { path: { path: ["level"], eq: 1 } } }')).toEqual([1]);
    expect(await userIds('{ meta: { path: { path: ["level"], ne: 1 } } }')).toEqual([]);
  });

  it('a text operand reads a boolean as true / false, not 1 / 0', async () => {
    // The number 1 reads as the text "1", as it does on PostgreSQL; the boolean true does not.
    expect(await userIds('{ meta: { path: { path: ["level"], eq: "1" } } }')).toEqual([1, 5]);
    expect(await userIds('{ meta: { path: { path: ["level"], eq: "true" } } }')).toEqual([4]);
  });
});

describe('sqlite: columns without a meaningful ordering', () => {
  const inputFields = (name: string) => Object.keys((schema.getType(name) as GraphQLInputObjectType).getFields());
  const objectFields = (name: string) => Object.keys((schema.getType(name) as GraphQLObjectType).getFields());
  const enumValues = (name: string) => (schema.getType(name) as GraphQLEnumType).getValues().map((v) => v.name);

  it('leaves JSON and blob bigint columns out of orderBy', () => {
    expect(inputFields('UsersOrderBy')).toEqual(['id', 'nickname', 'role']);
  });

  it('leaves JSON out of distinct, but keeps the blob bigint', () => {
    expect(enumValues('UsersDistinctColumn')).toEqual(['id', 'nickname', 'role', 'amount']);
  });

  it('leaves the blob bigint out of min / max, but counts and groups it', async () => {
    expect(objectFields('UsersMinAggregate')).not.toContain('amount');
    expect(objectFields('UsersMaxAggregate')).not.toContain('amount');
    expect(objectFields('UsersCountDistinctAggregate')).toContain('amount');
    expect(enumValues('UsersGroupByColumn')).toContain('amount');
    const data = await run('{ usersAggregate { countDistinct { amount } } }');
    expect(data.usersAggregate.countDistinct.amount).toBe(2);
  });

  it('rejects a default ordering on such a column at build time', () => {
    for (const column of ['meta', 'amount']) {
      expect(() => buildSchema(db, { defaults: { Users: { orderBy: { [column]: 'asc' } } } } as any)).toThrow(
        /has no meaningful ordering/,
      );
    }
  });
});
