// A SQLite `integer({ mode: 'number' })` or `numeric({ mode: 'number' })` column stores any
// 64-bit integer. Past ±2^53 a driver like better-sqlite3 reads one as the nearest double, so
// 2^53 and 2^53 + 1 read alike, and a cursor that carried the read number put such rows at one
// position: paging repeated rows forever. Such a row's cursor now carries the stored integer's
// text, which `after` binds as text for SQLite's integer affinity to compare exactly. Every other
// row — a safe integer, a real, or text the column's dynamic typing let it hold — keeps the
// cursor it always had, and the output value is still the number the driver read.
//
// A driver set to read integers as bigints (node:sqlite `readBigInts`, libsql `intMode: 'bigint'`)
// issues a tagged bigint for a safe integer, which `after` used to refuse; it is accepted now.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle as libsqlDrizzle } from 'drizzle-orm/libsql';
import { drizzle as nodeSqliteDrizzle } from 'drizzle-orm/node-sqlite';
import { integer, numeric, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Owners = sqliteTable('owners', { id: integer('id').primaryKey() });
const Nums = sqliteTable('nums', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id').notNull(),
  int: integer('int'),
  key: integer('key').notNull(),
  num: numeric('num', { mode: 'number' }),
});
const tables = { Owners, Nums };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Owners: { nums: r.many.Nums({ from: r.Owners.id, to: r.Nums.ownerId }) },
});

/**
 * Stored values as SQL literals. `int` also holds reals and text; `key` is NOT NULL integers
 * only, so a cursor over it compares as one row value; `num` holds integers and reals.
 */
const ROWS: [id: number, int: string, key: string, num: string][] = [
  [1, '9007199254740993', '-9223372036854775808', '9007199254740993'],
  [2, '9007199254740992', '-9223372036854775807', '9007199254740992'],
  [3, '-9007199254740993', '9223372036854775807', '-9007199254740993'],
  [4, '-9007199254740992', '9223372036854775806', '-9007199254740992'],
  [5, '9223372036854775807', '9007199254740993', '9223372036854775807'],
  [6, '9223372036854775806', '9007199254740992', '9223372036854775806'],
  [7, '-9223372036854775808', '-9007199254740993', '-9223372036854775808'],
  [8, '1.5', '-9007199254740992', '1.5'],
  [9, '1e30', '9007199254740991', '1e30'],
  [10, "'abc'", '0', 'NULL'],
  [11, "'abd'", '-9223372036854775806', '-1.5'],
  [12, 'NULL', '9223372036854775805', '3'],
  [13, '3', '1', '1e30'],
  [14, '-1e30', '-1', '9007199254740993'],
  [15, "'99 bottles'", '2', '9007199254740992'],
];
type ColumnName = 'int' | 'key' | 'num';

/**
 * node:sqlite reading integers the way better-sqlite3, bun:sqlite and sql.js do by default: as a
 * JS number, rounded past ±2^53. (node:sqlite itself refuses such a value instead.)
 */
const roundingClient = (database: DatabaseSync) => ({
  prepare: (query: string) => {
    const statement: StatementSync = database.prepare(query);
    statement.setReadBigInts(true);
    const round = (value: unknown) => (typeof value === 'bigint' ? Number(value) : value);
    const roundRow = (row: any) =>
      Array.isArray(row)
        ? row.map(round)
        : row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key, round(value)]));
    return {
      setReturnArrays: (enabled: boolean) => statement.setReturnArrays(enabled),
      all: (...params: any[]) => statement.all(...params).map(roundRow),
      get: (...params: any[]) => roundRow(statement.get(...params)),
      run: (...params: any[]) => statement.run(...params),
    };
  },
});

let dir: string;
let oracle: DatabaseSync;
const closers: (() => void)[] = [];
const schemas: Record<'rounding' | 'node:sqlite bigints' | 'libsql bigints', GraphQLSchema> = {} as any;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const seed = async (db: any) => {
  await db.run(sql`CREATE TABLE owners (id integer PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE nums (id integer PRIMARY KEY, owner_id integer NOT NULL, int integer, key integer NOT NULL, num numeric)`,
  );
  await db.run(sql`INSERT INTO owners VALUES (1)`);
  await db.run(
    sql.raw(
      `INSERT INTO nums VALUES ${ROWS.map(([id, int, key, num]) => `(${id}, 1, ${int}, ${key}, ${num})`).join(', ')}`,
    ),
  );
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'drizzle-graphql-sqlite-integer-number-mode-'));
  const rounding = new DatabaseSync(join(dir, 'rounding.sqlite'));
  const bigints = new DatabaseSync(join(dir, 'bigints.sqlite'), { readBigInts: true });
  const libsql = createClient({ url: `file:${join(dir, 'libsql.sqlite')}`, intMode: 'bigint' });
  oracle = bigints;
  closers.push(
    () => rounding.close(),
    () => bigints.close(),
    () => libsql.close(),
  );
  const dbs = {
    rounding: (nodeSqliteDrizzle as any)({ client: roundingClient(rounding), relations }),
    'node:sqlite bigints': (nodeSqliteDrizzle as any)({ client: bigints, relations }),
    'libsql bigints': (libsqlDrizzle as any)({ client: libsql, relations }),
  };
  for (const [name, db] of Object.entries(dbs)) {
    await seed(db);
    schemas[name as keyof typeof schemas] = buildSchema(db).schema;
  }
});

