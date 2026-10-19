import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { int, date as mysqlDate, mysqlTable } from 'drizzle-orm/mysql-core';
import { date, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, GraphQLDate } from '@/index';
import { generateMySQL } from '@/util/builders';

// ── A calendar-date column is the `Date` scalar everywhere ─────────────────────
// Both drizzle modes — `'string'` (the value is `YYYY-MM-DD`) and `'date'` (a JS `Date`) —
// hold the same thing, a day with no time and no offset, so the schema gives both one type
// in every position: output, create/update input, filter operands, aggregates and group keys.
// Run this file under a non-UTC TZ (e.g. `TZ=America/Chicago`) to check that no day shifts.
const Entries = pgTable('entries', {
  id: serial('id').primaryKey(),
  dayString: date('day_string', { mode: 'string' }),
  dayDate: date('day_date', { mode: 'date' }),
  daysDate: date('days_date', { mode: 'date' }).array(),
  at: timestamp('at'),
});
const relations = buildRelations({ Entries }, {});
const schema = { Entries, relations };

const DATA_DIR = `./tests/.temp/pgdata-date-columns-${Date.now()}`;

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const inputFieldType = (typeName: string, fieldName: string) =>
  String((entities.inputs[typeName] as GraphQLInputObjectType).getFields()[fieldName]!.type);
