// MySQL sibling of tests/sqlite-filter-semantics.test.ts.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { int, mysqlTable, text } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = mysqlTable('items', { id: int('id').primaryKey(), name: text('name') });
const Posts = mysqlTable('posts', { id: int('id').primaryKey(), itemId: int('item_id'), title: text('title') });
const Comments = mysqlTable('comments', { id: int('id').primaryKey(), postId: int('post_id'), body: text('body') });
const tables = { Items, Posts, Comments };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Items: { posts: r.many.Posts({ from: r.Items.id, to: r.Posts.itemId }) },
  Posts: {
    item: r.one.Items({ from: r.Posts.itemId, to: r.Items.id }),
    comments: r.many.Comments({ from: r.Posts.id, to: r.Comments.postId }),
  },
  Comments: { post: r.one.Posts({ from: r.Comments.postId, to: r.Posts.id }) },
});

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
let schema: GraphQLSchema;

const tunnel = (name: string) => () => {
  const child = spawn('docker', [
    'exec',
    '-i',
    name,
    'bash',
    '-c',
    'exec 3<>/dev/tcp/127.0.0.1/3306; cat <&3 & exec cat >&3',
  ]);
  const stream: any = Duplex.from({ readable: child.stdout, writable: child.stdin } as any);
  stream.setNoDelay = () => stream;
  stream.setKeepAlive = () => stream;
  stream.setTimeout = () => stream;
  stream.on('close', () => child.kill());
  return stream;
};
const connect = async (name: string, database?: string) => {
  let last: unknown;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const conn = await mysql.createConnection({
        stream: tunnel(name),
        user: 'root',
        password: 'mysql',
        ...(database ? { database } : {}),
      } as any);
      await conn.query('select 1');
      return conn;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last;
};

const ids = async (root: string, where: string): Promise<number[]> => {
  const res: any = await graphql({
    schema,
    source: `{ ${root}(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    contextValue: {},
  });
  expect(res.errors).toBeUndefined();
  return res.data[root].map((row: any) => row.id);
};

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-filter-semantics-${randomUUID().slice(0, 8)}`;
    const started = spawnSync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-e',
      'MYSQL_ROOT_PASSWORD=mysql',
      'mysql:8',
    ]);
    if (started.status !== 0) {
      throw new Error(`docker run failed: ${started.stderr}`);
    }
    ownContainer = true;
  }
  const database = `filter_semantics_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  const db: any = (drizzle as any)({ client: connection, relations });
  await connection.query('CREATE TABLE items (id int PRIMARY KEY, name text)');
  await connection.query('CREATE TABLE posts (id int PRIMARY KEY, item_id int, title text)');
  await connection.query('CREATE TABLE comments (id int PRIMARY KEY, post_id int, body text)');
  // 1: every post is "x" · 2: no posts · 3: one NULL-title post · 4: "x" and NULL · 5: "y"
  await db.insert(Items).values([1, 2, 3, 4, 5].map((id) => ({ id, name: id === 1 ? null : 'n' })));
  await db.insert(Posts).values([
    { id: 1, itemId: 1, title: 'x' },
    { id: 2, itemId: 1, title: 'x' },
    { id: 3, itemId: 3, title: null },
    { id: 4, itemId: 4, title: 'x' },
    { id: 5, itemId: 4, title: null },
    { id: 6, itemId: 5, title: 'y' },
  ]);
  await db.insert(Comments).values([
    { id: 1, postId: 1, body: 'ok' },
    { id: 2, postId: 2, body: null },
    { id: 3, postId: 6, body: 'ok' },
  ]);
  schema = buildSchema(db).schema;
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

describe('every: a related row whose compared column is NULL fails', () => {
  it('passes only items whose every post matches, and items with no posts', async () => {
    expect(await ids('items', '{ posts: { every: { title: { eq: "x" } } } }')).toEqual([1, 2]);
  });

  it('NOT every is its exact complement', async () => {
    expect(await ids('items', '{ NOT: { posts: { every: { title: { eq: "x" } } } } }')).toEqual([3, 4, 5]);
  });

  it('nested every inside every fails a NULL comment body', async () => {
    expect(await ids('items', '{ posts: { every: { comments: { every: { body: { eq: "ok" } } } } } }')).toEqual([
      2, 3, 4, 5,
    ]);
  });

  it('a match-all inner filter keeps every item; a match-nothing one keeps only items with no posts', async () => {
    expect(await ids('items', '{ posts: { every: { title: { notInArray: [] } } } }')).toEqual([1, 2, 3, 4, 5]);
    expect(await ids('items', '{ posts: { every: { title: { inArray: [] } } } }')).toEqual([2]);
  });

  it('a to-one filter does not match a NULL target column', async () => {
    expect(await ids('posts', '{ item: { name: { ne: "n" } } }')).toEqual([]);
    expect(await ids('posts', '{ item: { name: { isNull: true } } }')).toEqual([1, 2]);
  });
});
