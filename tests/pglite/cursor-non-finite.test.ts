// PostgreSQL float columns hold `NaN` and `±Infinity`, which JSON.stringify turns into `null`: a
// cursor on such a row resumed from NULL instead, and a walk ended early or repeated rows. The
// cursor tags them like dates and bigints. PostgreSQL sorts NaN above every number and compares
// NaN = NaN as true, so the keyset predicate needs no special case once the value survives.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { doublePrecision, integer, pgTable, real } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const PAGE_SIZE = 2;
const MAX_PAGES = 20;

const Nums = pgTable('nums', {
  id: integer('id').primaryKey(),
  v: doublePrecision('v'),
  r: real('r'),
  strict: doublePrecision('strict').notNull(),
});

let pglite: PGlite;
let schema: GraphQLSchema;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations: buildRelations({ Nums }, {}) });
  await db.execute(
    sql`CREATE TABLE nums (id integer primary key, v double precision, r real, strict double precision not null)`,
  );
  await db.execute(sql`INSERT INTO nums VALUES
    (1, 1, 1, 1),
    (2, 'NaN', 'NaN', 'NaN'),
    (3, 'Infinity', 'Infinity', 'Infinity'),
    (4, 2, 2, 2),
    (5, '-Infinity', '-Infinity', '-Infinity'),
    (6, 'NaN', 'NaN', 'NaN'),
    (7, NULL, NULL, 0),
    (8, 'Infinity', 'Infinity', 'Infinity')`);
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const query = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return (res.data as any).nums as { id: number; cursor: string }[];
};

const combos: [string, string, string][] = [];
for (const column of ['v', 'r', 'strict']) {
  for (const direction of ['asc', 'desc']) {
    for (const nulls of ['', ', nulls: first', ', nulls: last']) {
      combos.push([column, direction, nulls]);
    }
  }
}

describe('pglite: cursor walk over NaN / ±Infinity', () => {
  it.each(combos)('%s %s%s visits every row once, in order', async (column, direction, nulls) => {
    const orderBy = `{ ${column}: { direction: ${direction}, priority: 2${nulls} }, id: { direction: ${direction}, priority: 1 } }`;
    const expected = (await query(`{ nums(orderBy: ${orderBy}) { id } }`)).map((row) => row.id);

    const seen: number[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const afterArg: string = after ? `, after: "${after}"` : '';
      const rows = await query(`{ nums(orderBy: ${orderBy}, limit: ${PAGE_SIZE}${afterArg}) { id cursor } }`);
      if (!rows.length) {
        break;
      }
      seen.push(...rows.map((row) => row.id));
      after = rows[rows.length - 1]!.cursor;
    }
    expect(seen).toEqual(expected);
  });
});
