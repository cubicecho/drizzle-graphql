// Variable values as resolvers see them under both graphql majors. graphql 16 hands resolvers
// `info.variableValues` as a plain map; 17 wraps it in `{ sources, coerced }`, and adds
// fragment arguments (`experimentalFragmentArguments`), whose variables are scoped to the
// fragment and never appear on `info` at all. Anything that re-walks the document from `info`
// — the resolve-info parser, the auto-transaction field counter, the per-request memo key — has
// to read both correctly.
//
// The variable-driven @skip / @include cases run on both majors. The fragment-argument cases
// only exist under 17 and are skipped on 16; CI's `checks-graphql-17` leg runs them.

import { PGlite } from '@electric-sql/pglite';
import { defineRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { execute, type GraphQLSchema, graphql, parse, validate, version } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const major = Number(version.split('.')[0]);

const Items = pgTable('items', { id: integer('id').primaryKey(), name: text('name').notNull() });
const P = pgTable('p', { id: integer('id').primaryKey() });
const C = pgTable('c', { id: integer('id').primaryKey(), pid: integer('pid') });

const relations = defineRelations({ Items, P, C }, (r: any) => ({
  P: { cs: r.many.C({ from: r.P.id, to: r.C.pid }) },
}));

let pglite: PGlite;
let db: any;
let txSchema: GraphQLSchema;
let eagerSchema: GraphQLSchema;
let lazySchema: GraphQLSchema;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE items (id integer primary key, name text not null)`);
  await db.execute(sql`CREATE TABLE p (id integer primary key)`);
  await db.execute(sql`CREATE TABLE c (id integer primary key, pid integer)`);
  await db.execute(sql`INSERT INTO p VALUES (1)`);
  await db.execute(sql`INSERT INTO c VALUES (1,1),(2,1),(3,1)`);
  txSchema = buildSchema(db, { transactions: { mode: 'auto', timeoutMs: 200 } }).schema;
  eagerSchema = buildSchema(db).schema;
  lazySchema = buildSchema(db, { eagerLoadRelations: false }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM items`);
  await db.execute(sql`INSERT INTO items VALUES (1, 'seed')`);
});

const itemIds = async () => (await db.execute(sql`SELECT id FROM items ORDER BY id`)).rows.map((r: any) => r.id);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parses with fragment arguments on, validates, and executes. Only meaningful under 17. */
const runWithFragmentArguments = async (schema: GraphQLSchema, source: string, variableValues?: any) => {
  const document = parse(source, { experimentalFragmentArguments: true } as any);
  expect(validate(schema, document)).toEqual([]);
  return (await execute({ schema, document, variableValues, contextValue: {} })) as any;
};

describe(`auto transactions with variable-driven @skip / @include (graphql ${version})`, () => {
  it('@skip(if: $s) skips a field, so the one that runs commits instead of timing out', async () => {
    const res = await graphql({
      schema: txSchema,
      source: `mutation ($s: Boolean!) {
        a: createItemsSingle(values: { id: 10, name: "a" }) { id }
        b: createItemsSingle(values: { id: 11, name: "b" }) @skip(if: $s) { id }
      }`,
      variableValues: { s: true },
      contextValue: {},
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ a: { id: 10 } });
    // The response already reported `a` as written; it must still be there after the timeout.
    await pause(600);
    expect(await itemIds()).toEqual([1, 10]);
  });

  it('@include(if: $i) includes both fields, so a later failure rolls the earlier one back', async () => {
    const res = await graphql({
      schema: txSchema,
      source: `mutation ($i: Boolean!) {
        a: createItemsSingle(values: { id: 20, name: "a" }) @include(if: $i) { id }
        b: createItemsSingle(values: { id: 1, name: "dup" }) @include(if: $i) { id }
      }`,
      variableValues: { i: true },
      contextValue: {},
    });
    expect(res.errors?.length).toBe(1);
    expect(await itemIds()).toEqual([1]);
  });
});

