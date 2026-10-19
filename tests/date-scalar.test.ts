import { Kind, parseValue as parseLiteralAst } from 'graphql';
import { describe, expect, it } from 'vitest';
import { GraphQLDate } from '@/index';

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e: any) {
    return e.extensions?.code;
  }
  return undefined;
};

const NOT_DATES = [
  '2026-13-45',
  '2026-00-10',
  '2026-02-30',
  '2025-02-29',
  '1900-02-29',
  '2026-04-31',
  '2026-09-15T10:00:00Z',
  '2026-09-15T00:00:00.000Z',
  '2026-09-15 00:00:00',
  '2026-9-15',
  '26-09-15',
  '+2026-09-15',
  ' 2026-09-15',
  '',
  'yesterday',
];

describe('GraphQLDate', () => {
  it('is named Date', () => {
    expect(GraphQLDate.name).toBe('Date');
  });

  describe('parseValue', () => {
    it('returns a valid full-date string unchanged', () => {
      for (const value of ['2026-09-15', '2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31']) {
        expect(GraphQLDate.parseValue(value)).toBe(value);
      }
    });

    it('rejects strings that are not a real calendar date, with an input-value code', () => {
      for (const value of NOT_DATES) {
        expect(() => GraphQLDate.parseValue(value), value).toThrow();
        expect(codeOf(() => GraphQLDate.parseValue(value))).toBe('DRIZZLE_INVALID_INPUT_VALUE');
      }
    });

    it('rejects non-strings, including a JS Date', () => {
      for (const value of [20260915, new Date('2026-09-15'), null, {}, true]) {
        expect(() => GraphQLDate.parseValue(value)).toThrow();
      }
    });
  });

  describe('parseLiteral', () => {
    it('accepts a string literal holding a full-date', () => {
      expect(GraphQLDate.parseLiteral(parseLiteralAst('"2026-09-15"'), undefined)).toBe('2026-09-15');
    });

    it('rejects an invalid string literal and non-string literals', () => {
      expect(() => GraphQLDate.parseLiteral(parseLiteralAst('"2026-02-30"'), undefined)).toThrow();
      expect(() => GraphQLDate.parseLiteral(parseLiteralAst('"2026-09-15T10:00:00Z"'), undefined)).toThrow();
      expect(() => GraphQLDate.parseLiteral({ kind: Kind.INT, value: '20260915' } as any, undefined)).toThrow();
      expect(() => GraphQLDate.parseLiteral(parseLiteralAst('true'), undefined)).toThrow();
    });
  });

  describe('serialize', () => {
    it('passes a valid full-date string through', () => {
      expect(GraphQLDate.serialize('2026-09-15')).toBe('2026-09-15');
    });

    it('formats a JS Date as the UTC day it encodes', () => {
      // How drivers hand back a `date` column in `'date'` mode: UTC midnight.
      expect(GraphQLDate.serialize(new Date('2026-09-15'))).toBe('2026-09-15');
      expect(GraphQLDate.serialize(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01');
      expect(GraphQLDate.serialize(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
      const earlyYear = new Date(Date.UTC(2000, 0, 5));
      earlyYear.setUTCFullYear(5);
      expect(GraphQLDate.serialize(earlyYear)).toBe('0005-01-05');
    });

    it('rejects invalid strings, invalid Dates and other values, with an unrepresentable code', () => {
      for (const value of [...NOT_DATES, new Date('nope'), new Date(Date.UTC(10000, 0, 1)), 20260915, {}]) {
        expect(codeOf(() => GraphQLDate.serialize(value))).toBe('DRIZZLE_UNREPRESENTABLE_VALUE');
      }
    });
  });
});
