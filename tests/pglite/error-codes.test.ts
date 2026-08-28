import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { bigint, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, GraphQLBigIntString, GraphQLDecimalString } from '@/index';
import { remapFromGraphQLSingleInput } from '@/util/data-mappers/index';

// ── A table with one column per coercion path the codes below classify ───────
const Readings = pgTable('readings', {
  id: uuid('id').primaryKey(),
  counter: bigint('counter', { mode: 'bigint' }),
  amount: numeric('amount'),
  takenAt: timestamp('taken_at'),
});
const relations = buildRelations({ Readings }, {});
const schema = { Readings, relations };

const DATA_DIR = `./tests/.temp/pgdata-error-codes-${Date.now()}`;
const UUID_A = '11111111-1111-4111-8111-111111111111';

let pglite: PGlite;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`CREATE TABLE "readings" (
      "id" uuid PRIMARY KEY NOT NULL,
      "counter" bigint,
      "amount" numeric,
      "taken_at" timestamp
    );`,
  );

  gqlSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

/**
 * Everything a client can get wrong about a *value* answers with one code, so a consumer can
 * tell "you sent something this column cannot take" apart from the failures that already had
 * codes — a refused write, a bad cursor, a rejected filter — without reading prose.
 */
describe.sequential('invalid input values are classified', () => {
  it('classifies a BigInt literal that is not an integer', async () => {
    const res = await run(`mutation {
      createReadingsSingle(values: { id: "${UUID_A}", counter: "1.5" }) { id }
    }`);

    expect(res.errors![0]!.message).toMatch(/BigInt cannot represent/);
    expect(res.errors![0]!.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
  });

  // A variable is coerced before any resolver runs, and graphql-js wraps the scalar's throw in
  // an error of its own. The wrapper inherits the original's extensions, so the code survives.
  it('keeps the code on a BigInt variable, which graphql-js rejects before the resolver', async () => {
    const res = await run(
      `mutation ($counter: BigInt) {
        createReadingsSingle(values: { id: "${UUID_A}", counter: $counter }) { id }
      }`,
      { counter: 'twelve' },
    );

    expect(res.errors![0]!.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
    // Raised outside a field, so there is no `drizzle` block to say which one.
    expect(res.errors![0]!.extensions?.['drizzle']).toBeUndefined();
  });

  it('classifies a Decimal that is not a number', async () => {
    const res = await run(`mutation {
      createReadingsSingle(values: { id: "${UUID_A}", amount: "NaN" }) { id }
    }`);

    expect(res.errors![0]!.message).toMatch(/Decimal cannot represent/);
    expect(res.errors![0]!.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
  });

  it('classifies a value of the wrong kind entirely', async () => {
    const res = await run(`mutation {
      createReadingsSingle(values: { id: "${UUID_A}", counter: true }) { id }
    }`);

    expect(res.errors![0]!.extensions?.['code']).toBe('DRIZZLE_INVALID_INPUT_VALUE');
  });
});

/**
 * The remaining coercion guards sit below the scalars, where a generated schema cannot reach
 * them: they are what catches a hand-built input, or a scalar override that lets more through
 * than the column can store. They are exercised directly for the same reason.
 */
describe('input remapping raises coded errors', () => {
  it('classifies a date that does not parse', () => {
    expect(() => remapFromGraphQLSingleInput({ takenAt: 'not-a-date' }, Readings)).toThrowError(
      expect.objectContaining({ extensions: { code: 'DRIZZLE_INVALID_INPUT_VALUE' } }),
    );
  });

  it('classifies a bigint that does not convert', () => {
    expect(() => remapFromGraphQLSingleInput({ counter: 'twelve' }, Readings)).toThrowError(
      expect.objectContaining({ extensions: { code: 'DRIZZLE_INVALID_INPUT_VALUE' } }),
    );
  });

  it('separates a key that is not a column of the table', () => {
    expect(() => remapFromGraphQLSingleInput({ nope: 1 }, Readings)).toThrowError(
      expect.objectContaining({ extensions: { code: 'DRIZZLE_UNKNOWN_COLUMN' } }),
    );
  });
});

/**
 * The mirror image: a stored value the scalar cannot transport is the data's problem, not the
 * request's, and says so with its own code — a client retrying with a different argument would
 * get the same answer.
 */
describe('unrepresentable stored values are classified apart', () => {
  it('classifies a bigint column value the scalar cannot represent', () => {
    expect(() => GraphQLBigIntString.serialize(1.5)).toThrowError(
      expect.objectContaining({ extensions: { code: 'DRIZZLE_UNREPRESENTABLE_VALUE' } }),
    );
  });

  it('classifies a numeric column value the scalar cannot represent', () => {
    expect(() => GraphQLDecimalString.serialize(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining({ extensions: { code: 'DRIZZLE_UNREPRESENTABLE_VALUE' } }),
    );
  });

  it('reports the same value as an invalid input when it arrives as an argument', () => {
    expect(() => GraphQLBigIntString.parseValue(1.5)).toThrowError(
      expect.objectContaining({ extensions: { code: 'DRIZZLE_INVALID_INPUT_VALUE' } }),
    );
  });
});
