// A write converts its arguments into a copy, never in place. The `onWrite` hooks are documented
// to see the arguments exactly as the resolver received them, and graphql-js hands one coerced
// variable object to every field that uses it, so converting in place showed hooks database-form
// values (a Buffer, a stamped context column) and broke the second field sharing a variable.
// SQLite (libsql) carries the full matrix; PGlite repeats the shared-variable insert.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { type Client, createClient } from '@libsql/client';
import { defineRelations, sql } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/libsql';
import { bytea, integer as pgInteger, pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, type WriteHookPayload } from '@/index';

const Files = sqliteTable('files', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id'),
  name: text('name'),
  data: blob('data', { mode: 'buffer' }),
});

const ORG = 7;

/** Snapshot of `args` at call time, so a later mutation of the object cannot hide one. */
const snapshot = (value: unknown) => structuredClone(value);

describe.sequential('SQLite: write arguments are converted into a copy', () => {
  let dir: string;
  let client: Client;
  let db: any;
  let gqlSchema: GraphQLSchema;
  const seen: { position: string; args: any }[] = [];

  const run = async (source: string, variableValues?: Record<string, unknown>) => {
    const result = await graphql({ schema: gqlSchema, source, variableValues, contextValue: { org: ORG } });
    expect(result.errors).toBeUndefined();
    return result.data as any;
  };

  const rows = async () => {
    const all = await db.select().from(Files).orderBy(Files.id);
    return all.map((row: any) => ({ ...row, data: row.data ? [...row.data] : row.data }));
  };

  beforeAll(async () => {
    // A file database: the hooks force a transaction, after which `:memory:` loses its data.
    dir = await mkdtemp(join(tmpdir(), 'dg-write-args-'));
    client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
    db = drizzleSqlite({ client, relations: defineRelations({ Files }) });
    await db.run(sql`CREATE TABLE files (id integer PRIMARY KEY, org_id integer, name text, data blob)`);
    const record = (position: string) => (payload: WriteHookPayload) => {
      seen.push({ position, args: snapshot(payload.args) });
    };
    gqlSchema = buildSchema(db, {
      features: { upsert: true },
      contextValues: { Files: { orgId: (ctx: any) => ctx.org } },
      onWrite: { Files: { before: record('before'), after: record('after') } },
    } as any).schema;
  });

  afterAll(async () => {
    client.close();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    seen.length = 0;
    await db.run(sql`DELETE FROM files`);
  });

  /** Both hook positions saw `expected`, exactly. */
  const expectHooksSaw = (expected: unknown) => {
    expect(seen.map((entry) => entry.position)).toEqual(['before', 'after']);
    for (const entry of seen) {
      expect(entry.args).toEqual(expected);
    }
  };

  it('insert single: hooks see the arguments as sent', async () => {
    await run('mutation { createFilesSingle(values: { id: 1, name: null, data: [1, 2, 3] }) { id } }');
    expectHooksSaw({ values: { id: 1, name: null, data: [1, 2, 3] } });
    expect(await rows()).toEqual([{ id: 1, orgId: ORG, name: null, data: [1, 2, 3] }]);
  });

  it('insert list: hooks see the arguments as sent', async () => {
    await run('mutation { createFiles(values: [{ id: 1, data: [1] }, { id: 2, name: null, data: [2] }]) { id } }');
    expectHooksSaw({
      values: [
        { id: 1, data: [1] },
        { id: 2, name: null, data: [2] },
      ],
    });
    expect((await rows()).map((row: any) => row.orgId)).toEqual([ORG, ORG]);
  });

  it('upsert: hooks see the arguments as sent', async () => {
    await run('mutation { upsertFilesSingle(values: { id: 1, name: null, data: [9] }) { id } }');
    expectHooksSaw({ values: { id: 1, name: null, data: [9] } });
    seen.length = 0;
    await run('mutation { upsertFiles(values: [{ id: 1, name: "b", data: [8] }]) { id } }');
    expectHooksSaw({ values: [{ id: 1, name: 'b', data: [8] }] });
    expect(await rows()).toEqual([{ id: 1, orgId: ORG, name: 'b', data: [8] }]);
  });

  it('update: hooks see the arguments as sent', async () => {
    await db.insert(Files).values({ id: 1, orgId: ORG, name: 'a' });
    await run('mutation { updateFiles(set: { name: null, data: [5, 6] }, where: { id: { eq: 1 } }) { id } }');
    expectHooksSaw({ set: { name: null, data: [5, 6] }, where: { id: { eq: 1 } } });
    expect(await rows()).toEqual([{ id: 1, orgId: ORG, name: null, data: [5, 6] }]);
  });

  it('a single-row variable shared by two insert fields writes both rows', async () => {
    await run(
      'mutation($v: CreateFilesInput!) { a: createFilesSingle(values: $v) { id } b: createFilesSingle(values: $v) { id } }',
      { v: { name: 'same', data: [3, 4] } },
    );
    expect(await rows()).toEqual([
      { id: 1, orgId: ORG, name: 'same', data: [3, 4] },
      { id: 2, orgId: ORG, name: 'same', data: [3, 4] },
    ]);
  });

  it('a list variable shared by two insert fields writes every row', async () => {
    await run(
      'mutation($v: [CreateFilesInput!]!) { a: createFiles(values: $v) { id } b: createFiles(values: $v) { id } }',
      {
        v: [
          { name: 'x', data: [1] },
          { name: 'y', data: [2] },
        ],
      },
    );
    expect((await rows()).map((row: any) => [row.name, row.data, row.orgId])).toEqual([
      ['x', [1], ORG],
      ['y', [2], ORG],
      ['x', [1], ORG],
      ['y', [2], ORG],
    ]);
  });

  it('a variable shared by two update fields writes both', async () => {
    await db.insert(Files).values([
      { id: 1, orgId: ORG, name: 'a' },
      { id: 2, orgId: ORG, name: 'b' },
    ]);
    await run(
      `mutation($s: UpdateFilesInput!) {
        a: updateFiles(set: $s, where: { id: { eq: 1 } }) { id }
        b: updateFiles(set: $s, where: { id: { eq: 2 } }) { id }
      }`,
      { s: { name: 'z', data: [7] } },
    );
    expect(await rows()).toEqual([
      { id: 1, orgId: ORG, name: 'z', data: [7] },
      { id: 2, orgId: ORG, name: 'z', data: [7] },
    ]);
  });
});

