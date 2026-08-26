import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLEnumType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Sales = sqliteTable('sales', {
  id: integer('id').primaryKey(),
  region: text('region').notNull(),
  channel: text('channel'),
  amount: integer('amount'),
});
const relations = buildRelations({ Sales }, { Sales: {} });
const schema = { Sales, relations };

let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });
const byRegion = (rows: any[]) => [...rows].sort((a, b) => a.group.region.localeCompare(b.group.region));

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "sales" (
		"id" integer PRIMARY KEY NOT NULL,
		"region" text NOT NULL,
		"channel" text,
		"amount" integer
	);`);

  await db.insert(Sales).values([
    { id: 1, region: 'eu', channel: 'web', amount: 10 },
    { id: 2, region: 'eu', channel: 'web', amount: 30 },
    { id: 3, region: 'eu', channel: 'store', amount: 20 },
    { id: 4, region: 'us', channel: 'web', amount: 100 },
    { id: 5, region: 'us', channel: null, amount: null },
  ]);

  gqlSchema = buildSchema(db).schema;
});

afterAll(() => {
  client.close();
});

describe.sequential('SQLite group by', () => {
  it('returns one row per group with its aggregates', async () => {
    const result = await run(`{
      salesGroupBy(groupBy: [region]) {
        group { region }
        count
        sum { amount }
        avg { amount }
        max { amount }
        countNonNull { amount }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(byRegion(result.data?.['salesGroupBy'] as any[])).toEqual([
      {
        group: { region: 'eu' },
        count: 3,
        sum: { amount: 60 },
        avg: { amount: 20 },
        max: { amount: 30 },
        countNonNull: { amount: 3 },
      },
      {
        group: { region: 'us' },
        count: 2,
        sum: { amount: 100 },
        avg: { amount: 100 },
        max: { amount: 100 },
        countNonNull: { amount: 1 },
      },
    ]);
  });

  it('groups by several columns at once, keeping null keys', async () => {
    const result = await run(`{
      salesGroupBy(groupBy: [region, channel]) { group { region channel } count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['salesGroupBy']).toEqual(
      expect.arrayContaining([
        { group: { region: 'eu', channel: 'web' }, count: 2 },
        { group: { region: 'eu', channel: 'store' }, count: 1 },
        { group: { region: 'us', channel: 'web' }, count: 1 },
        { group: { region: 'us', channel: null }, count: 1 },
      ]),
    );
    expect(result.data?.['salesGroupBy']).toHaveLength(4);
  });

  it('filters rows with where and groups with having', async () => {
    // `where` drops the first two eu sales, so eu sums to 20 and only us survives the `having`.
    const result = await run(`{
      salesGroupBy(groupBy: [region], where: { id: { gte: 3 } }, having: { sum: { amount: { gt: 45 } } }) {
        group { region }
        sum { amount }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['salesGroupBy']).toEqual([{ group: { region: 'us' }, sum: { amount: 100 } }]);
  });

  it('rejects an empty groupBy list', async () => {
    const result = await run(`{ salesGroupBy(groupBy: []) { count } }`);

    expect(result.errors?.[0]?.message).toBe('At least one column to group by is required!');
  });

  it('exposes only groupable columns on the enum and prices the query', () => {
    const queries = gqlSchema.getQueryType()!.getFields();
    const columns = gqlSchema.getType('SalesGroupByColumn') as GraphQLEnumType;

    expect(columns.getValues().map((v) => v.name)).toEqual(['id', 'region', 'channel', 'amount']);
    expect(queries['salesGroupBy']!.extensions['complexity']).toBeTypeOf('function');

    // The group keys reuse the table's own column types; the aggregates reuse the aggregate ones.
    const groupBy = gqlSchema.getType('SalesGroupBy') as GraphQLObjectType;
    expect(groupBy.getFields()['group']!.type.toString()).toBe('SalesGroupKeys!');
    expect(groupBy.getFields()['sum']!.type).toBe(
      (gqlSchema.getType('SalesAggregate') as GraphQLObjectType).getFields()['sum']!.type,
    );
  });

  it('is removed with features.groupBy', () => {
    const withoutGroupBy = buildSchema(db, { features: { groupBy: false } }).schema;

    expect(withoutGroupBy.getQueryType()!.getFields()['salesGroupBy']).toBeUndefined();
    expect(withoutGroupBy.getQueryType()!.getFields()['salesAggregate']).toBeDefined();
    expect(withoutGroupBy.getType('SalesGroupBy')).toBeUndefined();
    expect(withoutGroupBy.getType('SalesHaving')).toBeUndefined();
  });
});
