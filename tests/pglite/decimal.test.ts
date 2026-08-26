import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { decimal as mysqlDecimal, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql, printSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, GraphQLDecimalString } from '@/index';
import { generateMySQL } from '@/util/builders';

// ── Schema with a numeric column (unconstrained, so inserted precision survives) ──
const Products = pgTable('products', {
  id: uuid('id').primaryKey(),
  price: numeric('price'),
  qty: integer('qty'),
  label: text('label'),
});
const relations = buildRelations({ Products }, {});
const schema = { Products, relations };

const DATA_DIR = `./tests/.temp/pgdata-decimal-${Date.now()}`;
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
// More significant digits than a JS double can hold — must survive as a string.
const PRECISE = '12345678901234567890.12345678901234567891';

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const fieldTypeName = (typeName: string, fieldName: string) =>
  String((entities.types[typeName] as GraphQLObjectType).getFields()[fieldName]!.type);

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "products" (
      "id" uuid PRIMARY KEY NOT NULL,
      "price" numeric,
      "qty" integer,
      "label" text
    );`,
  );

  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe.sequential('Decimal schema shape', () => {
  it('maps numeric columns to the Decimal scalar on the object type', () => {
    expect(fieldTypeName('Products', 'price')).toBe('Decimal');
  });

  it('uses the Decimal scalar on the insert and update inputs', () => {
    const insertFields = (entities.inputs['CreateProductsInput'] as GraphQLInputObjectType).getFields();
    expect(String(insertFields['price']!.type)).toBe('Decimal');
    const updateFields = (entities.inputs['UpdateProductsInput'] as GraphQLInputObjectType).getFields();
    expect(String(updateFields['price']!.type)).toBe('Decimal');
  });

  it('gives numeric columns a DecimalFilter with Decimal-typed operators', () => {
    const filters = (entities.inputs['ProductsFilters'] as GraphQLInputObjectType).getFields();
    const priceFilter = filters['price']!.type as GraphQLInputObjectType;
    expect(priceFilter.name).toBe('DecimalFilter');
    const filterFields = priceFilter.getFields();
    expect(String(filterFields['eq']!.type)).toBe('Decimal');
    expect(String(filterFields['gt']!.type)).toBe('Decimal');
    expect(String(filterFields['inArray']!.type)).toBe('[Decimal!]');
  });

  it('prints the named scalar in the SDL', () => {
    const sdl = printSchema(gqlSchema);
    expect(sdl).toContain('scalar Decimal');
    expect(sdl).toContain('price: Decimal');
  });

  it('aggregate min/max over a numeric column keep the Decimal scalar', () => {
    const aggregate = (entities.types['ProductsAggregate'] as GraphQLObjectType).getFields();
    const min = (aggregate['min']!.type as any).getFields();
    expect(String(min['price'].type)).toBe('Decimal');
  });

  it('the schema uses the exported GraphQLDecimalString instance', () => {
    expect(gqlSchema.getType('Decimal')).toBe(GraphQLDecimalString);
  });
});

describe.sequential('Decimal round-trips', () => {
  it('accepts a numeric string and returns it with full precision', async () => {
    const res = await run(`mutation {
      createProductsSingle(values: { id: "${UUID_A}", price: "${PRECISE}" }) { price }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createProductsSingle.price).toBe(PRECISE);

    const read = await run(`{ productsSingle(where: { id: { eq: "${UUID_A}" } }) { price } }`);
    expect(read.errors).toBeUndefined();
    expect((read.data as any).productsSingle.price).toBe(PRECISE);
  });

  it('accepts an integer literal', async () => {
    const res = await run(`mutation {
      createProductsSingle(values: { id: "${UUID_B}", price: 42 }) { price }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createProductsSingle.price).toBe('42');
  });

  it('accepts a float literal', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const res = await run(`mutation {
      createProductsSingle(values: { id: "${id}", price: 19.99 }) { price }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createProductsSingle.price).toBe('19.99');
  });

  it('accepts a negative numeric string passed as a variable', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const res = await run(`mutation ($v: CreateProductsInput!) { createProductsSingle(values: $v) { price } }`, {
      v: { id, price: '-0.5' },
    });
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createProductsSingle.price).toBe('-0.5');
  });
});

