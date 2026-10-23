// Column types whose values the data mappers have to convert, or leave alone, on the way in and
// out: arrays of coerced elements (`bigint[]`, `timestamp[]`), byte columns (`bytea`), float
// tuples and vectors (`point` / `line` in tuple mode, `halfvec`), and object-valued geometric
// columns (`point` in `'xy'` mode, `line` in `'abc'` mode).
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { bigint, bytea, halfvec, integer, line, pgTable, point, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Arrays = pgTable('arrays', {
  id: integer('id').primaryKey(),
  bigs: bigint('bigs', { mode: 'bigint' }).array(),
  times: timestamp('times').array(),
});

const Bytes = pgTable('bytes', {
  id: integer('id').primaryKey(),
  data: bytea('data'),
  chunks: bytea('chunks').array(),
});

const Shapes = pgTable('shapes', {
  id: integer('id').primaryKey(),
  pt: point('pt', { mode: 'tuple' }),
  ptXy: point('pt_xy', { mode: 'xy' }),
  ln: line('ln', { mode: 'tuple' }),
  lnAbc: line('ln_abc', { mode: 'abc' }),
  // PGlite has no pgvector, and drizzle casts a written halfvec to `halfvec`, so this one is
  // only ever read (from a text column standing in for it).
  half: halfvec('half', { dimensions: 3 }),
});

const relations = buildRelations({ Arrays, Bytes, Shapes }, {});

let pglite: PGlite;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = async (source: string, variableValues?: Record<string, any>) => {
  const res = await graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });
  return JSON.parse(JSON.stringify(res));
};

const fieldType = (typeName: string, fieldName: string) =>
  String((entities.types[typeName] as GraphQLObjectType).getFields()[fieldName]!.type);
const inputFieldType = (inputName: string, fieldName: string) =>
  String((entities.inputs[inputName] as GraphQLInputObjectType).getFields()[fieldName]!.type);

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE arrays (id integer PRIMARY KEY, bigs bigint[], times timestamp[])`);
  await db.execute(sql`CREATE TABLE bytes (id integer PRIMARY KEY, data bytea, chunks bytea[])`);
  await db.execute(
    sql`CREATE TABLE shapes (id integer PRIMARY KEY, pt point, pt_xy point, ln line, ln_abc line, half text)`,
  );
  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe.sequential('arrays of bigint and timestamp elements', () => {
  it('are written and read back element by element', async () => {
    const res = await run(`mutation {
      createArraysSingle(values: {
        id: 1, bigs: ["9007199254740993", "2"], times: ["2026-09-15T10:00:00.000Z", "2026-09-16T11:30:00.000Z"]
      }) { id bigs times }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.createArraysSingle).toEqual({
      id: 1,
      bigs: ['9007199254740993', '2'],
      times: ['2026-09-15T10:00:00.000Z', '2026-09-16T11:30:00.000Z'],
    });

    const read = await run('{ arraysSingle(where: { id: { eq: 1 } }) { bigs times } }');
    expect(read.errors).toBeUndefined();
    expect(read.data.arraysSingle.bigs).toEqual(['9007199254740993', '2']);
  });

  it('are updated element by element', async () => {
    const res = await run(`mutation {
      updateArrays(where: { id: { eq: 1 } }, set: { bigs: ["5"], times: ["2027-01-01T00:00:00.000Z"] }) { bigs times }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.updateArrays).toEqual([{ bigs: ['5'], times: ['2027-01-01T00:00:00.000Z'] }]);
  });

  it('take filter operands converted the same way', async () => {
    await run(`mutation {
      createArraysSingle(values: { id: 2, bigs: ["9007199254740993", "7"], times: ["2026-09-15T10:00:00.000Z"] }) { id }
    }`);
    const res = await run(`{
      eq: arrays(where: { bigs: { eq: ["9007199254740993", "7"] } }) { id }
      has: arrays(where: { bigs: { has: "9007199254740993" } }) { id }
      hasSome: arrays(where: { times: { hasSome: ["2026-09-15T10:00:00.000Z", "2030-01-01T00:00:00.000Z"] } }) { id }
      hasEvery: arrays(where: { times: { hasEvery: ["2026-09-15T10:00:00.000Z"] } }) { id }
      hasTime: arrays(where: { times: { has: "2027-01-01T00:00:00.000Z" } }) { id }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      eq: [{ id: 2 }],
      has: [{ id: 2 }],
      hasSome: [{ id: 2 }],
      hasEvery: [{ id: 2 }],
      hasTime: [{ id: 1 }],
    });
  });

  it('reject an element that is not a valid value', async () => {
    const res = await run('mutation { createArraysSingle(values: { id: 3, bigs: ["1", "x"] }) { id } }');
    expect(res.errors?.[0]?.message).toMatch(/BigInt/);
  });
});