const objectFieldType = (type: GraphQLObjectType, fieldName: string) => String(type.getFields()[fieldName]!.type);

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "entries" (
    "id" serial PRIMARY KEY NOT NULL,
    "day_string" date,
    "day_date" date,
    "days_date" date[],
    "at" timestamp
  );`);

  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('date column schema shape', () => {
  it('is the library-owned Date scalar', () => {
    expect(gqlSchema.getType('Date')).toBe(GraphQLDate);
  });

  for (const column of ['dayString', 'dayDate']) {
    it(`types ${column} as Date on the object type, both inputs and the filter`, () => {
      expect(objectFieldType(entities.types['Entries'], column)).toBe('Date');
      expect(inputFieldType('CreateEntriesInput', column)).toBe('Date');
      expect(inputFieldType('UpdateEntriesInput', column)).toBe('Date');
      expect(inputFieldType('EntriesFilters', column)).toBe('DateFilter');
    });

    it(`types ${column} as Date in aggregate min/max and group keys`, () => {
      const aggregate = gqlSchema.getType('EntriesAggregate') as GraphQLObjectType;
      const min = aggregate.getFields()['min']!.type as GraphQLObjectType;
      const max = aggregate.getFields()['max']!.type as GraphQLObjectType;
      expect(objectFieldType(min, column)).toBe('Date');
      expect(objectFieldType(max, column)).toBe('Date');
      expect(objectFieldType(gqlSchema.getType('EntriesGroupKeys') as GraphQLObjectType, column)).toBe('Date');
    });
  }

  it('types a date array column as a list of Date', () => {
    expect(objectFieldType(entities.types['Entries'], 'daysDate')).toBe('[Date!]');
    expect(inputFieldType('CreateEntriesInput', 'daysDate')).toBe('[Date!]');
  });

  it('gives DateFilter the DateTimeFilter operator set, with Date operands', () => {
    const dateFilter = gqlSchema.getType('DateFilter') as GraphQLInputObjectType;
    const dateTimeFilter = gqlSchema.getType('DateTimeFilter') as GraphQLInputObjectType;
    const fields = dateFilter.getFields();
    expect(Object.keys(fields).sort()).toEqual(Object.keys(dateTimeFilter.getFields()).sort());
    for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']) {
      expect(String(fields[op]!.type)).toBe('Date');
    }
    expect(String(fields['inArray']!.type)).toBe('[Date!]');
    expect(fields['contains']).toBeUndefined();
    expect(fields['startsWith']).toBeUndefined();
  });
});

describe.sequential('date column round-trips', () => {
  it('creates with literals and reads back YYYY-MM-DD in both modes', async () => {
    const res = await run(`mutation {
      createEntriesSingle(values: { id: 1, dayString: "2026-09-15", dayDate: "2026-09-15", daysDate: ["2026-01-01", "2026-12-31"] }) {
        dayString dayDate daysDate
      }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createEntriesSingle).toEqual({
      dayString: '2026-09-15',
      dayDate: '2026-09-15',
      daysDate: ['2026-01-01', '2026-12-31'],
    });

    const read = await run(`{ entriesSingle(where: { id: { eq: 1 } }) { dayString dayDate daysDate } }`);
    expect(read.errors).toBeUndefined();
    expect((read.data as any).entriesSingle).toEqual({
      dayString: '2026-09-15',
      dayDate: '2026-09-15',
      daysDate: ['2026-01-01', '2026-12-31'],
    });
  });

  it('stores the day itself, whatever the server timezone', async () => {
    const [row] = await db.select().from(Entries).where(sql`id = 1`);
    expect(row.dayString).toBe('2026-09-15');
    expect(row.dayDate).toBeInstanceOf(Date);
    expect((row.dayDate as Date).toISOString()).toBe('2026-09-15T00:00:00.000Z');
    const raw = await db.execute(sql`select day_date::text as d from entries where id = 1`);
    expect(raw.rows[0].d).toBe('2026-09-15');
  });

  it('creates with variables typed Date', async () => {
    const res = await run(
      `mutation ($s: Date, $d: Date) { createEntriesSingle(values: { id: 2, dayString: $s, dayDate: $d }) { dayString dayDate } }`,
      { s: '2024-02-29', d: '2024-03-01' },
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createEntriesSingle).toEqual({ dayString: '2024-02-29', dayDate: '2024-03-01' });
  });

  it('updates both modes', async () => {
    const res = await run(`mutation {
      updateEntries(set: { dayString: "2026-10-01", dayDate: "2026-10-02" }, where: { id: { eq: 2 } }) { dayString dayDate }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).updateEntries).toEqual([{ dayString: '2026-10-01', dayDate: '2026-10-02' }]);
  });

  it('filters both modes with eq, ordering and inArray', async () => {
    for (const column of ['dayString', 'dayDate']) {
      const eq = await run(`{ entries(where: { ${column}: { eq: "2026-09-15" } }) { id } }`);
      expect(eq.errors).toBeUndefined();
      expect((eq.data as any).entries).toEqual([{ id: 1 }]);

      const range = await run(`{ entries(where: { ${column}: { gt: "2026-09-15", lte: "2026-12-31" } }) { id } }`);
      expect(range.errors).toBeUndefined();
      expect((range.data as any).entries).toEqual([{ id: 2 }]);

      const inArray = await run(
        `query ($days: [Date!]) { entries(where: { ${column}: { inArray: $days } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
        { days: ['2026-09-15', '2026-10-01', '2026-10-02'] },
      );
      expect(inArray.errors).toBeUndefined();
      expect((inArray.data as any).entries).toEqual([{ id: 1 }, { id: 2 }]);
    }
  });

  it('returns YYYY-MM-DD from min/max aggregates and group keys', async () => {
    const agg = await run(`{ entriesAggregate { min { dayString dayDate } max { dayString dayDate } } }`);
    expect(agg.errors).toBeUndefined();
    expect((agg.data as any).entriesAggregate).toEqual({
      min: { dayString: '2026-09-15', dayDate: '2026-09-15' },
      max: { dayString: '2026-10-01', dayDate: '2026-10-02' },
    });

    const grouped = await run(`{ entriesGroupBy(groupBy: [dayDate]) { group { dayDate } count } }`);
    expect(grouped.errors).toBeUndefined();
    expect(
      (grouped.data as any).entriesGroupBy
        .map((g: any) => g.group.dayDate)
        .sort((a: string, b: string) => (a < b ? -1 : 1)),
    ).toEqual(['2026-09-15', '2026-10-02']);
  });
});

