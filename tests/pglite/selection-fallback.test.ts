// When `resolveSelection` cannot tell which build a selection belongs to — a parsed tree, with two
// policy-free builds over one instance — it reads with no build at all. That fallback used to
// page with the MySQL / SQLite NULL placement (PostgreSQL sorts NULLs largest, so a cursor before
// the NULL rows ended the walk early) and to know no compound unique-key `where` fields.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, resolveSelection } from '@/index';

const Items = pgTable(
  'items',
  {
    id: integer('id').primaryKey(),
    rank: integer('rank'),
    a: text('a').notNull(),
    b: text('b').notNull(),
  },
  (t) => [unique('items_a_b').on(t.a, t.b)],
);

let pglite: PGlite;
let db: any;

/** A parsed selection of `items { id }`: it carries no type that names a build. */
const tree = {
  name: 'items',
  alias: 'items',
  args: {},
  fieldsByTypeName: { Items: { id: { name: 'id', alias: 'id', args: {}, fieldsByTypeName: {} } } },
};
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations: buildRelations({ Items }, {}) });
  await db.execute(
    sql`CREATE TABLE items (id integer primary key, rank integer, a text not null, b text not null, unique (a, b))`,
  );
  await db.execute(sql`INSERT INTO items VALUES (1, 1, 'x', 'p'), (2, NULL, 'x', 'q'), (3, 2, 'y', 'p')`);
  // Two builds without row policies: neither can be picked, and neither has to be.
  buildSchema(db, { features: { uniqueKeyFilters: true } });
  buildSchema(db, { features: { uniqueKeyFilters: true } });
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('pglite: resolveSelection with no identifiable build', () => {
  it("pages past a cursor with PostgreSQL's NULL placement", async () => {
    // Ascending on PostgreSQL the NULL rank sorts last: 1 (rank 1), 3 (rank 2), 2 (NULL).
    const after = forge({
      o: [
        ['rank', 'asc'],
        ['id', 'asc'],
      ],
      v: [2, 3],
    });
    const rows = await resolveSelection(tree, {
      db,
      table: 'Items',
      orderBy: { rank: { direction: 'asc', priority: 1 } },
      after,
    });
    expect(rows).toEqual([{ id: 2 }]);
  });

  it('compiles a compound unique-key where', async () => {
    const rows = await resolveSelection(tree, { db, table: 'Items', where: { a_b: { a: 'x', b: 'q' } } });
    expect(rows).toEqual([{ id: 2 }]);
  });
});
