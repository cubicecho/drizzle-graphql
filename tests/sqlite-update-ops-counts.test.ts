import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty'),
  ratio: real('ratio'),
});

const relations = buildRelations({ Items }, { Items: {} });
const schema = { Items, relations };

let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const items = () => db.select().from(Items).orderBy(Items.id);

beforeAll(async () => {
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "items" (
		"id" integer PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"qty" integer,
		"ratio" real
	);`);

  gqlSchema = buildSchema(db, { features: { fieldUpdateOperations: true, countMutations: true } }).schema;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "items"`);
  await db.insert(Items).values([
    { id: 1, name: 'a', qty: 10, ratio: 1.5 },
    { id: 2, name: 'b', qty: 20, ratio: 2.5 },
  ]);
});

describe('sqlite: field update operations', () => {
  it('gives numeric columns an operations input', () => {
    const fields = (gqlSchema.getType('UpdateItemsInput') as GraphQLInputObjectType).getFields();

    expect(String(fields['qty']!.type)).toBe('IntFieldUpdate');
    expect(String(fields['ratio']!.type)).toBe('FloatFieldUpdate');
    expect(String(fields['name']!.type)).toBe('String');
  });

  it('increments in the database', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        updateItems(set: { qty: { increment: 5 } }) {
          id
          qty
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data!['updateItems']).toEqual([
      { id: 1, qty: 15 },
      { id: 2, qty: 25 },
    ]);
  });

  it('multiplies a real column', async () => {
    await run(/* GraphQL */ `
      mutation {
        updateItems(set: { ratio: { multiply: 2 } }) {
          id
        }
      }
    `);

    expect((await items()).map((r: any) => r.ratio)).toEqual([3, 5]);
  });

  it('still rejects two operations on one column', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        updateItems(set: { qty: { increment: 1, multiply: 2 } }) {
          id
        }
      }
    `);

    expect(res.errors?.[0]?.message).toContain('takes exactly one update operation');
  });
});

describe('sqlite: count mutations', () => {
  it('reports the rows an update touched', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        updateItemsCount(set: { qty: { increment: 1 } })
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateItemsCount: 2 });
    expect((await items()).map((r: any) => r.qty)).toEqual([11, 21]);
  });

  it('reports the rows a delete removed', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        deleteItemsCount(where: { id: { eq: 1 } })
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ deleteItemsCount: 1 });
    expect((await items()).map((r: any) => r.id)).toEqual([2]);
  });

  it('reports zero for a where that matched nothing', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        deleteItemsCount(where: { id: { eq: 99 } })
      }
    `);

    expect(res.data).toEqual({ deleteItemsCount: 0 });
  });
});