describe.sequential('Decimal input validation', () => {
  const insert = (price: string) =>
    run(
      `mutation { createProductsSingle(values: { id: "55555555-5555-4555-8555-555555555555", price: ${price} }) { price } }`,
    );

  it('rejects a non-numeric string', async () => {
    const res = await insert('"abc"');
    expect(res.errors?.[0]?.message).toMatch(/Decimal cannot represent non-numeric value: "abc"/);
  });

  it('rejects "NaN"', async () => {
    const res = await insert('"NaN"');
    expect(res.errors?.[0]?.message).toMatch(/Decimal cannot represent non-numeric value: "NaN"/);
  });

  it('rejects "Infinity"', async () => {
    const res = await insert('"Infinity"');
    expect(res.errors?.[0]?.message).toMatch(/Decimal cannot represent non-numeric value: "Infinity"/);
  });

  it('rejects a boolean literal', async () => {
    const res = await insert('true');
    expect(res.errors?.[0]?.message).toMatch(/Decimal cannot represent a BooleanValue/);
  });

  it('rejects a non-numeric string passed as a variable', async () => {
    const res = await run(`mutation ($v: CreateProductsInput!) { createProductsSingle(values: $v) { price } }`, {
      v: { id: '66666666-6666-4666-8666-666666666666', price: '12.5.6' },
    });
    expect(res.errors?.[0]?.message).toMatch(/Decimal cannot represent non-numeric value: "12.5.6"/);
  });
});

describe.sequential('Decimal filters', () => {
  it('filters with gt using a numeric string', async () => {
    const res = await run(
      `{ products(where: { price: { gt: "100" } }, orderBy: { price: { direction: asc, priority: 1 } }) { price } }`,
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as any).products).toEqual([{ price: PRECISE }]);
  });

  it('filters with eq using a numeric literal', async () => {
    const res = await run(`{ products(where: { price: { eq: 19.99 } }) { price } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).products).toEqual([{ price: '19.99' }]);
  });

  it('filters with inArray', async () => {
    const res = await run(
      `{ products(where: { price: { inArray: ["42", "19.99"] } }, orderBy: { price: { direction: asc, priority: 1 } }) { price } }`,
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as any).products).toEqual([{ price: '19.99' }, { price: '42' }]);
  });

  it('rejects a non-numeric filter value', async () => {
    const res = await run(`{ products(where: { price: { eq: "abc" } }) { price } }`);
    expect(res.errors?.[0]?.message).toMatch(/Decimal cannot represent non-numeric value: "abc"/);
  });
});

// The mapping is dialect-agnostic (keyed on the extracted `constraint === 'numeric'`), so the
// MySQL builder is exercised with a mock db the way tests/pglite/mysql-schema.test.ts does.
describe('MySQL decimal columns', () => {
  const MysqlProducts = mysqlTable('products', {
    id: varchar('id', { length: 36 }).primaryKey(),
    price: mysqlDecimal('price', { precision: 10, scale: 2 }),
  });
  const mysqlRelations = buildRelations({ Products: MysqlProducts }, {});
  const mockQueryBuilder = { findMany: async () => [], findFirst: async () => null };
  const mockDb: any = {
    query: { Products: mockQueryBuilder },
    select: () => ({}),
    insert: () => ({}),
    update: () => ({}),
    delete: () => ({}),
  };

  const mysqlEntities = generateMySQL(mockDb, { Products: MysqlProducts }, mysqlRelations, {
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
    },
  }) as any;

  it('maps mysql decimal columns to the Decimal scalar', () => {
    const fields = (mysqlEntities.types['Products'] as GraphQLObjectType).getFields();
    expect(String(fields['price']!.type)).toBe('Decimal');
  });

  it('gives mysql decimal columns the DecimalFilter', () => {
    const filters = (mysqlEntities.inputs['ProductsFilters'] as GraphQLInputObjectType).getFields();
    expect((filters['price']!.type as GraphQLInputObjectType).name).toBe('DecimalFilter');
  });
});
