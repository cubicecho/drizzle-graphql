import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, jsonb, numeric, pgTable, real, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import {
  type GraphQLInputObjectType,
  type GraphQLObjectType,
  GraphQLScalarType,
  type GraphQLSchema,
  graphql,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, GraphQLBigIntString } from '@/index';

// ── Hand-made scalars with distinctive coercion, to prove the generated resolvers
//    pass values through untouched (no double conversion on top of the scalar's own).

/** Integer cents in the database ⇄ "$12.34" strings over GraphQL. */
const GraphQLMoney = new GraphQLScalarType<number, string>({
  name: 'Money',
  serialize: (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError(`Money cannot serialize non-integer value: ${String(value)}`);
    }
    return `$${(value / 100).toFixed(2)}`;
  },
  parseValue: (value) => {
    if (typeof value !== 'string' || !/^\$\d+\.\d{2}$/.test(value)) {
      throw new TypeError(`Money must look like "$12.34", got: ${String(value)}`);
    }
    return Math.round(Number(value.slice(1)) * 100);
  },
});

/** Output-only: serializes whatever the driver returned as a JSON string. */
const GraphQLJSONText = new GraphQLScalarType<unknown, string>({
  name: 'JSONText',
  serialize: (value) => JSON.stringify(value),
});

/** Prefixes the stored float with "score:" so serialization is observable. */
const GraphQLScore = new GraphQLScalarType<number, string>({
  name: 'Score',
  serialize: (value) => `score:${String(value)}`,
  parseValue: (value) => {
    const parsed = Number(String(value).replace(/^score:/, ''));
    if (Number.isNaN(parsed)) {
      throw new TypeError(`Score cannot parse: ${String(value)}`);
    }
    return parsed;
  },
});

/** Used by mapColumnType for `balance` — must LOSE to the declarative entry. */
const GraphQLDecoy = new GraphQLScalarType({ name: 'Decoy' });

// ── Schema ────────────────────────────────────────────────────────────────────
const Products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name'),
  balance: numeric('balance'),
  priceCents: integer('price_cents').notNull(),
  meta: jsonb('meta'),
  score: real('score'),
});
const relations = buildRelations({ Products }, {});
const schema = { Products, relations };

const DATA_DIR = `./tests/.temp/pgdata-scalar-overrides-${Date.now()}`;

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const fieldTypeName = (typeName: string, fieldName: string) =>
  String((entities.types[typeName] as GraphQLObjectType).getFields()[fieldName]!.type);

const inputFieldTypeName = (inputName: string, fieldName: string) =>
  String(entities.inputs[inputName].getFields()[fieldName]!.type);

