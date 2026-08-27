import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { bigint, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── Schema covering every scalar-mapped column type ──────────────────────────
const Docs = pgTable('docs', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id'),
  payload: jsonb('payload'),
  counter: bigint('counter', { mode: 'bigint' }),
  label: text('label'),
});
const relations = buildRelations({ Docs }, {});
const schema = { Docs, relations };

const DATA_DIR = `./tests/.temp/pgdata-scalars-${Date.now()}`;
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

const fieldTypeName = (typeName: string, fieldName: string) =>
  String((entities.types[typeName] as GraphQLObjectType).getFields()[fieldName]!.type);

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "docs" (
      "id" uuid PRIMARY KEY NOT NULL,
      "owner_id" uuid,
      "payload" jsonb,
      "counter" bigint,
      "label" text
    );`,
  );

  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('scalar schema shape', () => {
  it('maps uuid columns to the UUID scalar', () => {
    expect(fieldTypeName('Docs', 'id')).toBe('UUID!');
    expect(fieldTypeName('Docs', 'ownerId')).toBe('UUID');
  });

  it('maps jsonb columns to the JSON scalar', () => {
    expect(fieldTypeName('Docs', 'payload')).toBe('JSON');
  });

  it('maps bigint columns to the BigInt scalar', () => {
    expect(fieldTypeName('Docs', 'counter')).toBe('BigInt');
  });

  it('leaves plain text columns as String', () => {
    expect(fieldTypeName('Docs', 'label')).toBe('String');
  });

  it('uses the same scalars on the insert input', () => {
    const fields = entities.inputs['CreateDocsInput'].getFields();
    expect(String(fields['id'].type)).toBe('UUID!');
    expect(String(fields['payload'].type)).toBe('JSON');
    expect(String(fields['counter'].type)).toBe('BigInt');
  });

  it('aggregates over a bigint column keep the BigInt scalar', () => {
    const aggregate = (entities.types['DocsAggregate'] as GraphQLObjectType).getFields();
    const min = (aggregate['min']!.type as any).getFields();
    expect(String(min['counter'].type)).toBe('BigInt');
  });
});

describe.sequential('JSON round-trips', () => {
  it('stores and returns an object literal without stringifying it', async () => {
    const insert = await run(`mutation {
      createDocsSingle(values: { id: "${UUID_A}", payload: { field: "value", nested: { n: 1 } } }) {
        id
        payload
      }
    }`);
    expect(insert.errors).toBeUndefined();
    expect((insert.data as any).createDocsSingle).toEqual({
      id: UUID_A,
      payload: { field: 'value', nested: { n: 1 } },
    });

    const read = await run(`{ docsSingle(where: { id: { eq: "${UUID_A}" } }) { payload } }`);
    expect(read.errors).toBeUndefined();
    expect((read.data as any).docsSingle.payload).toEqual({ field: 'value', nested: { n: 1 } });
  });

  it('round-trips a JSON array', async () => {
    const res = await run(`mutation {
      createDocsSingle(values: { id: "${UUID_B}", payload: [1, "two", { three: true }] }) { payload }
    }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createDocsSingle.payload).toEqual([1, 'two', { three: true }]);
  });

  it('round-trips a JSON value that is itself a string, without re-parsing it', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const res = await run(`mutation {
      createDocsSingle(values: { id: "${id}", payload: "just a string" }) { payload }
    }`);
    // Previously this threw, because the string was fed back through JSON.parse.
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createDocsSingle.payload).toBe('just a string');
  });

  it('accepts a JSON value passed as a variable', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const res = await run(`mutation ($v: CreateDocsInput!) { createDocsSingle(values: $v) { payload } }`, {
      v: { id, payload: { from: 'variable' } },
    });
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createDocsSingle.payload).toEqual({ from: 'variable' });
  });
});

describe.sequential('BigInt round-trips', () => {
  it('accepts a decimal string and returns one', async () => {
    const id = '55555555-5555-4555-8555-555555555555';
    const res = await run(`mutation {
      createDocsSingle(values: { id: "${id}", counter: "9007199254740993" }) { counter }
    }`);
    expect(res.errors).toBeUndefined();
    // 9007199254740993 is not representable as a JS number — it must survive as a string.
    expect((res.data as any).createDocsSingle.counter).toBe('9007199254740993');
  });

  it('accepts an integer literal', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    const res = await run(`mutation { createDocsSingle(values: { id: "${id}", counter: 42 }) { counter } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).createDocsSingle.counter).toBe('42');
  });

  it('rejects a non-integer string', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    const res = await run(`mutation { createDocsSingle(values: { id: "${id}", counter: "12.5" }) { counter } }`);
    expect(res.errors?.[0]?.message).toMatch(/BigInt cannot represent non-integer value/);
  });

  it('rejects a float literal', async () => {
    const id = '88888888-8888-4888-8888-888888888888';
    const res = await run(`mutation { createDocsSingle(values: { id: "${id}", counter: 1.5 }) { counter } }`);
    expect(res.errors?.[0]?.message).toMatch(/BigInt cannot represent a FloatValue/);
  });
});

describe.sequential('UUID round-trips', () => {
  it('returns the stored uuid unchanged', async () => {
    const res = await run(`{ docsSingle(where: { id: { eq: "${UUID_A}" } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).docsSingle.id).toBe(UUID_A);
  });

  it('rejects a malformed uuid on input', async () => {
    const res = await run(`mutation { createDocsSingle(values: { id: "not-a-uuid" }) { id } }`);
    expect(res.errors?.[0]?.message).toMatch(/UUID/);
  });

  it('rejects a malformed uuid in a filter', async () => {
    const res = await run(`{ docsSingle(where: { id: { eq: "nope" } }) { id } }`);
    expect(res.errors?.[0]?.message).toMatch(/UUID/);
  });
});
