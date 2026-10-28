import { buildRelations } from 'drizzle-orm';
import { datetime, int, mysqlTable, timestamp } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import type { GraphQLInputObjectType, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { remapFromGraphQLCore, remapToGraphQLCore } from '@/util/data-mappers';

// ── A MySQL timestamp / datetime column is the `DateTime` scalar everywhere ────
// Both column types, in both drizzle modes — `'date'` (a JS `Date`) and `'string'` (MySQL's own
// `YYYY-MM-DD HH:MM:SS` text) — hold an instant, so the schema gives all four `DateTime` in every
// position and `DateTimeFilter` in filters, as it does Postgres `timestamp`. No database is
// needed: the schema is built from a mysql2 drizzle instance whose client is never called.
// Run this file under a non-UTC TZ (e.g. `TZ=America/Chicago`) too — nothing here may shift.
const Stamps = mysqlTable('stamps', {
  id: int('id').primaryKey(),
  ts: timestamp('ts', { fsp: 3 }),
  tsString: timestamp('ts_string', { mode: 'string', fsp: 3 }),
  dt: datetime('dt', { fsp: 3 }),
  dtString: datetime('dt_string', { mode: 'string', fsp: 3 }),
});
const COLUMNS = ['ts', 'tsString', 'dt', 'dtString'] as const;
const DATE_MODE = [Stamps.ts, Stamps.dt] as const;
const STRING_MODE = [Stamps.tsString, Stamps.dtString] as const;

const db = drizzle({ client: { config: {} } as any, relations: buildRelations({ Stamps }, {}) });
const { schema } = buildSchema(db);

const fieldType = (typeName: string, fieldName: string) =>
  String((schema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType).getFields()[fieldName]!.type);

const INSTANT = '2026-09-15T10:00:00.000Z';
const MYSQL_TEXT = '2026-09-15 10:00:00.000';

describe('MySQL timestamp / datetime schema shape', () => {
  for (const column of COLUMNS) {
    it(`types ${column} as DateTime in every position`, () => {
      for (const typeName of [
        'Stamps',
        'CreateStampsInput',
        'UpdateStampsInput',
        'StampsMinAggregate',
        'StampsMaxAggregate',
        'StampsGroupKeys',
      ]) {
        expect(fieldType(typeName, column), `${typeName}.${column}`).toBe('DateTime');
      }
      expect(fieldType('StampsFilters', column)).toBe('DateTimeFilter');
    });
  }

  it('gives the DateTimeFilter DateTime operands', () => {
    expect(fieldType('DateTimeFilter', 'eq')).toBe('DateTime');
    expect(fieldType('DateTimeFilter', 'inArray')).toBe('[DateTime!]');
    expect(schema.getType('JSONFilter')).toBeUndefined();
  });
});

describe('MySQL timestamp / datetime input mapping', () => {
  it("passes a 'date'-mode column a Date that drizzle writes as the same UTC instant", () => {
    for (const column of DATE_MODE) {
      const mapped = remapFromGraphQLCore(GraphQLDateTime.parseValue(INSTANT), column, column.name, undefined);
      expect(mapped).toBeInstanceOf(Date);
      expect((mapped as Date).toISOString()).toBe(INSTANT);
      // What drizzle hands mysql2: UTC text, not mysql2's local-time formatting of a Date.
      expect(column.mapToDriverValue(mapped)).toBe(MYSQL_TEXT);
    }
  });

  it("passes a 'string'-mode column MySQL datetime text in UTC", () => {
    for (const column of STRING_MODE) {
      expect(remapFromGraphQLCore(GraphQLDateTime.parseValue(INSTANT), column, column.name, undefined)).toBe(
        MYSQL_TEXT,
      );
      // An offset is resolved to the instant it names.
      expect(
        remapFromGraphQLCore(GraphQLDateTime.parseValue('2026-09-15T05:00:00-05:00'), column, column.name, undefined),
      ).toBe(MYSQL_TEXT);
    }
  });

  it('reads offset-less MySQL text from a hand-built caller as UTC, in both modes', () => {
    for (const column of DATE_MODE) {
      expect((remapFromGraphQLCore('2026-09-15 10:00:00', column, column.name, undefined) as Date).toISOString()).toBe(
        INSTANT,
      );
    }
    for (const column of STRING_MODE) {
      expect(remapFromGraphQLCore('2026-09-15 10:00:00', column, column.name, undefined)).toBe(MYSQL_TEXT);
    }
  });

  it('rejects a value that is not a date', () => {
    for (const column of [...DATE_MODE, ...STRING_MODE]) {
      expect(() => remapFromGraphQLCore('not a date', column, column.name, undefined)).toThrow(
        expect.objectContaining({ extensions: expect.objectContaining({ code: 'DRIZZLE_INVALID_INPUT_VALUE' }) }),
      );
    }
  });
});

describe('MySQL timestamp / datetime output mapping', () => {
  const serialize = (value: unknown) => (GraphQLDateTime.serialize(value) as Date).toISOString();

  it("serializes a 'string'-mode column's MySQL text as the UTC instant", () => {
    for (const [key, column] of [
      ['tsString', Stamps.tsString],
      ['dtString', Stamps.dtString],
    ] as const) {
      expect(serialize(remapToGraphQLCore(key, '2026-09-15 10:00:00', 'stamps', column, undefined))).toBe(INSTANT);
      expect(serialize(remapToGraphQLCore(key, '2026-09-15 10:00:00.123', 'stamps', column, undefined))).toBe(
        '2026-09-15T10:00:00.123Z',
      );
      expect(serialize(remapToGraphQLCore(key, '2026-09-15 10:00:00.123456', 'stamps', column, undefined))).toBe(
        '2026-09-15T10:00:00.123Z',
      );
    }
  });

  it("serializes a 'date'-mode column's Date as the same instant", () => {
    for (const [key, column] of [
      ['ts', Stamps.ts],
      ['dt', Stamps.dt],
    ] as const) {
      expect(serialize(remapToGraphQLCore(key, new Date(INSTANT), 'stamps', column, undefined))).toBe(INSTANT);
    }
  });

  it('leaves text that names no instant for the scalar to reject', () => {
    const zeroDate = remapToGraphQLCore('tsString', '0000-00-00 00:00:00', 'stamps', Stamps.tsString, undefined);
    expect(() => GraphQLDateTime.serialize(zeroDate)).toThrow();
  });
});
