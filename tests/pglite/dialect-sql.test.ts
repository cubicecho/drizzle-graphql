// PostgreSQL reads that used to be offered by the schema and then fail in the database: `=` on
// a `json` column, ordering by JSON, `having` with a fractional operand, and `min` / `max` over
// types PostgreSQL has no such aggregate for.
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { bit, integer, json, jsonb, macaddr, macaddr8, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLEnumType, type GraphQLInputObjectType, type GraphQLObjectType, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Docs = pgTable('docs', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id'),
  plain: json('plain'),
  binary: jsonb('binary'),
});
const Owners = pgTable('owners', { id: integer('id').primaryKey(), name: text('name') });
const Posts = pgTable('posts', { id: integer('id').primaryKey(), category: text('category'), views: integer('views') });
const Devices = pgTable('devices', {
  id: integer('id').primaryKey(),
  u: uuid('u'),
  m: macaddr('m'),
  m8: macaddr8('m8'),
  bt: bit('bt', { dimensions: 3 }),
});

const tables = { Docs, Owners, Posts, Devices };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Docs: { owner: r.one.Owners({ from: r.Docs.ownerId, to: r.Owners.id }) },
  Owners: { docs: r.many.Docs({ from: r.Owners.id, to: r.Docs.ownerId }) },
});

let client: PGlite;
let db: any;
let schema: ReturnType<typeof buildSchema>['schema'];

const run = async (source: string) => {
  const res = await graphql({ schema, source, contextValue: {} });
  expect(res.errors?.map((e) => e.message)).toBeUndefined();
  return res.data as any;
};
const docIds = async (where: string) =>
  (await run(`{ docs(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`)).docs.map(
    (row: any) => row.id,
  );

beforeAll(async () => {
  client = new PGlite();
  db = (drizzle as any)({ client, relations });
  await db.execute(sql`CREATE TABLE owners (id integer PRIMARY KEY, name text)`);
  await db.execute(sql`CREATE TABLE docs (id integer PRIMARY KEY, owner_id integer, plain json, "binary" jsonb)`);
  await db.execute(sql`CREATE TABLE posts (id integer PRIMARY KEY, category text, views integer)`);
  await db.execute(sql`CREATE TABLE devices (id integer PRIMARY KEY, u uuid, m macaddr, m8 macaddr8, bt bit(3))`);

  await db.insert(Owners).values([{ id: 1, name: 'o' }]);
  await db.insert(Docs).values([
    { id: 1, ownerId: 1, plain: { a: 1, b: [1, 2] }, binary: { a: 1, b: [1, 2] } },
    { id: 2, ownerId: 1, plain: [1, 2], binary: [1, 2] },
    { id: 3, ownerId: null, plain: null, binary: null },
  ]);
  await db.insert(Posts).values([
    { id: 1, category: 'x', views: 1 },
    { id: 2, category: 'x', views: 2 },
    { id: 3, category: 'y', views: 3 },
  ]);
  await db.execute(sql`INSERT INTO devices VALUES
    (1, '11111111-1111-4111-8111-111111111111', '08:00:2b:01:02:03', '08:00:2b:01:02:03:04:05', B'101'),
    (2, '11111111-1111-4111-8111-111111111111', '08:00:2b:01:02:04', '08:00:2b:01:02:03:04:06', B'110')`);

  schema = buildSchema(db).schema;
});
afterAll(async () => client.close());

describe('pg: whole-document JSON eq / ne', () => {
  for (const column of ['plain', 'binary']) {
    it(`compares documents on a ${column === 'plain' ? 'json' : 'jsonb'} column`, async () => {
      expect(await docIds(`{ ${column}: { eq: { b: [1, 2], a: 1 } } }`)).toEqual([1]);
      expect(await docIds(`{ ${column}: { eq: [1, 2] } }`)).toEqual([2]);
      expect(await docIds(`{ ${column}: { ne: [1, 2] } }`)).toEqual([1]);
    });
  }
});

describe('pg: JSON columns have no ordering', () => {
  const inputFields = (name: string) => Object.keys((schema.getType(name) as GraphQLInputObjectType).getFields());
  const enumValues = (name: string) => (schema.getType(name) as GraphQLEnumType).getValues().map((v) => v.name);

  it('leaves json and jsonb out of orderBy, including a relation orderBy', () => {
    expect(inputFields('DocsOrderBy')).toEqual(['id', 'ownerId', 'owner']);
    const ownerOrder = (schema.getType('DocsOrderBy') as GraphQLInputObjectType).getFields()['owner']!.type;
    expect(String(ownerOrder)).toBe('OwnersOrderBy');
  });

  it('leaves json and jsonb out of distinct', () => {
    expect(enumValues('DocsDistinctColumn')).toEqual(['id', 'ownerId']);
  });

  it('rejects an orderBy on a JSON column as a validation error', async () => {
    const res = await graphql({
      schema,
      source: '{ docs(orderBy: { plain: { direction: asc, priority: 1 } }) { id } }',
      contextValue: {},
    });
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects a default ordering on a JSON column at build time', () => {
    expect(() => buildSchema(db, { defaults: { Docs: { orderBy: { binary: 'desc' } } } } as any)).toThrow(
      /has no meaningful ordering/,
    );
  });
});

describe('pg: having with a non-integer operand', () => {
  const groups = async (having: string) =>
    (await run(`{ postsGroupBy(groupBy: [category], having: ${having}) { group { category } } }`)).postsGroupBy
      .map((row: any) => row.group.category)
      .sort();

  it('compares count, sum, min, max, countNonNull and countDistinct numerically', async () => {
    expect(await groups('{ count: { gt: 1.5 } }')).toEqual(['x']);
    expect(await groups('{ sum: { views: { gt: 2.5 } } }')).toEqual(['x', 'y']);
    expect(await groups('{ min: { views: { lt: 1.5 } } }')).toEqual(['x']);
    expect(await groups('{ max: { views: { lt: 2.5 } } }')).toEqual(['x']);
    expect(await groups('{ countNonNull: { views: { gte: 1.5 } } }')).toEqual(['x']);
    expect(await groups('{ countDistinct: { views: { gt: 1.5 } } }')).toEqual(['x']);
    expect(await groups('{ avg: { views: { eq: 1.5 } } }')).toEqual(['x']);
  });
});

describe('pg: min / max over types without those aggregates', () => {
  const objectFields = (name: string) => Object.keys((schema.getType(name) as GraphQLObjectType).getFields());
  const enumValues = (name: string) => (schema.getType(name) as GraphQLEnumType).getValues().map((v) => v.name);

  it('leaves uuid, macaddr, macaddr8 and bit out of min / max', () => {
    expect(objectFields('DevicesMinAggregate')).toEqual(['id']);
    expect(objectFields('DevicesMaxAggregate')).toEqual(['id']);
  });

  it('still counts their distinct values and groups by them', async () => {
    expect(objectFields('DevicesCountDistinctAggregate')).toEqual(['id', 'u', 'm', 'm8', 'bt']);
    expect(enumValues('DevicesGroupByColumn')).toEqual(['id', 'u', 'm', 'm8', 'bt']);
    const data = await run('{ devicesAggregate { countDistinct { u m m8 bt } } }');
    expect(data.devicesAggregate.countDistinct).toEqual({ u: 1, m: 2, m8: 2, bt: 2 });
    const grouped = await run('{ devicesGroupBy(groupBy: [u]) { count } }');
    expect(grouped.devicesGroupBy).toEqual([{ count: 2 }]);
  });
});
