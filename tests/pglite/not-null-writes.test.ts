import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql, printType } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── One column per shape an explicit `null` can be aimed at ───────────────────
// name          NOT NULL, no default  → non-null on the create input, nullable on update
// systemPrompt  NOT NULL, defaulted   → nullable on *both* inputs; the reported column
// runCount      NOT NULL, defaulted   → same, but numeric, so it also takes update operations
// nickname      nullable              → the regression guard
// settings      nullable jsonb        → the shape the report says already worked
const Agents = pgTable('agents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  systemPrompt: text('system_prompt').notNull().default('be helpful'),
  runCount: integer('run_count').notNull().default(0),
  nickname: text('nickname'),
  settings: jsonb('settings'),
});

// A child table, so the nested-write `create` path — which is an insert — is covered too.
const Runs = pgTable('runs', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').notNull(),
  label: text('label').notNull().default('untitled'),
});

const r = createRelationsHelper({ Agents, Runs });
const relations = buildRelations(
  { Agents, Runs },
  {
    Agents: { runs: r.many.Runs({ from: r.Agents.id, to: r.Runs.agentId }) },
    Runs: { agent: r.one.Agents({ from: r.Runs.agentId, to: r.Agents.id }) },
  },
);
const schema = { Agents, Runs, relations };

const DATA_DIR = `./tests/.temp/pgdata-not-null-writes-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;

const run = (source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const agents = () => db.select().from(Agents).orderBy(Agents.id);
const agent = async (id: number) => (await db.select().from(Agents).where(eq(Agents.id, id)))[0];
const codeOf = (res: Awaited<ReturnType<typeof run>>) => res.errors?.[0]?.extensions?.['code'];

const seed = async () =>
  db.insert(Agents).values({ name: 'original', systemPrompt: 'kept', nickname: 'nick', settings: { a: 1 } });

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "agents" (
    "id" serial PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "system_prompt" text NOT NULL DEFAULT 'be helpful',
    "run_count" integer NOT NULL DEFAULT 0,
    "nickname" text,
    "settings" jsonb
  );`);
  await db.execute(sql`CREATE TABLE "runs" (
    "id" serial PRIMARY KEY NOT NULL,
    "agent_id" integer NOT NULL,
    "label" text NOT NULL DEFAULT 'untitled'
  );`);

  gqlSchema = buildSchema(db, {
    features: { nestedWrites: true, fieldUpdateOperations: true, countMutations: true, upsert: true },
  }).schema;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "agents", "runs" RESTART IDENTITY`);
});

/**
 * Why the two sides of a write read the same `null` differently, stated as types: the create
 * input only makes a NOT NULL column nullable when something can fill it in, so a `null` there
 * is an offer the schema made. The update input makes *every* field nullable regardless, so a
 * `null` there says nothing about defaults — it can only mean "write null".
 */
describe('the generated inputs say which nulls are meaningful', () => {
  it('keeps a NOT NULL column with no default non-null on the create input', () => {
    const created = printType(gqlSchema.getTypeMap()['CreateAgentsInput']!);
    expect(created).toContain('name: String!');
    expect(created).toContain('systemPrompt: String');
    expect(created).toContain('nickname: String');
  });

  it('makes every column nullable on the update input, defaulted or not', () => {
    const updated = printType(gqlSchema.getTypeMap()['UpdateAgentsInput']!);
    expect(updated).toContain('name: String');
    expect(updated).not.toContain('name: String!');
    expect(updated).toContain('systemPrompt: String');
  });
});

describe.sequential('an update cannot set a NOT NULL column to null', () => {
  it('names the column instead of claiming no values were specified', async () => {
    await seed();

    const res = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { systemPrompt: null }) { id systemPrompt }
    }`);

    expect(codeOf(res)).toBe('DRIZZLE_NOT_NULL');
    expect(res.errors?.[0]?.message).toContain('systemPrompt');
    // The symptom the report opened with: the only value was dropped, then the resolver said
    // there had never been one.
    expect(codeOf(res)).not.toBe('DRIZZLE_NO_VALUES');
    expect(res.errors?.[0]?.message).not.toMatch(/no values specified/);
  });

  it('refuses a NOT NULL column that has no default just the same', async () => {
    await seed();

    const res = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { name: null }) { id name }
    }`);

    expect(codeOf(res)).toBe('DRIZZLE_NOT_NULL');
    expect(res.errors?.[0]?.message).toContain('name');
  });

  it('writes nothing at all when another field is set alongside the null', async () => {
    await seed();

    const res = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { name: "renamed", systemPrompt: null }) { id name }
    }`);

    expect(codeOf(res)).toBe('DRIZZLE_NOT_NULL');
    // The half that used to report success: `name` landed, `systemPrompt` silently did not.
    // A partial write here would be worse than the original bug, so the row is re-read.
    const row = await agent(1);
    expect(row.name).toBe('original');
    expect(row.systemPrompt).toBe('kept');
  });

  it('refuses it on the plural update as well, leaving every matched row alone', async () => {
    await db.insert(Agents).values([
      { name: 'a', systemPrompt: 'one' },
      { name: 'b', systemPrompt: 'two' },
    ]);

    const res = await run(`mutation {
      updateAgents(set: { nickname: "touched", systemPrompt: null }) { id }
    }`);

    expect(codeOf(res)).toBe('DRIZZLE_NOT_NULL');
    expect(await agents()).toMatchObject([
      { name: 'a', systemPrompt: 'one', nickname: null },
      { name: 'b', systemPrompt: 'two', nickname: null },
    ]);
  });

  it('rejects the whole batch on updateMany, before the transaction opens', async () => {
    await db.insert(Agents).values([{ name: 'a' }, { name: 'b' }]);

    const res = await run(`mutation {
      updateAgentsMany(updates: [
        { where: { id: { eq: 1 } }, set: { nickname: "first" } },
        { where: { id: { eq: 2 } }, set: { systemPrompt: null } }
      ]) { id }
    }`);

    expect(codeOf(res)).toBe('DRIZZLE_NOT_NULL');
    // Entries are remapped up front precisely so a bad one rejects the request rather than
    // rolling back mid-batch — the valid entry ahead of it must not have landed either.
    expect((await agent(1)).nickname).toBeNull();
  });

  it('refuses it on the count mutation too', async () => {
    await seed();

    const res = await run(`mutation {
      updateAgentsCount(where: { id: { eq: 1 } }, set: { systemPrompt: null })
    }`);

    expect(codeOf(res)).toBe('DRIZZLE_NOT_NULL');
    expect((await agent(1)).systemPrompt).toBe('kept');
  });

  it('refuses a null through a field update operation, and as a bare value', async () => {
    await seed();

    const viaOperation = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { runCount: { set: null } }) { id }
    }`);
    expect(codeOf(viaOperation)).toBe('DRIZZLE_NOT_NULL');
    expect(viaOperation.errors?.[0]?.message).toContain('runCount');

    const bare = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { runCount: null }) { id }
    }`);
    expect(codeOf(bare)).toBe('DRIZZLE_NOT_NULL');

    // An operation that is not a null still works — the guard is about the value, not the shape.
    const incremented = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { runCount: { increment: 2 } }) { runCount }
    }`);
    expect(incremented.errors).toBeUndefined();
    expect(incremented.data?.['updateAgentsSingle']).toEqual({ runCount: 2 });
  });
});

describe.sequential('a nullable column still clears', () => {
  it('clears a nullable column on its own', async () => {
    await seed();

    const res = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { nickname: null }) { id nickname }
    }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateAgentsSingle']).toEqual({ id: 1, nickname: null });
  });

  it('clears a nullable column beside another field', async () => {
    await seed();

    const res = await run(`mutation {
      updateAgentsSingle(where: { id: { eq: 1 } }, set: { name: "renamed", nickname: null, settings: null }) {
        id name nickname settings
      }
    }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateAgentsSingle']).toEqual({ id: 1, name: 'renamed', nickname: null, settings: null });

    const row = await agent(1);
    expect(row.name).toBe('renamed');
    expect(row.nickname).toBeNull();
    expect(row.settings).toBeNull();
  });
});