describe.sequential('PGlite: write arguments are converted into a copy', () => {
  const PgFiles = pgTable('files', {
    id: pgInteger('id').primaryKey().generatedByDefaultAsIdentity(),
    name: pgText('name'),
    data: bytea('data'),
  });
  let pglite: PGlite;
  let db: any;
  let gqlSchema: GraphQLSchema;

  beforeAll(async () => {
    pglite = new PGlite();
    db = drizzlePglite({ client: pglite, relations: defineRelations({ Files: PgFiles }) });
    await db.execute(
      sql`CREATE TABLE files (id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY, name text, data bytea)`,
    );
    gqlSchema = buildSchema(db).schema;
  });

  afterAll(async () => {
    await pglite.close();
  });

  it('a variable shared by two insert fields writes both rows', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source:
        'mutation($v: CreateFilesInput!) { a: createFilesSingle(values: $v) { data } b: createFilesSingle(values: $v) { data } }',
      variableValues: { v: { name: 'same', data: [3, 4] } },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: { data: [3, 4] }, b: { data: [3, 4] } });
    const written = await db.select().from(PgFiles).orderBy(PgFiles.id);
    expect(written.map((row: any) => [row.name, [...row.data]])).toEqual([
      ['same', [3, 4]],
      ['same', [3, 4]],
    ]);
  });
});
