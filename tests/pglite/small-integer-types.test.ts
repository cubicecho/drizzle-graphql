import { PGlite } from '@electric-sql/pglite';
import { defineRelations, getColumns } from 'drizzle-orm';
import * as my from 'drizzle-orm/mysql-core';
import * as pg from 'drizzle-orm/pg-core';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import * as sq from 'drizzle-orm/sqlite-core';
import {
  GraphQLFloat,
  type GraphQLInputObjectType,
  GraphQLInt,
  type GraphQLSchema,
  getNullableType,
  graphql,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { drizzleColumnToGraphQLType } from '@/util/type-converter';

// Small integer kinds (smallint, tinyint, mediumint, smallserial, MySQL year) used to fall
// through to Float. Wider kinds keep their previous mapping.

const typeOf = (table: any, key: string) =>
  getNullableType(drizzleColumnToGraphQLType(getColumns(table)[key]!, key, 'T').type);

describe('integer column types', () => {
  const pgT = pg.pgTable('t', {
    integer: pg.integer(),
    smallint: pg.smallint(),
    serial: pg.serial(),
    smallserial: pg.smallserial(),
    real: pg.real(),
    double: pg.doublePrecision(),
    bigint53: pg.bigint({ mode: 'number' }),
  });
  const myT = my.mysqlTable('t', {
    int: my.int(),
    unsignedInt: my.int({ unsigned: true }),
    tinyint: my.tinyint(),
    unsignedTinyint: my.tinyint({ unsigned: true }),
    smallint: my.smallint(),
    mediumint: my.mediumint(),
    serial: my.serial(),
    year: my.year(),
    float: my.float(),
    double: my.double(),
    bigint53: my.bigint({ mode: 'number' }),
  });
  const sqT = sq.sqliteTable('t', { integer: sq.integer(), real: sq.real() });

  it.each(['integer', 'smallint', 'serial', 'smallserial'])('pg %s is Int', (key) => {
    expect(typeOf(pgT, key)).toBe(GraphQLInt);
  });
  it.each(['real', 'double', 'bigint53'])('pg %s stays Float', (key) => {
    expect(typeOf(pgT, key)).toBe(GraphQLFloat);
  });
  it.each(['int', 'unsignedInt', 'tinyint', 'unsignedTinyint', 'smallint', 'mediumint', 'serial', 'year'])(
    'mysql %s is Int',
    (key) => {
      expect(typeOf(myT, key)).toBe(GraphQLInt);
    },
  );
  it.each(['float', 'double', 'bigint53'])('mysql %s stays Float', (key) => {
    expect(typeOf(myT, key)).toBe(GraphQLFloat);
  });
  it('sqlite integer is Int, real stays Float', () => {
    expect(typeOf(sqT, 'integer')).toBe(GraphQLInt);
    expect(typeOf(sqT, 'real')).toBe(GraphQLFloat);
  });
});

describe.sequential('smallint through the generated schema (PGlite)', () => {
  const scores = pg.pgTable('scores', {
    id: pg.serial().primaryKey(),
    points: pg.smallint().notNull(),
  });
  let client: PGlite;
  let db: PgliteDatabase<any>;
  let schema: GraphQLSchema;

  beforeAll(async () => {
    client = new PGlite();
    await client.waitReady;
    db = drizzle({ client, relations: defineRelations({ scores }) });
    await client.exec('CREATE TABLE scores (id serial PRIMARY KEY, points smallint NOT NULL);');
    schema = buildSchema(db).schema;
  });

  afterAll(async () => {
    await client.close().catch(console.error);
  });

  it('types the filter as IntFilter and round-trips values', async () => {
    const filters = schema.getType('ScoresFilters') as GraphQLInputObjectType;
    expect((filters.getFields()['points']!.type as GraphQLInputObjectType).name).toBe('IntFilter');

    const created = await graphql({
      schema,
      source: 'mutation { createScores(values: [{ points: 7 }, { points: 30 }]) { points } }',
    });
    expect(created.errors).toBeUndefined();

    const read = await graphql({
      schema,
      source: '{ scores(where: { points: { gt: 10 } }) { points } }',
    });
    expect(read.errors).toBeUndefined();
    expect(read.data).toEqual({ scores: [{ points: 30 }] });
  });

  it('rejects a fractional value', async () => {
    const result = await graphql({
      schema,
      source: 'mutation { createScores(values: [{ points: 1.5 }]) { points } }',
    });
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});
