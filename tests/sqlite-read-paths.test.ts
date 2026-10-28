// Read-path regressions on SQLite:
//
// - `offset: 0` without a `limit` was sent as `OFFSET ?` with no `LIMIT`, which SQLite rejects:
//   the "no limit" stand-in only went in for an offset that skipped rows. `offset: 0` is now no
//   offset at all, on every read path.
// - drizzle selects a SQLite `numeric()` column (string and bigint modes) as an unaliased
//   `cast("col" as text)`. The batched relation page and the `distinct` pass wrap a select in a
//   subquery and read its columns back by name, so a table with such a column broke both.
// - A root list page under a non-unique `orderBy` had no primary-key tiebreak, so tied rows
//   could repeat or go missing between pages; a relation field's `distinct` without pagination
//   came back in no particular order.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, numeric, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Shops = sqliteTable('shops', { id: integer('id').primaryKey() });
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  shopId: integer('shop_id').notNull(),
  grp: integer('grp').notNull(),
  price: numeric('price').notNull(),
  big: numeric('big', { mode: 'bigint' }).notNull(),
});
// A text primary key, inserted out of key order, so "no ORDER BY" (rowid order) and "ordered by
// the primary key" give different answers.
const Tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  shopId: integer('shop_id').notNull(),
  grp: integer('grp').notNull(),
});
const tables = { Shops, Items, Tags };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Shops: {
    items: r.many.Items({ from: r.Shops.id, to: r.Items.shopId }),
    tags: r.many.Tags({ from: r.Shops.id, to: r.Tags.shopId }),
  },
  Items: { shop: r.one.Shops({ from: r.Items.shopId, to: r.Shops.id }) },
});

let client: Client;
let eager: GraphQLSchema;
let lazy: GraphQLSchema;
const queries: string[] = [];

const run = async (schema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  return {
    data: result.data as any,
    errors: result.errors?.map((e) => String((e.originalError as any)?.cause?.message ?? e.message)),
  };
};
const ids = (rows: { id: unknown }[]) => rows.map((row) => row.id);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  const db = (drizzle as any)({ client, relations, logger: { logQuery: (query: string) => queries.push(query) } });
  await db.run(sql`CREATE TABLE shops (id integer PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE items (id integer PRIMARY KEY, shop_id integer NOT NULL, grp integer NOT NULL, price numeric NOT NULL, big numeric NOT NULL)`,
  );
  await db.run(sql`CREATE TABLE tags (id text PRIMARY KEY, shop_id integer NOT NULL, grp integer NOT NULL)`);
  await db.insert(Shops).values([{ id: 1 }, { id: 2 }]);
  await db.insert(Items).values([
    { id: 1, shopId: 1, grp: 1, price: '2.50', big: 9007199254740993n },
    { id: 2, shopId: 1, grp: 1, price: '1.25', big: 2n },
    { id: 3, shopId: 1, grp: 2, price: '10.00', big: 3n },
    { id: 4, shopId: 1, grp: 2, price: '9.00', big: 4n },
  ]);
  await db.insert(Tags).values([
    { id: 'd', shopId: 1, grp: 1 },
    { id: 'b', shopId: 1, grp: 1 },
    { id: 'c', shopId: 1, grp: 2 },
    { id: 'a', shopId: 1, grp: 2 },
  ]);
  eager = buildSchema(db, { onError: (e) => e as Error }).schema;
  lazy = buildSchema(db, { onError: (e) => e as Error, eagerLoadRelations: false }).schema;
});
afterAll(() => client?.close());
beforeEach(() => {
  queries.length = 0;
});

