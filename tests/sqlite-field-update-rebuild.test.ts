import { createClient } from '@libsql/client';
import { buildRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, GraphQLScalarType, type GraphQLSchema, getNamedType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Whether a column takes a `…FieldUpdate` input depends on the build's scalar overrides, so a
// second build over the same tables must decide it afresh rather than reuse the first build's.

// Fresh tables per test: the stale cache was keyed on the Column objects.
const freshDb = () => {
  const Items = sqliteTable('items', {
    id: integer('id').primaryKey(),
    name: text('name'),
    qty: integer('qty'),
  });
  const relations = buildRelations({ Items }, {});
  return (drizzle as any)({ client: createClient({ url: ':memory:' }), relations });
};

// SQLite `integer` in number mode converts to Float.
const NUMBER_FIELD_UPDATE = 'FloatFieldUpdate';
const Money = new GraphQLScalarType({ name: 'Money', parseValue: (value) => value, serialize: (value) => value });

const qtyInputType = (schema: GraphQLSchema) =>
  getNamedType((schema.getType('UpdateItemsInput') as GraphQLInputObjectType).getFields()['qty']!.type).name;

describe('fieldUpdateOperations across builds', () => {
  it("a later build's scalar override owns the column again", () => {
    const db = freshDb();
    const plain = buildSchema(db, { features: { fieldUpdateOperations: true } }).schema;
    expect(qtyInputType(plain)).toBe(NUMBER_FIELD_UPDATE);

    const overridden = buildSchema(db, {
      features: { fieldUpdateOperations: true },
      scalars: { Items: { qty: Money } },
    } as any).schema;
    expect(qtyInputType(overridden)).toBe('Money');
  });

  it('a later build without the override offers the operations again', () => {
    const db = freshDb();
    const overridden = buildSchema(db, {
      features: { fieldUpdateOperations: true },
      scalars: { Items: { qty: Money } },
    } as any).schema;
    expect(qtyInputType(overridden)).toBe('Money');

    const plain = buildSchema(db, { features: { fieldUpdateOperations: true } }).schema;
    expect(qtyInputType(plain)).toBe(NUMBER_FIELD_UPDATE);
  });
});
