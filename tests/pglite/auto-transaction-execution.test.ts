import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type DocumentNode, execute, type GraphQLSchema, parse } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// `transactions: 'auto'` keeps its state per execution. A host may reuse one context object
// across requests, pass no context at all, or hand every request the same parsed document
// from a cache; none of that may carry one request's transaction state into the next.

const users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const relations = defineRelations({ users });

let client: PGlite;
let db: any;
let schema: GraphQLSchema;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle({ client, relations } as any);
  await client.exec('create table users (id integer primary key, name text not null);');
  ({ schema } = buildSchema(db, { transactions: 'auto' }));
});
afterEach(async () => {
  await client.close();
});

const userIds = async () =>
  (await client.query<{ id: number }>('select id from users order by id')).rows.map((r) => r.id);

const create = (alias: string, id: number) => `${alias}: createUsersSingle(values: { id: ${id}, name: "n" }) { id }`;

const oneCreate = parse(`mutation { ${create('a', 1)} }`);
// `b` collides with `a`'s primary key, so the document fails in its second field.
const failingPair = parse(`mutation { ${create('a', 2)} ${create('b', 2)} }`);
const succeedingPair = parse(`mutation { ${create('a', 3)} ${create('b', 4)} }`);

const run = (document: DocumentNode, contextValue?: unknown) => execute({ schema, document, contextValue }) as any;
const codes = (result: any) => (result.errors ?? []).map((e: any) => e.extensions?.code ?? e.message);

describe('auto-transaction state across executions', () => {
  it('a context reused after a single-field document still opens a transaction', async () => {
    const context = {};
    expect((await run(oneCreate, context)).errors).toBeUndefined();

    const result = await run(failingPair, context);

    expect(result.errors).toHaveLength(1);
    // The pair ran in one transaction, so `a` rolled back with `b`.
    expect(await userIds()).toEqual([1]);
  });

  it('a context reused after a rolled-back document runs the next one', async () => {
    const context = {};
    await run(failingPair, context);

    const result = await run(succeedingPair, context);

    expect(codes(result)).toEqual([]);
    expect(await userIds()).toEqual([3, 4]);
  });

  it('without a context object, a cached document that rolled back once runs the next time', async () => {
    // Fails in `b` while row 7 exists, and succeeds once it is gone.
    const cached = parse(`mutation { ${create('a', 6)} ${create('b', 7)} }`);
    await client.exec(`insert into users values (7, 'taken');`);
    expect((await run(cached)).errors).toHaveLength(1);
    await client.exec('delete from users where id = 7');

    const result = await run(cached);

    expect(codes(result)).toEqual([]);
    expect(await userIds()).toEqual([6, 7]);
  });
});
