import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { pgTable, serial, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { unknownInputField } from '../util/validation-messages';

// ── Schema mixing id-named columns of different data types ────────────────────
// The filter a column gets must follow its data type, never its name: a
// human-meaningful text key (ULID/slug/SKU) keeps the string operators even when
// it is called `id`/`somethingId`, while a uuid column keeps the lean IdFilter.
const Owners = pgTable('owners', {
  id: text('id').primaryKey(), // ULID-style text primary key named `id`
  name: text('name'),
});
const Assets = pgTable('assets', {
  id: serial('id').primaryKey(), // plain integer id
  someId: text('some_id'), // human-meaningful text key
  userId: text('user_id'), // text foreign key to Owners.id
  externalId: uuid('external_id'), // opaque uuid key
});
const r = createRelationsHelper({ Owners, Assets });
const relations = buildRelations(
  { Owners, Assets },
  {
    Owners: { assets: r.many.Assets({ from: r.Owners.id, to: r.Assets.userId }) },
    Assets: { owner: r.one.Owners({ from: r.Assets.userId, to: r.Owners.id }) },
  },
);
const schema = { Owners, Assets, relations };

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const filterFieldsFor = (tableTypeName: string, columnName: string) => {
  const tableFilters = gqlSchema.getType(`${tableTypeName}Filters`) as GraphQLInputObjectType;
  const columnFilter = tableFilters.getFields()[columnName]!.type as GraphQLInputObjectType;
  return { name: columnFilter.name, fields: Object.keys(columnFilter.getFields()) };
};

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "owners" ("id" text PRIMARY KEY NOT NULL, "name" text);`);
  await db.execute(
    sql`CREATE TABLE "assets" ("id" serial PRIMARY KEY NOT NULL, "some_id" text, "user_id" text, "external_id" uuid);`,
  );

  await db.insert(Owners).values([
    { id: 'usr_alpha', name: 'Alpha' },
    { id: 'usr_beta', name: 'Beta' },
    { id: 'acc_gamma', name: 'Gamma' },
  ]);
  await db.insert(Assets).values([
    { id: 1, someId: 'SKU-RED-001', userId: 'usr_alpha', externalId: '6f0b2b0a-9df1-4c6f-8b64-2f8f4d2f0a11' },
    { id: 2, someId: 'SKU-BLUE-002', userId: 'usr_beta', externalId: '0e6f4a7c-1f2d-4b3a-9c8e-5d6f7a8b9c0d' },
    { id: 3, someId: 'ULID01HZX', userId: 'acc_gamma', externalId: null },
  ]);

  gqlSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe.sequential('filter selection by column type', () => {
  it('gives a text column named userId/someId the String filter with string operators', () => {
    for (const columnName of ['userId', 'someId']) {
      const { name, fields } = filterFieldsFor('Assets', columnName);
      expect(name).toBe('StringFilter');
      expect(fields).toEqual(expect.arrayContaining(['like', 'notLike', 'ilike', 'notIlike']));
    }
  });

  it('gives a text column literally named id the String filter with string operators', () => {
    const { name, fields } = filterFieldsFor('Owners', 'id');
    expect(name).toBe('StringFilter');
    expect(fields).toEqual(expect.arrayContaining(['like', 'notLike', 'ilike', 'notIlike']));
  });

  it('keeps the lean IdFilter for a uuid-typed column', () => {
    const { name, fields } = filterFieldsFor('Assets', 'externalId');
    expect(name).toBe('IdFilter');
    expect(fields).not.toEqual(expect.arrayContaining(['like']));
    expect(fields).not.toEqual(expect.arrayContaining(['ilike']));
    expect(fields).toEqual(expect.arrayContaining(['eq', 'ne', 'inArray', 'isNull', 'isNotNull']));
  });

  it('gives an integer id column an Int filter without string operators', () => {
    const { name, fields } = filterFieldsFor('Assets', 'id');
    expect(name).toBe('IntFilter');
    expect(fields).not.toEqual(expect.arrayContaining(['like']));
    expect(fields).not.toEqual(expect.arrayContaining(['ilike']));
    expect(fields).toEqual(expect.arrayContaining(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']));
  });

  it('filters a text userId column with like at runtime', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ assets(where: { userId: { like: "usr_%" } }, orderBy: { id: { direction: asc, priority: 1 } }) { id userId } }`,
      contextValue: {},
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as any).assets).toEqual([
      { id: 1, userId: 'usr_alpha' },
      { id: 2, userId: 'usr_beta' },
    ]);
  });

  it('filters a text someId column with ilike at runtime', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ assets(where: { someId: { ilike: "sku-%" } }, orderBy: { id: { direction: asc, priority: 1 } }) { id someId } }`,
      contextValue: {},
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as any).assets).toEqual([
      { id: 1, someId: 'SKU-RED-001' },
      { id: 2, someId: 'SKU-BLUE-002' },
    ]);
  });

  it('filters a text primary key named id with like at runtime', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ owners(where: { id: { like: "usr_%" } }, orderBy: { id: { direction: asc, priority: 1 } }) { id name } }`,
      contextValue: {},
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as any).owners).toEqual([
      { id: 'usr_alpha', name: 'Alpha' },
      { id: 'usr_beta', name: 'Beta' },
    ]);
  });

  it('still filters a uuid column by equality at runtime', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ assets(where: { externalId: { eq: "6f0b2b0a-9df1-4c6f-8b64-2f8f4d2f0a11" } }) { id } }`,
      contextValue: {},
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as any).assets).toEqual([{ id: 1 }]);
  });

  it('rejects like on a uuid column as a validation error', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ assets(where: { externalId: { like: "6f%" } }) { id } }`,
      contextValue: {},
    });

    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toMatch(unknownInputField('like'));
  });

  it('still filters an integer id column by equality and range at runtime', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ assets(where: { id: { gte: 2 } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
      contextValue: {},
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as any).assets).toEqual([{ id: 2 }, { id: 3 }]);
  });
});
