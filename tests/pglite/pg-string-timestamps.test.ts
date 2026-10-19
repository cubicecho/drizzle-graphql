import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import type { GraphQLInputObjectType, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { graphql } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { remapFromGraphQLCore, remapToGraphQLCore } from '@/util/data-mappers';

// ── A Postgres `timestamp(…, { mode: 'string' })` column round-trips as `DateTime` ──
// In `'string'` mode the driver hands back Postgres's own text — `2026-09-15 10:00:00[.ffffff]`
// for `timestamp`, the same with an offset (`+00`, `-05`, `+05:30`) for `timestamptz` — which
// the `DateTime` scalar does not accept. The output mapper rewrites it as RFC 3339 in UTC; the
// input mapper writes the instant back in the form each column type reads unambiguously.
// `timestamp` without time zone holds UTC wall time, the convention drizzle's `'date'` mode uses.
// Run this file under a non-UTC TZ (e.g. `TZ=America/Chicago`) too — nothing here may shift.
const Stamps = pgTable('stamps', {
  id: integer('id').primaryKey(),
  ts: timestamp('ts', { mode: 'string' }),
  tsTz: timestamp('ts_tz', { mode: 'string', withTimezone: true }),
  tsP: timestamp('ts_p', { mode: 'string', precision: 6 }),
  tsTzP: timestamp('ts_tz_p', { mode: 'string', withTimezone: true, precision: 6 }),
  tsDate: timestamp('ts_date', { precision: 3 }),
});
const STRING_COLUMNS = ['ts', 'tsTz', 'tsP', 'tsTzP'] as const;
const ALL_COLUMNS = [...STRING_COLUMNS, 'tsDate'] as const;
const SELECTION = ALL_COLUMNS.join(' ');

const INSTANT = '2026-09-15T10:00:00.000Z';
const relations = buildRelations({ Stamps }, {});
const DATA_DIR = `./tests/.temp/pgdata-pg-string-timestamps-${Date.now()}`;

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const ok = async (source: string, variableValues?: Record<string, any>) => {
  const res = await run(source, variableValues);
  expect(res.errors).toBeUndefined();
  // As on the wire: the `DateTime` scalar serializes to a `Date`, which JSON writes as ISO 8601.
  return JSON.parse(JSON.stringify(res.data));
};

const allValues = (value: string) => Object.fromEntries(ALL_COLUMNS.map((column) => [column, value]));

const rawText = async (id: number) => {
  const res = await db.execute(
    sql`select ts::text as ts, ts_tz::text as ts_tz, ts_p::text as ts_p, ts_tz_p::text as ts_tz_p, ts_date::text as ts_date from stamps where id = ${id}`,
  );
  return (res.rows ?? res)[0];
};

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations, logger: !!process.env['LOG_SQL'] });
  await db.execute(sql`CREATE TABLE "stamps" (
    "id" integer PRIMARY KEY NOT NULL,
    "ts" timestamp,
    "ts_tz" timestamp with time zone,
    "ts_p" timestamp(6),
    "ts_tz_p" timestamp(6) with time zone,
    "ts_date" timestamp(3)
  );`);
  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`SET TIME ZONE 'UTC'`);
  await db.execute(sql`DELETE FROM stamps`);
});

describe('Postgres string-mode timestamp schema shape', () => {
  const fieldType = (typeName: string, fieldName: string) =>
    String((gqlSchema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType).getFields()[fieldName]!.type);

  it('types every variant as DateTime in every position', () => {
    for (const column of ALL_COLUMNS) {
      expect(String((entities.types['Stamps'] as GraphQLObjectType).getFields()[column]!.type)).toBe('DateTime');
      expect(String((entities.inputs['CreateStampsInput'] as GraphQLInputObjectType).getFields()[column]!.type)).toBe(
        'DateTime',
      );
      expect(String((entities.inputs['UpdateStampsInput'] as GraphQLInputObjectType).getFields()[column]!.type)).toBe(
        'DateTime',
      );
      expect(fieldType('StampsFilters', column)).toBe('DateTimeFilter');
      expect(fieldType('StampsMinAggregate', column)).toBe('DateTime');
      expect(fieldType('StampsMaxAggregate', column)).toBe('DateTime');
    }
  });
});

