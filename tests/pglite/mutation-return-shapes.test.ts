import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, type SchemaFeatures } from '@/index';

const Items = pgTable('items', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty'),
});

const relations = buildRelations({ Items }, { Items: {} });
const schema = { Items, relations };

const DATA_DIR = `./tests/.temp/pgdata-mutation-shapes-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const build = (features?: SchemaFeatures, extra?: Record<string, any>) =>
  buildSchema(db, { ...(features ? { features } : {}), ...extra }).schema;

const mutationFields = (gql: GraphQLSchema) => gql.getMutationType()!.getFields();

const run = (source: string, variableValues?: Record<string, any>, target: GraphQLSchema = gqlSchema) =>
  graphql({ schema: target, source, variableValues, contextValue: {} });

const items = () => db.select().from(Items).orderBy(Items.id);

beforeAll(async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(DATA_DIR, { recursive: true });
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "items" (
		"id" integer PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"qty" integer
	);`);

  gqlSchema = build({ countMutations: true });
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM "items"`);
  await db.insert(Items).values([
    { id: 1, name: 'a', qty: 10 },
    { id: 2, name: 'b', qty: 20 },
    { id: 3, name: 'c', qty: 30 },
  ]);
});

describe('single insert nullability', () => {
  it('is non-null, because an insert either returns its row or throws', () => {
    expect(String(mutationFields(build())['createItemsSingle']!.type)).toBe('Items!');
  });

  it('is nullable under conflictDoNothing, the one setting that can swallow the insert', () => {
    expect(String(mutationFields(build(undefined, { conflictDoNothing: true }))['createItemsSingle']!.type)).toBe(
      'Items',
    );
  });

  it('returns the inserted row rather than null', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        createItemsSingle(values: { id: 9, name: "z" }) {
          id
        }
      }
    `);

    expect(res.errors?.[0]?.message).toBeUndefined();
  });
});

describe('updateMany return shape', () => {
  it('documents why its element is nullable where every sibling mutation is not', () => {
    const description = mutationFields(build())['updateItemsMany']!.description;

    expect(String(mutationFields(build())['updateItemsMany']!.type)).toBe('[Items]!');
    expect(description).toContain('entry order');
    expect(description).toContain('matched no rows');
  });
});

describe('countMutations: schema shape', () => {
  it('is off by default', () => {
    expect(mutationFields(build())['updateItemsCount']).toBeUndefined();
    expect(mutationFields(build())['deleteItemsCount']).toBeUndefined();
  });

  it('generates Int!-returning update and delete counters when on', () => {
    const fields = mutationFields(gqlSchema);

    expect(String(fields['updateItemsCount']!.type)).toBe('Int!');
    expect(String(fields['deleteItemsCount']!.type)).toBe('Int!');
    expect(fields['updateItemsCount']!.args.map((a) => `${a.name}: ${a.type}`)).toEqual([
      'set: UpdateItemsInput!',
      'where: ItemsFilters',
    ]);
    expect(fields['deleteItemsCount']!.args.map((a) => `${a.name}: ${a.type}`)).toEqual(['where: ItemsFilters']);
  });

  it('follows the feature switch of the write it mirrors', () => {
    const noUpdate = mutationFields(build({ countMutations: true, update: false }));
    expect(noUpdate['updateItemsCount']).toBeUndefined();
    expect(noUpdate['deleteItemsCount']).toBeDefined();

    const noDelete = mutationFields(build({ countMutations: true, delete: false }));
    expect(noDelete['updateItemsCount']).toBeDefined();
    expect(noDelete['deleteItemsCount']).toBeUndefined();
  });

  it('requires a where when requireWhere is on', () => {
    const fields = mutationFields(build({ countMutations: true, requireWhere: true }));

    expect(fields['updateItemsCount']!.args.find((a) => a.name === 'where')!.type.toString()).toBe('ItemsFilters!');
    expect(fields['deleteItemsCount']!.args.find((a) => a.name === 'where')!.type.toString()).toBe('ItemsFilters!');
  });

  it('does not add an output type — Int is already in the schema', () => {
    expect((gqlSchema.getType('Items') as GraphQLObjectType).name).toBe('Items');
    expect(gqlSchema.getType('ItemsCount')).toBeUndefined();
  });
});

describe('countMutations: behaviour', () => {
  it('counts the rows an unfiltered update touched without returning them', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        updateItemsCount(set: { name: "renamed" })
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateItemsCount: 3 });
    expect((await items()).map((r: any) => r.name)).toEqual(['renamed', 'renamed', 'renamed']);
  });

  it('counts only the rows the where matched', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        updateItemsCount(set: { name: "x" }, where: { qty: { gt: 15 } })
      }
    `);

    expect(res.data).toEqual({ updateItemsCount: 2 });
    expect((await items()).map((r: any) => r.name)).toEqual(['a', 'x', 'x']);
  });

  it('reports zero when nothing matched, rather than erroring', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        updateItemsCount(set: { name: "x" }, where: { id: { eq: 99 } })
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateItemsCount: 0 });
  });

  it('counts deleted rows and leaves the rest in place', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        deleteItemsCount(where: { id: { lt: 3 } })
      }
    `);

    expect(res.data).toEqual({ deleteItemsCount: 2 });
    expect((await items()).map((r: any) => r.id)).toEqual([3]);
  });

  it('deletes every row when given no where', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        deleteItemsCount
      }
    `);

    expect(res.data).toEqual({ deleteItemsCount: 3 });
    expect(await items()).toEqual([]);
  });

  it('refuses an update with nothing to set', async () => {
    const res = await run(/* GraphQL */ `
      mutation {
        updateItemsCount(set: {})
      }
    `);

    expect(res.errors?.[0]?.message).toBe('Unable to update with no values specified!');
  });

  it('rejects a missing where under requireWhere before touching a row', async () => {
    const strict = build({ countMutations: true, requireWhere: true });
    const res = await run(
      /* GraphQL */ `
        mutation {
          deleteItemsCount(where: {})
        }
      `,
      undefined,
      strict,
    );

    expect(res.errors?.[0]?.message).toContain("requires a 'where' argument");
    expect((await items()).length).toBe(3);
  });

  it('applies field update operations, like the write it mirrors', async () => {
    const withOps = build({ countMutations: true, fieldUpdateOperations: true });
    const res = await run(
      /* GraphQL */ `
        mutation {
          updateItemsCount(set: { qty: { increment: 5 } })
        }
      `,
      undefined,
      withOps,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateItemsCount: 3 });
    expect((await items()).map((r: any) => r.qty)).toEqual([15, 25, 35]);
  });
});
