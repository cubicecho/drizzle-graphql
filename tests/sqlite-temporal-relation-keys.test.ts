import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// SQLite counterpart of tests/pglite/temporal-relation-keys.test.ts. An integer timestamp column
// decodes to a `Date`, which the parent row carries as an ISO string once remapped; binding that
// string back through the column's encoder used to throw (`value.getTime is not a function`).

const Batches = sqliteTable(
  'batches',
  {
    deviceId: integer('device_id').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    label: text('label').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.at] })],
);
const Readings = sqliteTable('readings', {
  id: integer('id').primaryKey(),
  deviceId: integer('device_id').notNull(),
  at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  value: integer('value').notNull(),
});

// Single-column key: a whole-second timestamp.
const Shifts = sqliteTable('shifts', {
  startsAt: integer('starts_at', { mode: 'timestamp' }).primaryKey(),
  label: text('label').notNull(),
});
const Punches = sqliteTable('punches', {
  id: integer('id').primaryKey(),
  startsAt: integer('starts_at', { mode: 'timestamp' }).notNull(),
});

// A bigint key stored as a blob: decoded to a `bigint`, remapped to a string.
const Accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey(),
  ref: blob('ref', { mode: 'bigint' }).notNull().unique(),
});
const Entries = sqliteTable('entries', {
  id: integer('id').primaryKey(),
  ref: blob('ref', { mode: 'bigint' }).notNull(),
});

const tables = { Batches, Readings, Shifts, Punches, Accounts, Entries };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Batches: {
    readings: r.many.Readings({ from: [r.Batches.deviceId, r.Batches.at], to: [r.Readings.deviceId, r.Readings.at] }),
  },
  Readings: {
    batch: r.one.Batches({ from: [r.Readings.deviceId, r.Readings.at], to: [r.Batches.deviceId, r.Batches.at] }),
  },
  Shifts: { punches: r.many.Punches({ from: r.Shifts.startsAt, to: r.Punches.startsAt }) },
  Punches: { shift: r.one.Shifts({ from: r.Punches.startsAt, to: r.Shifts.startsAt }) },
  Accounts: { entries: r.many.Entries({ from: r.Accounts.ref, to: r.Entries.ref }) },
});

let db: any;

const run = async (schema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

beforeAll(async () => {
  db = (drizzle as any)({ client: createClient({ url: ':memory:' }), relations });
  await db.run(
    sql`CREATE TABLE batches (device_id integer NOT NULL, at integer NOT NULL, label text NOT NULL, PRIMARY KEY (device_id, at))`,
  );
  await db.run(
    sql`CREATE TABLE readings (id integer PRIMARY KEY, device_id integer NOT NULL, at integer NOT NULL, value integer NOT NULL)`,
  );
  await db.run(sql`CREATE TABLE shifts (starts_at integer PRIMARY KEY, label text NOT NULL)`);
  await db.run(sql`CREATE TABLE punches (id integer PRIMARY KEY, starts_at integer NOT NULL)`);
  await db.run(sql`CREATE TABLE accounts (id integer PRIMARY KEY, ref blob NOT NULL UNIQUE)`);
  await db.run(sql`CREATE TABLE entries (id integer PRIMARY KEY, ref blob NOT NULL)`);

  await db.insert(Batches).values([
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.100Z'), label: 'first' },
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.200Z'), label: 'second' },
  ]);
  await db.insert(Readings).values([
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.100Z'), value: 10 },
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.200Z'), value: 20 },
    { deviceId: 1, at: new Date('2026-01-01T00:00:00.200Z'), value: 21 },
  ]);
  await db.insert(Shifts).values([
    { startsAt: new Date('2026-01-01T08:00:00Z'), label: 'morning' },
    { startsAt: new Date('2026-01-01T16:00:00Z'), label: 'evening' },
  ]);
  await db.insert(Punches).values([
    { id: 1, startsAt: new Date('2026-01-01T08:00:00Z') },
    { id: 2, startsAt: new Date('2026-01-01T16:00:00Z') },
    { id: 3, startsAt: new Date('2026-01-01T16:00:00Z') },
  ]);
  await db.insert(Accounts).values([
    { id: 1, ref: 9007199254740993n },
    { id: 2, ref: 2n },
  ]);
  await db.insert(Entries).values([
    { id: 1, ref: 9007199254740993n },
    { id: 2, ref: 9007199254740993n },
    { id: 3, ref: 2n },
  ]);
});

for (const eagerLoadRelations of [true, false]) {
  describe(`sqlite relations joined on a timestamp (eagerLoadRelations: ${eagerLoadRelations})`, () => {
    let schema: GraphQLSchema;
    beforeAll(() => {
      schema = buildSchema(db, { eagerLoadRelations }).schema;
    });

    it('a composite key with a millisecond timestamp gives each parent its own rows and count', async () => {
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
      expect(data.readings.map((x: any) => x.batch?.label)).toEqual(['first', 'second', 'second']);
    });

    it('a single-column second-precision timestamp key matches its rows', async () => {
      const data = await run(
        schema,
        `{ shifts(orderBy: { label: { direction: desc, priority: 1 } }) { label punches { id } punchesAggregate { count } } }`,
      );
      expect(data.shifts.map((s: any) => [s.label, s.punches.length, s.punchesAggregate.count])).toEqual([
        ['morning', 1, 1],
        ['evening', 2, 2],
      ]);
      const back = await run(
        schema,
        `{ punches(orderBy: { id: { direction: asc, priority: 1 } }) { shift { label } } }`,
      );
      expect(back.punches.map((p: any) => p.shift.label)).toEqual(['morning', 'evening', 'evening']);
    });

    it('a bigint key matches its rows', async () => {
      const data = await run(
        schema,
        `{ accounts(orderBy: { id: { direction: asc, priority: 1 } }) { id entries { id } entriesAggregate { count } } }`,
      );
      expect(data.accounts.map((a: any) => [a.id, a.entries.length, a.entriesAggregate.count])).toEqual([
        [1, 2, 2],
        [2, 1, 1],
      ]);
    });
  });
}
