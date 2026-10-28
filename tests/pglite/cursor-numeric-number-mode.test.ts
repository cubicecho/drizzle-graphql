// A `numeric({ mode: 'number' })` value reads as the nearest double, so values that differ
// beyond double precision (0.1 and 0.10000000000000000001, or two 30-digit integers one apart)
// read as one number. A cursor that carried the read number put such rows at one position, so
// paging served rows twice or skipped them. A cursor over the column now carries PostgreSQL's
// own text of the value, and `after` compares the column with it exactly. The value a page
// outputs is still the lossy number.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, numeric, pgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Owners = pgTable('owners', { id: integer('id').primaryKey() });
const Nums = pgTable('nums', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id').notNull(),
  dec: numeric('dec', { mode: 'number' }),
  scaled: numeric('scaled', { mode: 'number', precision: 40, scale: 25 }).notNull(),
});
const tables = { Owners, Nums };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Owners: { nums: r.many.Nums({ from: r.Owners.id, to: r.Nums.ownerId }) },
});

/** Stored values, as text, each with its rank in PostgreSQL's ascending order (NULLs last). */
const ROWS: [id: number, dec: string | null, decRank: number, scaled: string, scaledRank: number][] = [
  [1, '0.10000000000000000001', 5, '0.1000000000000000000000001', 6],
  [2, '0.1', 4, '0.1', 5],
  [3, '0.10000000000000000002', 6, '0.1000000000000000000000002', 7],
  [4, '123456789012345678901234567890', 7, '-123456789012345.0000000000000000000000001', 1],
  [5, '123456789012345678901234567891', 8, '-123456789012345', 2],
  [6, 'NaN', 10, '123456789012345.0000000000000000000000001', 9],
  [7, 'Infinity', 9, '123456789012345', 8],
  [8, '-Infinity', 1, '123456789012345.0000000000000000000000002', 10],
  [9, null, 11, '0', 3],
  [10, '-0.10000000000000000001', 2, '-0', 3],
  [11, '-0.1', 3, '0.0000000000000000000000001', 4],
];

/** Row ids in PostgreSQL's order of the column whose rank sits at `rank`, then id ascending. */
const expectedOrder = (rank: 2 | 4, direction: 'asc' | 'desc'): number[] =>
  [...ROWS].sort((x, y) => (x[rank] - y[rank]) * (direction === 'asc' ? 1 : -1) || x[0] - y[0]).map(([id]) => id);

let pglite: PGlite;
let schema: GraphQLSchema;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const run = async (source: string) => {
  const res: any = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((error: Error) => error.message)).toBeUndefined();
  return res.data;
};

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE owners (id integer primary key)`);
  await db.execute(
    sql`CREATE TABLE nums (id integer primary key, owner_id integer not null, dec numeric, scaled numeric(40, 25) not null)`,
  );
  await db.execute(sql`INSERT INTO owners VALUES (1)`);
  await db.execute(
    sql.raw(
      `INSERT INTO nums VALUES ${ROWS.map(([id, dec, , scaled]) => `(${id}, 1, ${dec === null ? 'NULL' : `'${dec}'`}, '${scaled}')`).join(', ')}`,
    ),
  );
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
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

describe('pglite: cursors over number-mode numeric columns past double precision', () => {
  it.each([
    ['dec', 2, 'asc'],
    ['dec', 2, 'desc'],
    ['scaled', 4, 'asc'],
    ['scaled', 4, 'desc'],
  ] as const)('a root list ordered by %s walks every row once', async (column, rank, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(async (after) => (await run(`{ nums(${orderBy}, limit: 1${after}) { id cursor } }`)).nums);
    expect(seen).toEqual(expectedOrder(rank, direction));
  });

  it.each([
    ['dec', 2, 'asc'],
    ['scaled', 4, 'desc'],
  ] as const)('a relation list ordered by %s walks every row once', async (column, rank, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(
      async (after) => (await run(`{ owners { nums(${orderBy}, limit: 1${after}) { id cursor } } }`)).owners[0].nums,
    );
    expect(seen).toEqual(expectedOrder(rank, direction));
  });

  it('still outputs the value as the number it reads as', async () => {
    const data = await run(
      '{ nums(where: { id: { inArray: [1, 4] } }, orderBy: { id: { direction: asc, priority: 1 } }) { dec } }',
    );
    expect(data.nums).toEqual([{ dec: 0.1 }, { dec: 1.2345678901234568e29 }]);
  });

  it.each([
    ['a finite number', 0.1, [1, 3, 4, 5, 7, 6, 9]],
    ['a tagged infinity', { $type: 'float', value: 'Infinity' }, [7, 6, 9]],
  ])('accepts a cursor carrying %s, as cursors issued before did', async (_name, value, expected) => {
    const after = forge({
      o: [
        ['dec', 'asc'],
        ['id', 'asc'],
      ],
      v: [value, 2],
    });
    const data = await run(`{ nums(orderBy: { dec: { direction: asc, priority: 1 } }, after: "${after}") { id } }`);
    expect(data.nums.map((row: { id: number }) => row.id)).toEqual(expected);
  });

  it.each(['12abc', '1e5', '.5', '1.', '+1', ' 1', 'nan', ''])(
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
