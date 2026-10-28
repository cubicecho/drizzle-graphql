// A MySQL `float` column stores single precision, while a bound operand is a double: `v = 0.1`
// missed the stored 0.1, and a cursor walk over the column never got past its own row. Operands
// against single-precision columns are now cast to `float`; a `float(p > 24)` is a DOUBLE and is
// left alone.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations } from 'drizzle-orm';
import { float, int, mysqlTable } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

/** A MySQL `FLOAT(p)` above this precision is stored as DOUBLE. */
const DOUBLE_PRECISION_FLOAT = 30;
const PAGE_SIZE = 2;
const MAX_PAGES = 10;

const Nums = mysqlTable('nums', {
  id: int('id').primaryKey(),
  v: float('v'),
  scaled: float('scaled', { precision: 6, scale: 2 }),
  wide: float('wide', { precision: DOUBLE_PRECISION_FLOAT }),
});
const relations = buildRelations({ Nums }, {});
const ROWS = [
  { id: 1, v: 0.1, scaled: 0.1, wide: 0.1 },
  { id: 2, v: 0.1, scaled: 0.1, wide: 0.1 },
  { id: 3, v: 0.2, scaled: 0.2, wide: 0.2 },
  { id: 4, v: 0.3, scaled: 0.3, wide: 0.3 },
  { id: 5, v: 0.7, scaled: 0.7, wide: 0.7 },
  { id: 6, v: 1.5, scaled: 1.5, wide: 1.5 },
];

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

const run = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};
const ids = async (where: string) =>
  (await run(`{ nums(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`)).nums.map(
    (row: any) => row.id,
  );

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-float-${randomUUID().slice(0, 8)}`;
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
  const database = `float_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  const db: any = (drizzle as any)({ client: connection, relations });
  await connection.query(
    `CREATE TABLE nums (id int PRIMARY KEY, v float, scaled float(6,2), wide float(${DOUBLE_PRECISION_FLOAT}))`,
  );
  await db.insert(Nums).values(ROWS);
  schema = buildSchema(db).schema;
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

describe('mysql: float columns', () => {
  it.each(['v', 'scaled', 'wide'])('eq / ne / inArray / ranges on %s match the values read back', async (column) => {
    expect(await ids(`{ ${column}: { eq: 0.1 } }`)).toEqual([1, 2]);
    expect(await ids(`{ ${column}: { ne: 0.1 } }`)).toEqual([3, 4, 5, 6]);
    expect(await ids(`{ ${column}: { inArray: [0.2, 0.7] } }`)).toEqual([3, 5]);
    expect(await ids(`{ ${column}: { gte: 0.3, lte: 0.7 } }`)).toEqual([4, 5]);
    expect(await ids(`{ ${column}: { gt: 0.1, lt: 0.3 } }`)).toEqual([3]);
  });

  it.each([
    ['v', 'asc', [1, 2, 3, 4, 5, 6]],
    ['v', 'desc', [6, 5, 4, 3, 1, 2]],
    ['scaled', 'asc', [1, 2, 3, 4, 5, 6]],
    ['wide', 'desc', [6, 5, 4, 3, 1, 2]],
  ])('a cursor walk over %s %s visits every row once', async (column, direction, expected) => {
    const orderBy = `{ ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen: number[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const afterArg: string = after ? `, after: "${after}"` : '';
      const rows: any[] = (await run(`{ nums(orderBy: ${orderBy}, limit: ${PAGE_SIZE}${afterArg}) { id cursor } }`))
        .nums;
      if (!rows.length) {
        break;
      }
      seen.push(...rows.map((row) => row.id));
      after = rows[rows.length - 1].cursor;
    }
    expect(seen).toEqual(expected);
  });
});
