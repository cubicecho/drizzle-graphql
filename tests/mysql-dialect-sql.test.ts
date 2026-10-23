// MySQL reads that used to compile to SQL this dialect rejects or answers differently from
// PostgreSQL: `ilike`, `offset` without `limit`, whole-document JSON equality, cursor pages over
// an ENUM, and `avg` rounded to four decimals.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { int, json, mysqlEnum, mysqlTable, primaryKey, text } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLInputObjectType, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Users = mysqlTable('users', {
  id: int('id').primaryKey(),
  nickname: text('nickname'),
  role: mysqlEnum('role', ['admin', 'member', 'guest']).notNull(),
  age: int('age'),
  meta: json('meta'),
});
const Posts = mysqlTable('posts', {
  id: int('id').primaryKey(),
  authorId: int('author_id').notNull(),
  score: int('score'),
});
const Tags = mysqlTable('tags', { id: int('id').primaryKey() });
const PostTags = mysqlTable('post_tags', { postId: int('post_id').notNull(), tagId: int('tag_id').notNull() }, (t) => [
  primaryKey({ columns: [t.postId, t.tagId] }),
]);

const tables = { Users, Posts, Tags, PostTags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: { posts: r.many.Posts({ from: r.Users.id, to: r.Posts.authorId }) },
  Posts: {
    tags: r.many.Tags({ from: r.Posts.id.through(r.PostTags.postId), to: r.Tags.id.through(r.PostTags.tagId) }),
  },
});

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
let schema: ReturnType<typeof buildSchema>['schema'];

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

const run = async (source: string, variableValues?: Record<string, any>) => {
  const res = await graphql({ schema, source, contextValue: {}, variableValues });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};
const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
const userIds = async (where: string) =>
  ids((await run(`{ users(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`)).users);

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-dialect-${randomUUID().slice(0, 8)}`;
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
  const database = `dialect_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  const db: any = (drizzle as any)({ client: connection, relations });

  await connection.query(
    "CREATE TABLE users (id int PRIMARY KEY, nickname text, role enum('admin','member','guest') NOT NULL, age int, meta json)",
  );
  await connection.query('CREATE TABLE posts (id int PRIMARY KEY, author_id int NOT NULL, score int)');
  await connection.query('CREATE TABLE tags (id int PRIMARY KEY)');
  await connection.query(
    'CREATE TABLE post_tags (post_id int NOT NULL, tag_id int NOT NULL, PRIMARY KEY (post_id, tag_id))',
  );

  await db.insert(Users).values([
    { id: 1, nickname: 'al', role: 'admin', age: 30, meta: { level: 1, profile: { city: 'berlin' } } },
    { id: 2, nickname: null, role: 'member', age: null, meta: [1, 2, 3] },
    { id: 3, nickname: 'a_b', role: 'guest', age: 30, meta: null },
    { id: 4, nickname: 'aXb', role: 'member', age: 25, meta: { level: true } },
    { id: 5, nickname: 'zed', role: 'guest', age: 40, meta: { level: '1' } },
    { id: 6, nickname: 'x', role: 'admin', age: 25, meta: { level: false } },
  ]);
  await db.insert(Posts).values([
    { id: 1, authorId: 1, score: 5 },
    { id: 2, authorId: 1, score: 3 },
    { id: 3, authorId: 1, score: 5 },
    { id: 4, authorId: 2, score: null },
  ]);
  await db.insert(Tags).values([{ id: 1 }, { id: 2 }, { id: 3 }]);
  await db.insert(PostTags).values([
    { postId: 1, tagId: 1 },
    { postId: 1, tagId: 2 },
    { postId: 1, tagId: 3 },
  ]);

  schema = buildSchema(db).schema;
});

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

describe('mysql: ilike / notIlike', () => {
  it('ilike matches case-insensitively instead of failing on the missing keyword', async () => {
    expect(await userIds('{ nickname: { ilike: "A_B" } }')).toEqual([3, 4]);
  });

  it('notIlike excludes case-insensitively', async () => {
    expect(await userIds('{ nickname: { notIlike: "A%" } }')).toEqual([5, 6]);
  });
});

