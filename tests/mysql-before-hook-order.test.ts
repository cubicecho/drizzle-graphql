// MySQL half of tests/before-hook-order.test.ts: a write whose arguments alone are invalid is
// refused before the `before` hook runs, and a valid write fires it exactly once.
//
// The connection is tunnelled through `docker exec` into the container, as in
// tests/mysql-write-paths.test.ts. Set MYSQL_TEST_CONTAINER to reuse a running `mysql:8`
// container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, sql } from 'drizzle-orm';
import { int, mysqlTable, text } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLFieldConfig, GraphQLObjectType, GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = mysqlTable('items', {
  id: int('id').primaryKey(),
  qty: int('qty'),
  deletedAt: text('deleted_at'),
});
const relations = buildRelations({ Items }, {});

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
let db: any;
let schema: GraphQLSchema;
let fired = 0;

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

/**
 * The generated schema plus `rawCreateItemsSingle`, which calls the generated
 * `createItemsSingle` with a column no GraphQL input could carry: the one argument check that
 * path makes, reachable only from a custom resolver.
 */
const buildWithRawCreate = (): GraphQLSchema => {
  const { entities } = buildSchema(db, {
    onError: (error: unknown) => error as Error,
    features: { upsert: true, countMutations: true, requireWhere: true, fieldUpdateOperations: true },
    softDelete: { Items: 'deletedAt' },
    onWrite: {
      Items: {
        before: () => {
          fired++;
        },
      },
    },
  } as any);
  const createSingle = (entities.mutations as any)['createItemsSingle'] as GraphQLFieldConfig<any, any>;
  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: entities.queries as any }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: {
        ...(entities.mutations as any),
        rawCreateItemsSingle: {
          ...createSingle,
          resolve: (source, args, context, info) =>
            createSingle.resolve!(source, { values: { ...args.values, unknownColumn: 1 } }, context, info),
        },
      },
    }),
    types: Object.values(entities.types) as any,
  });
};

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-before-hook-${randomUUID().slice(0, 8)}`;
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
  const database = `before_hook_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  db = (drizzle as any)({ client: connection, relations });
  await connection.query('CREATE TABLE items (id int PRIMARY KEY, qty int, deleted_at text)');
  schema = buildWithRawCreate();
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

beforeEach(async () => {
  fired = 0;
  await db.execute(sql`DELETE FROM items`);
  await db.insert(Items).values([
    { id: 1, qty: 1 },
    { id: 2, qty: 1, deletedAt: 'gone' },
  ]);
});