describe(`fragment arguments (graphql ${version})`, () => {
  const eagerSource = `query { ...F(lim: 2) }
    fragment F($lim: Int = 1) on Query {
      p { id cs(limit: $lim, orderBy: { id: { direction: asc, priority: 1 } }) { id } }
    }`;

  it.skipIf(major < 17)('a relation argument bound to a fragment variable is honoured on the eager path', async () => {
    const res = await runWithFragmentArguments(eagerSchema, eagerSource);
    expect(res.errors).toBeUndefined();
    expect(res.data.p[0].cs).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it.skipIf(major < 17)('a fragment variable left unset falls back to its default', async () => {
    const res = await runWithFragmentArguments(eagerSchema, eagerSource.replace('...F(lim: 2)', '...F'));
    expect(res.errors).toBeUndefined();
    expect(res.data.p[0].cs).toEqual([{ id: 1 }]);
  });

  it.skipIf(major < 17)('a fragment argument can forward an operation variable', async () => {
    const res = await runWithFragmentArguments(
      eagerSchema,
      eagerSource.replace('query {', 'query ($n: Int) {').replace('...F(lim: 2)', '...F(lim: $n)'),
      { n: 3 },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.p[0].cs).toHaveLength(3);
  });

  it.skipIf(major < 17)('@skip bound to a fragment variable drops the field from the selection', async () => {
    const res = await runWithFragmentArguments(
      eagerSchema,
      `query { ...F(hide: true) }
       fragment F($hide: Boolean!) on Query { p { id cs @skip(if: $hide) { id } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.p).toEqual([{ id: 1 }]);
  });

  it.skipIf(major < 17)('one fragment spread with different arguments does not share a lazy batch', async () => {
    // The relation's field nodes are the fragment's own, identical at both spread sites, so a
    // per-request memo keyed on the nodes alone hands the second site the first one's limit.
    const res = await runWithFragmentArguments(
      lazySchema,
      `query { a: p { ...F(lim: 1) } b: p { ...F(lim: 3) } }
       fragment F($lim: Int) on P { cs(limit: $lim, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.a[0].cs).toEqual([{ id: 1 }]);
    expect(res.data.b[0].cs).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it.skipIf(major < 17)('one fragment spread with different arguments does not share an aggregate batch', async () => {
    const res = await runWithFragmentArguments(
      lazySchema,
      `query { a: p { ...F(min: 2) } b: p { ...F(min: 3) } }
       fragment F($min: Int) on P { csAggregate(where: { id: { gte: $min } }) { count } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.a[0].csAggregate.count).toBe(2);
    expect(res.data.b[0].csAggregate.count).toBe(1);
  });

  it.skipIf(major < 17)('auto transactions honour @skip bound to a fragment variable', async () => {
    const res = await runWithFragmentArguments(
      txSchema,
      `mutation { ...M(skipB: true) }
       fragment M($skipB: Boolean!) on Mutation {
         a: createItemsSingle(values: { id: 30, name: "a" }) { id }
         b: createItemsSingle(values: { id: 31, name: "b" }) @skip(if: $skipB) { id }
       }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ a: { id: 30 } });
    await pause(600);
    expect(await itemIds()).toEqual([1, 30]);
  });

  it.skipIf(major < 17)('auto transactions count a field whose arguments come from a fragment variable', async () => {
    // `b`'s required id is supplied only through the fragment. Read against the operation's
    // variables alone it fails to coerce and is not counted, so `a` runs outside a transaction
    // and survives `b`'s failure.
    const res = await runWithFragmentArguments(
      txSchema,
      `mutation { ...M(dupId: 1) }
       fragment M($dupId: Int!) on Mutation {
         a: createItemsSingle(values: { id: 40, name: "a" }) { id }
         b: createItemsSingle(values: { id: $dupId, name: "dup" }) { id }
       }`,
    );
    expect(res.errors?.length).toBe(1);
    expect(await itemIds()).toEqual([1]);
  });
});
