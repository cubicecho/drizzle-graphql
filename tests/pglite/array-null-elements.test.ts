// A Postgres array may hold NULL elements (`{1,NULL,3}`), at any depth. The output types used to
// declare them non-null (`[Int!]`), so reading such a value errored the field. Output elements
// are nullable now; inputs and filter operands keep `[T!]`.
import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { date, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Lists = pgTable('lists', {
  id: integer('id').primaryKey(),
  nums: integer('nums').array(),
  grid: integer('grid').array('[][]'),
  words: text('words').array(),
  days: date('days').array(),
});

const typeString = (schema: GraphQLSchema, typeName: string, field: string) =>
  String((schema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType).getFields()[field]!.type);

describe.sequential('pg array columns with NULL elements', () => {
  let pglite: PGlite;
  let schema: GraphQLSchema;

  const run = async (source: string) => {
    const res = await graphql({ schema, source, contextValue: {} });
    expect(res.errors?.map((e) => e.message)).toBeUndefined();
    return res.data as any;
  };

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.exec(`
      CREATE TABLE lists (id integer PRIMARY KEY, nums integer[], grid integer[][], words text[], days date[]);
      INSERT INTO lists VALUES
        (1, '{1,NULL,3}', '{{1,NULL},{3,4}}', '{a,NULL}', '{2026-01-02,NULL}'),
        (2, '{4,5}', NULL, '{b}', NULL);
    `);
    const db = (drizzle as any)({ client: pglite, relations: defineRelations({ Lists }) });
    schema = buildSchema(db).schema;
  });
  afterAll(async () => {
    await pglite.close();
  });

  it('declares nullable elements on output and non-null elements on input', () => {
    expect(typeString(schema, 'Lists', 'nums')).toBe('[Int]');
    expect(typeString(schema, 'Lists', 'grid')).toBe('[[Int]]');
    expect(typeString(schema, 'Lists', 'days')).toBe('[Date]');
    expect(typeString(schema, 'CreateListsInput', 'nums')).toBe('[Int!]');
    expect(typeString(schema, 'CreateListsInput', 'grid')).toBe('[[Int!]!]');
    expect(typeString(schema, 'UpdateListsInput', 'nums')).toBe('[Int!]');
    expect(typeString(schema, 'IntArrayFilter', 'hasSome')).toBe('[Int!]');
  });

  it('reads NULL elements at every depth', async () => {
    const data = await run('{ listsSingle(where: { id: { eq: 1 } }) { nums grid words days } }');
    expect(data.listsSingle).toEqual({
      nums: [1, null, 3],
      grid: [
        [1, null],
        [3, 4],
      ],
      words: ['a', null],
      days: ['2026-01-02', null],
    });
  });

  it('filters array columns holding NULL elements', async () => {
    const some = await run(
      '{ lists(where: { nums: { hasSome: [3, 5] } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }',
    );
    expect(some.lists).toEqual([{ id: 1 }, { id: 2 }]);
    const every = await run('{ lists(where: { nums: { hasEvery: [1, 3] } }) { id } }');
    expect(every.lists).toEqual([{ id: 1 }]);
    const eq = await run('{ lists(where: { nums: { eq: [4, 5] } }) { id } }');
    expect(eq.lists).toEqual([{ id: 2 }]);
  });
});
