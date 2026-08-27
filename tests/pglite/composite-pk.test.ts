import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── Composite-PK schema ───────────────────────────────────────────────────────
const Orgs = pgTable('orgs', { id: integer('id').primaryKey(), name: text('name') });
const Memberships = pgTable(
  'memberships',
  {
    orgId: integer('org_id').notNull(),
    userId: integer('user_id').notNull(),
    role: text('role'),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);
const r = createRelationsHelper({ Orgs, Memberships });
const relations = buildRelations(
  { Orgs, Memberships },
  {
    Orgs: { members: r.many.Memberships({ from: r.Orgs.id, to: r.Memberships.orgId }) },
    Memberships: { org: r.one.Orgs({ from: r.Memberships.orgId, to: r.Orgs.id }) },
  },
);
const schema = { Orgs, Memberships, relations };

const DATA_DIR = `./tests/.temp/pgdata-composite-pk-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const runCapturing = async (s: GraphQLSchema, source: string) => {
  const orig = pglite.query.bind(pglite);
  const sqls: string[] = [];
  (pglite as any).query = (text: string, ...rest: any[]) => {
    sqls.push(text.replace(/\s+/g, ' '));
    return orig(text, ...rest);
  };
  try {
    const result = await graphql({ schema: s, source, contextValue: {} });
    return { result, sqls };
  } finally {
    (pglite as any).query = orig;
  }
};

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "orgs" ("id" integer PRIMARY KEY NOT NULL, "name" text);`);
  await db.execute(
    sql`CREATE TABLE "memberships" ("org_id" integer NOT NULL, "user_id" integer NOT NULL, "role" text, PRIMARY KEY ("org_id", "user_id"));`,
  );
  await db.insert(Orgs).values([
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ]);
  // Insert in scrambled userId order so a missing PK tiebreaker would NOT happen to look sorted.
  await db.insert(Memberships).values([
    { orgId: 1, userId: 40, role: 'm' },
    { orgId: 1, userId: 10, role: 'm' },
    { orgId: 1, userId: 30, role: 'm' },
    { orgId: 1, userId: 20, role: 'm' },
    { orgId: 2, userId: 6, role: 'm' },
    { orgId: 2, userId: 5, role: 'm' },
  ]);

  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('composite primary key', () => {
  it('eager paginated relation to a composite-PK target orders by the composite PK', async () => {
    const { result, sqls } = await runCapturing(gqlSchema, `{ orgs { id members(limit: 2) { userId } } }`);
    expect(result.errors).toBeUndefined();
    const orgs: any[] = (result.data as any)?.orgs ?? [];
    // Deterministic: the two lowest (orgId,userId) per org, despite scrambled insert order.
    expect(orgs.find((o) => o.id === 1)?.members.map((m: any) => m.userId)).toEqual([10, 20]);
    expect(orgs.find((o) => o.id === 2)?.members.map((m: any) => m.userId)).toEqual([5, 6]);
    // The lateral subquery orders by the composite PK columns (not just org_id).
    expect(sqls.some((q) => /order by .*"user_id"/i.test(q))).toBe(true);
  });

  it('lazy (window-function) paginated relation orders by the composite PK', async () => {
    const allTypes = entities.types as Record<string, GraphQLObjectType>;
    const OrgsType = allTypes['Orgs']!;
    const lazySchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          orgs: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(OrgsType))) as any,
            resolve: () => db.select().from(Orgs),
          },
        },
      }),
    });
    const { result, sqls } = await runCapturing(lazySchema, `{ orgs { id members(limit: 2) { userId } } }`);
    expect(result.errors).toBeUndefined();
    const orgs: any[] = (result.data as any)?.orgs ?? [];
    expect(orgs.find((o) => o.id === 1)?.members.map((m: any) => m.userId)).toEqual([10, 20]);
    // The window function partitions and orders by the composite PK.
    expect(sqls.some((q) => /row_number\(\) over \(partition by.*order by.*"user_id"/i.test(q))).toBe(true);
  });

  it('composite-PK mutation re-fetches relations with a row-value IN (not an OR explosion)', async () => {
    const { result, sqls } = await runCapturing(
      gqlSchema,
      `mutation {
        createMemberships(values: [
          { orgId: 1, userId: 99, role: "x" },
          { orgId: 2, userId: 98, role: "y" }
        ]) { role org { id name } }
      }`,
    );
    expect(result.errors).toBeUndefined();
    const created: any[] = (result.data as any)?.createMemberships ?? [];
    expect(created).toHaveLength(2);
    expect(created.find((m) => m.role === 'x')?.org).toEqual({ id: 1, name: 'A' });
    expect(created.find((m) => m.role === 'y')?.org).toEqual({ id: 2, name: 'B' });

    // The relation re-fetch keys the two mutated rows with a single row-value IN,
    // e.g. (... "org_id", ... "user_id") in (($1,$2),($3,$4)) — no per-row OR/AND chain.
    const refetch = sqls.find((q) => /from "memberships".*in \(\(/i.test(q));
    expect(refetch).toBeDefined();
    expect(refetch).not.toMatch(/ or /i);
  });
});
