import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLEnumType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BuildSchemaConfig, EnumValueNameInfo } from '@/index';
import { buildSchema } from '@/index';

// A shared pgEnum on two tables, plus an inline value list on one column.
const kindEnum = pgEnum('run_kind', ['nightly', 'onDemand', 'hot-fix']);

const Runs = pgTable('runs', {
  id: text('id').primaryKey(),
  status: text('status', { enum: ['running', 'ok', 'error', 'stopped'] }).notNull(),
  kind: kindEnum('kind'),
});

const Jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  kind: kindEnum('kind'),
});

const relations = buildRelations({ Runs, Jobs }, {});

let pglite: PGlite;
let db: any;

const build = (config: BuildSchemaConfig = {}): GraphQLSchema => buildSchema(db, config).schema;

const valueNames = (gqlSchema: GraphQLSchema, typeName: string): string[] =>
  (gqlSchema.getType(typeName) as GraphQLEnumType).getValues().map((v) => v.name);

const internalValues = (gqlSchema: GraphQLSchema, typeName: string): unknown[] =>
  (gqlSchema.getType(typeName) as GraphQLEnumType).getValues().map((v) => v.value);

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema: { Runs, Jobs }, relations });
  await db.execute(sql`CREATE TYPE "run_kind" AS ENUM ('nightly', 'onDemand', 'hot-fix');`);
  await db.execute(sql`CREATE TABLE "runs" ("id" text PRIMARY KEY, "status" text NOT NULL, "kind" "run_kind");`);
  await db.execute(sql`CREATE TABLE "jobs" ("id" text PRIMARY KEY, "kind" "run_kind");`);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('enum value naming', () => {
  it('keeps the stored values as names by default', () => {
    const gqlSchema = build();

    expect(valueNames(gqlSchema, 'RunsStatusEnum')).toEqual(['running', 'ok', 'error', 'stopped']);
    // `hot-fix` is not a usable GraphQL name, so it falls back to its position.
    expect(valueNames(gqlSchema, 'RunKindEnum')).toEqual(['nightly', 'onDemand', 'Option2']);
  });

  it('renames values with enumValueNameMapper, keeping the stored value internally', () => {
    const gqlSchema = build({ enumValueNameMapper: ({ value }) => value.replace(/-/g, '_').toUpperCase() });

    expect(valueNames(gqlSchema, 'RunsStatusEnum')).toEqual(['RUNNING', 'OK', 'ERROR', 'STOPPED']);
    expect(internalValues(gqlSchema, 'RunsStatusEnum')).toEqual(['running', 'ok', 'error', 'stopped']);
  });

  it("CONSTANT_CASEs every value with the 'constant' preset", () => {
    const gqlSchema = build({ enumValueNameMapper: 'constant' });

    expect(valueNames(gqlSchema, 'RunKindEnum')).toEqual(['NIGHTLY', 'ON_DEMAND', 'HOT_FIX']);
    expect(internalValues(gqlSchema, 'RunKindEnum')).toEqual(['nightly', 'onDemand', 'hot-fix']);
    expect(valueNames(gqlSchema, 'RunsStatusEnum')).toEqual(['RUNNING', 'OK', 'ERROR', 'STOPPED']);
  });

  it('keeps the default name for values the mapper returns undefined for', () => {
    const gqlSchema = build({ enumValueNameMapper: ({ value }) => (value === 'ok' ? 'SUCCEEDED' : undefined) });

    expect(valueNames(gqlSchema, 'RunsStatusEnum')).toEqual(['running', 'SUCCEEDED', 'error', 'stopped']);
  });

  it('passes the value, its position, the GraphQL type name and the column to the mapper', () => {
    const seen: EnumValueNameInfo[] = [];
    build({
      enumNameMapper: (info) => (info.columnName === 'status' ? 'RunStatus' : undefined),
      enumValueNameMapper: (info) => {
        seen.push(info);
        return undefined;
      },
    });

    const ok = seen.find((i) => i.value === 'ok')!;
    expect(ok.index).toBe(1);
    expect(ok.typeName).toBe('RunStatus');
    expect(ok.tableName).toBe('Runs');
    expect(ok.columnName).toBe('status');
    expect(ok.enumName).toBeUndefined();
    expect(ok.values).toEqual(['running', 'ok', 'error', 'stopped']);

    const shared = seen.find((i) => i.value === 'onDemand')!;
    expect(shared.enumName).toBe('run_kind');
    expect(shared.typeName).toBe('RunKindEnum');
  });

  it('keeps a shared enum shared when every column names its values the same way', () => {
    const gqlSchema = build({ enumValueNameMapper: 'constant' });

    expect(gqlSchema.getType('RunKindEnum')).toBeDefined();
    expect(gqlSchema.getType('RunsKindEnum')).toBeUndefined();
    expect(gqlSchema.getType('JobsKindEnum')).toBeUndefined();
  });

  it('throws when columns sharing an enum would name its values differently', () => {
    expect(() =>
      build({
        enumValueNameMapper: ({ value, tableName }) =>
          tableName === 'Jobs' ? `JOB_${value.length}${value[0]}` : undefined,
      }),
    ).toThrow(/sharing the GraphQL enum 'RunKindEnum' name its values differently/);
  });

  it('lets enumNameMapper split a shared enum whose columns name values differently', () => {
    const gqlSchema = build({
      enumNameMapper: ({ enumName, tableName }) => (enumName === 'run_kind' ? `${tableName}Kind` : undefined),
      enumValueNameMapper: ({ value, tableName }) =>
        tableName === 'Jobs' ? `JOB_${value[0]}${value.length}` : undefined,
    });

    expect(valueNames(gqlSchema, 'RunsKind')).toEqual(['nightly', 'onDemand', 'Option2']);
    expect(valueNames(gqlSchema, 'JobsKind')).toEqual(['JOB_n7', 'JOB_o8', 'JOB_h7']);
  });

  it('throws when two values of one enum map to the same name', () => {
    expect(() => build({ enumValueNameMapper: ({ value }) => (value === 'error' ? 'ok' : undefined) })).toThrow(
      /Values 'ok' and 'error' of enum 'RunsStatusEnum'.*both map to the GraphQL value name 'ok'/,
    );
  });

  it('throws when the mapper returns a name GraphQL does not allow', () => {
    expect(() => build({ enumValueNameMapper: ({ value }) => `${value}-x` })).toThrow(
      /not a valid GraphQL enum value name/,
    );
    expect(() => build({ enumValueNameMapper: ({ index }) => (index === 0 ? 'true' : undefined) })).toThrow(
      /not a valid GraphQL enum value name/,
    );
  });

  it('throws on an unknown preset', () => {
    expect(() => build({ enumValueNameMapper: 'kebab' as any })).toThrow(/Unknown enumValueNameMapper preset 'kebab'/);
  });
});

