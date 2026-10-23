import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, ne, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A relation joined on two columns — the tenant pattern, `(orderId, tenantId)` — has to match
// on both columns on every read path: eager (`with:`), the lazy batched field resolver, and
// `<relation>Aggregate`. Order ids repeat across tenants on purpose, so a path that matches on
// the first column alone hands one tenant's rows to the other.

const Orders = pgTable(
  'orders',
  { id: integer('id').notNull(), tenantId: integer('tenant_id').notNull(), status: text('status').notNull() },
  (t) => [primaryKey({ columns: [t.id, t.tenantId] })],
);
const Items = pgTable('items', {
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
    aItems: r.many.Items({
      from: [r.Orders.id, r.Orders.tenantId],
      to: [r.Items.orderId, r.Items.tenantId],
      where: { name: 'a' },
      alias: 'aItems',
    }),
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

let pglite: PGlite;
let db: any;

const run = async (schema: GraphQLSchema, source: string, contextValue: object = {}) => {
  const result = await graphql({ schema, source, contextValue });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations, logger: !!process.env['LOG_SQL'] });
  await db.execute(
    sql`CREATE TABLE orders (id int NOT NULL, tenant_id int NOT NULL, status text NOT NULL, PRIMARY KEY (id, tenant_id))`,
  );
  await db.execute(
    sql`CREATE TABLE items (id int PRIMARY KEY, order_id int, tenant_id int NOT NULL, name text NOT NULL, rank int NOT NULL)`,
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
    // Order (2, 2) does not exist: this item belongs to no order, though order 2 does.
    { id: 7, orderId: 2, tenantId: 2, name: 'x', rank: 1 },
    { id: 8, orderId: null, tenantId: 1, name: 'n', rank: 1 },
  ]);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const ORDERS = `orders(orderBy: { id: { direction: asc, priority: 2 }, tenantId: { direction: asc, priority: 1 } })`;
const BY_RANK = `orderBy: { rank: { direction: asc, priority: 1 } }`;
const ids = (rows: any[]) => rows.map((row) => row.id);

const paths = [
  ['eager', true],
  ['lazy', false],
] as const;

describe.sequential('relations joined on two columns', () => {
  it.each(paths)('%s: each order reads only its own tenant’s items', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const data = await run(schema, `{ ${ORDERS} { id tenantId items(${BY_RANK}) { id } itemsAggregate { count } } }`);
    expect(data.orders.map((o: any) => [o.id, o.tenantId, ids(o.items), o.itemsAggregate.count])).toEqual([
      [1, 1, [1, 2, 3], 3],
      [1, 2, [4, 5], 2],
      [2, 1, [6], 1],
    ]);
  });

  it.each(paths)('%s: aggregates take a where and count per parent', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const data = await run(
      schema,
      `{ ${ORDERS} { itemsAggregate(where: { name: { eq: "a" } }) { count max { rank } } } }`,
    );
    expect(data.orders.map((o: any) => o.itemsAggregate)).toEqual([
      { count: 2, max: { rank: 3 } },
      { count: 1, max: { rank: 2 } },
      { count: 0, max: { rank: null } },
    ]);
  });

  it.each(paths)('%s: limit / offset page each parent separately', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const data = await run(
      schema,
      `{ ${ORDERS} { first: items(${BY_RANK}, limit: 1) { id } rest: items(${BY_RANK}, offset: 1) { id } } }`,
    );
    expect(data.orders.map((o: any) => [ids(o.first), ids(o.rest)])).toEqual([
      [[1], [2, 3]],
      [[4], [5]],
      [[6], []],
    ]);
  });

  it.each(paths)('%s: distinct is per parent', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const data = await run(schema, `{ ${ORDERS} { items(distinct: [name], ${BY_RANK}) { id } } }`);
    expect(data.orders.map((o: any) => ids(o.items))).toEqual([[1, 2], [4, 5], [6]]);
  });

  it.each(paths)('%s: the to-one side matches on both columns', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const data = await run(
      schema,
      `{ items(orderBy: { id: { direction: asc, priority: 1 } }) { id order { id tenantId status } } }`,
    );
    expect(data.items.map((i: any) => [i.id, i.order && [i.order.id, i.order.tenantId, i.order.status]])).toEqual([
      [1, [1, 1, 'open']],
      [2, [1, 1, 'open']],
      [3, [1, 1, 'open']],
      [4, [1, 2, 'closed']],
      [5, [1, 2, 'closed']],
      [6, [2, 1, 'open']],
      [7, null],
      [8, null],
    ]);
  });

  it.each(paths)('%s: a relation’s own where, direct and reversed', async (_label, eagerLoadRelations) => {
    const { schema } = buildSchema(db, { eagerLoadRelations });
    const data = await run(
      schema,
      `{ ${ORDERS} {
        aItems(${BY_RANK}) { id } aItemsAggregate { count }
        openItems(${BY_RANK}) { id } openItemsAggregate { count }
      } }`,
    );
    expect(
      data.orders.map((o: any) => [
        ids(o.aItems),
        o.aItemsAggregate.count,
        ids(o.openItems),
        o.openItemsAggregate.count,
      ]),
    ).toEqual([
      [[1, 3], 2, [1, 2, 3], 3],
      [[5], 1, [], 0],
      [[], 0, [6], 1],
    ]);
  });

  it.each(paths)(
    '%s: the target’s scope narrows the relation and its aggregate',
    async (_label, eagerLoadRelations) => {
      const { schema } = buildSchema(db, {
        eagerLoadRelations,
        scope: { Items: (_ctx: any, table: any) => ne(table.name, 'a') },
      });
      const data = await run(schema, `{ ${ORDERS} { items(${BY_RANK}) { id } itemsAggregate { count } } }`);
      expect(data.orders.map((o: any) => [ids(o.items), o.itemsAggregate.count])).toEqual([
        [[2], 1],
        [[4], 1],
        [[6], 1],
      ]);
    },
  );

  it('entities.fieldResolvers batch parents by every join column', async () => {
    const { entities } = buildSchema(db, { eagerLoadRelations: false });
    const resolveItems = (entities.fieldResolvers as any).Orders.items;
    const context = {};
    // One context, so all four calls share one batch. Order (2, 2) is not a stored row, but a
    // resolver called with that key still finds the item that carries it.
    const parents = [
      { id: 1, tenantId: 1 },
      { id: 1, tenantId: 2 },
      { id: 2, tenantId: 2 },
      { id: 2, tenantId: 1 },
    ];
    const results = await Promise.all(parents.map((parent) => resolveItems(parent, {}, context, undefined)));
    expect(results.map((rows: any[]) => ids(rows).sort())).toEqual([[1, 2, 3], [4, 5], [7], [6]]);

    const resolveOrder = (entities.fieldResolvers as any).Items.order;
    const orderContext = {};
    const orders = await Promise.all(
      [
        { orderId: 1, tenantId: 2 },
        { orderId: 1, tenantId: 1 },
        { orderId: 2, tenantId: 2 },
        { orderId: null, tenantId: 1 },
      ].map((parent) => resolveOrder(parent, {}, orderContext, undefined)),
    );
    expect(orders.map((o: any) => o && [o.id, o.tenantId])).toEqual([[1, 2], [1, 1], null, null]);
  });
});