describe('sqlite: offset: 0 without limit', () => {
  it('root list', async () => {
    const res = await run(eager, '{ shops(offset: 0) { id } }');
    expect(res.errors).toBeUndefined();
    expect(ids(res.data.shops)).toEqual([1, 2]);
  });

  it('single', async () => {
    const res = await run(eager, '{ shopsSingle(offset: 0) { id } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.shopsSingle).toEqual({ id: 1 });
  });

  it('eager and lazy relation fields', async () => {
    for (const schema of [eager, lazy]) {
      const res = await run(schema, '{ shops(where: { id: { eq: 1 } }) { items(offset: 0) { id } } }');
      expect(res.errors).toBeUndefined();
      expect(ids(res.data.shops[0].items)).toEqual([1, 2, 3, 4]);
    }
  });

  it('distinct', async () => {
    const res = await run(eager, '{ items(distinct: [grp], offset: 0) { id } }');
    expect(res.errors).toBeUndefined();
    expect(ids(res.data.items)).toEqual([1, 3]);
  });

  it('sends no OFFSET for it', async () => {
    await run(eager, '{ shops(offset: 0) { id } }');
    expect(queries.join('\n')).not.toMatch(/offset/i);
  });

  it('offset: 1 still skips a row', async () => {
    const res = await run(eager, '{ shops(offset: 1) { id } }');
    expect(res.errors).toBeUndefined();
    expect(ids(res.data.shops)).toEqual([2]);
  });
});

describe('sqlite: numeric() columns inside the window and distinct subqueries', () => {
  it('a paginated relation on the batched path reads them back', async () => {
    const res = await run(lazy, '{ shops(where: { id: { eq: 1 } }) { items(limit: 2) { id price big } } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.shops[0].items).toEqual([
      { id: 1, price: '2.5', big: '9007199254740993' },
      { id: 2, price: '1.25', big: '2' },
    ]);
  });

  it('a relation page with `cursor` selected, ordered by the numeric column', async () => {
    const res = await run(
      eager,
      '{ shops(where: { id: { eq: 1 } }) { items(orderBy: { price: { direction: asc, priority: 1 } }, limit: 3) { id cursor } } }',
    );
    expect(res.errors).toBeUndefined();
    expect(ids(res.data.shops[0].items)).toEqual([2, 1, 4]);
  });

  it('distinct ordered by the numeric column sorts it as a number', async () => {
    const res = await run(
      eager,
      '{ items(distinct: [grp], orderBy: { price: { direction: desc, priority: 1 } }) { id price } }',
    );
    expect(res.errors).toBeUndefined();
    // '10.00' outranks '9.00' as a number; as text it would not.
    expect(res.data.items).toEqual([
      { id: 3, price: '10' },
      { id: 1, price: '2.5' },
    ]);
  });

  it('distinct on a relation field', async () => {
    const res = await run(
      eager,
      '{ shops(where: { id: { eq: 1 } }) { items(distinct: [grp], orderBy: { big: { direction: asc, priority: 1 } }) { id big } } }',
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.shops[0].items).toEqual([
      { id: 2, big: '2' },
      { id: 3, big: '3' },
    ]);
  });
});

describe('sqlite: primary-key tiebreak', () => {
  it('pages a root list under a non-unique orderBy by primary key within ties', async () => {
    const page = (offset: number) =>
      run(eager, `{ tags(orderBy: { grp: { direction: asc, priority: 1 } }, limit: 2, offset: ${offset}) { id } }`);
    const first = await page(0);
    const second = await page(2);
    expect(first.errors).toBeUndefined();
    expect(second.errors).toBeUndefined();
    expect([...ids(first.data.tags), ...ids(second.data.tags)]).toEqual(['b', 'd', 'a', 'c']);
  });

  it('gives a root list page and the same relation page the same rows', async () => {
    const root = await run(eager, '{ tags(orderBy: { grp: { direction: desc, priority: 1 } }, limit: 3) { id } }');
    for (const schema of [eager, lazy]) {
      const rel = await run(
        schema,
        '{ shops(where: { id: { eq: 1 } }) { tags(orderBy: { grp: { direction: desc, priority: 1 } }, limit: 3) { id } } }',
      );
      expect(rel.errors).toBeUndefined();
      expect(ids(rel.data.shops[0].tags)).toEqual(ids(root.data.tags));
    }
    expect(ids(root.data.tags)).toEqual(['a', 'c', 'b']);
  });

  it('tiebreaks an unpaginated list too, as a cursor would (#236)', async () => {
    queries.length = 0;
    const res = await run(eager, '{ tags(orderBy: { grp: { direction: asc, priority: 1 } }) { id } }');
    expect(ids(res.data.tags)).toEqual(['b', 'd', 'a', 'c']);
    expect(queries.join('\n')).toMatch(/order by "d0"\."grp" asc, "d0"\."id" asc$/);
  });

  it('orders a relation field distinct without pagination as the root distinct does', async () => {
    const root = await run(eager, '{ tags(distinct: [grp]) { id } }');
    expect(ids(root.data.tags)).toEqual(['a', 'b']);
    for (const schema of [eager, lazy]) {
      queries.length = 0;
      const rel = await run(schema, '{ shops(where: { id: { eq: 1 } }) { tags(distinct: [grp]) { id } } }');
      expect(rel.errors).toBeUndefined();
      expect(ids(rel.data.shops[0].tags)).toEqual(['a', 'b']);
      // SQLite happens to return an `IN (…)` lookup in key order anyway, so check the SQL: the
      // query the distinct pass narrows is itself ordered by the key.
      expect(queries[queries.length - 1]).toMatch(/order by "tags"\."id" asc$/);
    }
  });
});
