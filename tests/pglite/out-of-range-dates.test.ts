// A `mode: 'date'` timestamp or date column can hold values a JS Date cannot: BC dates, years past
// 275760, and PostgreSQL's infinities. drizzle reads those as an invalid Date. Such a row must
// still list and page: a selected value the `DateTime` / `Date` scalar cannot represent is a
// field error on that row alone, and an ordering column that is fetched but not selected is not
// rendered at all. Cursors over such a column carry the database's own text, which also keeps
// `timestamp` infinity apart from the ordinary instant drizzle misreads it as.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { date, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { GraphQLDateTime as GraphQLScalarsDateTime } from 'graphql-scalars';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, GraphQLDateTime } from '@/index';

const Groups = pgTable('groups', { id: integer('id').primaryKey() });
const Eras = pgTable('eras', {
  id: integer('id').primaryKey(),
  groupId: integer('group_id').notNull(),
  // Millisecond precision: a JS Date holds it, so no full-precision text was fetched for cursors.
  atMs: timestamp('at_ms', { precision: 3 }).notNull(),
  at: timestamp('at').notNull(),
  atTz: timestamp('at_tz', { withTimezone: true }).notNull(),
  day: date('day', { mode: 'date' }).notNull(),
  maybeAt: timestamp('maybe_at', { precision: 3 }),
});
const tables = { Groups, Eras };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Groups: { eras: r.many.Eras({ from: r.Groups.id, to: r.Eras.groupId }) },
});