describe.sequential('enum value naming round-trip', () => {
  let gqlSchema: GraphQLSchema;
  const run = (source: string, variableValues?: Record<string, any>) =>
    graphql({ schema: gqlSchema, source, contextValue: {}, variableValues });

  beforeAll(() => {
    gqlSchema = build({ enumValueNameMapper: 'constant' });
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM "runs";`);
  });

  it('stores the original value on create and returns the mapped name', async () => {
    const created = await run(
      `mutation { createRunsSingle(values: { id: "a", status: RUNNING, kind: ON_DEMAND }) { id status kind } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data?.['createRunsSingle']).toEqual({ id: 'a', status: 'RUNNING', kind: 'ON_DEMAND' });

    const stored = await db.execute(sql`SELECT "status", "kind" FROM "runs" WHERE "id" = 'a';`);
    expect(stored.rows).toEqual([{ status: 'running', kind: 'onDemand' }]);
  });

  it('stores the original value on update', async () => {
    await db.execute(sql`INSERT INTO "runs" ("id", "status", "kind") VALUES ('a', 'running', 'nightly');`);

    const updated = await run(
      `mutation($status: RunsStatusEnum!) { updateRuns(set: { status: $status, kind: HOT_FIX }, where: { id: { eq: "a" } }) { status kind } }`,
      { status: 'STOPPED' },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.['updateRuns']).toEqual([{ status: 'STOPPED', kind: 'HOT_FIX' }]);

    const stored = await db.execute(sql`SELECT "status", "kind" FROM "runs" WHERE "id" = 'a';`);
    expect(stored.rows).toEqual([{ status: 'stopped', kind: 'hot-fix' }]);
  });

  it('filters with eq and inArray against the stored values', async () => {
    await db.execute(
      sql`INSERT INTO "runs" ("id", "status") VALUES ('a', 'running'), ('b', 'ok'), ('c', 'error'), ('d', 'ok');`,
    );

    const eq = await run(
      `{ runs(where: { status: { eq: OK } }, orderBy: { id: { direction: asc, priority: 1 } }) { id status } }`,
    );
    expect(eq.errors).toBeUndefined();
    expect(eq.data?.['runs']).toEqual([
      { id: 'b', status: 'OK' },
      { id: 'd', status: 'OK' },
    ]);

    const inArray = await run(
      `query($s: [RunsStatusEnum!]) { runs(where: { status: { inArray: $s } }, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`,
      { s: ['RUNNING', 'ERROR'] },
    );
    expect(inArray.errors).toBeUndefined();
    expect(inArray.data?.['runs']).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('rejects the stored value as a literal once it is renamed', async () => {
    const result = await run(`{ runs(where: { status: { eq: ok } }) { id } }`);
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});

describe.sequential('enum values and names GraphQL does not allow as written', () => {
  const modeEnum = pgEnum('2fa_mode', ['2xl', 'true', 'false', 'null', 'set']);
  const Prefs = pgTable('prefs', {
    id: text('id').primaryKey(),
    mode: modeEnum('mode'),
    flag: text('flag', { enum: ['true', 'false'] }),
  });

  let prefsSchema: GraphQLSchema;
  const run = (source: string) => graphql({ schema: prefsSchema, source, contextValue: {} });

  beforeAll(async () => {
    const prefsDb = (drizzle as any)({ client: pglite, relations: buildRelations({ Prefs }, {}) });
    await prefsDb.execute(sql`CREATE TYPE "2fa_mode" AS ENUM ('2xl', 'true', 'false', 'null', 'set');`);
    await prefsDb.execute(sql`CREATE TABLE "prefs" ("id" text PRIMARY KEY, "mode" "2fa_mode", "flag" text);`);
    prefsSchema = buildSchema(prefsDb).schema;
  });

  it('names a value that starts with a digit or is true / false / null Option<index>', () => {
    expect(valueNames(prefsSchema, '_2faModeEnum')).toEqual(['Option0', 'Option1', 'Option2', 'Option3', 'set']);
    expect(valueNames(prefsSchema, 'PrefsFlagEnum')).toEqual(['Option0', 'Option1']);
  });

  it('round-trips those values under their Option names', async () => {
    const created = await run(
      `mutation { createPrefsSingle(values: { id: "a", mode: Option0, flag: Option1 }) { mode flag } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(created.data?.['createPrefsSingle']).toEqual({ mode: 'Option0', flag: 'Option1' });

    const stored = await run(`{ prefs(where: { mode: { eq: Option0 } }) { id } }`);
    expect(stored.data?.['prefs']).toEqual([{ id: 'a' }]);
  });
});
