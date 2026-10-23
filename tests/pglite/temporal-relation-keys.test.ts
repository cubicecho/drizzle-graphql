import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { date, integer, numeric, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Relations joined on a temporal (or otherwise remapped) column. The parent row a relation field
// resolves under has already been remapped to its GraphQL form — a `Date` is an ISO string by
// then — so the batched field resolver and `<relation>Aggregate` must correlate on the column's
// own value, not that string, and must group the related rows by a key both sides agree on.

// Composite key (deviceId, at), `at` a millisecond timestamp in `'date'` mode.
const Batches = pgTable(
  'batches',
  {
    deviceId: integer('device_id').notNull(),
    at: timestamp('at', { precision: 3, mode: 'date' }).notNull(),
    label: text('label').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.at] })],
);
const Readings = pgTable('readings', {
  id: serial('id').primaryKey(),
  deviceId: integer('device_id').notNull(),
  at: timestamp('at', { precision: 3, mode: 'date' }).notNull(),
  value: integer('value').notNull(),
});

// Single-column key: a microsecond timestamp in `'string'` mode. The two slots differ by one
// microsecond, which a `Date` cannot tell apart.
const Slots = pgTable('slots', {
  at: timestamp('at', { precision: 6, mode: 'string' }).primaryKey(),
  label: text('label').notNull(),
});
const SlotEvents = pgTable('slot_events', {
  id: serial('id').primaryKey(),
  at: timestamp('at', { precision: 6, mode: 'string' }).notNull(),
});

// `date` columns in both modes.
const Days = pgTable('days', {
  id: integer('id').primaryKey(),
  d: date('d', { mode: 'date' }).notNull().unique(),
  s: date('s', { mode: 'string' }).notNull().unique(),
});
const DayEvents = pgTable('day_events', {
  id: serial('id').primaryKey(),
  d: date('d', { mode: 'date' }),
  s: date('s', { mode: 'string' }),
});

// Decimal keys of different scale on the two sides: SQL compares them by value.
const Prices = pgTable('prices', {
  amount: numeric('amount', { precision: 10, scale: 2 }).primaryKey(),
  label: text('label').notNull(),
});
const Offers = pgTable('offers', {
  id: serial('id').primaryKey(),
  amount: numeric('amount', { precision: 10, scale: 3 }).notNull(),
});

const tables = { Batches, Readings, Slots, SlotEvents, Days, DayEvents, Prices, Offers };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Batches: {
    readings: r.many.Readings({ from: [r.Batches.deviceId, r.Batches.at], to: [r.Readings.deviceId, r.Readings.at] }),
  },
  Readings: {
    batch: r.one.Batches({ from: [r.Readings.deviceId, r.Readings.at], to: [r.Batches.deviceId, r.Batches.at] }),
  },
  Slots: { events: r.many.SlotEvents({ from: r.Slots.at, to: r.SlotEvents.at }) },
  SlotEvents: { slot: r.one.Slots({ from: r.SlotEvents.at, to: r.Slots.at }) },
  Days: {
    dateEvents: r.many.DayEvents({ from: r.Days.d, to: r.DayEvents.d }),
    stringEvents: r.many.DayEvents({ from: r.Days.s, to: r.DayEvents.s }),
  },
  DayEvents: { day: r.one.Days({ from: r.DayEvents.d, to: r.Days.d }) },
  Prices: { offers: r.many.Offers({ from: r.Prices.amount, to: r.Offers.amount }) },
});

let db: any;

