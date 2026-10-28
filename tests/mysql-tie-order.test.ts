// MySQL sibling of tests/sqlite-tie-order.test.ts: tied rows in an ordered list come back in
// primary-key order, with or without `cursor` and with or without a page (issue #236). The
// `(grp, id desc)` index is what InnoDB walks for an ORDER BY on `grp` alone, so untiebroken
// ties come back in the reverse of key order. See tests/util/tie-order.ts.
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
import { afterAll, beforeAll, expect } from 'vitest';
import { buildSchema } from '@/index';
import { defineTieOrderTests, TIE_ITEMS, TIE_LOGS, TIE_PARENTS } from './util/tie-order';

const TieParents = mysqlTable('tie_parents', { id: int('id').primaryKey() });
const TieItems = mysqlTable('tie_items', {
  id: int('id').primaryKey(),
  parentId: int('parent_id').notNull(),
  grp: int('grp').notNull(),
});
const TieLogs = mysqlTable('tie_logs', { grp: int('grp').notNull(), note: varchar('note', { length: 8 }).notNull() });
const tables = { TieParents, TieItems, TieLogs };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  TieParents: { items: r.many.TieItems({ from: r.TieParents.id, to: r.TieItems.parentId }) },
});

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
let db: any;

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

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-tie-order-${randomUUID().slice(0, 8)}`;
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
  const database = `tie_order_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  db = (drizzle as any)({ client: connection, relations });
  await connection.query('CREATE TABLE tie_parents (id int PRIMARY KEY)');
  await connection.query(
    'CREATE TABLE tie_items (id int PRIMARY KEY, parent_id int NOT NULL, grp int NOT NULL, INDEX tie_items_grp (grp, id DESC))',
  );
  await connection.query('CREATE TABLE tie_logs (grp int NOT NULL, note varchar(8) NOT NULL)');
  await db.insert(TieParents).values(TIE_PARENTS);
  await db.insert(TieItems).values(TIE_ITEMS);
  await db.insert(TieLogs).values(TIE_LOGS);
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

defineTieOrderTests(async (source, config) => {
  const res = await graphql({ schema: buildSchema(db, config as any).schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
});