describe.sequential('Postgres string-mode timestamp round-trips', () => {
  it('creates and reads back every variant as the same instant', async () => {
    const created = await ok(`mutation ($v: CreateStampsInput!) { createStampsSingle(values: $v) { ${SELECTION} } }`, {
      v: { id: 1, ...allValues(INSTANT) },
    });
    expect(created.createStampsSingle).toEqual(allValues(INSTANT));

    const read = await ok(`{ stampsSingle(where: { id: { eq: 1 } }) { ${SELECTION} } }`);
    expect(read.stampsSingle).toEqual(allValues(INSTANT));
  });

  it('stores UTC wall time in timestamp and the instant in timestamptz', async () => {
    await ok(`mutation ($v: CreateStampsInput!) { createStampsSingle(values: $v) { id } }`, {
      v: { id: 1, ...allValues(INSTANT) },
    });
    expect(await rawText(1)).toEqual({
      ts: '2026-09-15 10:00:00',
      ts_tz: '2026-09-15 10:00:00+00',
      ts_p: '2026-09-15 10:00:00',
      ts_tz_p: '2026-09-15 10:00:00+00',
      ts_date: '2026-09-15 10:00:00',
    });
  });

  it('lands an input with a non-UTC offset on the right instant', async () => {
    await ok(`mutation ($v: CreateStampsInput!) { createStampsSingle(values: $v) { id } }`, {
      v: { id: 1, ...allValues('2026-09-15T05:00:00.250-05:00') },
    });
    expect(await rawText(1)).toEqual({
      ts: '2026-09-15 10:00:00.25',
      ts_tz: '2026-09-15 10:00:00.25+00',
      ts_p: '2026-09-15 10:00:00.25',
      ts_tz_p: '2026-09-15 10:00:00.25+00',
      ts_date: '2026-09-15 10:00:00.25',
    });
    const read = await ok(`{ stampsSingle(where: { id: { eq: 1 } }) { ${SELECTION} } }`);
    expect(read.stampsSingle).toEqual(allValues('2026-09-15T10:00:00.250Z'));
  });

  it('reads timestamptz text in a non-UTC session zone as the same instant', async () => {
    await ok(`mutation ($v: CreateStampsInput!) { createStampsSingle(values: $v) { id } }`, {
      v: { id: 1, ...allValues(INSTANT) },
    });
    for (const [zone, text] of [
      ['America/Chicago', '2026-09-15 05:00:00-05'],
      ['Asia/Kolkata', '2026-09-15 15:30:00+05:30'],
    ] as const) {
      await db.execute(sql.raw(`SET TIME ZONE '${zone}'`));
      expect((await rawText(1)).ts_tz).toBe(text);
      const read = await ok(`{ stampsSingle(where: { id: { eq: 1 } }) { tsTz tsTzP } }`);
      expect(read.stampsSingle).toEqual({ tsTz: INSTANT, tsTzP: INSTANT });
    }
  });

  it('reads stored microseconds, truncated to the milliseconds DateTime carries', async () => {
    await db.execute(
      sql`insert into stamps (id, ts_p, ts_tz_p) values (1, '2026-09-15 10:00:00.123456', '2026-09-15 04:00:00.123456-06')`,
    );
    const read = await ok(`{ stampsSingle(where: { id: { eq: 1 } }) { tsP tsTzP } }`);
    expect(read.stampsSingle).toEqual({ tsP: '2026-09-15T10:00:00.123Z', tsTzP: '2026-09-15T10:00:00.123Z' });
  });

  it('updates every variant', async () => {
    await ok(`mutation ($v: CreateStampsInput!) { createStampsSingle(values: $v) { id } }`, {
      v: { id: 1, ...allValues(INSTANT) },
    });
    const later = '2026-12-31T23:59:59.999Z';
    const updated = await ok(
      `mutation ($s: UpdateStampsInput!) { updateStamps(set: $s, where: { id: { eq: 1 } }) { ${SELECTION} } }`,
      { s: allValues('2027-01-01T05:59:59.999+06:00') },
    );
    expect(updated.updateStamps).toEqual([allValues(later)]);
    expect((await rawText(1)).ts).toBe('2026-12-31 23:59:59.999');
  });

  it('filters every variant with eq and a range, offsets included', async () => {
    for (const [id, value] of [
      [1, '2026-09-15T09:00:00.000Z'],
      [2, INSTANT],
      [3, '2026-09-15T11:00:00.000Z'],
    ] as const) {
      await ok(`mutation ($v: CreateStampsInput!) { createStampsSingle(values: $v) { id } }`, {
        v: { id, ...allValues(value) },
      });
    }
    const order = 'orderBy: { id: { direction: asc, priority: 1 } }';
    for (const column of ALL_COLUMNS) {
      const eq = await ok(`{ stamps(where: { ${column}: { eq: "2026-09-15T05:00:00-05:00" } }) { id } }`);
      expect(eq.stamps).toEqual([{ id: 2 }]);
      const range = await ok(
        `{ stamps(where: { ${column}: { gt: "2026-09-15T09:00:00Z", lte: "2026-09-15T16:30:00+05:30" } }, ${order}) { id } }`,
      );
      expect(range.stamps).toEqual([{ id: 2 }, { id: 3 }]);
      const inArray = await ok(
        `{ stamps(where: { ${column}: { inArray: ["2026-09-15T09:00:00Z", "2026-09-15T06:00:00-05:00"] } }, ${order}) { id } }`,
      );
      expect(inArray.stamps).toEqual([{ id: 1 }, { id: 3 }]);
    }
  });

  it('returns min/max and group keys as the UTC instant', async () => {
    await db.execute(sql`SET TIME ZONE 'America/Chicago'`);
    for (const [id, value] of [
      [1, '2026-09-15T09:00:00.000Z'],
      [2, INSTANT],
    ] as const) {
      await ok(`mutation ($v: CreateStampsInput!) { createStampsSingle(values: $v) { id } }`, {
        v: { id, ...allValues(value) },
      });
    }
    const agg = await ok(`{ stampsAggregate { min { ${SELECTION} } max { ${SELECTION} } } }`);
    expect(agg.stampsAggregate).toEqual({
      min: allValues('2026-09-15T09:00:00.000Z'),
      max: allValues(INSTANT),
    });
    for (const column of ALL_COLUMNS) {
      const grouped = await ok(`{ stampsGroupBy(groupBy: [${column}]) { group { ${column} } count } }`);
      expect(
        [...grouped.stampsGroupBy].sort((a: any, b: any) => a.group[column].localeCompare(b.group[column])),
      ).toEqual([
        { group: { [column]: '2026-09-15T09:00:00.000Z' }, count: 1 },
        { group: { [column]: INSTANT }, count: 1 },
      ]);
    }
  });
});

