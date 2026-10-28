import { createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { GraphQLScalarType, type GraphQLSchema, graphql, printSchema } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Each `buildSchema` call owns its registries — scalar overrides, enum naming, column
// exclusions, field-update kinds and the aggregate caches — so a schema built earlier keeps
// behaving by its own config after a later build over the same table objects with a
// conflicting one. Request-time remapping used to read whichever build ran last (#234).

const Owners = sqliteTable('owners', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
  bytes: blob('bytes', { mode: 'buffer' }),
  qty: integer('qty').notNull().default(0),
  status: text('status', { enum: ['in_stock', 'sold_out'] })
    .notNull()
    .default('in_stock'),
  secret: text('secret'),
  meta: blob('meta', { mode: 'json' }),
});

const r = createRelationsHelper({ Owners, Items });
const relations = buildRelations(
  { Owners, Items },
  {
    Owners: { items: r.many.Items({ from: r.Owners.id, to: r.Items.ownerId }) },
    Items: { owner: r.one.Owners({ from: r.Items.ownerId, to: r.Owners.id }) },
  },
);

/** Carries a timestamp as epoch milliseconds; says so when handed anything but a `Date`. */
const EpochMs = new GraphQLScalarType({
  name: 'EpochMs',
  serialize: (value) => (value instanceof Date ? value.getTime() : `not a Date: ${typeof value}`),
  parseValue: (value) => new Date(value as number),
});

/** Hands the driver whatever the client sent, untouched. */
const Passthrough = new GraphQLScalarType({
  name: 'Passthrough',
  serialize: (value) => value,
  parseValue: (value) => value,
});

const client = createClient({ url: ':memory:' });
const db = (drizzle as any)({ client, relations });

const run = async (schema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema, source, contextValue: {} });
  return { data: result.data as any, errors: result.errors?.map((error) => error.message) };
};

let first: GraphQLSchema;
let second: GraphQLSchema;
let firstSdl: string;

beforeAll(async () => {
  await client.executeMultiple(`
    CREATE TABLE owners (id integer primary key, name text not null);
    CREATE TABLE items (
      id integer primary key, owner_id integer not null, name text not null, created_at integer,
      bytes blob, qty integer not null default 0, status text not null default 'in_stock',
      secret text, meta blob
    );
    INSERT INTO owners (id, name) VALUES (1, 'ann');
    INSERT INTO items (id, owner_id, name, created_at, qty, status, secret, meta)
      VALUES (1, 1, 'kettle', 1700000000000, 3, 'sold_out', 'hidden', NULL);
  `);

  first = buildSchema(db, {
    scalars: { Items: { createdAt: EpochMs } },
    exclude: { columns: { Items: ['secret'] } },
    enumValueNameMapper: 'constant',
    features: { fieldUpdateOperations: true },
  } as any).schema;
  firstSdl = printSchema(first);

  // Over the same table objects, every one of those decisions the other way round.
  second = buildSchema(db, {
    scalars: { Items: { qty: Passthrough, bytes: Passthrough } },
    enumNameMapper: ({ tableName, columnName }: { tableName: string; columnName: string }) =>
      `${tableName}${columnName}Choice`,
  } as any).schema;
});

describe.sequential('two schemas built in one process', () => {
  it('the later build leaves the earlier schema as it was', () => {
    expect(printSchema(first)).toBe(firstSdl);
    expect(firstSdl).not.toContain('secret');
    expect(printSchema(second)).toContain('secret');
  });

  it("maps the earlier schema's output through its own scalar overrides", async () => {
    const { data, errors } = await run(first, '{ items { createdAt status } }');
    expect(errors).toEqual(undefined);
    expect(data.items).toEqual([{ createdAt: 1700000000000, status: 'SOLD_OUT' }]);

    // The later build has no override on the column: it gets the built-in DateTime.
    const later = await run(second, '{ items { createdAt status } }');
    expect(later.errors).toBeUndefined();
    expect(later.data.items).toEqual([{ createdAt: new Date(1700000000000), status: 'sold_out' }]);
  });

  it('filters the earlier schema by its own enum value names and overrides', async () => {
    const { data, errors } = await run(
      first,
      '{ items(where: { status: { eq: SOLD_OUT }, createdAt: { eq: 1700000000000 } }) { id } }',
    );
    expect(errors).toEqual(undefined);
    expect(data.items).toEqual([{ id: 1 }]);
  });

  it("writes through the earlier schema's own input mapping", async () => {
    // `bytes` is a plain `[Int!]` column on the earlier schema, so the bytes become a Buffer;
    // the later build passes the column's value through untouched.
    const { data, errors } = await run(
      first,
      'mutation { createItemsSingle(values: { id: 2, ownerId: 1, name: "mug", bytes: [1, 2, 3], createdAt: 1700000001000 }) { id bytes createdAt } }',
    );
    expect(errors).toEqual(undefined);
    expect(data.createItemsSingle).toEqual({ id: 2, bytes: [1, 2, 3], createdAt: 1700000001000 });
  });

  it("runs the earlier schema's atomic field updates", async () => {
    // Only the earlier build turned `fieldUpdateOperations` on, and only the later one gave
    // `qty` an override that owns its input.
    const { data, errors } = await run(
      first,
      'mutation { updateItems(where: { id: { eq: 1 } }, set: { qty: { increment: 2 } }) { id qty } }',
    );
    expect(errors).toEqual(undefined);
    expect(data.updateItems).toEqual([{ id: 1, qty: 5 }]);
  });

  it('reads a NULL JSON blob through a relation on both schemas', async () => {
    for (const schema of [first, second]) {
      const { data, errors } = await run(
        schema,
        '{ owners { items(orderBy: { id: { direction: asc, priority: 1 } }) { id meta } } }',
      );
      expect(errors).toEqual(undefined);
      expect(data.owners[0].items[0]).toEqual({ id: 1, meta: null });
    }
  });
});
