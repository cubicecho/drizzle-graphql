import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// SQLite counterpart of tests/pglite/multi-column-relations.test.ts: a relation joined on two
// columns is read by both on the eager path, the lazy batched resolver and
// `<relation>Aggregate`, including the per-parent window SQLite runs for pagination and distinct.

const Orders = sqliteTable(
  'orders',
  { id: integer('id').notNull(), tenantId: integer('tenant_id').notNull(), status: text('status').notNull() },
  (t) => [primaryKey({ columns: [t.id, t.tenantId] })],
);
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  orderId: integer('order_id'),
  tenantId: integer('tenant_id').notNull(),
  name: text('name').notNull(),
  rank: integer('rank').notNull(),
});

const tables = { Orders, Items };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Orders: {
    items: r.many.Items({ from: [r.Orders.id, r.Orders.tenantId], to: [r.Items.orderId, r.Items.tenantId] }),
    // Inherits `Items.openOrder`'s `where`, which is written against Orders.
    openItems: r.many.Items({ alias: 'open' }),
  },
  Items: {
    order: r.one.Orders({ from: [r.Items.orderId, r.Items.tenantId], to: [r.Orders.id, r.Orders.tenantId] }),
    openOrder: r.one.Orders({
      from: [r.Items.orderId, r.Items.tenantId],
      to: [r.Orders.id, r.Orders.tenantId],
      where: { status: 'open' },
      alias: 'open',
    }),
  },
});

let client: Client;
let db: any;

const run = async (schema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(
    sql`CREATE TABLE orders (id integer NOT NULL, tenant_id integer NOT NULL, status text NOT NULL, PRIMARY KEY (id, tenant_id))`,
  );
  await db.run(
    sql`CREATE TABLE items (id integer PRIMARY KEY, order_id integer, tenant_id integer NOT NULL, name text NOT NULL, rank integer NOT NULL)`,
  );
  await db.insert(Orders).values([
    { id: 1, tenantId: 1, status: 'open' },
    { id: 1, tenantId: 2, status: 'closed' },
    { id: 2, tenantId: 1, status: 'open' },
  ]);
  await db.insert(Items).values([
    { id: 1, orderId: 1, tenantId: 1, name: 'a', rank: 1 },
    { id: 2, orderId: 1, tenantId: 1, name: 'b', rank: 2 },
    { id: 3, orderId: 1, tenantId: 1, name: 'a', rank: 3 },
    { id: 4, orderId: 1, tenantId: 2, name: 'c', rank: 1 },
    { id: 5, orderId: 1, tenantId: 2, name: 'a', rank: 2 },
    { id: 6, orderId: 2, tenantId: 1, name: 'd', rank: 1 },
    { id: 7, orderId: 2, tenantId: 2, name: 'x', rank: 1 },
  ]);
});

afterAll(() => {
  client?.close();
});

const ORDERS = `orders(orderBy: { id: { direction: asc, priority: 2 }, tenantId: { direction: asc, priority: 1 } })`;
const BY_RANK = `orderBy: { rank: { direction: asc, priority: 1 } }`;
const ids = (rows: any[]) => rows.map((row) => row.id);

describe.sequential('sqlite: relations joined on two columns', () => {
  it.each([
    ['eager', true],
    ['lazy', false],
  ] as const)('%s: every read path matches on both columns', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const data = await run(
      schema,
      `{ ${ORDERS} {
        items(${BY_RANK}) { id }
        itemsAggregate { count }
        aCount: itemsAggregate(where: { name: { eq: "a" } }) { count }
        paged: items(${BY_RANK}, limit: 1, offset: 1) { id }
        distinctNames: items(distinct: [name], ${BY_RANK}) { id }
        openItems(${BY_RANK}) { id }
        openItemsAggregate { count }
      } }`,
    );
    expect(
      data.orders.map((o: any) => [
        ids(o.items),
        o.itemsAggregate.count,
        o.aCount.count,
        ids(o.paged),
        ids(o.distinctNames),
        ids(o.openItems),
        o.openItemsAggregate.count,
      ]),
    ).toEqual([
      [[1, 2, 3], 3, 2, [2], [1, 2], [1, 2, 3], 3],
      [[4, 5], 2, 1, [5], [4, 5], [], 0],
      [[6], 1, 0, [], [6], [6], 1],
    ]);

    const items = await run(
      schema,
      `{ items(orderBy: { id: { direction: asc, priority: 1 } }) { id order { tenantId } } }`,
    );
    expect(items.items.map((i: any) => i.order?.tenantId ?? null)).toEqual([1, 1, 1, 2, 2, 1, null]);
  });
});
