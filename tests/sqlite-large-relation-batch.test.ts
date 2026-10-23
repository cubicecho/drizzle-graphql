import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A batched relation read binds every parent's key into one query. SQLite refuses an expression
// more than 1,000 levels deep — which a flat `(a = ? AND b = ?) OR …` over ~1,000 parents is —
// and more than 32,766 parameters in one statement, which a single-column `IN (…)` list over
// that many parents is. Both have to keep working for a large list of parents.

const Orders = sqliteTable('orders', { id: integer('id').notNull(), tenantId: integer('tenant_id').notNull() }, (t) => [
  primaryKey({ columns: [t.id, t.tenantId] }),
]);
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  orderId: integer('order_id').notNull(),
  tenantId: integer('tenant_id').notNull(),
});
const Users = sqliteTable('users', { id: integer('id').primaryKey() });
const Posts = sqliteTable('posts', { id: integer('id').primaryKey(), userId: integer('user_id').notNull() });

const tables = { Orders, Items, Users, Posts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Orders: { items: r.many.Items({ from: [r.Orders.id, r.Orders.tenantId], to: [r.Items.orderId, r.Items.tenantId] }) },
  Items: { order: r.one.Orders({ from: [r.Items.orderId, r.Items.tenantId], to: [r.Orders.id, r.Orders.tenantId] }) },
  Users: { posts: r.many.Posts({ from: r.Users.id, to: r.Posts.userId }) },
});

// Over the 1,000-level expression limit, and over one 10,000-key chunk with a remainder.
const ORDERS = 12_345;
// Over SQLite's 32,766-parameter limit.
const USERS = 33_000;

let db: any;

const run = async (schema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

beforeAll(async () => {
  db = (drizzle as any)({ client: createClient({ url: ':memory:' }), relations });
  await db.run(sql`CREATE TABLE orders (id integer NOT NULL, tenant_id integer NOT NULL, PRIMARY KEY (id, tenant_id))`);
  await db.run(sql`CREATE TABLE items (id integer PRIMARY KEY, order_id integer NOT NULL, tenant_id integer NOT NULL)`);
  await db.run(sql`CREATE TABLE users (id integer PRIMARY KEY)`);
  await db.run(sql`CREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL)`);
  await db.run(
    sql.raw(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ORDERS}) INSERT INTO orders SELECT i, 1 FROM n`,
    ),
  );
  // Order i has (i % 3) items.
  await db.run(
    sql`INSERT INTO items (order_id, tenant_id) SELECT id, tenant_id FROM orders WHERE id % 3 >= 1 UNION ALL SELECT id, tenant_id FROM orders WHERE id % 3 = 2`,
  );
  await db.run(
    sql.raw(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${USERS}) INSERT INTO users SELECT i FROM n`,
    ),
  );
  await db.run(sql`INSERT INTO posts (user_id) SELECT id FROM users WHERE id % 2 = 0`);
});

describe('relation reads over a large batch of parents', () => {
  for (const eagerLoadRelations of [true, false]) {
    it(`a multi-column relation and its aggregate (eagerLoadRelations: ${eagerLoadRelations})`, async () => {
      const { schema } = buildSchema(db, { eagerLoadRelations });
      const data = await run(
        schema,
        `{ orders(orderBy: { id: { direction: asc, priority: 1 } }) { id items { id } itemsAggregate { count } } }`,
      );
      expect(data.orders).toHaveLength(ORDERS);
      for (const order of data.orders) {
        expect(order.items).toHaveLength(order.id % 3);
        expect(order.itemsAggregate.count).toBe(order.id % 3);
      }
      const one = await run(schema, `{ items { order { id } } }`);
      expect(one.items.every((item: any) => item.order !== null)).toBe(true);
    });
  }

  it('a single-column relation over more parents than SQLite takes parameters', async () => {
    const { schema } = buildSchema(db, { eagerLoadRelations: false });
    const data = await run(
      schema,
      `{ users(orderBy: { id: { direction: asc, priority: 1 } }) { id posts(limit: 1) { id } postsAggregate { count } } }`,
    );
    expect(data.users).toHaveLength(USERS);
    for (const user of data.users) {
      const expected = user.id % 2 === 0 ? 1 : 0;
      expect(user.posts).toHaveLength(expected);
      expect(user.postsAggregate.count).toBe(expected);
    }
  });
});
