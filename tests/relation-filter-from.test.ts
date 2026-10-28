// The FROM clause of the subqueries relation filters and relation ordering compile to (issue
// #201). drizzle's `getTableAsAliasSQL` returns an `SQL` on rc.4 and an array of chunks on
// rc.5, which a template renders as a tuple — `from ("app", ., "items",  as , "dgql_rel_0")`.
// The library builds the `<schema>.<name> as <alias>` entry itself, so these compile a filter
// with each dialect's own `sqlToQuery` and pin the exact entry, with and without a schema.

import { buildRelations, createRelationsHelper, type SQL, sql, type Table } from 'drizzle-orm';
import {
  MySqlDialect,
  int as mysqlInt,
  primaryKey as mysqlPrimaryKey,
  mysqlSchema,
  mysqlTable,
  text as mysqlText,
} from 'drizzle-orm/mysql-core';
import {
  PgDialect,
  integer as pgInteger,
  primaryKey as pgPrimaryKey,
  pgSchema,
  pgTable,
  text as pgText,
} from 'drizzle-orm/pg-core';
import {
  SQLiteDialect,
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  sqliteTable,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { buildNamedRelations, extractFilters, extractOrderBy, relationFilterCtx } from '@/util/builders/common';

type TableFn = (name: string, columns: any, extra?: any) => Table;

/**
 * Orders, their items (to-many, plus one declaring its own `where`), each item's order (to-one)
 * and tags through a junction.
 */
const makeFixture = (table: TableFn, integer: (name: string) => any, text: (name: string) => any, pk: any) => {
  const Orders = table('orders', { id: integer('id').primaryKey(), name: text('name') });
  const Items = table('items', { id: integer('id').primaryKey(), orderId: integer('order_id'), name: text('name') });
  const Tags = table('tags', { id: integer('id').primaryKey(), name: text('name') });
  const OrdersToTags = table(
    'orders_to_tags',
    { orderId: integer('order_id').notNull(), tagId: integer('tag_id').notNull() },
    (t: any) => [pk({ columns: [t.orderId, t.tagId] })],
  );
  const tables = { Orders, Items, Tags, OrdersToTags };
  const r = createRelationsHelper(tables) as any;
  const relations = buildRelations(tables, {
    Orders: {
      items: r.many.Items({ from: r.Orders.id, to: r.Items.orderId }),
      pubItems: r.many.Items({ from: r.Orders.id, to: r.Items.orderId, where: { name: { like: 'pub%' } } }),
      tags: r.many.Tags({
        from: r.Orders.id.through(r.OrdersToTags.orderId),
        to: r.Tags.id.through(r.OrdersToTags.tagId),
      }),
    },
    Items: { order: r.one.Orders({ from: r.Items.orderId, to: r.Orders.id }) },
  } as any);
  return { tables, namedRelations: buildNamedRelations(relations as any, Object.entries(tables)) };
};

const dialects = [
  {
    name: 'pg',
    dialect: new PgDialect(),
    q: '"',
    table: pgTable as TableFn,
    schemaTable: pgSchema('app').table as TableFn,
    columns: [pgInteger, pgText, pgPrimaryKey],
  },
  {
    name: 'mysql',
    dialect: new MySqlDialect(),
    q: '`',
    table: mysqlTable as TableFn,
    schemaTable: mysqlSchema('app').table as TableFn,
    columns: [mysqlInt, mysqlText, mysqlPrimaryKey],
  },
  {
    name: 'sqlite',
    dialect: new SQLiteDialect(),
    q: '"',
    table: sqliteTable as TableFn,
    schemaTable: undefined,
    columns: [sqliteInteger, sqliteText, sqlitePrimaryKey],
  },
] as const;

describe.each(dialects)('relation subquery FROM clause ($name)', ({ dialect, q, table, schemaTable, columns }) => {
  const variants = [
    { label: 'without a schema', tableFn: table, prefix: '' },
    ...(schemaTable ? [{ label: 'with a schema', tableFn: schemaTable, prefix: `${q}app${q}\\.` }] : []),
  ];

  describe.each(variants)('$label', ({ tableFn, prefix }) => {
    const [integer, text, pk] = columns as any;
    const { tables, namedRelations } = makeFixture(tableFn, integer, text, pk);
    const ctx = (tableKey: string) => relationFilterCtx({ tables, namedRelations, uniqueKeys: {} }, tableKey)!;
    const compile = (chunk: SQL | undefined) => (dialect as any).sqlToQuery(chunk!).sql as string;
    const id = (name: string) => `${q}${name}${q}`;
    /** `<schema>.<name> as <alias>` as a pattern, the alias number left open — it comes from a shared counter. */
    const entry = (name: string, aliasPrefix = 'dgql_rel') => `${prefix}${id(name)} as ${q}${aliasPrefix}_\\d+${q}`;

    it('to-many `some` / `none` / `every` read the target as an aliased table', () => {
      for (const mode of ['some', 'none', 'every']) {
        const out = compile(
          extractFilters(tables.Orders, 'Orders', { items: { [mode]: { name: { eq: 'x' } } } } as any, ctx('Orders')),
        );
        expect(out, mode).toMatch(new RegExp(`exists \\(select 1 from ${entry('items')} where `));
      }
    });

    // rc.5 also changed `relationsFilterToSQL` to return `{ sql: chunks, hasRelationFilters }`,
    // which `and()` dropped — the relation's own `where` vanished from the subquery.
    it("a relation's own `where` is part of the subquery", () => {
      const query = (dialect as any).sqlToQuery(
        extractFilters(tables.Orders, 'Orders', { pubItems: { some: { id: { gt: 0 } } } } as any, ctx('Orders'))!,
      );
      expect(query.sql).toMatch(
        new RegExp(`from ${entry('items')} where .*\\(${q}dgql_rel_\\d+${q}\\.${q}name${q} like `),
      );
      expect(query.params).toContain('pub%');
    });

    it('a to-one filter reads the target as an aliased table', () => {
      const out = compile(extractFilters(tables.Items, 'Items', { order: { name: { eq: 'x' } } } as any, ctx('Items')));
      expect(out).toMatch(new RegExp(`exists \\(select 1 from ${entry('orders')} where `));
    });

    it('a `.through()` filter joins the aliased junction to the aliased target', () => {
      const out = compile(
        extractFilters(tables.Orders, 'Orders', { tags: { some: { name: { eq: 'x' } } } } as any, ctx('Orders')),
      );
      expect(out).toMatch(
        new RegExp(`exists \\(select 1 from ${entry('tags')} inner join ${entry('orders_to_tags')} on `),
      );
    });

    it('ordering through a to-one relation reads the target as an aliased table', () => {
      const out = compile(
        sql.join(
          extractOrderBy(tables.Items, { order: { name: { direction: 'asc', priority: 1 } } } as any, ctx('Items')),
          sql`, `,
        ),
      );
      expect(out).toMatch(new RegExp(` from ${entry('orders', 'dgql_ord')} where `));
    });
  });
});
