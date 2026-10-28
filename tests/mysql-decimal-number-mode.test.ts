// A MySQL `decimal({ mode: 'number' })` value reads as the nearest double, so values that differ
// beyond double precision (0.1 and 0.100000000000000000000000000001, or two 35-digit integers one
// apart) read as one number. A cursor that carried the read number put such rows at one
// position, so paging served rows twice or never ended. A cursor over the column now carries
// MySQL's own text of the value, and `after` compares the column with it exactly (MySQL converts
// the string operand to the column's decimal). The value a page outputs is still the lossy number.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { decimal, int, mysqlTable } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Owners = mysqlTable('owners', { id: int('id').primaryKey() });
const Nums = mysqlTable('nums', {
  id: int('id').primaryKey(),
  ownerId: int('owner_id').notNull(),
  dec: decimal('dec', { mode: 'number', precision: 65, scale: 30 }),
  big: decimal('big', { mode: 'number', precision: 40, scale: 0 }).notNull(),
});
const tables = { Owners, Nums };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Owners: { nums: r.many.Nums({ from: r.Owners.id, to: r.Nums.ownerId }) },
});

/** Stored values, as text, each with its rank in MySQL's ascending order (NULLs first). */
const ROWS: [id: number, dec: string | null, decRank: number, big: string, bigRank: number][] = [
  [1, '0.100000000000000000000000000001', 5, '1234567890123456789012345678901234567890', 7],
  [2, '0.1', 4, '1234567890123456789012345678901234567889', 6],
  [3, '0.100000000000000000000000000002', 6, '-1234567890123456789012345678901234567890', 1],
  [4, '12345678901234567890123456789012345', 7, '-1234567890123456789012345678901234567889', 2],
  [5, '12345678901234567890123456789012346', 8, '9007199254740993', 5],
  [6, null, 0, '9007199254740992', 4],
  [7, '-0.100000000000000000000000000001', 2, '0', 3],
  [8, '-0.1', 3, '9999999999999999999999999999999999999999', 8],
];

/** Row ids in MySQL's order of the column whose rank sits at `rank`, then id ascending. */
const expectedOrder = (rank: 2 | 4, direction: 'asc' | 'desc'): number[] =>
  [...ROWS].sort((x, y) => (x[rank] - y[rank]) * (direction === 'asc' ? 1 : -1) || x[0] - y[0]).map(([id]) => id);

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

const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const run = async (source: string) => {
  const res: any = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((error: Error) => error.message)).toBeUndefined();
  return res.data;
};

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-decimal-number-mode-${randomUUID().slice(0, 8)}`;
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
  const database = `decimal_number_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  await connection.query('CREATE TABLE owners (id int PRIMARY KEY)');
  await connection.query(
    'CREATE TABLE nums (id int PRIMARY KEY, owner_id int NOT NULL, `dec` decimal(65, 30), big decimal(40, 0) NOT NULL)',
  );
  await connection.query('INSERT INTO owners VALUES (1)');
  await connection.query(
    `INSERT INTO nums VALUES ${ROWS.map(([id, dec, , big]) => `(${id}, 1, ${dec ?? 'NULL'}, ${big})`).join(', ')}`,
  );
  const db = (drizzle as any)({ client: connection, relations });
  schema = buildSchema(db).schema;
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

/** Pages one row at a time through `page`, feeding each page's cursor back as `after`. */
const walk = async (page: (after: string) => Promise<{ id: number; cursor: string }[]>): Promise<number[]> => {
  const seen: number[] = [];
  let after = '';
  for (let i = 0; i <= ROWS.length; i++) {
    const rows = await page(after);
    if (!rows.length) {
      return seen;
    }
    seen.push(...rows.map((row) => row.id));
    after = `, after: "${rows[rows.length - 1]!.cursor}"`;
  }
  throw new Error('cursor pagination did not terminate');
};

describe('mysql: cursors over number-mode decimal columns past double precision', () => {
  it.each([
    ['dec', 2, 'asc'],
    ['dec', 2, 'desc'],
    ['big', 4, 'asc'],
    ['big', 4, 'desc'],
  ] as const)('a root list ordered by %s walks every row once', async (column, rank, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(async (after) => (await run(`{ nums(${orderBy}, limit: 1${after}) { id cursor } }`)).nums);
    expect(seen).toEqual(expectedOrder(rank, direction));
  });

  it.each([
    ['dec', 2, 'asc'],
    ['big', 4, 'desc'],
  ] as const)('a relation list ordered by %s walks every row once', async (column, rank, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(
      async (after) => (await run(`{ owners { nums(${orderBy}, limit: 1${after}) { id cursor } } }`)).owners[0].nums,
    );
    expect(seen).toEqual(expectedOrder(rank, direction));
  });

  it('still outputs the value as the number it reads as', async () => {
    const data = await run('{ nums(where: { id: { eq: 1 } }) { dec big } }');
    expect(data.nums).toEqual([{ dec: 0.1, big: Number(ROWS[0]![3]) }]);
  });

  it('accepts a cursor carrying a number, as cursors issued before did', async () => {
    const after = forge({
      o: [
        ['dec', 'asc'],
        ['id', 'asc'],
      ],
      v: [0.1, 2],
    });
    const data = await run(`{ nums(orderBy: { dec: { direction: asc, priority: 1 } }, after: "${after}") { id } }`);
    expect(data.nums.map((row: { id: number }) => row.id)).toEqual([1, 3, 4, 5]);
  });

  it.each(['12abc', '1e5', '.5', 'NaN', 'Infinity', ''])(
    'refuses the text %j as DRIZZLE_INVALID_CURSOR',
    async (text) => {
      const after = forge({
        o: [
          ['dec', 'asc'],
          ['id', 'asc'],
        ],
        v: [text, 1],
      });
      const res = await graphql({
        schema,
        source: `{ nums(orderBy: { dec: { direction: asc, priority: 1 } }, after: "${after}") { id } }`,
        contextValue: {},
      });
      expect(res.errors?.map((error) => error.extensions?.['code'])).toEqual(['DRIZZLE_INVALID_CURSOR']);
    },
  );
});
