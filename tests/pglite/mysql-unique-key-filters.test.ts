// @ts-nocheck — the mock db doesn't satisfy MySqlDatabase, which is fine: no resolver runs here.
// MySQL builds its schema through the same shared helpers as PostgreSQL and SQLite, so a table
// feature added there has to reach it too. It did not always: `uniqueKeyFilters` shipped while
// MySQL had its own copy of the build, and MySQL accepted the option and generated nothing.

import { buildRelations } from 'drizzle-orm';
import { int, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { printType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { generateMySQL } from '@/util/builders';

const Stock = mysqlTable(
  'stock',
  {
    id: int('id').primaryKey(),
    itemId: varchar('item_id', { length: 64 }).notNull(),
    locationId: varchar('location_id', { length: 64 }).notNull(),
  },
  (t) => [uniqueIndex('stock_item_location').on(t.itemId, t.locationId)],
);

const tables = { Stock };
const relations = buildRelations(tables, { Stock: {} });

const mockDb: any = { query: { Stock: { findMany: async () => [], findFirst: async () => null } } };

const generate = (uniqueKeyFilters: boolean) =>
  generateMySQL(mockDb, tables, relations, {
    relationsDepthLimit: undefined,
    prefixes: { insert: 'create', delete: 'delete', update: 'update' },
    suffixes: { list: '', single: 'Single' },
    conflictDoNothing: false,
    shouldEagerLoad: () => true,
    features: {
      aggregates: true,
      relationAggregates: true,
      distinct: true,
      insert: true,
      update: true,
      delete: true,
      upsert: false,
      uniqueKeyFilters,
    },
  }) as any;

describe('MySQL unique key filters', () => {
  it('offers a key field on the filter input when enabled', () => {
    const { inputs } = generate(true);
    expect(printType(inputs['StockFilters']!)).toContain('itemId_locationId: StockItemIdLocationIdKey');
    // The key type is reachable only through the field, not registered top-level.
    const keyType = inputs['StockFilters']!.getFields()['itemId_locationId']!.type as any;
    expect(printType(keyType)).toContain('itemId: String!');
    expect(printType(keyType)).toContain('locationId: String!');
  });

  it('generates nothing when the feature is off', () => {
    const { inputs } = generate(false);
    expect(printType(inputs['StockFilters']!)).not.toContain('itemId_locationId');
  });
});