describe('Postgres string-mode timestamp mapping helpers', () => {
  const serialize = (value: unknown) => (GraphQLDateTime.serialize(value) as Date).toISOString();
  const out = (column: keyof typeof Stamps._.columns, value: unknown) =>
    remapToGraphQLCore(column, value, 'stamps', Stamps[column]);

  it('rewrites timestamp text as RFC 3339 UTC, keeping the fraction', () => {
    expect(out('ts', '2026-09-15 10:00:00')).toBe('2026-09-15T10:00:00Z');
    expect(out('tsP', '2026-09-15 10:00:00.123456')).toBe('2026-09-15T10:00:00.123456Z');
    expect(serialize(out('tsP', '2026-09-15 10:00:00.123456'))).toBe('2026-09-15T10:00:00.123Z');
  });

  it('rewrites timestamptz text with any offset as the same instant in UTC', () => {
    expect(out('tsTz', '2026-09-15 10:00:00+00')).toBe('2026-09-15T10:00:00Z');
    expect(out('tsTz', '2026-09-15 04:00:00-06')).toBe('2026-09-15T10:00:00Z');
    expect(out('tsTz', '2026-09-15 15:30:00+05:30')).toBe('2026-09-15T10:00:00Z');
    expect(out('tsTzP', '2026-09-15 00:30:00.5-09:30')).toBe('2026-09-15T10:00:00.5Z');
    // Historical local mean time offsets carry seconds, which RFC 3339 cannot express.
    expect(out('tsTz', '1890-01-01 00:00:00+00:53:28')).toBe('1889-12-31T23:06:32Z');
    // Crossing a day, month and year boundary.
    expect(out('tsTzP', '2027-01-01 05:59:59.999999+06')).toBe('2026-12-31T23:59:59.999999Z');
  });

  it('leaves text that names no finite instant for the scalar to reject', () => {
    for (const value of ['infinity', '-infinity', '2026-09-15 10:00:00 BC']) {
      expect(out('tsTz', value)).toBe(value);
      expect(() => GraphQLDateTime.serialize(out('tsTz', value))).toThrow();
    }
  });

  it('writes timestamptz as an ISO instant and timestamp as UTC text without an offset', () => {
    const input = new Date('2026-09-15T05:00:00.250-05:00');
    expect(remapFromGraphQLCore(input, Stamps.tsTz, 'tsTz')).toBe('2026-09-15T10:00:00.250Z');
    expect(remapFromGraphQLCore(input, Stamps.tsTzP, 'tsTzP')).toBe('2026-09-15T10:00:00.250Z');
    expect(remapFromGraphQLCore(input, Stamps.ts, 'ts')).toBe('2026-09-15 10:00:00.250');
    expect(remapFromGraphQLCore(input, Stamps.tsP, 'tsP')).toBe('2026-09-15 10:00:00.250');
    // `'date'` mode is unchanged: drizzle's own mapToDriverValue takes the Date.
    expect(remapFromGraphQLCore(input, Stamps.tsDate, 'tsDate')).toEqual(input);
  });

  it('reads offset-less Postgres text from a hand-built caller as UTC', () => {
    expect(remapFromGraphQLCore('2026-09-15 10:00:00', Stamps.ts, 'ts')).toBe('2026-09-15 10:00:00.000');
    expect(remapFromGraphQLCore('2026-09-15 10:00:00', Stamps.tsTz, 'tsTz')).toBe(INSTANT);
    expect(remapFromGraphQLCore('2026-09-15 04:00:00-06', Stamps.tsTz, 'tsTz')).toBe(INSTANT);
  });

  it('rejects a value that is not a date', () => {
    for (const column of STRING_COLUMNS) {
      expect(() => remapFromGraphQLCore('not a date', Stamps[column], column)).toThrow(
        expect.objectContaining({ extensions: expect.objectContaining({ code: 'DRIZZLE_INVALID_INPUT_VALUE' }) }),
      );
    }
  });
});