let pglite: PGlite;
let schema: GraphQLSchema;
let db: any;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE groups (id integer PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE eras (
    id integer PRIMARY KEY,
    group_id integer NOT NULL,
    at_ms timestamp(3) NOT NULL,
    at timestamp NOT NULL,
    at_tz timestamptz NOT NULL,
    day date NOT NULL,
    maybe_at timestamp(3)
  )`);
  await db.execute(sql`INSERT INTO groups VALUES (1)`);
  await db.execute(sql`INSERT INTO eras VALUES
    (1, 1, '0044-03-15 12:00:00 BC', '0044-03-15 12:00:00 BC', '0044-03-15 12:00:00+00 BC', '0044-03-15 BC', '0044-03-15 12:00:00 BC'),
    (2, 1, '2024-01-01 00:00:00', '2024-01-01 00:00:00.123456', '2024-01-01 00:00:00+00', '2024-01-01', '2024-01-01 00:00:00'),
    (3, 1, '280000-01-01 00:00:00', '280000-01-01 00:00:00', '280000-01-01 00:00:00+00', '280000-01-01', '280000-01-01 00:00:00'),
    (4, 1, 'infinity', 'infinity', 'infinity', 'infinity', 'infinity'),
    (5, 1, '-infinity', '-infinity', '-infinity', '-infinity', '-infinity'),
    (6, 1, '1999-12-31 23:00:00', '1999-12-31 23:00:00', '1999-12-31 23:00:00+00', '1999-12-31', null)`);
  schema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const run = (source: string, variableValues?: Record<string, unknown>) =>
  graphql({ schema, source, variableValues, contextValue: {} });

/** Every column's values, ascending: -infinity, 44 BC, 1999, 2024, 280000, infinity. */
const ASCENDING = [5, 1, 6, 2, 3, 4];
const COLUMNS = ['atMs', 'at', 'atTz', 'day'] as const;

describe('pglite: mode date columns holding values a JS Date cannot', () => {
  it.each(COLUMNS)('lists rows ordered by %s when it is not selected', async (column) => {
    for (const direction of ['asc', 'desc'] as const) {
      const res: any = await run(`{ eras(orderBy: { ${column}: { direction: ${direction}, priority: 1 } }) { id } }`);
      expect(res.errors?.map((error: Error) => error.message)).toBeUndefined();
      const expected = direction === 'asc' ? ASCENDING : [...ASCENDING].reverse();
      expect(res.data.eras.map((row: { id: number }) => row.id)).toEqual(expected);
    }
  });

  it('pages past every row by cursor, on the root list and the relation list', async () => {
    for (const column of COLUMNS) {
      for (const direction of ['asc', 'desc'] as const) {
        const expected = direction === 'asc' ? ASCENDING : [...ASCENDING].reverse();
        const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
        const pages = {
          root: async (after: string) => (await run(`{ eras(${orderBy}, limit: 1${after}) { id cursor } }`)) as any,
          relation: async (after: string) => {
            const res: any = await run(`{ groups { eras(${orderBy}, limit: 1${after}) { id cursor } } }`);
            return { ...res, data: res.data && { eras: res.data.groups[0].eras } };
          },
        };
        for (const [path, page] of Object.entries(pages)) {
          const seen: number[] = [];
          let after = '';
          for (let i = 0; i <= expected.length; i++) {
            const res = await page(after);
            expect(
              res.errors?.map((error: Error) => error.message),
              `${path} ${column} ${direction}`,
            ).toBeUndefined();
            const rows = res.data.eras;
            if (!rows.length) {
              break;
            }
            seen.push(rows[0].id);
            after = `, after: "${rows[0].cursor}"`;
          }
          expect(seen, `${path} ${column} ${direction}`).toEqual(expected);
        }
      }
    }
  });

  it('reports a selected value the scalar cannot represent as an error on that field only', async () => {
    const res: any = await run(`{ eras(orderBy: { id: { direction: asc, priority: 1 } }) { id maybeAt } }`);
    // graphql-scalars 1 serializes `DateTime` as a string, 2 as a Date; both name the same instant.
    const at = (value: unknown) => (value === null ? null : new Date(value as string).toISOString());
    // drizzle reads `timestamp` infinity as an ordinary instant (see the file header), so rows 4
    // and 5 are not asserted.
    expect(
      res.data.eras.map((row: any) => [row.id, at(row.maybeAt)]).filter(([id]: [number]) => id < 4 || id > 5),
    ).toEqual([
      [1, null],
      [2, '2024-01-01T00:00:00.000Z'],
      [3, null],
      [6, null],
    ]);
    const failed = (res.errors ?? []).map((error: any) => error.path.join('.'));
    expect(failed).toEqual(expect.arrayContaining(['eras.0.maybeAt', 'eras.2.maybeAt']));
    expect(failed).not.toContain('eras.1.maybeAt');
    expect(failed).not.toContain('eras.5.maybeAt');
    for (const error of res.errors) {
      expect(error.message).not.toMatch(/Invalid time value|Internal server error/);
    }
  });

  it('codes a value the DateTime scalar cannot represent the way the Date scalar codes one', async () => {
    const res: any = await run(`{ eras(where: { id: { eq: 1 } }) { maybeAt } }`);
    const nested: any = await run(`{ erasAggregate { min { atTz } } }`);
    const errors = [...(res.errors ?? []), ...(nested.errors ?? [])];
    expect(errors.map((error: any) => error.path.join('.'))).toEqual(['eras.0.maybeAt', 'erasAggregate.min.atTz']);
    for (const error of errors) {
      expect(error.extensions?.code).toBe('DRIZZLE_UNREPRESENTABLE_VALUE');
      expect(error.message).toMatch(/^DateTime cannot represent/);
    }
    const day: any = await run(`{ eras(where: { id: { eq: 1 } }) { day } }`);
    expect(day.errors?.[0]?.extensions?.code).toBe('DRIZZLE_UNREPRESENTABLE_VALUE');
  });

  it('codes a DateTime argument the scalar cannot parse, as a literal or a variable', async () => {
    const literal: any = await run(`{ eras(where: { atTz: { eq: "not a date" } }) { id } }`);
    const variable: any = await run(`query ($at: DateTime) { eras(where: { atTz: { eq: $at } }) { id } }`, {
      at: 'not a date',
    });
    const write: any = await run(
      `mutation ($at: DateTime) { updateEras(where: { id: { eq: 2 } }, set: { maybeAt: $at }) { id } }`,
      {
        at: '2024-02-30T00:00:00Z',
      },
    );
    const results = { literal, variable, write };
    for (const [name, res] of Object.entries(results)) {
      expect(res.data, name).toBeUndefined();
      expect(res.errors, name).toHaveLength(1);
      expect(res.errors[0].extensions?.code, name).toBe('DRIZZLE_INVALID_INPUT_VALUE');
      expect(res.errors[0].message, name).toMatch(/DateTime cannot represent/);
      expect(res.errors[0].locations, name).toBeDefined();
    }
  });

  it("uses the library's DateTime instance, even for an override naming graphql-scalars' own", async () => {
    expect(schema.getType('DateTime')).toBe(GraphQLDateTime);
    expect(GraphQLDateTime).not.toBe(GraphQLScalarsDateTime);
    const overridden = buildSchema(db, {
      scalars: { Eras: { groupId: GraphQLScalarsDateTime } },
      mapColumnType: (_column, { columnName }) =>
        columnName === 'maybeAt' ? { output: GraphQLScalarsDateTime, input: GraphQLScalarsDateTime } : undefined,
    }).schema;
    expect(overridden.getType('DateTime')).toBe(GraphQLDateTime);
    const res: any = await graphql({ schema: overridden, source: '{ eras(where: { id: { eq: 1 } }) { maybeAt } }' });
    expect(res.errors?.[0]?.extensions?.code).toBe('DRIZZLE_UNREPRESENTABLE_VALUE');
  });

  it('returns a written row whose other columns a JS Date cannot hold', async () => {
    const res: any = await run(`mutation { updateEras(where: { id: { eq: 1 } }, set: { groupId: 1 }) { id groupId } }`);
    expect(res.errors?.map((error: Error) => error.message)).toBeUndefined();
    expect(res.data.updateEras).toEqual([{ id: 1, groupId: 1 }]);
  });

  it('aggregates min and max over such values without failing the other aggregates', async () => {
    const res: any = await run(`{ erasAggregate { count min { id atTz } max { id day } } }`);
    expect(res.data.erasAggregate.count).toBe(6);
    expect(res.data.erasAggregate.min.id).toBe(1);
    expect(res.data.erasAggregate.max.id).toBe(6);
    for (const error of res.errors ?? []) {
      expect(error.message).not.toMatch(/Invalid time value|Internal server error/);
    }
  });

  it('reports a NOT NULL selected value the scalar cannot represent as a field error, not a crash', async () => {
    const res: any = await run(`{ eras(where: { id: { inArray: [1, 2] } }) { id atTz day } }`);
    expect(res.errors?.length).toBeGreaterThan(0);
    for (const error of res.errors) {
      expect(error.message).not.toMatch(/Invalid time value|Internal server error/);
      expect(error.path).toEqual(['eras', 0, expect.stringMatching(/^(atTz|day)$/)]);
    }
  });
});
