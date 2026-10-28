// A SQLite `integer({ mode: 'timestamp' })` column stores whole seconds, and drizzle's encoder
// floors a filter operand to one: `lt: "…10:00:00.500Z"` became `< 10:00:00` and dropped the row
// stored at 10:00:00, and `gte` kept it. Those two now bound at the next whole second; every other
// operator keeps the floor, so `eq` with the value written finds the row it wrote.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  at: integer('at', { mode: 'timestamp' }),
  atMs: integer('at_ms', { mode: 'timestamp_ms' }),
});

/** Half a second after row 2's stored second. */
const BETWEEN = '2024-01-01T10:00:00.500Z';
const WHOLE = '2024-01-01T10:00:00.000Z';

let client: Client;
let schema: GraphQLSchema;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations: buildRelations({ Events }, {}) });
  await db.run(sql`CREATE TABLE events (id integer primary key, at integer, at_ms integer)`);
  await db.insert(Events).values([
    { id: 1, at: new Date('2024-01-01T09:59:59Z'), atMs: new Date('2024-01-01T09:59:59Z') },
    { id: 2, at: new Date(WHOLE), atMs: new Date(WHOLE) },
    { id: 3, at: new Date('2024-01-01T10:00:01Z'), atMs: new Date('2024-01-01T10:00:01Z') },
    { id: 4, at: null, atMs: null },
  ]);
  schema = buildSchema(db).schema;
});
afterAll(() => client.close());

const ids = async (where: string) => {
  const res: any = await graphql({
    schema,
    source: `{ events(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    contextValue: {},
  });
  expect(res.errors).toBeUndefined();
  return res.data.events.map((row: any) => row.id);
};

describe('sqlite second-precision timestamps: fractional operands', () => {
  it.each([
    ['lt', [1, 2]],
    ['lte', [1, 2]],
    ['gt', [3]],
    ['gte', [3]],
  ])('%s compares the stored second with the instant', async (operator, expected) => {
    expect(await ids(`{ at: { ${operator}: "${BETWEEN}" } }`)).toEqual(expected);
    // The millisecond column agrees: both store an instant at or below the operand's precision.
    expect(await ids(`{ atMs: { ${operator}: "${BETWEEN}" } }`)).toEqual(expected);
  });

  it('eq / ne / inArray keep the floored operand, as a write would store it', async () => {
    expect(await ids(`{ at: { eq: "${BETWEEN}" } }`)).toEqual([2]);
    expect(await ids(`{ at: { ne: "${BETWEEN}" } }`)).toEqual([1, 3]);
    expect(await ids(`{ at: { inArray: ["${BETWEEN}"] } }`)).toEqual([2]);
    expect(await ids(`{ at: { notInArray: ["${BETWEEN}"] } }`)).toEqual([1, 3]);
  });

  it('whole-second operands keep their exact meaning', async () => {
    expect(await ids(`{ at: { lt: "${WHOLE}" } }`)).toEqual([1]);
    expect(await ids(`{ at: { gte: "${WHOLE}" } }`)).toEqual([2, 3]);
    expect(await ids(`{ at: { eq: "${WHOLE}" } }`)).toEqual([2]);
  });
});
