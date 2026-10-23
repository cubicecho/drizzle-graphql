import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { GraphQLInputObjectType, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { remapFromGraphQLCore, remapToGraphQLCore } from '@/util/data-mappers';

// ── SQLite integer timestamps are `DateTime` ──
// `integer({ mode: 'timestamp' })` stores whole seconds since the epoch and
// `integer({ mode: 'timestamp_ms' })` milliseconds. Both are one drizzle class (`SQLiteTimestamp`)
// and used to fall through to `JSON`. Every position now carries `DateTime`; the unit only shows
// in the stored integer, which drizzle's column encoder produces from the input's `Date`. In
// seconds mode the fraction is floored on write and on filter operands alike.
// Run this file under a non-UTC TZ (e.g. `TZ=America/Chicago`) too — nothing here may shift.
const Events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id'),
  at: integer('at', { mode: 'timestamp' }),
  atMs: integer('at_ms', { mode: 'timestamp_ms' }),
  // Controls: neighbouring SQLite modes that must not be affected.
  doc: text('doc', { mode: 'json' }),
  big: blob('big', { mode: 'bigint' }),
  raw: blob('raw', { mode: 'buffer' }),
});
const Owners = sqliteTable('owners', {
  id: integer('id').primaryKey(),
});
const r = createRelationsHelper({ Events, Owners });
const relations = buildRelations(
  { Events, Owners },
  {
    Events: { owner: r.one.Owners({ from: r.Events.ownerId, to: r.Owners.id }) },
    Owners: { events: r.many.Events({ from: r.Owners.id, to: r.Events.ownerId }) },
  },
);

const COLUMNS = ['at', 'atMs'] as const;
const INSTANT = '2026-09-15T10:00:00.250Z';
const INSTANT_S = 1789466400; // 2026-09-15T10:00:00Z in epoch seconds

let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const ok = async (source: string, variableValues?: Record<string, any>) => {
  const res = await run(source, variableValues);
  expect(res.errors).toBeUndefined();
  // As on the wire: JSON writes a serialized `DateTime` as its ISO 8601 text.
  return JSON.parse(JSON.stringify(res.data));
};

const create = (id: number, values: Record<string, any>) =>
  ok(`mutation ($v: CreateEventsInput!) { createEventsSingle(values: $v) { id } }`, { v: { id, ...values } });

const rawRow = async (id: number) => {
  const res = await client.execute({
    sql: 'select at, at_ms, typeof(at) as at_type, typeof(at_ms) as at_ms_type from events where id = ?',
    args: [id],
  });
  return { ...res.rows[0] };
};

const ids = (rows: { id: number }[]) => rows.map((row) => row.id).sort((a, b) => a - b);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE "owners" ("id" integer PRIMARY KEY NOT NULL);`);
  await db.run(sql`CREATE TABLE "events" (
    "id" integer PRIMARY KEY NOT NULL,
    "owner_id" integer,
    "at" integer,
    "at_ms" integer,
    "doc" text,
    "big" blob,
    "raw" blob
  );`);
  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM events`);
  await db.run(sql`DELETE FROM owners`);
});

