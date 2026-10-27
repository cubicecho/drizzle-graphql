// An `orderBy` entry through a to-one relation was told from a column entry by its `direction`
// being absent — but when the target table has a column named `direction`, the relation entry
// carries `{ direction: { direction: asc } }`, and was taken for a column ordering.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Routes = sqliteTable('routes', { id: integer('id').primaryKey(), direction: text('direction') });
const Stops = sqliteTable('stops', { id: integer('id').primaryKey(), routeId: integer('route_id') });
const tables = { Routes, Stops };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Stops: { route: r.one.Routes({ from: r.Stops.routeId, to: r.Routes.id }) },
  Routes: { stops: r.many.Stops({ from: r.Routes.id, to: r.Stops.routeId }) },
});

/** Orders stops by their route's `direction` column. */
const BY_ROUTE_DIRECTION = '{ route: { direction: { direction: asc, priority: 2 } } }';
/** Any syntactically valid cursor: the ordering is refused before the cursor is compared. */
const EMPTY_CURSOR = Buffer.from(JSON.stringify({ o: [], v: [] }), 'utf8').toString('base64url');

let client: Client;
let schema: GraphQLSchema;
let lazy: GraphQLSchema;
const run = (target: GraphQLSchema, source: string) => graphql({ schema: target, source, contextValue: {} }) as any;

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE routes (id integer primary key, direction text)`);
  await db.run(sql`CREATE TABLE stops (id integer primary key, route_id integer)`);
  await db.run(sql`INSERT INTO routes VALUES (1, 'north'), (2, 'east')`);
  await db.run(sql`INSERT INTO stops VALUES (1, 1), (2, 2), (3, 1)`);
  schema = buildSchema(db).schema;
  lazy = buildSchema(db, { eagerLoadRelations: false }).schema;
});
afterAll(() => client.close());

describe('orderBy through a relation whose target has a `direction` column', () => {
  it('orders by the related column', async () => {
    const res = await run(schema, `{ stops(orderBy: ${BY_ROUTE_DIRECTION}) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.stops.map((stop: any) => stop.id)).toEqual([2, 1, 3]);
  });

  it('resolves a selected cursor to null', async () => {
    const res = await run(schema, `{ stops(orderBy: ${BY_ROUTE_DIRECTION}) { id cursor } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.stops.map((stop: any) => stop.cursor)).toEqual([null, null, null]);
  });

  it('rejects after with DRIZZLE_INVALID_CURSOR', async () => {
    const res = await run(schema, `{ stops(orderBy: ${BY_ROUTE_DIRECTION}, after: "${EMPTY_CURSOR}") { id } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('DRIZZLE_INVALID_CURSOR');
  });

  it('rejects distinct with DRIZZLE_INVALID_ORDER_BY', async () => {
    const res = await run(schema, `{ stops(orderBy: ${BY_ROUTE_DIRECTION}, distinct: [routeId]) { id } }`);
    expect(res.errors?.[0]?.extensions?.code).toBe('DRIZZLE_INVALID_ORDER_BY');
  });

  it.each([
    ['eager', () => schema],
    ['lazy', () => lazy],
  ])('a %s relation field resolves its cursor to null', async (_mode, target) => {
    const res = await run(
      target(),
      `{ routes(orderBy: { id: { direction: asc, priority: 1 } }) { id stops(orderBy: ${BY_ROUTE_DIRECTION}) { id cursor } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.routes).toEqual([
      {
        id: 1,
        stops: [
          { id: 1, cursor: null },
          { id: 3, cursor: null },
        ],
      },
      { id: 2, stops: [{ id: 2, cursor: null }] },
    ]);
  });

  it('a column named direction still orders and pages as a column', async () => {
    const orderBy = '{ direction: { direction: desc, priority: 1 } }';
    const first = await run(schema, `{ routes(orderBy: ${orderBy}, limit: 1) { id cursor } }`);
    expect(first.errors).toBeUndefined();
    expect(first.data.routes.map((route: any) => route.id)).toEqual([1]);
    const next = await run(schema, `{ routes(orderBy: ${orderBy}, after: "${first.data.routes[0].cursor}") { id } }`);
    expect(next.errors).toBeUndefined();
    expect(next.data.routes).toEqual([{ id: 2 }]);
  });
});