describe.sequential('date column rejects what is not a calendar date', () => {
  const INVALID = ['2026-13-45', '2026-02-30', '2025-02-29', '2026-09-15T10:00:00Z', '2026-9-15', ''];

  for (const value of INVALID) {
    for (const column of ['dayString', 'dayDate']) {
      it(`rejects ${JSON.stringify(value)} for ${column} as a literal and as a variable`, async () => {
        const literal = await run(`mutation { createEntriesSingle(values: { id: 99, ${column}: "${value}" }) { id } }`);
        expect(literal.errors?.length).toBeGreaterThan(0);
        expect(literal.errors![0]!.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');

        const variable = await run(
          `mutation ($v: Date) { createEntriesSingle(values: { id: 99, ${column}: $v }) { id } }`,
          { v: value },
        );
        expect(variable.errors?.length).toBeGreaterThan(0);
        expect(variable.errors![0]!.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');

        const update = await run(
          `mutation { updateEntries(set: { ${column}: "${value}" }, where: { id: { eq: 1 } }) { id } }`,
        );
        expect(update.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');

        const filter = await run(`{ entries(where: { ${column}: { eq: "${value}" } }) { id } }`);
        expect(filter.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
      });
    }
  }

  it('rejects a non-string literal', async () => {
    const res = await run(`mutation { createEntriesSingle(values: { id: 99, dayDate: 20260915 }) { id } }`);
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('wrote none of the rejected rows', async () => {
    const res = await run(`{ entries(where: { id: { eq: 99 } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).entries).toEqual([]);
  });
});

describe('Date as a scalar override', () => {
  // The exported scalar is the one natural date columns use, so overriding another column
  // with it shares the one `Date` type and the one `DateFilter`. (`graphql-scalars`' own
  // `GraphQLDate` is a different object with the same name, and graphql refuses a schema
  // holding both — see the README's migration note.)
  it('shares the Date type and DateFilter with natural date columns', () => {
    const Notes = pgTable('notes', { id: serial('id').primaryKey(), day: date('day'), dueOn: text('due_on') });
    const built = buildSchema((drizzle as any).mock({ relations: buildRelations({ Notes }, {}) }), {
      scalars: { Notes: { dueOn: GraphQLDate } },
    });
    expect(built.schema.getType('Date')).toBe(GraphQLDate);
    const filters = (built.entities.inputs['NotesFilters'] as GraphQLInputObjectType).getFields();
    expect(filters['day']!.type).toBe(filters['dueOn']!.type);
    expect(String(filters['dueOn']!.type)).toBe('DateFilter');
  });
});

describe('MySQL date columns', () => {
  const Days = mysqlTable('days', {
    id: int('id').primaryKey(),
    dayString: mysqlDate('day_string', { mode: 'string' }),
    dayDate: mysqlDate('day_date', { mode: 'date' }),
  });
  const mockQueryBuilder = { findMany: async () => [], findFirst: async () => null };
  const mockDb: any = {
    query: { Days: mockQueryBuilder },
    select: () => ({}),
    insert: () => ({}),
    update: () => ({}),
    delete: () => ({}),
  };
  const generated = (generateMySQL as any)(mockDb, { Days }, buildRelations({ Days }, {}), {
    prefixes: { insert: 'create', delete: 'delete', update: 'update' },
    suffixes: { list: '', single: 'Single' },
    conflictDoNothing: false,
    shouldEagerLoad: () => true,
    features: { aggregates: true, insert: true, update: true, delete: true },
  });

  for (const column of ['dayString', 'dayDate']) {
    it(`types ${column} as Date in every position`, () => {
      expect(String((generated.types['Days'] as GraphQLObjectType).getFields()[column]!.type)).toBe('Date');
      for (const input of ['CreateDaysInput', 'UpdateDaysInput']) {
        expect(String((generated.inputs[input] as GraphQLInputObjectType).getFields()[column]!.type)).toBe('Date');
      }
      expect(String((generated.inputs['DaysFilters'] as GraphQLInputObjectType).getFields()[column]!.type)).toBe(
        'DateFilter',
      );
    });
  }
});
