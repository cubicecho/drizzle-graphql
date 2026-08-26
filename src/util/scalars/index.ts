import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import { GraphQLDate, GraphQLDateTime, GraphQLJSON, GraphQLUUID } from 'graphql-scalars';

const asDecimalString = (value: unknown): string => {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new GraphQLError(`BigInt cannot represent non-integer value: ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new GraphQLError(
        `BigInt cannot represent the number ${value} without precision loss — pass it as a string instead`,
      );
    }
    return String(value);
  }

  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new GraphQLError(`BigInt cannot represent non-integer value: "${value}"`);
    }
    return value;
  }

  throw new GraphQLError(`BigInt cannot represent value: ${JSON.stringify(value)}`);
};

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
  serialize: asDecimalString,
  parseValue: asDecimalString,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT) {
      throw new GraphQLError(`BigInt cannot represent a ${ast.kind}`, { nodes: ast });
    }
    return asDecimalString(ast.value);
  },
});

// Optional sign, digits with an optional fractional part (or a bare fractional part),
// and an optional exponent. Deliberately excludes 'NaN', 'Infinity', and empty strings,
// even though some databases would accept them.
const numericStringPattern = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const asNumericString = (value: unknown): string => {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new GraphQLError(`Decimal cannot represent non-finite value: ${value}`);
    }
    return String(value);
  }

  if (typeof value === 'string') {
    if (!numericStringPattern.test(value)) {
      throw new GraphQLError(`Decimal cannot represent non-numeric value: "${value}"`);
    }
    return value;
  }

  throw new GraphQLError(`Decimal cannot represent value: ${JSON.stringify(value)}`);
};

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
  serialize: asNumericString,
  parseValue: asNumericString,
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING && ast.kind !== Kind.INT && ast.kind !== Kind.FLOAT) {
      throw new GraphQLError(`Decimal cannot represent a ${ast.kind}`, { nodes: ast });
    }
    return asNumericString(ast.value);
  },
});

export { GraphQLDate, GraphQLDateTime, GraphQLJSON, GraphQLUUID };
