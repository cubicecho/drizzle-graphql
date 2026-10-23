// A PostgreSQL timestamp keeps microseconds (default precision 6), but a `mode: 'date'` column
// reads into a JS Date, which keeps milliseconds. A cursor built from that Date resumes at
// `at > <truncated>` — which the boundary row itself satisfies — so paging returned the same
// row forever. The cursor has to carry the column's full-precision value.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, time, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Streams = pgTable('streams', { id: integer('id').primaryKey() });
const Events = pgTable('events', {
  id: integer('id').primaryKey(),
  streamId: integer('stream_id').notNull(),
  at: timestamp('at').notNull(),
  atTz: timestamp('at_tz', { withTimezone: true, precision: 6 }).notNull(),
  atStr: timestamp('at_str', { mode: 'string' }).notNull(),
  atMs: timestamp('at_ms', { precision: 3 }).notNull(),
  clock: time('clock').notNull(),
});
const tables = { Streams, Events };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Streams: { events: r.many.Events({ from: r.Streams.id, to: r.Events.streamId }) },
});

let pglite: PGlite;
let schema: GraphQLSchema;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE streams (id integer primary key)`);
  await db.execute(sql`CREATE TABLE events (
    id integer primary key,
    stream_id integer not null,
    at timestamp not null,
    at_tz timestamp(6) with time zone not null,
    at_str timestamp not null,
    at_ms timestamp(3) not null,
    clock time not null
  )`);
  await db.execute(sql`INSERT INTO streams VALUES (1)`);
  // Ids run against the time order, so the primary-key tiebreak can't paper over a lost
  // microsecond: every step of the walk has to come from the timestamp itself.
  await db.execute(sql`INSERT INTO events VALUES
    (4, 1, '2024-01-01 00:00:00.123100', '2024-01-01 00:00:00.123100+00', '2024-01-01 00:00:00.123100', '2024-01-01 00:00:00.123', '10:00:00.123100'),
    (3, 1, '2024-01-01 00:00:00.123200', '2024-01-01 00:00:00.123200+00', '2024-01-01 00:00:00.123200', '2024-01-01 00:00:00.124', '10:00:00.123200'),
    (2, 1, '2024-01-01 00:00:00.123300', '2024-01-01 00:00:00.123300+00', '2024-01-01 00:00:00.123300', '2024-01-01 00:00:00.125', '10:00:00.123300'),
    (1, 1, '2024-01-01 00:00:00.124000', '2024-01-01 00:00:00.124000+00', '2024-01-01 00:00:00.124000', '2024-01-01 00:00:00.126', '10:00:00.124000')`);
  schema = buildSchema(db).schema;
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const walk = async (
  column: string,
  direction: 'asc' | 'desc',
  page: (args: string) => string,
  pick: (data: any) => any[],
): Promise<number[]> => {
  const seen: number[] = [];
  let after: string | null = null;
  for (let i = 0; i < 6; i++) {
    const args = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }, limit: 1${after ? `, after: "${after}"` : ''}`;
    const res: any = await graphql({ schema, contextValue: {}, source: page(args) });
    expect(res.errors).toBeUndefined();
    const rows = pick(res.data);
    if (!rows.length) {
      break;
    }
    seen.push(rows[0].id);
    after = rows[0].cursor;
  }
  return seen;
};

const rootWalk = (column: string, direction: 'asc' | 'desc' = 'asc') =>
  walk(
    column,
    direction,
    (args) => `{ events(${args}) { id cursor } }`,
    (data) => data.events,
  );

describe('cursor over sub-millisecond date/time values', () => {
  it('pages a microsecond timestamp (mode date) once per row, ascending', async () => {
    expect(await rootWalk('at')).toEqual([4, 3, 2, 1]);
  });

  it('pages a microsecond timestamp (mode date) once per row, descending', async () => {
    expect(await rootWalk('at', 'desc')).toEqual([1, 2, 3, 4]);
  });

  it('pages a microsecond timestamptz', async () => {
    expect(await rootWalk('atTz')).toEqual([4, 3, 2, 1]);
  });

  it('pages a timestamp in mode string', async () => {
    expect(await rootWalk('atStr')).toEqual([4, 3, 2, 1]);
  });

  it('pages a millisecond-precision timestamp', async () => {
    expect(await rootWalk('atMs')).toEqual([4, 3, 2, 1]);
  });

  it('pages a microsecond time column', async () => {
    expect(await rootWalk('clock')).toEqual([4, 3, 2, 1]);
  });

  it('pages a relation field by a microsecond timestamp', async () => {
    const seen = await walk(
      'at',
      'asc',
      (args) => `{ streams { events(${args}) { id cursor } } }`,
      (data) => data.streams[0].events,
    );
    expect(seen).toEqual([4, 3, 2, 1]);
  });

  it('pages a relation field without limit through the plain batch query', async () => {
    let after: string | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res: any = await graphql({
        schema,
        contextValue: {},
        source: `{ streams { events(orderBy: { at: { direction: asc, priority: 1 } }${after ? `, after: "${after}"` : ''}) { id cursor } } }`,
      });
      expect(res.errors).toBeUndefined();
      const rows = res.data.streams[0].events;
      if (!rows.length) {
        break;
      }
      seen.push(rows[0].id);
      after = rows[0].cursor;
    }
    expect(seen).toEqual([4, 3, 2, 1]);
  });

  it('does not leak the full-precision helper value into the row', async () => {
    const res: any = await graphql({
      schema,
      contextValue: {},
      source: `{ events(orderBy: { at: { direction: asc, priority: 1 } }, limit: 1) { id at cursor } }`,
    });
    expect(res.errors).toBeUndefined();
    expect(Object.keys(res.data.events[0]).sort()).toEqual(['at', 'cursor', 'id']);
  });
});