/**
 * The insert side is unchanged, and asserted here so the asymmetry is written down rather than
 * inferred. `tests/pglite/upsert-null-key.test.ts` already pins the same rule for a key column.
 */
describe.sequential('an insert still reads a null as an absent value', () => {
  it('lets the default apply when a defaulted NOT NULL column is given null', async () => {
    const res = await run(`mutation {
      createAgentsSingle(values: { name: "a", systemPrompt: null, runCount: null }) {
        id name systemPrompt runCount
      }
    }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['createAgentsSingle']).toEqual({
      id: 1,
      name: 'a',
      systemPrompt: 'be helpful',
      runCount: 0,
    });
  });

  it('does the same for the plural insert and for an upsert', async () => {
    const inserted = await run(`mutation {
      createAgents(values: [{ name: "a", systemPrompt: null }]) { systemPrompt }
    }`);
    expect(inserted.errors).toBeUndefined();
    expect(inserted.data?.['createAgents']).toEqual([{ systemPrompt: 'be helpful' }]);

    const upserted = await run(`mutation {
      upsertAgentsSingle(values: { id: 1, name: "b", systemPrompt: null }) { systemPrompt }
    }`);
    expect(upserted.errors).toBeUndefined();
    expect(upserted.data?.['upsertAgentsSingle']).toEqual({ systemPrompt: 'be helpful' });
  });

  it('lets a nested create fall back to its defaults too', async () => {
    const res = await run(`mutation {
      createAgentsSingle(values: { name: "a", runs: { create: [{ label: null }] } }) { id }
    }`);

    expect(res.errors).toBeUndefined();
    expect(await db.select().from(Runs)).toMatchObject([{ agentId: 1, label: 'untitled' }]);
  });

  it('still lets the database reject a null it was never offered a way to fill', async () => {
    // `name` has no default, so the create input types it `String!` and the request never
    // reaches a resolver — the guarantee is in the schema, not in the remapper.
    const res = await run(
      `mutation Save($name: String) {
      createAgentsSingle(values: { name: $name }) { id }
    }`,
      { name: null },
    );

    expect(res.errors?.[0]?.message).toContain('String!');
    expect(await agents()).toEqual([]);
  });
});