const run = async (schema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(
    sql`CREATE TABLE batches (device_id integer NOT NULL, at timestamp(3) NOT NULL, label text NOT NULL, PRIMARY KEY (device_id, at))`,
  );
  await db.execute(
    sql`CREATE TABLE readings (id serial PRIMARY KEY, device_id integer NOT NULL, at timestamp(3) NOT NULL, value integer NOT NULL)`,
  );
  await db.execute(sql`CREATE TABLE slots (at timestamp(6) PRIMARY KEY, label text NOT NULL)`);
  await db.execute(sql`CREATE TABLE slot_events (id serial PRIMARY KEY, at timestamp(6) NOT NULL)`);
  await db.execute(sql`CREATE TABLE days (id integer PRIMARY KEY, d date NOT NULL UNIQUE, s date NOT NULL UNIQUE)`);
  await db.execute(sql`CREATE TABLE day_events (id serial PRIMARY KEY, d date, s date)`);
  await db.execute(sql`CREATE TABLE prices (amount numeric(10, 2) PRIMARY KEY, label text NOT NULL)`);
  await db.execute(sql`CREATE TABLE offers (id serial PRIMARY KEY, amount numeric(10, 3) NOT NULL)`);

  await db.insert(Batches).values([
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.100Z'), label: 'first' },
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.200Z'), label: 'second' },
  ]);
  await db.insert(Readings).values([
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.100Z'), value: 10 },
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.200Z'), value: 20 },
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.200Z'), value: 21 },
  ]);
  await db.execute(
    sql`INSERT INTO slots VALUES ('2026-01-01 00:00:00.100001', 'one'), ('2026-01-01 00:00:00.100002', 'two')`,
  );
  await db.execute(
    sql`INSERT INTO slot_events (at) VALUES ('2026-01-01 00:00:00.100001'), ('2026-01-01 00:00:00.100002'), ('2026-01-01 00:00:00.100002')`,
  );
  await db.execute(sql`INSERT INTO days VALUES (1, '2024-01-01', '2024-02-01'), (2, '2024-01-02', '2024-02-02')`);
  await db.execute(
    sql`INSERT INTO day_events (d, s) VALUES ('2024-01-01', '2024-02-02'), ('2024-01-01', '2024-02-02'), ('2024-01-02', NULL)`,
  );
  await db.execute(sql`INSERT INTO prices VALUES (1.50, 'one-fifty'), (2.00, 'two')`);
  await db.execute(sql`INSERT INTO offers (amount) VALUES (1.500), (1.5), (2.000)`);
});

for (const eagerLoadRelations of [true, false]) {
  describe(`relations joined on a temporal column (eagerLoadRelations: ${eagerLoadRelations})`, () => {
    let schema: GraphQLSchema;
    beforeAll(() => {
      schema = buildSchema(db, { eagerLoadRelations }).schema;
    });

    it('a composite key with a timestamp gives each parent its own rows and count', async () => {
      const data = await run(
        schema,
        `{ batches(orderBy: { label: { direction: asc, priority: 1 } }) {
          label
          readings(orderBy: { value: { direction: asc, priority: 1 } }) { value }
          readingsAggregate { count }
        } }`,
      );
      expect(data.batches).toEqual([
        { label: 'first', readings: [{ value: 10 }], readingsAggregate: { count: 1 } },
        { label: 'second', readings: [{ value: 20 }, { value: 21 }], readingsAggregate: { count: 2 } },
      ]);
    });

    it('a to-one relation keyed on a timestamp finds its row', async () => {
      const data = await run(
        schema,
        `{ readings(orderBy: { value: { direction: asc, priority: 1 } }) { value batch { label } } }`,
      );
      expect(data.readings).toEqual([
        { value: 10, batch: { label: 'first' } },
        { value: 20, batch: { label: 'second' } },
        { value: 21, batch: { label: 'second' } },
      ]);
    });

    it('a string-mode microsecond timestamp key keeps its precision', async () => {
      const data = await run(
        schema,
        `{ slots(orderBy: { label: { direction: asc, priority: 1 } }) { label events { id } eventsAggregate { count } } }`,
      );
      expect(data.slots.map((s: any) => [s.label, s.events.length, s.eventsAggregate.count])).toEqual([
        ['one', 1, 1],
        ['two', 2, 2],
      ]);
      const back = await run(
        schema,
        `{ slotEvents(orderBy: { id: { direction: asc, priority: 1 } }) { slot { label } } }`,
      );
      expect(back.slotEvents.map((e: any) => e.slot.label)).toEqual(['one', 'two', 'two']);
    });

    it('date keys, in either mode, match their rows', async () => {
      const data = await run(
        schema,
        `{ days(orderBy: { id: { direction: asc, priority: 1 } }) {
          id
          dateEvents { id } dateEventsAggregate { count }
          stringEvents { id } stringEventsAggregate { count }
        } }`,
      );
      expect(
        data.days.map((d: any) => [
          d.id,
          d.dateEvents.length,
          d.dateEventsAggregate.count,
          d.stringEvents.length,
          d.stringEventsAggregate.count,
        ]),
      ).toEqual([
        [1, 2, 2, 0, 0],
        [2, 1, 1, 2, 2],
      ]);
      const back = await run(schema, `{ dayEvents(orderBy: { id: { direction: asc, priority: 1 } }) { day { id } } }`);
      expect(back.dayEvents.map((e: any) => e.day.id)).toEqual([1, 1, 2]);
    });

    it('decimal keys of different scale match by value', async () => {
      const data = await run(
        schema,
        `{ prices(orderBy: { label: { direction: asc, priority: 1 } }) { label offers { id } offersAggregate { count } } }`,
      );
      expect(data.prices.map((p: any) => [p.label, p.offers.length, p.offersAggregate.count])).toEqual([
        ['one-fifty', 2, 2],
        ['two', 1, 1],
      ]);
    });
  });
}
