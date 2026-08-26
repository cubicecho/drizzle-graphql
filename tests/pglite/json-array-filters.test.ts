import { mkdir, rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── Schema covering json + int/text array columns ────────────────────────────
const Items = pgTable('items', {
  id: serial('id').primaryKey(),
  meta: jsonb('meta'),
  nums: integer('nums').array(),
  labels: text('labels').array(),
});
const relations = buildRelations({ Items }, {});
const schema = { Items, relations };

const DATA_DIR = `./tests/.temp/pgdata-json-array-filters-${Date.now()}`;

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const filterFieldNames = (typeName: string): string[] =>
  Object.keys((gqlSchema.getType(typeName) as GraphQLInputObjectType).getFields()).sort();

const filterFieldType = (typeName: string, fieldName: string): string =>
  String((gqlSchema.getType(typeName) as GraphQLInputObjectType).getFields()[fieldName]!.type);

const ids = async (where: string): Promise<number[]> => {
  const res = await run(`{ items(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`);
  expect(res.errors).toBeUndefined();
  return (res.data as any).items.map((row: any) => row.id);
};

beforeAll(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "items" (
      "id" serial PRIMARY KEY NOT NULL,
      "meta" jsonb,
      "nums" integer[],
      "labels" text[]
    );`,
  );

  await db.insert(Items).values([
    {
      id: 1,
      meta: { tags: ['a'], profile: { role: 'admin', level: 3 } },
      nums: [1, 2, 3],
      labels: ['red', 'blue'],
    },
    { id: 2, meta: { profile: { role: 'user' } }, nums: [3, 4, 5], labels: ['blue', 'green'] },
    { id: 3, meta: null, nums: [], labels: [] },
    { id: 4, meta: { plain: true }, nums: null, labels: null },
  ]);

  gqlSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('filter input shape', () => {
  it('gives json columns a JSONFilter with eq/ne/contains and no scalar string ops', () => {
    expect(filterFieldNames('JSONFilter')).toStrictEqual([
      'AND',
      'NOT',
      'OR',
      'contains',
      'eq',
      'isNotNull',
      'isNull',
      'ne',
    ]);
    expect(filterFieldType('JSONFilter', 'eq')).toBe('JSON');
    expect(filterFieldType('JSONFilter', 'contains')).toBe('JSON');
  });

  it('gives int array columns membership operators instead of scalar comparison operators', () => {
    expect(filterFieldNames('IntArrayFilter')).toStrictEqual([
      'AND',
      'NOT',
      'OR',
      'eq',
      'has',
      'hasEvery',
      'hasSome',
      'inArray',
      'isEmpty',
      'isNotNull',
      'isNull',
      'ne',
      'notInArray',
    ]);
    expect(filterFieldType('IntArrayFilter', 'eq')).toBe('[Int!]');
    expect(filterFieldType('IntArrayFilter', 'has')).toBe('Int');
    expect(filterFieldType('IntArrayFilter', 'hasSome')).toBe('[Int!]');
    expect(filterFieldType('IntArrayFilter', 'hasEvery')).toBe('[Int!]');
    expect(filterFieldType('IntArrayFilter', 'isEmpty')).toBe('Boolean');
  });

  it('keys array filters per element type — text arrays get their own StringArrayFilter', () => {
    expect(filterFieldType('StringArrayFilter', 'has')).toBe('String');
    expect(filterFieldType('StringArrayFilter', 'hasSome')).toBe('[String!]');

    const itemsFilters = (gqlSchema.getType('ItemsFilters') as GraphQLInputObjectType).getFields();
    expect(String(itemsFilters['nums']!.type)).toBe('IntArrayFilter');
    expect(String(itemsFilters['labels']!.type)).toBe('StringArrayFilter');
    expect(String(itemsFilters['meta']!.type)).toBe('JSONFilter');
  });

  it('rejects the removed type-confused operators on json and array columns', async () => {
    // `inArray` stays available on array columns — it is well-typed as `[[Element!]!]`
    // (whole-array IN) and covered by the string-array regression tests for issue #15.
    for (const where of ['{ meta: { like: "x" } }', '{ nums: { lt: [1] } }']) {
      const res = await run(`{ items(where: ${where}) { id } }`);
      expect(res.errors?.[0]?.message).toMatch(/is not defined by type/);
    }
  });
});

describe.sequential('JSON filters', () => {
  it('eq matches the whole document with jsonb semantics (key order does not matter)', async () => {
    await expect(ids(`{ meta: { eq: { profile: { level: 3, role: "admin" }, tags: ["a"] } } }`)).resolves.toStrictEqual(
      [1],
    );
  });

  it('eq does not match a partial document', async () => {
    await expect(ids(`{ meta: { eq: { profile: { role: "admin" } } } }`)).resolves.toStrictEqual([]);
  });

  it('contains matches nested containment', async () => {
    await expect(ids(`{ meta: { contains: { profile: { role: "admin" } } } }`)).resolves.toStrictEqual([1]);
    await expect(ids(`{ meta: { contains: { profile: {} } } }`)).resolves.toStrictEqual([1, 2]);
  });

  it('contains matches a top-level key/value pair', async () => {
    await expect(ids(`{ meta: { contains: { plain: true } } }`)).resolves.toStrictEqual([4]);
  });

  it('contains accepts the value through a variable', async () => {
    const res = await run(
      `query ($where: ItemsFilters) {
        items(where: $where, orderBy: { id: { direction: asc, priority: 1 } }) { id }
      }`,
      { where: { meta: { contains: { tags: ['a'] } } } },
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as any).items.map((row: any) => row.id)).toStrictEqual([1]);
  });

  it('isNull / isNotNull still work on json columns', async () => {
    await expect(ids(`{ meta: { isNull: true } }`)).resolves.toStrictEqual([3]);
    await expect(ids(`{ meta: { isNotNull: true } }`)).resolves.toStrictEqual([1, 2, 4]);
  });
});

describe.sequential('array filters', () => {
  it('has matches single-element membership on int and text arrays', async () => {
    await expect(ids(`{ nums: { has: 3 } }`)).resolves.toStrictEqual([1, 2]);
    await expect(ids(`{ nums: { has: 1 } }`)).resolves.toStrictEqual([1]);
    await expect(ids(`{ labels: { has: "blue" } }`)).resolves.toStrictEqual([1, 2]);
    await expect(ids(`{ labels: { has: "purple" } }`)).resolves.toStrictEqual([]);
  });

  it('hasSome matches overlap', async () => {
    await expect(ids(`{ nums: { hasSome: [1, 5] } }`)).resolves.toStrictEqual([1, 2]);
    await expect(ids(`{ labels: { hasSome: ["green", "purple"] } }`)).resolves.toStrictEqual([2]);
  });

  it('hasEvery matches containment of all elements', async () => {
    await expect(ids(`{ nums: { hasEvery: [1, 2] } }`)).resolves.toStrictEqual([1]);
    await expect(ids(`{ nums: { hasEvery: [3] } }`)).resolves.toStrictEqual([1, 2]);
    await expect(ids(`{ labels: { hasEvery: ["blue", "green"] } }`)).resolves.toStrictEqual([2]);
  });

  it('isEmpty matches empty (but not null) arrays', async () => {
    await expect(ids(`{ nums: { isEmpty: true } }`)).resolves.toStrictEqual([3]);
    await expect(ids(`{ labels: { isEmpty: true } }`)).resolves.toStrictEqual([3]);
  });

  it('eq still compares the whole array', async () => {
    await expect(ids(`{ nums: { eq: [1, 2, 3] } }`)).resolves.toStrictEqual([1]);
    await expect(ids(`{ nums: { eq: [3, 2, 1] } }`)).resolves.toStrictEqual([]);
  });

  it('isNull matches missing arrays', async () => {
    await expect(ids(`{ nums: { isNull: true } }`)).resolves.toStrictEqual([4]);
  });

  it('membership operators combine with other filters', async () => {
    await expect(ids(`{ nums: { has: 3 }, labels: { has: "green" } }`)).resolves.toStrictEqual([2]);
  });

  it('rejects hasSome / hasEvery with an empty list', async () => {
    for (const op of ['hasSome', 'hasEvery']) {
      const res = await run(`{ items(where: { nums: { ${op}: [] } }) { id } }`);
      expect(res.errors?.[0]?.message).toMatch(/empty array/);
    }
  });
});
