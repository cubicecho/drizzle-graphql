import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { bigint, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import { remapFromGraphQLSingleInput } from '@/util/data-mappers';

// Nullable columns whose input remapping coerces the value: a timestamp goes through
// `new Date(value)`, which turns `null` into the epoch, and a bigint through `BigInt(value)`,
// which throws on it. An explicit `null` on either must be written as NULL (#173).
const Todos = pgTable('todos', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  bytes: bigint('bytes', { mode: 'bigint' }),
});
const relations = defineRelations({ Todos });
const schema = { Todos, relations };

const DATA_DIR = `./tests/.temp/pgdata-nullable-null-writes-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const todo = async (id: number) => (await db.select().from(Todos).where(eq(Todos.id, id)))[0];

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "todos" (
    "id" serial PRIMARY KEY NOT NULL,
    "title" text NOT NULL,
    "completed_at" timestamp with time zone,
    "bytes" bigint
  );`);

  gqlSchema = buildSchema(db, { features: { fieldUpdateOperations: true } }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "todos" RESTART IDENTITY`);
});

describe('remapping an explicit null for a nullable column', () => {
  it('passes it through untouched on both sides of a write', () => {
    for (const operation of ['insert', 'update'] as const) {
      expect(remapFromGraphQLSingleInput({ completedAt: null, bytes: null }, Todos, undefined, operation)).toEqual({
        completedAt: null,
        bytes: null,
      });
    }
  });
});

describe.sequential('an explicit null on a nullable column writes NULL', () => {
  const seed = () =>
    run(`mutation {
      createTodosSingle(values: { title: "t", completedAt: "2024-05-01T12:00:00.000Z", bytes: "42" }) {
        id completedAt bytes
      }
    }`);

  it('clears a timestamp on update instead of writing the epoch', async () => {
    const created = await seed();
    expect(created.errors).toBeUndefined();
    expect(created.data?.['createTodosSingle']).toMatchObject({ completedAt: new Date('2024-05-01T12:00:00.000Z') });

    const res = await run(`mutation {
      updateTodosSingle(where: { id: { eq: 1 } }, set: { completedAt: null }) { id completedAt }
    }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateTodosSingle']).toEqual({ id: 1, completedAt: null });
    expect((await todo(1)).completedAt).toBeNull();

    const read = await run(`{ todosSingle(where: { id: { eq: 1 } }) { completedAt } }`);
    expect(read.errors).toBeUndefined();
    expect(read.data?.['todosSingle']).toEqual({ completedAt: null });
  });

  it('clears a bigint on update instead of rejecting it', async () => {
    expect((await seed()).errors).toBeUndefined();

    const res = await run(`mutation {
      updateTodosSingle(where: { id: { eq: 1 } }, set: { bytes: null }) { id bytes }
    }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateTodosSingle']).toEqual({ id: 1, bytes: null });
    expect((await todo(1)).bytes).toBeNull();
  });

  it('clears them through a variable and through the `set` update operation too', async () => {
    expect((await seed()).errors).toBeUndefined();

    const res = await run(
      `mutation ($at: DateTime) {
        updateTodosSingle(where: { id: { eq: 1 } }, set: { completedAt: $at, bytes: { set: null } }) { id }
      }`,
      { at: null },
    );

    expect(res.errors).toBeUndefined();
    expect(await todo(1)).toMatchObject({ completedAt: null, bytes: null });
  });

  it('writes NULL for an explicit null on create', async () => {
    const res = await run(`mutation {
      createTodosSingle(values: { title: "t", completedAt: null, bytes: null }) { id completedAt bytes }
    }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['createTodosSingle']).toEqual({ id: 1, completedAt: null, bytes: null });
    expect(await todo(1)).toMatchObject({ completedAt: null, bytes: null });
  });
});
