import { GraphQLScalarType, Kind } from 'graphql';
import { GraphQLDateTime, GraphQLJSON, GraphQLUUID } from 'graphql-scalars';
import { type DrizzleErrorCode, drizzleError } from '../builders/common/errors.ts';

// Both scalars below coerce the same way in both directions, so each helper is built once per
// direction with the code that direction reports: a rejected argument is the client's value to
// fix, while a rejected column value is the stored data's. graphql-js wraps a `parseValue`
// throw when it coerces variables, but the wrapper inherits the original's `extensions`, so
// the code survives that trip.
const INVALID_INPUT: DrizzleErrorCode = 'DRIZZLE_INVALID_INPUT_VALUE';
const UNREPRESENTABLE: DrizzleErrorCode = 'DRIZZLE_UNREPRESENTABLE_VALUE';

const decimalString =
  (code: DrizzleErrorCode) =>
  (value: unknown): string => {
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        throw drizzleError(`BigInt cannot represent non-integer value: ${value}`, { code });
      }
      if (!Number.isSafeInteger(value)) {
        throw drizzleError(
          `BigInt cannot represent the number ${value} without precision loss — pass it as a string instead`,
          { code },
        );
      }
      return String(value);
    }

    if (typeof value === 'string') {
      if (!/^-?\d+$/.test(value)) {
        throw drizzleError(`BigInt cannot represent non-integer value: "${value}"`, { code });
      }
      return value;
    }

    throw drizzleError(`BigInt cannot represent value: ${JSON.stringify(value)}`, { code });
  };

const parseDecimal = decimalString(INVALID_INPUT);

/**
 * A 64-bit integer. Always transported as a decimal string, in both directions, so no value
 * is ever silently rounded by JSON's double-precision numbers. `graphql-scalars`' own
 * `GraphQLBigInt` is deliberately not used: it emits numbers for safe integers and strings
 * for everything else, so a client cannot know which it will get.
 */
export const GraphQLBigIntString = new GraphQLScalarType<string, string>({
  name: 'BigInt',
  description:
    'A 64-bit integer, transported as a decimal string so that values beyond ' +
    "JavaScript's safe integer range survive the round-trip intact.",
  serialize: decimalString(UNREPRESENTABLE),
  parseValue: parseDecimal,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT) {
      throw drizzleError(`BigInt cannot represent a ${ast.kind}`, { code: INVALID_INPUT, nodes: ast });
    }
    return parseDecimal(ast.value);
  },
});

// Optional sign, digits with an optional fractional part (or a bare fractional part),
// and an optional exponent. Deliberately excludes 'NaN', 'Infinity', and empty strings,
// even though some databases would accept them.
const numericStringPattern = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const numericString =
  (code: DrizzleErrorCode) =>
  (value: unknown): string => {
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw drizzleError(`Decimal cannot represent non-finite value: ${value}`, { code });
      }
      return String(value);
    }

    if (typeof value === 'string') {
      if (!numericStringPattern.test(value)) {
        throw drizzleError(`Decimal cannot represent non-numeric value: "${value}"`, { code });
      }
      return value;
    }

    throw drizzleError(`Decimal cannot represent value: ${JSON.stringify(value)}`, { code });
  };

const parseNumeric = numericString(INVALID_INPUT);

/**
 * An arbitrary-precision decimal (`numeric` / `decimal` columns). Always transported as a
 * numeric string, in both directions, so no value is ever silently rounded by JSON's
 * double-precision numbers. Accepts numeric literals and numeric strings on input; rejects
 * non-numeric strings (including 'NaN' and 'Infinity').
 */
export const GraphQLDecimalString = new GraphQLScalarType<string, string>({
  name: 'Decimal',
  description:
    'An arbitrary-precision decimal, transported as a numeric string so that values ' +
    "beyond JavaScript's double-precision range survive the round-trip intact.",
  serialize: numericString(UNREPRESENTABLE),
  parseValue: parseNumeric,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT && ast.kind !== Kind.FLOAT) {
      throw drizzleError(`Decimal cannot represent a ${ast.kind}`, { code: INVALID_INPUT, nodes: ast });
    }
    return parseNumeric(ast.value);
  },
});

// RFC 3339 `full-date`: four-digit year, two-digit month and day, nothing else — no time, no
// offset. The shape alone admits `2026-13-45`, so `isCalendarDate` checks the ranges too.
const fullDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/** Whether `value` is a `YYYY-MM-DD` string naming a day that exists on the calendar. */
export const isCalendarDate = (value: string): boolean => {
  const match = fullDatePattern.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
};

/**
 * A JS `Date` as the calendar day it stands for. Read in UTC, because that is how drivers
 * build one from a `date` column: `new Date('2026-09-15')` is UTC midnight, so the local
 * getters would name the previous day anywhere west of Greenwich.
 */
export const dateToCalendarDate = (value: Date): string | undefined => {
  if (Number.isNaN(value.getTime())) {
    return undefined;
  }
  const year = value.getUTCFullYear();
  if (year < 0 || year > 9999) {
    return undefined;
  }
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${month}-${day}`;
};

const calendarDate =
  (code: DrizzleErrorCode, acceptDate: boolean) =>
  (value: unknown): string => {
    if (typeof value === 'string') {
      if (!isCalendarDate(value)) {
        throw drizzleError(`Date cannot represent "${value}": expected a calendar date as YYYY-MM-DD`, { code });
      }
      return value;
    }

    if (acceptDate && value instanceof Date) {
      const formatted = dateToCalendarDate(value);
      if (formatted === undefined) {
        throw drizzleError('Date cannot represent an invalid or out-of-range Date', { code });
      }
      return formatted;
    }

    throw drizzleError(`Date cannot represent value: ${JSON.stringify(value)}: expected a YYYY-MM-DD string`, {
      code,
    });
  };

const parseCalendarDate = calendarDate(INVALID_INPUT, false);

/**
 * A calendar day — `date` columns, whichever `mode` drizzle reads them in. Always transported
 * as an RFC 3339 `full-date` string (`YYYY-MM-DD`), in both directions: it has no time and no
 * offset, so there is nothing for a client's timezone to shift. `graphql-scalars`' own
 * `GraphQLDate` is deliberately not used: its `parseValue` returns a JS `Date`, so the same
 * scalar would be a string on the way out and an instant on the way in.
 *
 * Input accepts only a `YYYY-MM-DD` string naming a real day (`2026-02-30` and datetime
 * strings are rejected) and hands it on unchanged. Output also accepts a JS `Date`, read as
 * the UTC day it encodes.
 */
export const GraphQLDate = new GraphQLScalarType<string, string>({
  name: 'Date',
  description: 'A calendar date with no time or offset, transported as an RFC 3339 full-date string (YYYY-MM-DD).',
  specifiedByURL: 'https://datatracker.ietf.org/doc/html/rfc3339#section-5.6',
  serialize: calendarDate(UNREPRESENTABLE, true),
  parseValue: parseCalendarDate,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) {
      throw drizzleError(`Date cannot represent a ${ast.kind}`, { code: INVALID_INPUT, nodes: ast });
    }
    return parseCalendarDate(ast.value);
  },
});

export { GraphQLDateTime, GraphQLJSON, GraphQLUUID };