describe.sequential('bytea', () => {
  it('is typed as a list of bytes', () => {
    expect(fieldType('Bytes', 'data')).toBe('[Int!]');
    expect(inputFieldType('CreateBytesInput', 'data')).toBe('[Int!]');
    expect(fieldType('Bytes', 'chunks')).toBe('[[Int!]!]');
  });

  it('round-trips through create, read and update', async () => {
    const created = await run(
      'mutation { createBytesSingle(values: { id: 1, data: [1, 2, 255], chunks: [[0], [9, 8]] }) { data chunks } }',
    );
    expect(created.errors).toBeUndefined();
    expect(created.data.createBytesSingle).toEqual({ data: [1, 2, 255], chunks: [[0], [9, 8]] });

    const read = await run('{ bytesSingle(where: { id: { eq: 1 } }) { data chunks } }');
    expect(read.data.bytesSingle).toEqual({ data: [1, 2, 255], chunks: [[0], [9, 8]] });

    // What was read can be written back unchanged.
    const updated = await run(
      'mutation($data: [Int!]) { updateBytes(where: { id: { eq: 1 } }, set: { data: $data }) { data } }',
      { data: read.data.bytesSingle.data },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updateBytes).toEqual([{ data: [1, 2, 255] }]);
  });

  it('rejects a value that is not a byte', async () => {
    const res = await run('mutation { createBytesSingle(values: { id: 2, data: [1, 256] }) { id } }');
    expect(res.errors?.[0]?.message).toMatch(/not a list of bytes/);
  });
});

describe.sequential('float tuples and vectors', () => {
  it('build, typed as [Float!]', () => {
    expect(fieldType('Shapes', 'pt')).toBe('[Float!]');
    expect(fieldType('Shapes', 'ln')).toBe('[Float!]');
    expect(fieldType('Shapes', 'half')).toBe('[Float!]');
    expect(inputFieldType('CreateShapesInput', 'pt')).toBe('[Float!]');
  });

  it('round-trip through create and read', async () => {
    const created = await run(
      'mutation { createShapesSingle(values: { id: 1, pt: [1.5, 2], ln: [1, -1, 0] }) { pt ln } }',
    );
    expect(created.errors).toBeUndefined();
    expect(created.data.createShapesSingle).toEqual({ pt: [1.5, 2], ln: [1, -1, 0] });
    await pglite.exec(`UPDATE shapes SET half = '[0.5,1,2]' WHERE id = 1`);

    const read = await run('{ shapesSingle(where: { id: { eq: 1 } }) { pt ln half } }');
    expect(read.data.shapesSingle).toEqual({ pt: [1.5, 2], ln: [1, -1, 0], half: [0.5, 1, 2] });
  });

  it('reject a tuple of the wrong length', async () => {
    const point = await run('mutation { createShapesSingle(values: { id: 2, pt: [1, 2, 3] }) { id } }');
    expect(point.errors?.[0]?.message).toMatch(/expected array with length of 2, received 3/);
    const ln = await run('mutation { createShapesSingle(values: { id: 2, ln: [1, 2] }) { id } }');
    expect(ln.errors?.[0]?.message).toMatch(/expected array with length of 3, received 2/);
  });

  it('are not offered the list `push` operation', () => {
    const update = (entities.inputs['UpdateShapesInput'] as GraphQLInputObjectType).getFields();
    expect(String(update['pt']!.type)).toBe('[Float!]');
    expect(String(update['half']!.type)).toBe('[Float!]');
  });
});

describe.sequential('object-valued geometric columns', () => {
  it('read back as objects, not JSON text', async () => {
    const created = await run(
      'mutation { createShapesSingle(values: { id: 3, ptXy: { x: 1, y: 2 }, lnAbc: { a: 1, b: -1, c: 0 } }) { ptXy lnAbc } }',
    );
    expect(created.errors).toBeUndefined();
    expect(created.data.createShapesSingle).toEqual({ ptXy: { x: 1, y: 2 }, lnAbc: { a: 1, b: -1, c: 0 } });

    const read = await run('{ shapesSingle(where: { id: { eq: 3 } }) { ptXy lnAbc } }');
    expect(read.data.shapesSingle).toEqual({ ptXy: { x: 1, y: 2 }, lnAbc: { a: 1, b: -1, c: 0 } });
  });
});
