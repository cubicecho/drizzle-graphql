// MySQL `bigint` columns in their lossy and their string modes (issue #237).
//
// A `bigint({ mode: 'number' })` / `serial` value past ±2^53 reads as the nearest double, and a
// cursor that carried it put neighbouring rows at one position: -2^63 went out as
// -9223372036854776000, below every row, so the row at -2^63 was served again. A cursor over
// these columns now carries MySQL's own text of the value, and `after` compares exactly.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { bigint, int, mysqlTable, serial } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Owners = mysqlTable('owners', { id: int('id').primaryKey() });
const Nums = mysqlTable('nums', {
  id: int('id').primaryKey(),
  ownerId: int('owner_id').notNull(),
  big: bigint('big', { mode: 'number' }),
  ubig: bigint('ubig', { mode: 'number', unsigned: true }).notNull(),
  ser: serial('ser'),
});
const tables = { Owners, Nums };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Owners: { nums: r.many.Nums({ from: r.Owners.id, to: r.Nums.ownerId }) },
});

/** Stored values, as text: the extremes and their neighbours, which a double cannot tell apart. */
const NUM_ROWS: [id: number, big: string | null, ubig: string, ser: string][] = [
  [1, '-9223372036854775808', '18446744073709551615', '18446744073709551615'],
  [2, '-9223372036854775807', '18446744073709551614', '18446744073709551614'],
  [3, '-9223372036854775806', '0', '1'],
  [4, '9223372036854775807', '9223372036854775808', '9223372036854775808'],
  [5, '9223372036854775806', '9223372036854775807', '9223372036854775807'],
  [6, '0', '9007199254740993', '9007199254740993'],
  [7, null, '9007199254740992', '9007199254740992'],
  [8, '9007199254740993', '1', '2'],
  [9, '9007199254740992', '2', '3'],
];
const NUM_COLUMNS = { big: 1, ubig: 2, ser: 3 } as const;

/** Row ids in the order MySQL sorts `column` (NULLs smallest), then id ascending. */
const expectedOrder = (column: keyof typeof NUM_COLUMNS, direction: 'asc' | 'desc'): number[] =>
  [...NUM_ROWS]
    .sort((x, y) => {
      const a = x[NUM_COLUMNS[column]];
      const b = y[NUM_COLUMNS[column]];
      if (a !== b) {
        const sign = direction === 'asc' ? 1 : -1;
        if (a === null || b === null) {
          return (a === null ? -1 : 1) * sign;
        }
        return (BigInt(a) < BigInt(b) ? -1 : 1) * sign;
      }
      return x[0] - y[0];
    })
    .map(([id]) => id);

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
    container = `drizzle-graphql-mysql-bigint-modes-${randomUUID().slice(0, 8)}`;
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
  const database = `bigint_modes_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  await connection.query('CREATE TABLE owners (id int PRIMARY KEY)');
  await connection.query(`CREATE TABLE nums (id int PRIMARY KEY, owner_id int NOT NULL, big bigint,
    ubig bigint unsigned NOT NULL, ser bigint unsigned NOT NULL UNIQUE)`);
  await connection.query('INSERT INTO owners VALUES (1)');
  await connection.query(
    `INSERT INTO nums VALUES ${NUM_ROWS.map(([id, big, ubig, ser]) => `(${id}, 1, ${big ?? 'NULL'}, ${ubig}, ${ser})`).join(', ')}`,
  );
  const db: any = (drizzle as any)({ client: connection, relations });
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
  for (let i = 0; i <= NUM_ROWS.length; i++) {
    const rows = await page(after);
    if (!rows.length) {
      return seen;
    }
    seen.push(...rows.map((row) => row.id));
    after = `, after: "${rows[rows.length - 1]!.cursor}"`;
  }
  throw new Error('cursor pagination did not terminate');
};

describe('mysql: cursors over number-mode bigint columns past 2^53', () => {
  it.each(
    (['big', 'ubig', 'ser'] as const).flatMap((column) => [
      [column, 'asc'],
      [column, 'desc'],
    ]) as [keyof typeof NUM_COLUMNS, 'asc' | 'desc'][],
  )('a root list ordered by %s %s walks every row once', async (column, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(async (after) => (await run(`{ nums(${orderBy}, limit: 1${after}) { id cursor } }`)).nums);
    expect(seen).toEqual(expectedOrder(column, direction));
  });

  it.each([
    ['big', 'asc'],
    ['ubig', 'desc'],
  ] as const)('a relation list ordered by %s %s walks every row once', async (column, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(
      async (after) => (await run(`{ owners { nums(${orderBy}, limit: 1${after}) { id cursor } } }`)).owners[0].nums,
    );
    expect(seen).toEqual(expectedOrder(column, direction));
  });

  it('still outputs the value as the number it reads as', async () => {
    const data = await run('{ nums(where: { id: { eq: 2 } }) { big ubig } }');
    expect(data.nums).toEqual([{ big: Number(NUM_ROWS[1]![1]), ubig: Number(NUM_ROWS[1]![2]) }]);
  });

  it('accepts a cursor carrying a number, as cursors issued before did', async () => {
    const after = forge({
      o: [
        ['big', 'asc'],
        ['id', 'asc'],
      ],
      v: [0, 6],
    });
    const data = await run(`{ nums(orderBy: { big: { direction: asc, priority: 1 } }, after: "${after}") { id } }`);
    expect(data.nums.map((row: { id: number }) => row.id)).toEqual([9, 8, 5, 4]);
  });

  it.each<[string, string]>([
    ['big', '12abc'],
    ['big', '9223372036854775808'],
    ['ubig', '-1'],
    ['ubig', '18446744073709551616'],
  ])('refuses %s text %j as DRIZZLE_INVALID_CURSOR', async (column, text) => {
    const after = forge({
      o: [
        [column, 'asc'],
        ['id', 'asc'],
      ],
      v: [text, 1],
    });
    const res = await graphql({
      schema,
      source: `{ nums(orderBy: { ${column}: { direction: asc, priority: 1 } }, after: "${after}") { id } }`,
      contextValue: {},
    });
    expect(res.errors?.map((error) => error.extensions?.['code'])).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });
});
