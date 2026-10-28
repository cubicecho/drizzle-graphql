// A full-precision timestamp column's cursor carries PostgreSQL's own text, and `after` checks
// that text before binding it. The check must take every form PostgreSQL issues: BC dates,
// years past 9999, the infinities, and offsets with minutes or (local mean time) seconds.
//
// Each row's cursor is issued by the library's own encoder over the text the cursor query
// selects. The pages list every row, the BC one a `mode: 'date'` column reads as an invalid JS
// Date included: the column orders the page but is not selected, so nothing renders it.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, eq, sql } from 'drizzle-orm';
import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import {
  attachRowCursors,
  type CursorOrderEntry,
  cursorPreciseSelection,
  rowCursorResolver,
} from '@/util/builders/common/cursor';

const Eras = pgTable('eras', {
  id: integer('id').primaryKey(),
  at: timestamp('at').notNull(),
  atTz: timestamp('at_tz', { withTimezone: true }).notNull(),
});

let pglite: PGlite;
let db: any;
let schema: GraphQLSchema;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations: buildRelations({ Eras }, {}) });
  await db.execute(sql`CREATE TABLE eras (id integer primary key, at timestamp not null, at_tz timestamptz not null)`);
  await db.execute(sql`INSERT INTO eras VALUES
    (1, '0044-03-15 12:00:00 BC', '0044-03-15 12:00:00+00 BC'),
    (2, '2024-01-01 00:00:00.123456', '2024-01-01 00:00:00.123456+00'),
    (3, '20000-01-01 00:00:00', '20000-01-01 00:00:00+00'),
    (4, 'infinity', 'infinity'),
    (5, '-infinity', '-infinity'),
    (6, '1850-06-01 00:00:00.5', '1850-06-01 00:00:00.5+00')`);
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const ASCENDING = [5, 1, 6, 2, 3, 4];

/** The cursor the library issues for row `id` under `entries`. */
const issueCursor = async (entries: CursorOrderEntry[], id: number): Promise<string> => {
  const [column] = entries[0]!;
  const rows = await db
    .select({ id: Eras.id, [column]: (Eras as any)[column], ...cursorPreciseSelection(Eras, entries) })
    .from(Eras)
    .where(eq(Eras.id, id));
  attachRowCursors(rows, entries);
  return rowCursorResolver(rows[0])!;
};

describe('pglite: cursors over every timestamp text PostgreSQL issues', () => {
  it.each(['UTC', 'Asia/Kolkata', 'America/St_Johns'])('pages past each row with the session in %s', async (zone) => {
    await db.execute(sql.raw(`SET TIME ZONE '${zone}'`));
    for (const column of ['at', 'atTz']) {
      for (const direction of ['asc', 'desc'] as const) {
        const order = direction === 'asc' ? ASCENDING : [...ASCENDING].reverse();
        const entries: CursorOrderEntry[] = [
          [column, direction],
          ['id', 'asc'],
        ];
        for (const [position, id] of order.entries()) {
          const after = await issueCursor(entries, id);
          const res: any = await graphql({
            schema,
            source: `{ eras(orderBy: { ${column}: { direction: ${direction}, priority: 1 } }, after: "${after}") { id } }`,
            contextValue: {},
          });
          expect(res.errors?.map((error: Error) => error.message)).toBeUndefined();
          const expected = order.slice(position + 1);
          expect(res.data.eras.map((row: { id: number }) => row.id)).toEqual(expected);
        }
      }
    }
  });
});
