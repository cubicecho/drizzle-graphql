// Regression tests for string-array columns (GitHub issue #15).
// Under drizzle-orm 1.x a text().array() column keeps dataType 'string' and sets
// `dimensions`, so the type converter must not degrade it to a plain String — and
// the generic filter for it must be String-typed, distinct from Int/Float arrays.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { doublePrecision, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Docs = pgTable('docs', {
  id: serial('id').primaryKey(),
  tags: text('tags').array(),
  counts: integer('counts').array(),
  scores: doublePrecision('scores').array(),
});
const relations = buildRelations({ Docs }, {});
const schema = { Docs, relations };

const DATA_DIR = `./tests/.temp/pgdata-string-array-${Date.now()}`;

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const fieldTypeName = (typeName: string, fieldName: string) =>
  String((entities.types[typeName] as GraphQLObjectType).getFields()[fieldName]!.type);

const filterFieldType = (fieldName: string) =>
  (entities.inputs['DocsFilters'] as GraphQLInputObjectType).getFields()[fieldName]!.type as GraphQLInputObjectType;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "docs" (
      "id" serial PRIMARY KEY NOT NULL,
      "tags" text[],
      "counts" integer[],
      "scores" double precision[]
    );`,
  );

  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe.sequential('string-array schema shape', () => {
  it('types a text().array() column as [String!] on the object type', () => {
    expect(fieldTypeName('Docs', 'tags')).toBe('[String!]');
  });

  it('keeps numeric array columns typed as [Int!] / [Float!]', () => {
    expect(fieldTypeName('Docs', 'counts')).toBe('[Int!]');
    expect(fieldTypeName('Docs', 'scores')).toBe('[Float!]');
  });

  it('types the column as [String!] on the create and update inputs', () => {
    const createFields = (entities.inputs['CreateDocsInput'] as GraphQLInputObjectType).getFields();
    expect(String(createFields['tags']!.type)).toBe('[String!]');

    const updateFields = (entities.inputs['UpdateDocsInput'] as GraphQLInputObjectType).getFields();
    expect(String(updateFields['tags']!.type)).toBe('[String!]');
  });
});

describe.sequential('array filter types', () => {
  it('gives string-array columns a String-typed StringArrayFilter', () => {
    const filter = filterFieldType('tags');
    expect(filter.name).toBe('StringArrayFilter');

    const fields = filter.getFields();
    expect(String(fields['eq']!.type)).toBe('[String!]');
    expect(String(fields['ne']!.type)).toBe('[String!]');
    expect(String(fields['inArray']!.type)).toBe('[[String!]!]');
    expect(String(fields['notInArray']!.type)).toBe('[[String!]!]');
  });

  it('keeps int and float array filters distinct from the string-array filter', () => {
    const countsFilter = filterFieldType('counts');
    const scoresFilter = filterFieldType('scores');
    const tagsFilter = filterFieldType('tags');

    expect(countsFilter.name).toBe('IntArrayFilter');
    expect(String(countsFilter.getFields()['eq']!.type)).toBe('[Int!]');
    expect(String(countsFilter.getFields()['inArray']!.type)).toBe('[[Int!]!]');

    expect(scoresFilter.name).toBe('FloatArrayFilter');
    expect(String(scoresFilter.getFields()['eq']!.type)).toBe('[Float!]');

    expect(tagsFilter).not.toBe(scoresFilter);
    expect(tagsFilter).not.toBe(countsFilter);
    expect(countsFilter).not.toBe(scoresFilter);
  });
});

describe.sequential('string-array round-trips', () => {
  it('stores and returns an array of strings', async () => {
    const insert = await run(`mutation {
      createDocsSingle(values: { tags: ["alpha", "beta"], counts: [1, 2], scores: [1.5, 2.5] }) {
        id
        tags
        counts
        scores
      }
    }`);
    expect(insert.errors).toBeUndefined();
    expect((insert.data as any).createDocsSingle).toEqual({
      id: 1,
      tags: ['alpha', 'beta'],
      counts: [1, 2],
      scores: [1.5, 2.5],
    });

    const read = await run(`{ docsSingle(where: { id: { eq: 1 } }) { tags } }`);
    expect(read.errors).toBeUndefined();
    expect((read.data as any).docsSingle.tags).toEqual(['alpha', 'beta']);
  });

  it('accepts a string array passed as a variable', async () => {
    const res = await run(`mutation ($v: CreateDocsInput!) { createDocsSingle(values: $v) { tags } }`, {
      v: { tags: ['from', 'variable'] },
    });
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createDocsSingle.tags).toEqual(['from', 'variable']);
  });

  it('updates a string-array column', async () => {
    const res = await run(`mutation {
      updateDocs(where: { id: { eq: 1 } }, set: { tags: ["updated"] }) { id tags }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).updateDocs).toEqual([{ id: 1, tags: ['updated'] }]);
  });

  it('rejects a non-string element', async () => {
    const res = await run(`mutation { createDocsSingle(values: { tags: [true] }) { tags } }`);
    expect(res.errors?.[0]?.message).toMatch(/String cannot represent a non string value/);
  });
});

describe.sequential('string-array filter execution', () => {
  it('filters with eq on a string-array column', async () => {
    const seed = await run(`mutation {
      createDocs(values: [{ tags: ["x", "y"] }, { tags: ["z"] }]) { id }
    }`);
    expect(seed.errors).toBeUndefined();

    const res = await run(`{ docs(where: { tags: { eq: ["x", "y"] } }) { tags } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).docs).toEqual([{ tags: ['x', 'y'] }]);
  });

  it('filters with inArray on a string-array column', async () => {
    const res = await run(`{ docs(where: { tags: { inArray: [["z"], ["nope"]] } }) { tags } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).docs).toEqual([{ tags: ['z'] }]);
  });

  it('rejects a Float value where a string-array filter expects strings', async () => {
    const res = await run(`{ docs(where: { tags: { eq: [1.5] } }) { tags } }`);
    expect(res.errors?.[0]?.message).toMatch(/String cannot represent a non string value/);
  });
});