describe('SQLite integer timestamp schema shape', () => {
  const fieldType = (typeName: string, fieldName: string) =>
    String((gqlSchema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType).getFields()[fieldName]!.type);

  it('types both modes as DateTime in every position', () => {
    const groupType = String(
      (gqlSchema.getType('EventsGroupBy') as GraphQLObjectType).getFields()['group']!.type,
    ).replace(/!$/, '');
    for (const column of COLUMNS) {
      expect(String((entities.types['Events'] as GraphQLObjectType).getFields()[column]!.type)).toBe('DateTime');
      expect(String((entities.inputs['CreateEventsInput'] as GraphQLInputObjectType).getFields()[column]!.type)).toBe(
        'DateTime',
      );
      expect(String((entities.inputs['UpdateEventsInput'] as GraphQLInputObjectType).getFields()[column]!.type)).toBe(
        'DateTime',
      );
      expect(fieldType('EventsFilters', column)).toBe('DateTimeFilter');
      expect(fieldType('EventsMinAggregate', column)).toBe('DateTime');
      expect(fieldType('EventsMaxAggregate', column)).toBe('DateTime');
      expect(fieldType(groupType, column)).toBe('DateTime');
    }
    expect(fieldType('DateTimeFilter', 'eq')).toBe('DateTime');
    expect(fieldType('DateTimeFilter', 'inArray')).toBe('[DateTime!]');
  });

  it('leaves the neighbouring json and blob modes alone', () => {
    const fields = (entities.types['Events'] as GraphQLObjectType).getFields();
    expect(String(fields['doc']!.type)).toBe('JSON');
    expect(fieldType('EventsFilters', 'doc')).toBe('JSONFilter');
    expect(String(fields['big']!.type)).toBe('BigInt');
    // `blob({ mode: 'buffer' })` is a list of bytes, like Postgres `bytea`.
    expect(String(fields['raw']!.type)).toBe('[Int!]');
  });
});

