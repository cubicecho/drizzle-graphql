import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { bigint, integer, numeric, pgTable, real, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql, printType } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = pgTable('items', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty'),
  ratio: real('ratio'),
  price: numeric('price'),
  views: bigint('views', { mode: 'bigint' }),
  tags: text('tags').array(),
});

const relations = buildRelations({ Items }, { Items: {} });
const schema = { Items, relations };

const DATA_DIR = `./tests/.temp/pgdata-field-updates-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let plainSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const items = () => db.select().from(Items).orderBy(Items.id);

const updateInput = (gql: GraphQLSchema) => gql.getType('UpdateItemsInput') as GraphQLInputObjectType;

const UPDATE = /* GraphQL */ `
  mutation ($set: UpdateItemsInput!, $where: ItemsFilters) {
    updateItems(set: $set, where: $where) {
      id
      qty
      ratio
      price
      views
      tags
    }
  }
`;

beforeAll(async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(DATA_DIR, { recursive: true });
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "items" (
		"id" integer PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"qty" integer,
		"ratio" real,
		"price" numeric,
		"views" bigint,
		"tags" text[]
	);`);

  gqlSchema = buildSchema(db, { features: { fieldUpdateOperations: true } }).schema;
  plainSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM "items"`);
  await db.insert(Items).values([
    { id: 1, name: 'a', qty: 10, ratio: 1.5, price: '10.50', views: 100n, tags: ['x'] },
    { id: 2, name: 'b', qty: 20, ratio: 2.5, price: '20.50', views: 200n, tags: ['y', 'z'] },
  ]);
});

describe('fieldUpdateOperations: schema shape', () => {
  it('leaves the update input set-only when the flag is off', () => {
    const fields = updateInput(plainSchema).getFields();

    expect(String(fields['qty']!.type)).toBe('Int');
    expect(String(fields['tags']!.type)).toBe('[String!]');
    expect(plainSchema.getType('IntFieldUpdate')).toBeUndefined();
    expect(plainSchema.getType('StringListFieldUpdate')).toBeUndefined();
  });

  it('replaces numeric and array fields with operations inputs when the flag is on', () => {
    const fields = updateInput(gqlSchema).getFields();

    expect(String(fields['qty']!.type)).toBe('IntFieldUpdate');
    expect(String(fields['ratio']!.type)).toBe('FloatFieldUpdate');
    expect(String(fields['price']!.type)).toBe('DecimalFieldUpdate');
    expect(String(fields['views']!.type)).toBe('BigIntFieldUpdate');
    expect(String(fields['tags']!.type)).toBe('StringListFieldUpdate');
    // Non-numeric, non-list columns keep their plain type.
    expect(String(fields['name']!.type)).toBe('String');
  });

  it('names the operations input for the scalar so every column of that type shares one', () => {
    expect(printType(gqlSchema.getType('IntFieldUpdate')!)).toMatchInlineSnapshot(`
      """"An update to a Int column: exactly one of these operations"""
      input IntFieldUpdate {
        """Replace the current value with this one"""
        set: Int

        """Add this to the current value (SQL \`column + value\`)"""
        increment: Int

        """Subtract this from the current value (SQL \`column - value\`)"""
        decrement: Int

        """Multiply the current value by this (SQL \`column * value\`)"""
        multiply: Int

        """
        Divide the current value by this (SQL \`column / value\`), rounding as the database does
        """
        divide: Int
      }"
    `);
  });

  it('offers only set and push on an array column', () => {
    expect(Object.keys((gqlSchema.getType('StringListFieldUpdate') as GraphQLInputObjectType).getFields())).toEqual([
      'set',
      'push',
    ]);
  });

  it('leaves the insert input alone — operations are relative to a current value', () => {
    const insert = (gqlSchema.getType('CreateItemsInput') as GraphQLInputObjectType).getFields();
    expect(String(insert['qty']!.type)).toBe('Int');
  });
});

describe('fieldUpdateOperations: arithmetic', () => {
  it('increments in the database rather than from a read value', async () => {
    const res = await run(UPDATE, { set: { qty: { increment: 5 } } });

    expect(res.errors).toBeUndefined();
    expect((res.data!['updateItems'] as any[]).map((r) => r['qty'])).toEqual([15, 25]);
  });

  it('decrements, multiplies and divides', async () => {
    expect(((await run(UPDATE, { set: { qty: { decrement: 3 } } })).data!['updateItems'] as any[])[0]!['qty']).toBe(7);
    expect(((await run(UPDATE, { set: { qty: { multiply: 2 } } })).data!['updateItems'] as any[])[0]!['qty']).toBe(14);
    expect(((await run(UPDATE, { set: { qty: { divide: 2 } } })).data!['updateItems'] as any[])[0]!['qty']).toBe(7);
  });

  it('applies the operation per row, not once for the batch', async () => {
    await run(UPDATE, { set: { qty: { multiply: 10 } } });
    expect((await items()).map((r: any) => r.qty)).toEqual([100, 200]);
  });

  it('honours where, leaving other rows untouched', async () => {
    const res = await run(UPDATE, { set: { qty: { increment: 1 } }, where: { id: { eq: 1 } } });

    expect(res.errors).toBeUndefined();
    expect((await items()).map((r: any) => r.qty)).toEqual([11, 20]);
  });

  it('works on Float, Decimal and BigInt columns, which transport as strings', async () => {
    const res = await run(UPDATE, {
      set: { ratio: { increment: 0.5 }, price: { increment: '1.25' }, views: { multiply: '3' } },
    });

    expect(res.errors).toBeUndefined();
    const [first] = res.data!['updateItems'] as any[];
    expect(first['ratio']).toBe(2);
    expect(first['price']).toBe('11.75');
    expect(first['views']).toBe('300');
  });

  it('accepts set as the explicit spelling of a plain assignment', async () => {
    const res = await run(UPDATE, { set: { qty: { set: 42 } } });

    expect(res.errors).toBeUndefined();
    expect((await items()).map((r: any) => r.qty)).toEqual([42, 42]);
  });

  it('mixes operations, plain fields and set in one update', async () => {
    const res = await run(
      /* GraphQL */ `
        mutation ($set: UpdateItemsInput!) {
          updateItems(set: $set) {
            id
            name
            qty
          }
        }
      `,
      { set: { name: 'renamed', qty: { increment: 1 } } },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data!['updateItems']).toEqual([
      { id: 1, name: 'renamed', qty: 11 },
      { id: 2, name: 'renamed', qty: 21 },
    ]);
  });

  it('sets null through set, which arithmetic cannot express', async () => {
    const res = await run(UPDATE, { set: { qty: { set: null } } });

    expect(res.errors).toBeUndefined();
    expect((await items()).map((r: any) => r.qty)).toEqual([null, null]);
  });
});

describe('fieldUpdateOperations: arrays', () => {
  it('appends with push, leaving the existing elements in place', async () => {
    const res = await run(UPDATE, { set: { tags: { push: ['new'] } } });

    expect(res.errors).toBeUndefined();
    expect((res.data!['updateItems'] as any[]).map((r) => r['tags'])).toEqual([
      ['x', 'new'],
      ['y', 'z', 'new'],
    ]);
  });

  it('replaces with set', async () => {
    const res = await run(UPDATE, { set: { tags: { set: ['only'] } } });

    expect(res.errors).toBeUndefined();
    expect((res.data!['updateItems'] as any[]).map((r) => r['tags'])).toEqual([['only'], ['only']]);
  });
});

describe('fieldUpdateOperations: exactly one operation', () => {
  it('rejects two operations on one column', async () => {
    const res = await run(UPDATE, { set: { qty: { increment: 1, decrement: 1 } } });

    expect(res.errors?.[0]?.message).toBe(
      "Field 'qty' takes exactly one update operation, but 2 were given (increment, decrement).",
    );
    expect((await items()).map((r: any) => r.qty)).toEqual([10, 20]);
  });

  it('rejects an empty operations object, which would silently update nothing', async () => {
    const res = await run(UPDATE, { set: { qty: {} } });

    expect(res.errors?.[0]?.message).toBe(
      "Field 'qty' was given no update operation. Pass exactly one of set, increment, decrement, multiply, divide, push.",
    );
  });
});

describe('fieldUpdateOperations: single-row and many updates', () => {
  it('applies operations on updateItemsSingle', async () => {
    const res = await run(
      /* GraphQL */ `
        mutation {
          updateItemsSingle(set: { qty: { increment: 100 } }, where: { id: { eq: 2 } }) {
            id
            qty
          }
        }
      `,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data!['updateItemsSingle']).toEqual({ id: 2, qty: 120 });
  });

  it('applies a different operation per entry on updateItemsMany', async () => {
    const res = await run(
      /* GraphQL */ `
        mutation ($updates: [UpdateItemsManyInput!]!) {
          updateItemsMany(updates: $updates) {
            id
            qty
          }
        }
      `,
      {
        updates: [
          { where: { id: { eq: 1 } }, set: { qty: { increment: 1 } } },
          { where: { id: { eq: 2 } }, set: { qty: { decrement: 1 } } },
        ],
      },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data!['updateItemsMany']).toEqual([
      { id: 1, qty: 11 },
      { id: 2, qty: 19 },
    ]);
  });
});
