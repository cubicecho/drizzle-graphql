// MySQL sibling of tests/sqlite-read-paths.test.ts. `offset: 0` without a `limit` was sent as
// `OFFSET ?` with no `LIMIT`, which MySQL rejects as a syntax error; and a root list page under a
// non-unique `orderBy` had no primary-key tiebreak.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Shops = mysqlTable('shops', { id: int('id').primaryKey() });
const Items = mysqlTable('items', { id: int('id').primaryKey(), shopId: int('shop_id').notNull() });
// A text primary key, inserted out of key order, so tied rows are not already in key order.
const Tags = mysqlTable('tags', {
  id: varchar('id', { length: 8 }).primaryKey(),
  shopId: int('shop_id').notNull(),
  grp: int('grp').notNull(),
});
const tables = { Shops, Items, Tags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Shops: {
    items: r.many.Items({ from: r.Shops.id, to: r.Items.shopId }),
    tags: r.many.Tags({ from: r.Shops.id, to: r.Tags.shopId }),
  },
});

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
let schema: ReturnType<typeof buildSchema>['schema'];
let lazy: ReturnType<typeof buildSchema>['schema'];
const queries: string[] = [];

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

const run = async (source: string, target = schema) => {
  const res = await graphql({ schema: target, source, contextValue: {} });
  return { data: res.data as any, errors: res.errors?.map((e) => (e.originalError as any)?.message ?? e.message) };
};

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-read-paths-${randomUUID().slice(0, 8)}`;
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
  const database = `read_paths_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  const db: any = (drizzle as any)({
    client: connection,
    relations,
    logger: { logQuery: (query: string) => queries.push(query) },
  });
  await connection.query('CREATE TABLE shops (id int PRIMARY KEY)');
  await connection.query('CREATE TABLE items (id int PRIMARY KEY, shop_id int NOT NULL)');
  await connection.query('CREATE TABLE tags (id varchar(8) PRIMARY KEY, shop_id int NOT NULL, grp int NOT NULL)');
  await db.insert(Shops).values([{ id: 1 }, { id: 2 }]);
  await db.insert(Items).values([
    { id: 1, shopId: 1 },
    { id: 2, shopId: 1 },
  ]);
  await db.insert(Tags).values([
    { id: 'd', shopId: 1, grp: 1 },
    { id: 'b', shopId: 1, grp: 1 },
    { id: 'c', shopId: 1, grp: 2 },
    { id: 'a', shopId: 1, grp: 2 },
  ]);
  schema = buildSchema(db, { onError: (e) => e as Error }).schema;
  lazy = buildSchema(db, { onError: (e) => e as Error, eagerLoadRelations: false }).schema;
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

describe('mysql: offset: 0 without limit', () => {
  it('root list', async () => {
    const res = await run('{ shops(offset: 0) { id } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.shops.map((s: any) => s.id)).toEqual([1, 2]);
  });

  it('single', async () => {
    const res = await run('{ shopsSingle(offset: 0) { id } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.shopsSingle).toEqual({ id: 1 });
  });

  it('eager and lazy relation fields', async () => {
    for (const target of [schema, lazy]) {
      const res = await run('{ shops { id items(offset: 0) { id } } }', target);
      expect(res.errors).toBeUndefined();
      expect(res.data.shops[0].items.map((s: any) => s.id)).toEqual([1, 2]);
    }
  });

  it('distinct', async () => {
    const res = await run('{ tags(distinct: [grp], offset: 0) { id } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.tags.map((t: any) => t.id)).toEqual(['a', 'b']);
  });
});

describe('mysql: primary-key tiebreak on a root list page', () => {
  it('pages a non-unique orderBy by primary key within ties', async () => {
    queries.length = 0;
    const first = await run('{ tags(orderBy: { grp: { direction: asc, priority: 1 } }, limit: 2) { id } }');
    const second = await run('{ tags(orderBy: { grp: { direction: asc, priority: 1 } }, limit: 2, offset: 2) { id } }');
    expect(first.errors).toBeUndefined();
    expect(second.errors).toBeUndefined();
    expect([...first.data.tags, ...second.data.tags].map((t: any) => t.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(queries[0]).toMatch(/order by .*`grp` asc, .*`id` asc/);
  });
});