describe.sequential('SQLite integer timestamp round-trips', () => {
  it('stores seconds and milliseconds, and reads both back as DateTime', async () => {
    await create(1, { at: INSTANT, atMs: INSTANT });
    expect(await rawRow(1)).toEqual({
      at: INSTANT_S,
      at_ms: INSTANT_S * 1000 + 250,
      at_type: 'integer',
      at_ms_type: 'integer',
    });

    const read = await ok(`{ eventsSingle(where: { id: { eq: 1 } }) { at atMs } }`);
    // Seconds mode floors the fraction: the column cannot hold it.
    expect(read.eventsSingle).toEqual({ at: '2026-09-15T10:00:00.000Z', atMs: INSTANT });
  });

  it('floors rather than rounds in seconds mode', async () => {
    await create(1, { at: '2026-09-15T10:00:00.999Z', atMs: '2026-09-15T10:00:00.999Z' });
    expect(await rawRow(1)).toMatchObject({ at: INSTANT_S, at_ms: INSTANT_S * 1000 + 999 });
  });

  it('lands an input with a non-UTC offset on the right instant', async () => {
    await create(1, { at: '2026-09-15T05:00:00.250-05:00', atMs: '2026-09-15T15:30:00.250+05:30' });
    expect(await rawRow(1)).toMatchObject({ at: INSTANT_S, at_ms: INSTANT_S * 1000 + 250 });
  });

  it('returns the created row as DateTime and updates both modes', async () => {
    const created = await ok(`mutation ($v: CreateEventsInput!) { createEventsSingle(values: $v) { at atMs } }`, {
      v: { id: 1, at: INSTANT, atMs: INSTANT },
    });
    expect(created.createEventsSingle).toEqual({ at: '2026-09-15T10:00:00.000Z', atMs: INSTANT });

    const updated = await ok(
      `mutation ($s: UpdateEventsInput!) { updateEvents(where: { id: { eq: 1 } }, set: $s) { at atMs } }`,
      { s: { at: '2026-09-16T10:00:00.000Z', atMs: '2026-09-16T10:00:00.007Z' } },
    );
    expect(updated.updateEvents).toEqual([{ at: '2026-09-16T10:00:00.000Z', atMs: '2026-09-16T10:00:00.007Z' }]);
    expect(await rawRow(1)).toMatchObject({ at: INSTANT_S + 86400, at_ms: (INSTANT_S + 86400) * 1000 + 7 });

    const cleared = await ok(
      `mutation { updateEvents(where: { id: { eq: 1 } }, set: { at: null, atMs: null }) { at atMs } }`,
    );
    expect(cleared.updateEvents).toEqual([{ at: null, atMs: null }]);
  });

  it('rejects a value that is not a date-time', async () => {
    const res = await run(`mutation { createEventsSingle(values: { id: 1, at: "yesterday" }) { id } }`);
    expect(res.errors).toBeDefined();
    const dateOnly = await run(`mutation { createEventsSingle(values: { id: 1, atMs: "2026-09-15" }) { id } }`);
    expect(dateOnly.errors).toBeDefined();
  });

  describe.sequential('filters', () => {
    beforeEach(async () => {
      await create(1, { at: '2026-09-15T09:00:00.000Z', atMs: '2026-09-15T09:00:00.000Z' });
      await create(2, { at: INSTANT, atMs: INSTANT });
      await create(3, { at: '2026-09-15T11:00:00.000Z', atMs: '2026-09-15T11:00:00.000Z' });
    });

    const where = async (filter: string) =>
      ids((await ok(`{ events(where: ${filter}) { id } }`)).events as { id: number }[]);

    it('matches eq in both units, with an offset operand', async () => {
      expect(await where(`{ atMs: { eq: "${INSTANT}" } }`)).toEqual([2]);
      expect(await where(`{ atMs: { eq: "2026-09-15T05:00:00.250-05:00" } }`)).toEqual([2]);
      // A different millisecond is a different value in ms mode…
      expect(await where(`{ atMs: { eq: "2026-09-15T10:00:00.000Z" } }`)).toEqual([]);
      // …but in seconds mode the operand is floored as the write was, so it finds the row.
      expect(await where(`{ at: { eq: "${INSTANT}" } }`)).toEqual([2]);
      expect(await where(`{ at: { eq: "2026-09-15T10:00:00.000Z" } }`)).toEqual([2]);
      expect(await where(`{ at: { ne: "2026-09-15T10:00:00.000Z" } }`)).toEqual([1, 3]);
    });

    it('applies ranges in both units', async () => {
      for (const column of COLUMNS) {
        expect(await where(`{ ${column}: { gt: "2026-09-15T09:00:00.000Z" } }`)).toEqual([2, 3]);
        expect(await where(`{ ${column}: { gte: "2026-09-15T09:00:00.000Z", lt: "2026-09-15T11:00:00Z" } }`)).toEqual([
          1, 2,
        ]);
        expect(await where(`{ ${column}: { lte: "2026-09-15T06:00:00-05:00" } }`)).toEqual([1, 2, 3]);
        expect(await where(`{ ${column}: { lt: "2026-09-15T04:30:00-05:00" } }`)).toEqual([1]);
      }
    });

    it('applies inArray and notInArray in both units', async () => {
      for (const column of COLUMNS) {
        expect(
          await where(`{ ${column}: { inArray: ["2026-09-15T09:00:00.000Z", "2026-09-15T06:00:00-05:00"] } }`),
        ).toEqual([1, 3]);
        expect(await where(`{ ${column}: { notInArray: ["2026-09-15T09:00:00.000Z"] } }`)).toEqual([2, 3]);
      }
    });

    it('orders by inArray position with matchFilterOrder', async () => {
      for (const column of COLUMNS) {
        const res = await ok(`{
          events(
            where: { ${column}: { inArray: ["2026-09-15T11:00:00Z", "2026-09-15T09:00:00Z"] } }
            orderBy: { ${column}: { direction: asc, priority: 1, matchFilterOrder: true } }
          ) { id }
        }`);
        expect(res.events.map((row: { id: number }) => row.id)).toEqual([3, 1]);
      }
    });

    it('orders by value', async () => {
      const res = await ok(`{ events(orderBy: { atMs: { direction: desc, priority: 1 } }) { id } }`);
      expect(res.events.map((row: { id: number }) => row.id)).toEqual([3, 2, 1]);
    });
  });

  describe.sequential('aggregates and group keys', () => {
    beforeEach(async () => {
      await db.run(sql`INSERT INTO owners (id) VALUES (1)`);
      await create(1, { ownerId: 1, at: '2026-09-15T09:00:00.000Z', atMs: '2026-09-15T09:00:00.001Z' });
      await create(2, { ownerId: 1, at: INSTANT, atMs: INSTANT });
      await create(3, { ownerId: 1, at: INSTANT, atMs: '2026-09-15T11:00:00.999Z' });
    });

    it('returns min/max as the right instant in each unit', async () => {
      const res = await ok(`{ eventsAggregate { min { at atMs } max { at atMs } } }`);
      expect(res.eventsAggregate).toEqual({
        min: { at: '2026-09-15T09:00:00.000Z', atMs: '2026-09-15T09:00:00.001Z' },
        max: { at: '2026-09-15T10:00:00.000Z', atMs: '2026-09-15T11:00:00.999Z' },
      });
    });

    it('returns min/max through a relation aggregate', async () => {
      const res = await ok(`{ ownersSingle { eventsAggregate { min { at atMs } max { at atMs } } } }`);
      expect(res.ownersSingle.eventsAggregate).toEqual({
        min: { at: '2026-09-15T09:00:00.000Z', atMs: '2026-09-15T09:00:00.001Z' },
        max: { at: '2026-09-15T10:00:00.000Z', atMs: '2026-09-15T11:00:00.999Z' },
      });
    });

    it('groups by either column and returns the keys as DateTime', async () => {
      const bySeconds = await ok(`{ eventsGroupBy(groupBy: [at]) { group { at } count max { atMs } } }`);
      expect(
        [...bySeconds.eventsGroupBy].sort((a: any, b: any) => String(a.group.at).localeCompare(b.group.at)),
      ).toEqual([
        { group: { at: '2026-09-15T09:00:00.000Z' }, count: 1, max: { atMs: '2026-09-15T09:00:00.001Z' } },
        { group: { at: '2026-09-15T10:00:00.000Z' }, count: 2, max: { atMs: '2026-09-15T11:00:00.999Z' } },
      ]);

      const byMs = await ok(`{ eventsGroupBy(groupBy: [atMs], where: { id: { lte: 2 } }) { group { atMs } count } }`);
      expect(
        [...byMs.eventsGroupBy].sort((a: any, b: any) => String(a.group.atMs).localeCompare(b.group.atMs)),
      ).toEqual([
        { group: { atMs: '2026-09-15T09:00:00.001Z' }, count: 1 },
        { group: { atMs: INSTANT }, count: 1 },
      ]);
    });
  });

  it('leaves json and bigint blob values alone, including the bigint null quirk', async () => {
    await create(1, { doc: { a: [1, 'x'] }, big: '9007199254740993' });
    await create(2, {});
    const res = await ok(`{ events(orderBy: { id: { direction: asc, priority: 1 } }) { id doc big at } }`);
    expect(res.events).toEqual([
      { id: 1, doc: { a: [1, 'x'] }, big: '9007199254740993', at: null },
      { id: 2, doc: null, big: null, at: null },
    ]);
  });
});

describe('SQLite integer timestamp mappers', () => {
  const column = (name: 'at' | 'atMs') => (Events as any)[name];

  it('reads a bare stored integer in the column unit', () => {
    expect(remapToGraphQLCore('at', INSTANT_S, 'events', column('at'))).toBe('2026-09-15T10:00:00.000Z');
    expect(remapToGraphQLCore('atMs', INSTANT_S * 1000 + 250, 'events', column('atMs'))).toBe(INSTANT);
  });

  it('hands drizzle a Date whose encoder gives seconds or milliseconds', () => {
    const forSeconds = remapFromGraphQLCore(new Date(INSTANT), column('at'), 'at');
    const forMs = remapFromGraphQLCore(new Date(INSTANT), column('atMs'), 'atMs');
    expect(forSeconds).toBeInstanceOf(Date);
    expect(column('at').mapToDriverValue(forSeconds)).toBe(INSTANT_S);
    expect(column('atMs').mapToDriverValue(forMs)).toBe(INSTANT_S * 1000 + 250);
  });
});