describe('mysql: offset without limit', () => {
  const OB = 'orderBy: { id: { direction: asc, priority: 1 } }';

  it('on a root list', async () => {
    expect(ids((await run(`{ users(offset: 4, ${OB}) { id } }`)).users)).toEqual([5, 6]);
  });

  it('after a cursor', async () => {
    const first = await run(`{ users(limit: 2, ${OB}) { id cursor } }`);
    const next = await run(`query($a: String) { users(after: $a, offset: 1, ${OB}) { id } }`, {
      a: first.users[1].cursor,
    });
    expect(ids(next.users)).toEqual([4, 5, 6]);
  });

  it('with distinct', async () => {
    // distinct roles by lowest id: 1 admin, 2 member, 3 guest
    expect(ids((await run(`{ users(distinct: [role], offset: 1, ${OB}) { id } }`)).users)).toEqual([2, 3]);
  });

  it('on an eager to-many relation, a junction relation, and under a single-row query', async () => {
    const list = await run(`{ users(where: { id: { eq: 1 } }) { posts(offset: 1, ${OB}) { id } } }`);
    expect(ids(list.users[0].posts)).toEqual([2, 3]);
    const through = await run(`{ posts(where: { id: { eq: 1 } }) { tags(offset: 2, ${OB}) { id } } }`);
    expect(ids(through.posts[0].tags)).toEqual([3]);
    const single = await run(`{ usersSingle(where: { id: { eq: 1 } }) { posts(offset: 2, ${OB}) { id } } }`);
    expect(ids(single.usersSingle.posts)).toEqual([3]);
  });
});

describe('mysql: whole-document JSON eq / ne', () => {
  it('matches an equal object document, whatever the key order', async () => {
    expect(await userIds('{ meta: { eq: { level: 1, profile: { city: "berlin" } } } }')).toEqual([1]);
    expect(await userIds('{ meta: { eq: { profile: { city: "berlin" }, level: 1 } } }')).toEqual([1]);
  });

  it('matches an equal array document', async () => {
    expect(await userIds('{ meta: { eq: [1, 2, 3] } }')).toEqual([2]);
  });

  it('ne excludes the equal document', async () => {
    expect(await userIds('{ meta: { ne: [1, 2, 3] } }')).toEqual([1, 4, 5, 6]);
  });
});

describe('mysql: cursor pages over an ENUM', () => {
  const walk = async (orderBy: string) => {
    const seen: number[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data: any = await run(
        `query($a: String) { users(orderBy: ${orderBy}, limit: 2, after: $a) { id cursor } }`,
        {
          a: after,
        },
      );
      if (!data.users.length) {
        break;
      }
      seen.push(...ids(data.users));
      after = data.users[data.users.length - 1].cursor;
    }
    return seen;
  };

  for (const direction of ['asc', 'desc']) {
    it(`walks every row in declaration order (${direction})`, async () => {
      const orderBy = `{ role: { direction: ${direction}, priority: 2 }, id: { direction: asc, priority: 1 } }`;
      const full = ids((await run(`{ users(orderBy: ${orderBy}) { id } }`)).users);
      // admin < member < guest by declaration, not alphabetically
      expect(full).toEqual(direction === 'asc' ? [1, 6, 2, 4, 3, 5] : [3, 5, 2, 4, 1, 6]);
      expect(await walk(orderBy)).toEqual(full);
    });
  }

  it('leaves JSON out of orderBy', () => {
    expect(Object.keys((schema.getType('UsersOrderBy') as GraphQLInputObjectType).getFields())).not.toContain('meta');
  });
});

describe('mysql: avg is not rounded to four decimals', () => {
  it('on an aggregate, a filtered aggregate, and a relation aggregate', async () => {
    const posts = await run('{ postsAggregate { avg { score } } }');
    expect(posts.postsAggregate.avg.score).toBeCloseTo(13 / 3, 10);
    const users = await run('{ usersAggregate(where: { id: { inArray: [1, 4, 5] } }) { avg { age } } }');
    expect(users.usersAggregate.avg.age).toBeCloseTo(95 / 3, 10);
    const related = await run('{ users(where: { id: { eq: 1 } }) { postsAggregate { avg { score } } } }');
    expect(related.users[0].postsAggregate.avg.score).toBeCloseTo(13 / 3, 10);
  });

  it('in having', async () => {
    const data = await run(
      '{ postsGroupBy(groupBy: [authorId], having: { avg: { score: { gt: 4.3334 } } }) { group { authorId } } }',
    );
    expect(data.postsGroupBy).toEqual([]);
    const lower = await run(
      '{ postsGroupBy(groupBy: [authorId], having: { avg: { score: { gt: 4.3333 } } }) { group { authorId } } }',
    );
    expect(lower.postsGroupBy).toEqual([{ group: { authorId: 1 } }]);
  });
});
