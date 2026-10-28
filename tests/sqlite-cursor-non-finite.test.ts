// SQLite REAL columns hold `±Infinity` (NaN is stored as NULL), which JSON.stringify turns into
// `null`: a cursor on such a row resumed from NULL, and a walk repeated or dropped rows. The
// cursor tags non-finite numbers like dates and bigints.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, real, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const PAGE_SIZE = 2;
const MAX_PAGES = 20;

const Nums = sqliteTable('nums', { id: integer('id').primaryKey(), v: real('v') });

let client: Client;
let schema: GraphQLSchema;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations: buildRelations({ Nums }, {}) });
  await db.run(sql`CREATE TABLE nums (id integer primary key, v real)`);
  // 9e999 overflows to +Infinity in SQLite's parser.
  await db.run(sql`INSERT INTO nums VALUES (1, 1), (2, 9e999), (3, -9e999), (4, 2), (5, NULL), (6, 9e999)`);
  schema = buildSchema(db).schema;
});
afterAll(() => client.close());

const query = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return (res.data as any).nums as { id: number; cursor: string }[];
};

describe('sqlite: cursor walk over ±Infinity', () => {
  it.each(['asc', 'desc'])('%s visits every row once, in order', async (direction) => {
    const orderBy = `{ v: { direction: ${direction}, priority: 2 }, id: { direction: ${direction}, priority: 1 } }`;
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
