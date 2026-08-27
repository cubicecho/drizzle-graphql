import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { pgTable, serial, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql, printType } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── One table per way a key can be filled in ──────────────────────────────────
// `serial` defaults in the database, `defaultRandom()` defaults in the database from a
// non-Int type, `$defaultFn` defaults in drizzle before the statement is built, and `Bare`
// has no default at all — the one shape that cannot express "insert me a new row".
const Serials = pgTable('serials', { id: serial('id').primaryKey(), name: text('name').notNull() });
const Uuids = pgTable('uuids', { id: uuid('id').primaryKey().defaultRandom(), name: text('name').notNull() });
const Slugs = pgTable('slugs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => 'generated-slug'),
  name: text('name').notNull(),
});
const Bare = pgTable('bare', { id: text('id').primaryKey(), name: text('name').notNull() });

const tables = { Serials, Uuids, Slugs, Bare };
const relations = buildRelations(tables, { Serials: {}, Uuids: {}, Slugs: {}, Bare: {} });

const DATA_DIR = `./tests/.temp/pgdata-upsert-null-key-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const serials = () => db.select().from(Serials).orderBy(Serials.id);

// The document a client actually writes: one mutation, one nullable variable, both halves.
const SAVE = `mutation Save($id: Int, $name: String!) {
  upsertSerialsSingle(values: { id: $id, name: $name }) { id name }
}`;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema: { ...tables, relations }, relations });

  await db.execute(sql`CREATE TABLE "serials" ("id" serial PRIMARY KEY, "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "uuids" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "slugs" ("id" text PRIMARY KEY, "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "bare" ("id" text PRIMARY KEY, "name" text NOT NULL);`);

  gqlSchema = buildSchema(db, { features: { upsert: true } }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "serials" RESTART IDENTITY;`);
  await db.execute(sql`TRUNCATE "uuids";`);
  await db.execute(sql`TRUNCATE "slugs";`);
  await db.execute(sql`TRUNCATE "bare";`);
});

describe.sequential('a null key is an absent key', () => {
  it('types a defaulted key as nullable, so one document can carry a nullable variable', () => {
    expect(printType(gqlSchema.getTypeMap()['CreateSerialsInput']!)).toContain('id: Int');
    expect(printType(gqlSchema.getTypeMap()['CreateUuidsInput']!)).toContain('id: UUID');
    expect(printType(gqlSchema.getTypeMap()['CreateSlugsInput']!)).toContain('id: String');
  });

  it('inserts when the key variable is null and updates when it holds one', async () => {
    const inserted = await run(SAVE, { id: null, name: 'fresh' });
    expect(inserted.errors).toBeUndefined();
    expect(inserted.data?.['upsertSerialsSingle']).toEqual({ id: 1, name: 'fresh' });

    // Same document, same variable — now carrying the key that came back.
    const updated = await run(SAVE, { id: 1, name: 'edited' });
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.['upsertSerialsSingle']).toEqual({ id: 1, name: 'edited' });

    expect(await serials()).toEqual([{ id: 1, name: 'edited' }]);
  });

  it('lets the database fill a null key of any type', async () => {
    const uuidRes = await run(
      `mutation Save($id: UUID) { upsertUuidsSingle(values: { id: $id, name: "u" }) { name } }`,
      { id: null },
    );
    expect(uuidRes.errors).toBeUndefined();
    expect(uuidRes.data?.['upsertUuidsSingle']).toEqual({ name: 'u' });
    expect((await db.select().from(Uuids))[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lets drizzle's own default fill a null key", async () => {
    const res = await run(`mutation Save($id: String) { upsertSlugsSingle(values: { id: $id, name: "s" }) { id } }`, {
      id: null,
    });
    expect(res.errors).toBeUndefined();
    expect(res.data?.['upsertSlugsSingle']).toEqual({ id: 'generated-slug' });
  });

  it('mixes rows with and without a key in one batch', async () => {
    await run(SAVE, { id: null, name: 'existing' });

    const res = await run(
      `mutation Save($id: Int) {
        upsertSerials(values: [{ id: $id, name: "new" }, { id: 1, name: "overwritten" }]) { id name }
      }`,
      { id: null },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['upsertSerials']).toEqual([
      { id: 2, name: 'new' },
      { id: 1, name: 'overwritten' },
    ]);
  });

  it('applies to plain inserts too', async () => {
    const res = await run(`mutation Save($id: Int) { createSerials(values: [{ id: $id, name: "c" }]) { id name } }`, {
      id: null,
    });
    expect(res.errors).toBeUndefined();
    expect(res.data?.['createSerials']).toEqual([{ id: 1, name: 'c' }]);
  });

  it('keeps a key with nothing to fill it non-null, so the omission is a build-time error', async () => {
    expect(printType(gqlSchema.getTypeMap()['CreateBareInput']!)).toContain('id: String!');

    const res = await run(`mutation Save($id: String) { upsertBareSingle(values: { id: $id, name: "b" }) { id } }`, {
      id: null,
    });
    expect(res.errors?.[0]?.message).toContain('used in position expecting type "String!"');
  });
});
