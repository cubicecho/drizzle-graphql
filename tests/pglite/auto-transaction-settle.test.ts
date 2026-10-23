import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// How `transactions: 'auto'` settles its shared transaction: the timeout it is configured with,
// the error a later field reports once that timeout fired, and a root field whose resolver never
// runs because its arguments fail to coerce.

const users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const relations = defineRelations({ users });

let client: PGlite;
let db: any;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle({ client, relations } as any);
  await client.exec('create table users (id integer primary key, name text not null);');
});
afterEach(async () => {
  await client.close();
});

const userIds = async () =>
  (await client.query<{ id: number }>('select id from users order by id')).rows.map((r) => r.id);

/** Makes every `createUsersSingle { id }` take `ms` of host-side work between root fields. */
const slowIdField = (schema: GraphQLSchema, ms: number) => {
  const itemType = schema.getMutationType()!.getFields()['createUsersSingle']!.type as any;
  const idField = (itemType.ofType ?? itemType).getFields()['id'];
  idField.resolve = async (row: any) => {
    await new Promise((r) => setTimeout(r, ms));
    return row.id;
  };
};

const twoCreates = `mutation {
  a: createUsersSingle(values: { id: 1, name: "a" }) { id }
  b: createUsersSingle(values: { id: 2, name: "b" }) { id }
}`;

describe('transactions.timeoutMs', () => {
  // Node clamps a setTimeout delay above 2^31-1 ms to 1 ms, so these used to roll the shared
  // transaction back between the first and the second field.
  it('treats Infinity as no inactivity timer', async () => {
    const { schema } = buildSchema(db, { transactions: { mode: 'auto', timeoutMs: Number.POSITIVE_INFINITY } });
    slowIdField(schema, 20);
    const result = await graphql({ schema, source: twoCreates, contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(await userIds()).toEqual([1, 2]);
  });

  it.each([2 ** 31, 0, -1, 1.5, Number.NaN])('rejects a timeoutMs of %s at build time', (timeoutMs) => {
    expect(() => buildSchema(db, { transactions: { mode: 'auto', timeoutMs } })).toThrow(
      /config\.transactions\.timeoutMs must be a positive integer no greater than 2147483647, or Infinity/,
    );
  });

  it('accepts the largest delay setTimeout honours', async () => {
    const { schema } = buildSchema(db, { transactions: { mode: 'auto', timeoutMs: 2 ** 31 - 1 } });
    slowIdField(schema, 20);
    const result = await graphql({ schema, source: twoCreates, contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(await userIds()).toEqual([1, 2]);
  });

  it('names the timeout as the cause when a later field finds the transaction rolled back', async () => {
    const { schema } = buildSchema(db, { transactions: { mode: 'auto', timeoutMs: 10 } });
    slowIdField(schema, 100);
    const result = await graphql({ schema, source: twoCreates, contextValue: {} });
    const error = result.errors?.find((e) => e.path?.[0] === 'b');
    expect(error?.extensions?.['code']).toBe('DRIZZLE_TRANSACTION_ABORTED');
    expect(error?.message).toMatch(/timed out after 10ms/);
    expect(error?.message).not.toMatch(/earlier mutation in the same request failed/);
    expect(await userIds()).toEqual([]);
  });
});

describe('a root field whose arguments fail to coerce', () => {
  it('is not waited for: the earlier field commits before the response goes out', async () => {
    const { schema } = buildSchema(db, { transactions: { mode: 'auto', timeoutMs: 5_000 } });
    const result = await graphql({
      schema,
      // `$w` is defaulted but sent as an explicit null into a non-null position, so b fails
      // argument coercion at execution time and its resolver never runs.
      source: `mutation M($w: UsersFilters = { id: { eq: 10 } }) {
        a: createUsersSingle(values: { id: 10, name: "first" }) { id }
        b: updateUsersSingle(where: $w, set: { name: "second" }) { id }
      }`,
      variableValues: { w: null },
      contextValue: {},
    });
    expect(result.errors?.[0]?.message).toMatch(/where/);
    expect((result.data as any)?.a?.id).toBe(10);

    const started = Date.now();
    expect(await userIds()).toEqual([10]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still shares one transaction between the fields that do run', async () => {
    const { schema } = buildSchema(db, { transactions: { mode: 'auto', timeoutMs: 5_000 } });
    const result = await graphql({
      schema,
      source: `mutation M($w: UsersFilters = { id: { eq: 10 } }) {
        a: createUsersSingle(values: { id: 10, name: "first" }) { id }
        b: updateUsersSingle(where: $w, set: { name: "second" }) { id }
        c: createUsersSingle(values: { id: 10, name: "duplicate" }) { id }
      }`,
      variableValues: { w: null },
      contextValue: {},
    });
    expect(result.errors?.length).toBe(2);
    // c's duplicate key rolls a back with it.
    expect(await userIds()).toEqual([]);
  });
});
