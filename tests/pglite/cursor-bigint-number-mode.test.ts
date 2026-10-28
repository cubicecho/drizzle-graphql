// A `bigint({ mode: 'number' })` / `bigserial({ mode: 'number' })` value past ±2^53 reads as
// the nearest double: -2^63 + 1 and -2^63 + 2 both read as -2^63. A cursor that carried the read
// number put every such row at one position, so paging served rows twice or skipped them. A
// cursor over these columns now carries PostgreSQL's own text of the value, and `after`
// compares the column with it exactly. The value a page outputs is still the lossy number.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { bigint, bigserial, integer, pgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Owners = pgTable('owners', { id: integer('id').primaryKey() });
const Nums = pgTable('nums', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id').notNull(),
  big: bigint('big', { mode: 'number' }),
  ser: bigserial('ser', { mode: 'number' }).notNull(),
});
const tables = { Owners, Nums };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Owners: { nums: r.many.Nums({ from: r.Owners.id, to: r.Nums.ownerId }) },
});

/** Stored values, as text: the extremes and their neighbours, which a double cannot tell apart. */
const ROWS: [id: number, big: string | null, ser: string][] = [
  [1, '-9223372036854775808', '9223372036854775807'],
  [2, '-9223372036854775807', '9223372036854775806'],
  [3, '-9223372036854775806', '9223372036854775805'],
  [4, '9223372036854775807', '1'],
  [5, '9223372036854775806', '2'],
  [6, '0', '9007199254740993'],
  [7, null, '9007199254740992'],
  [8, '9007199254740993', '3'],
  [9, '9007199254740992', '4'],
];

/** Row ids in the order PostgreSQL sorts `column` (NULLs largest), then id ascending. */
const expectedOrder = (column: 1 | 2, direction: 'asc' | 'desc'): number[] =>
  [...ROWS]
    .sort((x, y) => {
      const a = x[column];
      const b = y[column];
      if (a !== b) {
        const sign = direction === 'asc' ? 1 : -1;
        if (a === null || b === null) {
          return (a === null ? 1 : -1) * sign;
        }
        return (BigInt(a) < BigInt(b) ? -1 : 1) * sign;
      }
      return x[0] - y[0];
    })
    .map(([id]) => id);

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
    sql`CREATE TABLE nums (id integer primary key, owner_id integer not null, big bigint, ser bigserial not null)`,
  );
  await db.execute(sql`INSERT INTO owners VALUES (1)`);
  await db.execute(
    sql.raw(
      `INSERT INTO nums VALUES ${ROWS.map(([id, big, ser]) => `(${id}, 1, ${big ?? 'NULL'}, ${ser})`).join(', ')}`,
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

describe('pglite: cursors over number-mode bigint columns past 2^53', () => {
  it.each([
    ['big', 1, 'asc'],
    ['big', 1, 'desc'],
    ['ser', 2, 'asc'],
    ['ser', 2, 'desc'],
  ] as const)('a root list ordered by %s walks every row once', async (column, index, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(async (after) => (await run(`{ nums(${orderBy}, limit: 1${after}) { id cursor } }`)).nums);
    expect(seen).toEqual(expectedOrder(index, direction));
  });

  it.each([
    ['big', 1, 'asc'],
    ['ser', 2, 'desc'],
  ] as const)('a relation list ordered by %s walks every row once', async (column, index, direction) => {
    const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
    const seen = await walk(
      async (after) => (await run(`{ owners { nums(${orderBy}, limit: 1${after}) { id cursor } } }`)).owners[0].nums,
    );
    expect(seen).toEqual(expectedOrder(index, direction));
  });

  it('still outputs the value as the number it reads as', async () => {
    const data = await run('{ nums(where: { id: { eq: 2 } }) { big ser } }');
    expect(data.nums).toEqual([{ big: Number(ROWS[1]![1]), ser: Number(ROWS[1]![2]) }]);
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
    expect(data.nums.map((row: { id: number }) => row.id)).toEqual([9, 8, 5, 4, 7]);
  });

  it.each(['12abc', '9223372036854775808', '1.5', ''])(
    'refuses the text %j as DRIZZLE_INVALID_CURSOR',
    async (text) => {
      const after = forge({
        o: [
          ['big', 'asc'],
          ['id', 'asc'],
        ],
        v: [text, 1],
      });
      const res = await graphql({
        schema,
        source: `{ nums(orderBy: { big: { direction: asc, priority: 1 } }, after: "${after}") { id } }`,
        contextValue: {},
      });
      expect(res.errors?.map((error) => error.extensions?.['code'])).toEqual(['DRIZZLE_INVALID_CURSOR']);
    },
  );
});
