import { GraphQLScalarType, Kind } from 'graphql';
import { GraphQLDate, GraphQLDateTime, GraphQLJSON, GraphQLUUID } from 'graphql-scalars';
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

export { GraphQLDate, GraphQLDateTime, GraphQLJSON, GraphQLUUID };
