// SQLite column values the generated schema has to carry intact:
// - `integer()` in number mode holds any 64-bit integer, so it is `Float` (exact to 2^53), not
//   `Int`, which cannot serialize anything past 2^31. Its boolean and timestamp modes keep their
//   own scalars.
// - `blob({ mode: 'buffer' })` is a list of bytes, like Postgres `bytea`, and round-trips.
// - a blob holding 0 is told apart from a NULL one, top-level and inside a nested relation,
//   where drizzle reads blobs back through `hex()`.
import { type Client, createClient } from '@libsql/client';
import { defineRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Owners = sqliteTable('owners', {
  id: integer('id').primaryKey(),
  name: text('name'),
});

const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  ownerId: integer('owner_id'),
  n: integer('n'),
  flag: integer('flag', { mode: 'boolean' }),
  at: integer('at', { mode: 'timestamp' }),
  big: blob('big', { mode: 'bigint' }),
  raw: blob('raw', { mode: 'buffer' }),
  doc: blob('doc', { mode: 'json' }),
});

const relations = defineRelations({ Owners, Items }, (r) => ({
  Owners: { items: r.many.Items({ from: r.Owners.id, to: r.Items.ownerId }) },
  Items: { owner: r.one.Owners({ from: r.Items.ownerId, to: r.Owners.id }) },
}));

const BIG = 5_000_000_000;

let client: Client;
let db: any;
let schema: GraphQLSchema;
let entities: any;

const run = async (source: string, variableValues?: Record<string, any>) =>
  JSON.parse(JSON.stringify(await graphql({ schema, source, contextValue: {}, variableValues })));

const fieldType = (typeName: string, fieldName: string) =>
  String((entities.types[typeName] as GraphQLObjectType).getFields()[fieldName]!.type);
const inputFieldType = (inputName: string, fieldName: string) =>
  String((entities.inputs[inputName] as GraphQLInputObjectType).getFields()[fieldName]!.type);

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE owners (id integer primary key, name text)`);
  await db.run(
    sql`CREATE TABLE items (id integer primary key, owner_id integer, n integer, flag integer, at integer, big blob, raw blob, doc blob)`,
  );
  const built = buildSchema(db);
  schema = built.schema;
  entities = built.entities;
});
afterAll(() => client.close());

describe.sequential('sqlite integer columns', () => {
  it('type number mode as Float everywhere, and leave boolean and timestamp modes alone', () => {
    expect(fieldType('Items', 'id')).toBe('Float!');
    expect(fieldType('Items', 'n')).toBe('Float');
    expect(fieldType('Items', 'flag')).toBe('Boolean');
    expect(fieldType('Items', 'at')).toBe('DateTime');
    expect(inputFieldType('CreateItemsInput', 'n')).toBe('Float');
    expect(inputFieldType('ItemsFilters', 'n')).toBe('FloatFilter');
    expect(inputFieldType('ItemsFilters', 'flag')).toBe('BooleanFilter');
  });

  it('write, read and filter values past 2^31', async () => {
    await run(`mutation { createOwnersSingle(values: { id: ${BIG}, name: "o" }) { id } }`);
    const created = await run(
      `mutation { createItemsSingle(values: { id: ${BIG}, ownerId: ${BIG}, n: 3000000000 }) { id ownerId n } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data.createItemsSingle).toEqual({ id: BIG, ownerId: BIG, n: 3_000_000_000 });

    const read = await run(`{
      gt: items(where: { id: { gt: 4000000000 } }) { id n owner { id } }
      byId: itemsSingle(where: { id: { eq: ${BIG} } }) { n }
      owners(where: { id: { eq: ${BIG} } }) { items { id } }
    }`);
    expect(read.errors).toBeUndefined();
    expect(read.data).toEqual({
      gt: [{ id: BIG, n: 3_000_000_000, owner: { id: BIG } }],
      byId: { n: 3_000_000_000 },
      owners: [{ items: [{ id: BIG }] }],
    });
  });

  it('page through them with a cursor', async () => {
    await run(`mutation { createItemsSingle(values: { id: ${BIG + 1}, n: 1 }) { id } }`);
    const first = await run(
      '{ items(where: { id: { gt: 4000000000 } }, orderBy: { id: { direction: asc, priority: 1 } }, limit: 1) { id cursor } }',
    );
    expect(first.errors).toBeUndefined();
    expect(first.data.items.map((row: any) => row.id)).toEqual([BIG]);

    const next = await run(
      'query($after: String) { items(where: { id: { gt: 4000000000 } }, orderBy: { id: { direction: asc, priority: 1 } }, limit: 1, after: $after) { id } }',
      { after: first.data.items[0].cursor },
    );
    expect(next.errors).toBeUndefined();
    expect(next.data.items).toEqual([{ id: BIG + 1 }]);
    await run(`mutation { deleteItems(where: { id: { eq: ${BIG + 1} } }) { id } }`);
  });

  it('aggregate them without overflowing', async () => {
    const agg = await run('{ itemsAggregate { max { n id } sum { n } } }');
    expect(agg.errors).toBeUndefined();
    expect(agg.data.itemsAggregate.max).toEqual({ n: 3_000_000_000, id: BIG });
    expect(agg.data.itemsAggregate.sum).toEqual({ n: 3_000_000_000 });
  });
});

describe.sequential('sqlite blob columns', () => {
  it('type a buffer blob as a list of bytes', () => {
    expect(fieldType('Items', 'raw')).toBe('[Int!]');
    expect(inputFieldType('CreateItemsInput', 'raw')).toBe('[Int!]');
  });

  it('round-trip a buffer blob through create, read and update', async () => {
    const created = await run('mutation { createItemsSingle(values: { id: 1, raw: [1, 2, 255] }) { raw } }');
    expect(created.errors).toBeUndefined();
    expect(created.data.createItemsSingle.raw).toEqual([1, 2, 255]);

    const read = await run('{ itemsSingle(where: { id: { eq: 1 } }) { raw } }');
    const updated = await run(
      'mutation($raw: [Int!]) { updateItems(where: { id: { eq: 1 } }, set: { raw: $raw }) { raw } }',
      { raw: read.data.itemsSingle.raw },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updateItems).toEqual([{ raw: [1, 2, 255] }]);
  });

  it('tell a bigint blob holding 0 apart from a NULL one, top-level and nested', async () => {
    await run('mutation { createOwnersSingle(values: { id: 1, name: "p" }) { id } }');
    await run('mutation { createItemsSingle(values: { id: 10, ownerId: 1, big: "0" }) { id } }');
    await run('mutation { createItemsSingle(values: { id: 11, ownerId: 1 }) { id } }');

    const res = await run(`{
      items(where: { ownerId: { eq: 1 } }, orderBy: { id: { direction: asc, priority: 1 } }) { id big raw doc }
      ownersSingle(where: { id: { eq: 1 } }) { items(orderBy: { id: { direction: asc, priority: 1 } }) { id big raw doc } }
    }`);
    expect(res.errors).toBeUndefined();
    const expected = [
      { id: 10, big: '0', raw: null, doc: null },
      { id: 11, big: null, raw: null, doc: null },
    ];
    expect(res.data.items).toEqual(expected);
    expect(res.data.ownersSingle.items).toEqual(expected);
  });
});
