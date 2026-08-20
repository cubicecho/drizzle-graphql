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

export { GraphQLDate, GraphQLDateTime, GraphQLJSON, GraphQLUUID };