afterAll(() => {
  for (const close of closers) {
    close();
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Row ids as SQLite itself orders them, after an optional `where`. */
const sqliteOrder = (column: ColumnName, direction: 'asc' | 'desc', where = 'true'): number[] =>
  oracle
    .prepare(`SELECT id FROM nums WHERE ${where} ORDER BY ${column} ${direction}, id`)
    .all()
    .map((row: any) => Number(row.id));

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

const runOn = (schema: GraphQLSchema) => async (source: string) => {
  const res: any = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((error: Error) => error.message)).toBeUndefined();
  return res.data;
};

const DRIVERS = ['rounding', 'node:sqlite bigints', 'libsql bigints'] as const;

describe.each(DRIVERS)('sqlite (%s): cursors over number-mode integer columns past 2^53', (driver) => {
  const run = (source: string) => runOn(schemas[driver])(source);

  it.each(
    (['int', 'key', 'num'] as const).flatMap((column) => [
      [column, 'asc'],
      [column, 'desc'],
    ]) as [ColumnName, 'asc' | 'desc'][],
  )('a root list ordered by %s %s walks every row once', async (column, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(async (after) => (await run(`{ nums(${orderBy}, limit: 1${after}) { id cursor } }`)).nums);
    expect(seen).toEqual(sqliteOrder(column, direction));
  });

  it.each([
    ['int', 'asc'],
    ['key', 'desc'],
    ['num', 'asc'],
  ] as const)('a relation list ordered by %s %s walks every row once', async (column, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(
      async (after) => (await run(`{ owners { nums(${orderBy}, limit: 1${after}) { id cursor } } }`)).owners[0].nums,
    );
    expect(seen).toEqual(sqliteOrder(column, direction));
  });
});

describe('sqlite: integer cursors issued and accepted', () => {
  const run = (source: string) => runOn(schemas.rounding)(source);
  const payloadOf = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

  it('carries text only for an integer past ±2^53, and the value it always did otherwise', async () => {
    const data = await run(
      '{ nums(orderBy: { int: { direction: asc, priority: 1 } }, where: { id: { inArray: [1, 8, 10, 13] } }) { id cursor } }',
    );
    expect(data.nums.map((row: any) => [row.id, payloadOf(row.cursor).v[0]])).toEqual([
      [8, 1.5],
      [13, 3],
      [1, '9007199254740993'],
      [10, 'abc'],
    ]);
  });

  it('still outputs the value as the number the driver read', async () => {
    const data = await run('{ nums(where: { id: { eq: 1 } }) { int key num } }');
    expect(data.nums).toEqual([{ int: 9007199254740992, key: -(2 ** 63), num: 9007199254740992 }]);
  });

  it('accepts a cursor carrying a rounded number, as cursors issued before did', async () => {
    const after = forge({
      o: [
        ['int', 'asc'],
        ['id', 'asc'],
      ],
      v: [9007199254740992, 1],
    });
    const data = await run(`{ nums(orderBy: { int: { direction: asc, priority: 1 } }, after: "${after}") { id } }`);
    expect(data.nums.map((row: { id: number }) => row.id)).toEqual(
      sqliteOrder('int', 'asc', 'int > 9007199254740992 or (int = 9007199254740992 and id > 1)'),
    );
  });

  it.each<[string, string, unknown]>([
    ['int', 'integer text past 64 bits', '9223372036854775808'],
    ['int', 'numeric-looking text', '1.5'],
    ['int', 'an exponent', '1e5'],
    ['int', 'a padded integer', ' 12'],
    ['num', 'non-numeric text', 'abc'],
    ['key', 'a bigint past 64 bits', { $type: 'bigint', value: '-9223372036854775809' }],
  ])('refuses %s %s as DRIZZLE_INVALID_CURSOR', async (column, _name, value) => {
    const after = forge({
      o: [
        [column, 'asc'],
        ['id', 'asc'],
      ],
      v: [value, 1],
    });
    const res = await graphql({
      schema: schemas.rounding,
      source: `{ nums(orderBy: { ${column}: { direction: asc, priority: 1 } }, after: "${after}") { id } }`,
      contextValue: {},
    });
    expect(res.errors?.map((error) => error.extensions?.['code'])).toEqual(['DRIZZLE_INVALID_CURSOR']);
  });
});
