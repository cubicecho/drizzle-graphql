// `distinct` used to return every primary key it kept to JS and bind them back into the read as
// an `IN (…)` list. Past PostgreSQL's 65,535-parameter limit that read could not run — PGlite
// even answered it with no rows and no error. The pass is now a subquery of the read, so the
// number of rows it keeps binds nothing.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Groups = pgTable('groups', { id: integer('id').primaryKey() });
const Items = pgTable('items', {
  id: integer('id').primaryKey(),
  groupId: integer('group_id').notNull(),
  title: text('title').notNull(),
});
const Pairs = pgTable(
  'pairs',
  { a: integer('a').notNull(), b: integer('b').notNull(), title: text('title').notNull() },
  (t) => [primaryKey({ columns: [t.a, t.b] })],
);
const Links = pgTable(
  'links',
  { groupId: integer('group_id').notNull(), itemId: integer('item_id').notNull() },
  (t) => [primaryKey({ columns: [t.groupId, t.itemId] })],
);

const tables = { Groups, Items, Pairs, Links };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Groups: {
    items: r.many.Items({ from: r.Groups.id, to: r.Items.groupId }),
    linked: r.many.Items({ from: r.Groups.id.through(r.Links.groupId), to: r.Items.id.through(r.Links.itemId) }),
  },
});

// Past the 65,535 parameters PostgreSQL binds in one statement.
const DISTINCT = 70_000;
// Rows 1…DUPLICATED share their title with row i + DISTINCT, so a distinct pass has a choice.
const DUPLICATED = 10_000;
const ROWS = DISTINCT + DUPLICATED;

let pglite: PGlite;
let schema: GraphQLSchema;

const run = async (source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

const range = (from: number, to: number, step = 1) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations });
  await pglite.exec(`
    CREATE TABLE groups (id integer PRIMARY KEY);
    CREATE TABLE items (id integer PRIMARY KEY, group_id integer NOT NULL, title text NOT NULL);
    CREATE TABLE pairs (a integer NOT NULL, b integer NOT NULL, title text NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE links (group_id integer NOT NULL, item_id integer NOT NULL, PRIMARY KEY (group_id, item_id));
    INSERT INTO groups VALUES (1);
    INSERT INTO items SELECT g, 1, 't' || ((g - 1) % ${DISTINCT}) FROM generate_series(1, ${ROWS}) g;
    INSERT INTO pairs SELECT g, 1, 't' || ((g - 1) % ${DISTINCT}) FROM generate_series(1, ${ROWS}) g;
    INSERT INTO links SELECT 1, g FROM generate_series(1, ${ROWS}) g;
  `);
  await db.execute(sql`ANALYZE`);
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('distinct keeping more rows than a statement can bind', () => {
  it('a root list keeps the first row of each group, in order', async () => {
    const data = await run('{ items(distinct: [title]) { id } }');
    expect(data.items.map((row: any) => row.id)).toEqual(range(1, DISTINCT));
  });

  it('a root list follows orderBy in choosing the row it keeps', async () => {
    const data = await run('{ items(distinct: [title], orderBy: { id: { direction: desc, priority: 1 } }) { id } }');
    expect(data.items.map((row: any) => row.id)).toEqual(range(ROWS, DUPLICATED + 1, -1));
  });

  it('a root page is cut from the kept rows', async () => {
    const data = await run(`{ items(distinct: [title], limit: 3, offset: ${DISTINCT - 2}) { id } }`);
    expect(data.items.map((row: any) => row.id)).toEqual([DISTINCT - 1, DISTINCT]);
  });

  it('a root list with a composite primary key', async () => {
    const data = await run('{ pairs(distinct: [title]) { a } }');
    expect(data.pairs.map((row: any) => row.a)).toEqual(range(1, DISTINCT));
  });

  it('a relation', async () => {
    const data = await run('{ groups { items(distinct: [title]) { id } } }');
    expect(data.groups[0].items.map((row: any) => row.id)).toEqual(range(1, DISTINCT));
  });

  it('a relation page', async () => {
    const data = await run(`{ groups { items(distinct: [title], limit: 3, offset: ${DISTINCT - 2}) { id } } }`);
    expect(data.groups[0].items.map((row: any) => row.id)).toEqual([DISTINCT - 1, DISTINCT]);
  });

  it('a many-to-many relation', async () => {
    const data = await run('{ groups { linked(distinct: [title]) { id } } }');
    expect(data.groups[0].linked.map((row: any) => row.id)).toEqual(range(1, DISTINCT));
  });
});