beforeAll(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "products" (
      "id" serial PRIMARY KEY,
      "name" text,
      "balance" numeric,
      "price_cents" integer NOT NULL,
      "meta" jsonb,
      "score" real
    );`,
  );

  const built = buildSchema(db, {
    scalars: {
      Products: {
        balance: GraphQLBigIntString, // exposed scalar, both directions
        priceCents: GraphQLMoney, // hand-made scalar, both directions
        meta: { output: GraphQLJSONText }, // asymmetric: output only, input keeps JSON
      },
    },
    mapColumnType: (column, { tableName, columnName, defaultType }) => {
      expect(tableName).toBe('Products');
      // The declarative map already decided `balance`; the mapper is not even consulted
      // for it, so this decoy must never surface.
      if (columnName === 'balance') {
        return GraphQLDecoy;
      }
      if (column.columnType === 'PgReal') {
        expect(String(defaultType)).toBe('Float');
        return GraphQLScore;
      }
      return undefined; // everything else keeps built-in detection
    },
  });
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('schema shape', () => {
  it('overrides the object type fields, keeping nullability wrapping', () => {
    expect(fieldTypeName('Products', 'balance')).toBe('BigInt');
    expect(fieldTypeName('Products', 'priceCents')).toBe('Money!');
    expect(fieldTypeName('Products', 'meta')).toBe('JSONText');
  });

  it('applies rule-based mapColumnType overrides', () => {
    expect(fieldTypeName('Products', 'score')).toBe('Score');
  });

  it('a mapper returning undefined leaves built-in detection untouched', () => {
    expect(fieldTypeName('Products', 'id')).toBe('Int!');
    expect(fieldTypeName('Products', 'name')).toBe('String');
  });

  it('the declarative map wins over mapColumnType', () => {
    expect(fieldTypeName('Products', 'balance')).toBe('BigInt');
    expect(gqlSchema.getType('Decoy')).toBeUndefined();
  });

  it('overrides the create input, honoring input/output asymmetry', () => {
    expect(inputFieldTypeName('CreateProductsInput', 'balance')).toBe('BigInt');
    expect(inputFieldTypeName('CreateProductsInput', 'priceCents')).toBe('Money!');
    expect(inputFieldTypeName('CreateProductsInput', 'score')).toBe('Score');
    // meta only overrides output — the input side keeps the default JSON scalar.
    expect(inputFieldTypeName('CreateProductsInput', 'meta')).toBe('JSON');
  });

  it('overrides the update input', () => {
    expect(inputFieldTypeName('UpdateProductsInput', 'balance')).toBe('BigInt');
    expect(inputFieldTypeName('UpdateProductsInput', 'priceCents')).toBe('Money');
  });

  it('creates a filter type named after the scalar, without string-pattern operators', () => {
    const filter = gqlSchema.getType('MoneyFilter') as GraphQLInputObjectType;
    expect(filter).toBeDefined();
    const fields = filter.getFields();
    expect(String(fields['eq']!.type)).toBe('Money');
    expect(String(fields['gte']!.type)).toBe('Money');
    expect(String(fields['inArray']!.type)).toBe('[Money!]');
    // priceCents is an integer column, so like/ilike make no sense.
    expect(fields['like']).toBeUndefined();
    expect(fields['ilike']).toBeUndefined();
    // The Products filter input points the column at the scalar's filter type.
    const productFilters = gqlSchema.getType('ProductsFilters') as GraphQLInputObjectType;
    expect(String(productFilters.getFields()['priceCents']!.type)).toBe('MoneyFilter');
  });

  it('an override to a library scalar shares the built-in filter, string ops and all', () => {
    // balance is a numeric column overridden to the exposed BigInt scalar, so it uses the
    // same BigIntFilter a natural bigint column gets — which omits like/ilike (pattern
    // matching is invalid SQL on numeric columns, and the shared type's shape must not
    // depend on which column built it first).
    const filter = gqlSchema.getType('BigIntFilter') as GraphQLInputObjectType;
    expect(filter).toBeDefined();
    const fields = filter.getFields();
    expect(String(fields['eq']!.type)).toBe('BigInt');
    expect(fields['like']).toBeUndefined();
    expect(fields['ilike']).toBeUndefined();
  });

  it('overrides aggregate min/max fields', () => {
    const aggregate = (entities.types['ProductsAggregate'] as GraphQLObjectType).getFields();
    const min = (aggregate['min']!.type as GraphQLObjectType).getFields();
    const max = (aggregate['max']!.type as GraphQLObjectType).getFields();
    expect(String(min['priceCents']!.type)).toBe('Money');
    expect(String(max['balance']!.type)).toBe('BigInt');
  });
});

describe.sequential('round-trips', () => {
  it('creates a row through the override scalars without double conversion', async () => {
    const res = await run(`mutation {
      createProductsSingle(values: {
        name: "widget",
        balance: "9007199254740993",
        priceCents: "$12.34",
        meta: { a: 1 },
        score: "score:3.5"
      }) { id name balance priceCents meta score }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createProductsSingle).toEqual({
      id: 1,
      name: 'widget',
      // Larger than Number.MAX_SAFE_INTEGER — survives only if carried as a string.
      balance: '9007199254740993',
      priceCents: '$12.34',
      meta: '{"a":1}',
      score: 'score:3.5',
    });
  });

  it('stores the scalar-parsed value in the database', async () => {
    const raw = await db.execute(sql`SELECT price_cents, score FROM products WHERE id = 1;`);
    expect(raw.rows[0]).toEqual({ price_cents: 1234, score: 3.5 });
  });

  it('accepts override values through variables', async () => {
    const res = await run(`mutation ($v: CreateProductsInput!) { createProductsSingle(values: $v) { priceCents } }`, {
      v: { name: 'gadget', priceCents: '$0.99', balance: '17' },
    });
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createProductsSingle.priceCents).toBe('$0.99');
  });

  it('rejects values the override scalar rejects', async () => {
    const res = await run(`mutation { createProductsSingle(values: { priceCents: "12.34" }) { id } }`);
    expect(res.errors?.[0]?.message).toMatch(/Money must look like/);
  });

  it('filters through the scalar filter type, coercing operands with the scalar', async () => {
    const res = await run(`{ products(where: { priceCents: { eq: "$12.34" } }) { name priceCents } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).products).toEqual([{ name: 'widget', priceCents: '$12.34' }]);

    const gte = await run(`{ products(where: { priceCents: { gte: "$1.00" } }) { name } }`);
    expect(gte.errors).toBeUndefined();
    expect((gte.data as any).products).toEqual([{ name: 'widget' }]);
  });

  it('filters an overridden string-backed column', async () => {
    const res = await run(`{ products(where: { balance: { eq: "9007199254740993" } }) { name } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).products).toEqual([{ name: 'widget' }]);
  });

  it('updates through the override scalars', async () => {
    const res = await run(`mutation {
      updateProducts(set: { priceCents: "$99.99" }, where: { name: { eq: "gadget" } }) { name priceCents }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).updateProducts).toEqual([{ name: 'gadget', priceCents: '$99.99' }]);
  });

  it('aggregates min/max through the override scalars', async () => {
    const res = await run(`{ productsAggregate { min { priceCents } max { priceCents balance } } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).productsAggregate).toEqual({
      min: { priceCents: '$12.34' },
      max: { priceCents: '$99.99', balance: '9007199254740993' },
    });
  });
});

describe.sequential('rebuilds', () => {
  it('a rebuild without overrides restores built-in detection', async () => {
    const rebuilt = buildSchema(db);
    const products = rebuilt.entities.types['Products'] as GraphQLObjectType;
    expect(String(products.getFields()['priceCents']!.type)).toBe('Int!');
    // Built-in detection maps numeric columns to the named Decimal scalar.
    expect(String(products.getFields()['balance']!.type)).toBe('Decimal');
    expect(rebuilt.schema.getType('MoneyFilter')).toBeUndefined();

    const res = await graphql({
      schema: rebuilt.schema,
      source: `{ productsSingle(where: { name: { eq: "widget" } }) { priceCents } }`,
      contextValue: {},
    });
    expect(res.errors).toBeUndefined();
    expect((res.data as any).productsSingle.priceCents).toBe(1234);
  });
});
