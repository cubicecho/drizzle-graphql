// `GraphQLUUID` is a copy of graphql-scalars' `UUID` whose refusals carry this library's codes.
// Everything else has to be graphql-scalars' own, so these compare the two side by side under
// whichever graphql / graphql-scalars majors the suite is running against.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations } from 'drizzle-orm';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import {
  GraphQLObjectType,
  type GraphQLScalarType,
  GraphQLSchema,
  graphql,
  parseValue as parseLiteralAst,
  printSchema,
} from 'graphql';
import { GraphQLUUID as GraphQLScalarsUUID } from 'graphql-scalars';
import { describe, expect, it } from 'vitest';
import { buildSchema, GraphQLUUID } from '@/index';

const outcome = (fn: () => unknown): { value?: unknown; message?: string; code?: unknown } => {
  try {
    return { value: fn() };
  } catch (e: any) {
    return { message: e.message, code: e.extensions?.code };
  }
};

const VALID = ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', '3F2504E0-4F89-11D3-9A0C-0305E82C3301'];
const INVALID: unknown[] = ['not-a-uuid', '3f2504e0-4f89-11d3-9a0c', 12, {}, true];

const sdlOf = (scalar: GraphQLScalarType) =>
  printSchema(new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: { id: { type: scalar } } }) }));

describe('GraphQLUUID', () => {
  it("prints exactly as graphql-scalars' UUID does, as a separate instance", () => {
    expect(GraphQLUUID).not.toBe(GraphQLScalarsUUID);
    expect(sdlOf(GraphQLUUID)).toBe(sdlOf(GraphQLScalarsUUID));
    expect(GraphQLUUID.name).toBe(GraphQLScalarsUUID.name);
  });

  it("coerces valid values exactly as graphql-scalars' UUID does", () => {
    for (const value of VALID) {
      expect(outcome(() => GraphQLUUID.serialize(value))).toEqual(outcome(() => GraphQLScalarsUUID.serialize(value)));
      expect(outcome(() => GraphQLUUID.parseValue(value))).toEqual(outcome(() => GraphQLScalarsUUID.parseValue(value)));
      const ast = parseLiteralAst(JSON.stringify(value));
      expect(outcome(() => GraphQLUUID.parseLiteral(ast, {}))).toEqual(
        outcome(() => GraphQLScalarsUUID.parseLiteral(ast, {})),
      );
    }
  });

  it("codes every refusal and keeps graphql-scalars' message", () => {
    for (const value of INVALID) {
      const ours = outcome(() => GraphQLUUID.serialize(value));
      const theirs = outcome(() => GraphQLScalarsUUID.serialize(value));
      expect(ours.message).toBe(theirs.message);
      expect(ours.code).toBe('DRIZZLE_UNREPRESENTABLE_VALUE');

      const oursIn = outcome(() => GraphQLUUID.parseValue(value));
      expect(oursIn.message).toBe(outcome(() => GraphQLScalarsUUID.parseValue(value)).message);
      expect(oursIn.code).toBe('DRIZZLE_INVALID_INPUT_VALUE');
    }
    for (const literal of ['"not-a-uuid"', '12']) {
      const ast = parseLiteralAst(literal);
      const ours = outcome(() => GraphQLUUID.parseLiteral(ast, {}));
      expect(ours.message).toBe(outcome(() => GraphQLScalarsUUID.parseLiteral(ast, {})).message);
      expect(ours.code).toBe('DRIZZLE_INVALID_INPUT_VALUE');
    }
  });
});

describe('uuid columns', () => {
  const Things = pgTable('things', { id: uuid('id').primaryKey(), name: text('name') });

  const build = async (config: Parameters<typeof buildSchema>[1] = {}) => {
    const client = new PGlite();
    await client.exec('create table things (id uuid primary key, name text)');
    const db = drizzle({ client, relations: buildRelations({ Things }, {}) });
    return buildSchema(db, config).schema;
  };

  it('codes an invalid uuid filter argument, as a literal and as a variable', async () => {
    const schema = await build();
    const literal = await graphql({ schema, source: '{ things(where: { id: { eq: "nope" } }) { id } }' });
    expect(literal.errors?.[0]?.extensions?.code).toBe('DRIZZLE_INVALID_INPUT_VALUE');

    const variable = await graphql({
      schema,
      source: 'query ($id: UUID!) { things(where: { id: { eq: $id } }) { id } }',
      variableValues: { id: 'nope' },
    });
    expect(variable.errors?.[0]?.extensions?.code).toBe('DRIZZLE_INVALID_INPUT_VALUE');
  });

  it("maps an override naming graphql-scalars' instance to the library's", async () => {
    const schema = await build({ scalars: { Things: { name: GraphQLScalarsUUID } } });
    expect(schema.getType('UUID')).toBe(GraphQLUUID);
  });
});
