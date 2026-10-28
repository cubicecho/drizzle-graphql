// `GraphQLDateTime` is a copy of graphql-scalars' `DateTime` whose refusals carry this library's
// codes. Everything else has to be graphql-scalars' own, so these compare the two side by side
// under whichever graphql / graphql-scalars majors the suite is running against.
import {
  GraphQLObjectType,
  type GraphQLScalarType,
  GraphQLSchema,
  parseValue as parseLiteralAst,
  printSchema,
} from 'graphql';
import { GraphQLDateTime as GraphQLScalarsDateTime } from 'graphql-scalars';
import { describe, expect, it } from 'vitest';
import { GraphQLDateTime } from '@/index';

const outcome = (fn: () => unknown): { value?: unknown; message?: string; code?: unknown; locations?: unknown } => {
  try {
    return { value: fn() };
  } catch (e: any) {
    return { message: e.message, code: e.extensions?.code, locations: e.locations };
  }
};

const INVALID_INPUTS: unknown[] = [
  'not a date',
  '2024-02-30T00:00:00Z',
  '2024-01-01',
  20240101,
  null,
  {},
  new Date('x'),
];
const INVALID_OUTPUTS: unknown[] = [new Date('x'), 'not a date', {}, true];

const sdlOf = (scalar: GraphQLScalarType) =>
  printSchema(new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { at: { type: scalar } } }) }));

describe('GraphQLDateTime', () => {
  it("prints exactly as graphql-scalars' DateTime does", () => {
    expect(GraphQLDateTime).not.toBe(GraphQLScalarsDateTime);
    expect(sdlOf(GraphQLDateTime)).toBe(sdlOf(GraphQLScalarsDateTime));
    expect(GraphQLDateTime.extensions).toEqual(GraphQLScalarsDateTime.extensions);
  });

  it("coerces valid values exactly as graphql-scalars' DateTime does", () => {
    const at = '2024-01-01T10:00:00.123Z';
    expect(GraphQLDateTime.parseValue(at)).toEqual(GraphQLScalarsDateTime.parseValue(at));
    expect(GraphQLDateTime.parseLiteral(parseLiteralAst(`"${at}"`), undefined)).toEqual(
      GraphQLScalarsDateTime.parseLiteral(parseLiteralAst(`"${at}"`), undefined),
    );
    for (const value of [new Date(at), at, 1704103200000]) {
      expect(GraphQLDateTime.serialize(value)).toEqual(GraphQLScalarsDateTime.serialize(value));
    }
  });

  it("codes a value it cannot output DRIZZLE_UNREPRESENTABLE_VALUE, keeping graphql-scalars' message", () => {
    for (const value of INVALID_OUTPUTS) {
      const ours = outcome(() => GraphQLDateTime.serialize(value));
      expect(ours.code, String(value)).toBe('DRIZZLE_UNREPRESENTABLE_VALUE');
      expect(ours.message).toBe(outcome(() => GraphQLScalarsDateTime.serialize(value)).message);
    }
  });

  it("codes a variable value it cannot parse DRIZZLE_INVALID_INPUT_VALUE, keeping graphql-scalars' message", () => {
    for (const value of INVALID_INPUTS) {
      const ours = outcome(() => GraphQLDateTime.parseValue(value));
      expect(ours.code, String(value)).toBe('DRIZZLE_INVALID_INPUT_VALUE');
      expect(ours.message).toBe(outcome(() => GraphQLScalarsDateTime.parseValue(value)).message);
    }
  });

  it('codes a literal it cannot parse DRIZZLE_INVALID_INPUT_VALUE, at the literal', () => {
    for (const literal of ['"not a date"', '"2024-02-30T00:00:00Z"', '20240101', 'true']) {
      const ours = outcome(() => GraphQLDateTime.parseLiteral(parseLiteralAst(literal), undefined));
      const theirs = outcome(() => GraphQLScalarsDateTime.parseLiteral(parseLiteralAst(literal), undefined));
      expect(ours.code, literal).toBe('DRIZZLE_INVALID_INPUT_VALUE');
      expect(ours.message).toBe(theirs.message);
      expect(ours.locations).toEqual([{ line: 1, column: 1 }]);
    }
  });

  it("wraps graphql 17's coerce* functions too, where the running graphql has them", () => {
    const scalar = GraphQLDateTime as any;
    if (typeof scalar.coerceOutputValue === 'function') {
      expect(outcome(() => scalar.coerceOutputValue(new Date('x'))).code).toBe('DRIZZLE_UNREPRESENTABLE_VALUE');
    }
    if (typeof scalar.coerceInputValue === 'function') {
      expect(outcome(() => scalar.coerceInputValue('not a date')).code).toBe('DRIZZLE_INVALID_INPUT_VALUE');
    }
  });
});