const REJECTED: { name: string; source: string; code: string }[] = [
  { name: 'insert: no values', source: 'createItems(values: []) { isSuccess }', code: 'DRIZZLE_NO_VALUES' },
  {
    name: 'insertSingle: unknown column',
    source: 'rawCreateItemsSingle(values: { id: 9 }) { isSuccess }',
    code: 'DRIZZLE_UNKNOWN_COLUMN',
  },
  { name: 'upsert: no values', source: 'upsertItems(values: []) { isSuccess }', code: 'DRIZZLE_NO_VALUES' },
  {
    name: 'upsert: conflict update naming a column the values leave out',
    source: 'upsertItems(values: [{ id: 1 }], onConflict: { update: [qty] }) { isSuccess }',
    code: 'DRIZZLE_INVALID_ON_CONFLICT',
  },
  {
    name: 'update: empty set',
    source: 'updateItems(where: { id: { eq: 1 } }, set: {}) { isSuccess }',
    code: 'DRIZZLE_NO_VALUES',
  },
  {
    name: 'update: where matching every row under requireWhere',
    source: 'updateItems(where: {}, set: { qty: { set: 2 } }) { isSuccess }',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  {
    name: 'update: two field operations on one column',
    source: 'updateItems(where: { id: { eq: 1 } }, set: { qty: { increment: 1, decrement: 1 } }) { isSuccess }',
    code: 'DRIZZLE_INVALID_UPDATE_OPERATION',
  },
  {
    name: 'updateSingle: empty where',
    source: 'updateItemsSingle(where: {}, set: { qty: { set: 2 } }) { isSuccess }',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  { name: 'updateMany: no updates', source: 'updateItemsMany(updates: []) { isSuccess }', code: 'DRIZZLE_NO_VALUES' },
  {
    name: 'updateMany: an entry with an empty set',
    source: 'updateItemsMany(updates: [{ where: { id: { eq: 1 } }, set: {} }]) { isSuccess }',
    code: 'DRIZZLE_NO_VALUES',
  },
  {
    name: 'updateMany: an entry without a where under requireWhere',
    source: 'updateItemsMany(updates: [{ set: { qty: { set: 2 } } }]) { isSuccess }',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  { name: 'delete: empty where', source: 'deleteItems(where: {}) { isSuccess }', code: 'DRIZZLE_WHERE_REQUIRED' },
  {
    name: 'deleteSingle: empty where',
    source: 'deleteItemsSingle(where: {}) { isSuccess }',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  { name: 'restore: empty where', source: 'restoreItems(where: {}) { isSuccess }', code: 'DRIZZLE_WHERE_REQUIRED' },
  {
    name: 'update count: empty set',
    source: 'updateItemsCount(where: { id: { eq: 1 } }, set: {})',
    code: 'DRIZZLE_NO_VALUES',
  },
  {
    name: 'update count: empty where',
    source: 'updateItemsCount(where: {}, set: { qty: { set: 2 } })',
    code: 'DRIZZLE_WHERE_REQUIRED',
  },
  { name: 'delete count: empty where', source: 'deleteItemsCount(where: {})', code: 'DRIZZLE_WHERE_REQUIRED' },
];

const ACCEPTED: { name: string; source: string }[] = [
  { name: 'insert', source: 'createItems(values: [{ id: 3 }]) { isSuccess }' },
  { name: 'insertSingle', source: 'createItemsSingle(values: { id: 3 }) { isSuccess }' },
  { name: 'upsert', source: 'upsertItems(values: [{ id: 1, qty: 5 }]) { isSuccess }' },
  { name: 'update', source: 'updateItems(where: { id: { eq: 1 } }, set: { qty: { set: 2 } }) { isSuccess }' },
  {
    name: 'updateSingle',
    source: 'updateItemsSingle(where: { id: { eq: 1 } }, set: { qty: { set: 2 } }) { isSuccess }',
  },
  {
    name: 'updateMany',
    source: 'updateItemsMany(updates: [{ where: { id: { eq: 1 } }, set: { qty: { set: 2 } } }]) { isSuccess }',
  },
  { name: 'delete', source: 'deleteItems(where: { id: { eq: 1 } }) { isSuccess }' },
  { name: 'deleteSingle', source: 'deleteItemsSingle(where: { id: { eq: 1 } }) { isSuccess }' },
  { name: 'restore', source: 'restoreItems(where: { id: { eq: 2 } }) { isSuccess }' },
  { name: 'update count', source: 'updateItemsCount(where: { id: { eq: 1 } }, set: { qty: { set: 2 } })' },
  { name: 'delete count', source: 'deleteItemsCount(where: { id: { eq: 1 } })' },
];

describe.sequential('mysql: the before hook runs only once the arguments have passed', () => {
  it.each(REJECTED)('$name: refused without firing the hook', async ({ source, code }) => {
    const res = await graphql({ schema, source: `mutation { ${source} }`, contextValue: {} });

    expect(res.errors?.[0]?.extensions?.['code']).toBe(code);
    expect(fired).toBe(0);
  });

  it.each(ACCEPTED)('$name: fires the hook once', async ({ source }) => {
    const res = await graphql({ schema, source: `mutation { ${source} }`, contextValue: {} });

    expect(res.errors).toBeUndefined();
    expect(fired).toBe(1);
  });
});
