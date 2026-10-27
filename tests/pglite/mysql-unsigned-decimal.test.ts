// MySQL `decimal({ unsigned: true })` reports drizzle's `unumeric` constraint rather than
// `numeric`, so it used to fall through to `String` with a `StringFilter`. It is a `Decimal`
// like the signed column now, in every position.
import { defineRelations } from 'drizzle-orm';
import { decimal, int, mysqlTable } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLInputObjectType, type GraphQLObjectType, getNamedType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Prices = mysqlTable('prices', {
  id: int('id').primaryKey(),
  signed: decimal('signed', { precision: 10, scale: 2 }),
  unsignedDec: decimal('unsigned_dec', { precision: 10, scale: 2, unsigned: true }),
});

// Building the schema runs no query, so the client is never used.
const db = (drizzle as any)({ client: { config: {} }, relations: defineRelations({ Prices }) });
const { schema } = buildSchema(db, { features: { fieldUpdateOperations: true } });

const namedTypeOf = (typeName: string, field: string) =>
  getNamedType((schema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType).getFields()[field]!.type).name;

describe('mysql unsigned decimal', () => {
  it.each([
    ['Prices', 'Decimal'],
    ['CreatePricesInput', 'Decimal'],
    ['PricesFilters', 'DecimalFilter'],
    ['UpdatePricesInput', 'DecimalFieldUpdate'],
  ])('%s types it as the signed column is: %s', (typeName, expected) => {
    expect(namedTypeOf(typeName, 'signed')).toBe(expected);
    expect(namedTypeOf(typeName, 'unsignedDec')).toBe(expected);
  });

  it('gives it the Decimal min/max aggregate', () => {
    expect(namedTypeOf('PricesMinAggregate', 'unsignedDec')).toBe('Decimal');
  });
});
