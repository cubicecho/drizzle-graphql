import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { GraphQLObjectType, GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, type WriteHookPayload } from '@/index';

const Orgs = sqliteTable('orgs', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  orgId: integer('org_id').notNull(),
  name: text('name'),
});
// Written only by hooks, so its contents are the record of what committed.
const Audit = sqliteTable('audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  operation: text('operation').notNull(),
  position: text('position').notNull(),
  detail: text('detail'),
});
const r = createRelationsHelper({ Orgs, Items, Audit });
const relations = buildRelations(
  { Orgs, Items, Audit },
  { Orgs: { items: r.many.Items({ from: r.Orgs.id, to: r.Items.orgId }) } },
);
const schema = { Orgs, Items, Audit, relations };

let client: Client;
let db: any;

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error: unknown) => error as Error, ...config } as any).schema;

const run = (gqlSchema: GraphQLSchema, source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });

const auditRows = async () => await db.select().from(Audit).orderBy(Audit.id);

const record = async (payload: WriteHookPayload) => {
  await payload.tx.insert(Audit).values({
    tableName: payload.table,
    operation: payload.operation,
    position: payload.position,
    detail: payload.rows.map((row: any) => row.id).join(','),
  });
};

beforeAll(async () => {
  client = createClient({ url: 'file::memory:?cache=shared' });
  db = (drizzle as any)({ client, schema, relations });

  await db.run(sql`CREATE TABLE "orgs" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.run(sql`CREATE TABLE "items" ("id" integer PRIMARY KEY NOT NULL, "org_id" integer NOT NULL, "name" text);`);
  await db.run(
    sql`CREATE TABLE "audit" ("id" integer PRIMARY KEY AUTOINCREMENT, "table_name" text NOT NULL, "operation" text NOT NULL, "position" text NOT NULL, "detail" text);`,
  );
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM "audit"`);
  await db.run(sql`DELETE FROM "items"`);
  await db.run(sql`DELETE FROM "orgs"`);
  await db.insert(Orgs).values([{ id: 1, name: 'Acme' }]);
  await db.insert(Items).values([
    { id: 1, orgId: 1, name: 'A1' },
    { id: 2, orgId: 1, name: 'A2' },
  ]);
});

describe.sequential('SQLite onWrite', () => {
  it('runs after the write and commits with the mutation', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: record } });
    const res = await run(gqlSchema, `mutation { createItems(values: [{ id: 3, orgId: 1 }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([
      expect.objectContaining({ tableName: 'Items', operation: 'insert', position: 'after', detail: '3' }),
    ]);
  });

  it('throwing rolls a single mutation field back', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Items: async () => {
          throw new Error('audit failed');
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createItems(values: [{ id: 3, orgId: 1 }]) { id } }`);
    expect(res.errors?.[0]?.message).toContain('audit failed');
    expect((await db.select().from(Items)).map((row: any) => row.id)).toEqual([1, 2]);
  });

  it('names both positions, and fires for update and delete too', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: { before: record, after: record } } });

    await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { id } }`);
    await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 2 } }) { id } }`);

    expect((await auditRows()).map((row: any) => `${row.operation}:${row.position}`)).toEqual([
      'update:before',
      'update:after',
      'delete:before',
      'delete:after',
    ]);
  });

  it('is registered per table', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: record } });
    const res = await run(gqlSchema, `mutation { createOrgs(values: [{ id: 2, name: "Globex" }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });
});

describe.sequential('SQLite onWrite columns', () => {
  /** A hook that keeps a copy of each `rows` it is handed, keyed by operation. */
  const capture = () => {
    const seen: { operation: string; rows: any[] }[] = [];
    const after = (payload: WriteHookPayload) => {
      seen.push({ operation: payload.operation, rows: payload.rows.map((row) => ({ ...row })) });
    };
    return { seen, after };
  };

  it('hands the hook its named columns when the client selects none of them', async () => {
    const { seen, after } = capture();
    const gqlSchema = buildWith({
      onWrite: { Items: { after, columns: ['id', 'orgId'] } },
      features: { upsert: true },
    });

    const responses = [
      await run(gqlSchema, `mutation { createItems(values: [{ id: 3, orgId: 1, name: "A3" }]) { name } }`),
      await run(gqlSchema, `mutation { createItemsSingle(values: { id: 4, orgId: 1, name: "A4" }) { name } }`),
      await run(gqlSchema, `mutation { upsertItems(values: [{ id: 3, orgId: 1, name: "B3" }]) { name } }`),
      await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { name } }`),
      await run(
        gqlSchema,
        `mutation { updateItemsMany(updates: [{ where: { id: { eq: 2 } }, set: { name: "y" } }]) { name } }`,
      ),
      await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 4 } }) { name } }`),
    ];

    for (const res of responses) {
      expect(res.errors).toBeUndefined();
    }
    expect(seen).toEqual([
      { operation: 'insert', rows: [{ id: 3, orgId: 1, name: 'A3' }] },
      { operation: 'insert', rows: [{ id: 4, orgId: 1, name: 'A4' }] },
      { operation: 'upsert', rows: [{ id: 3, orgId: 1, name: 'B3' }] },
      { operation: 'update', rows: [{ id: 1, orgId: 1, name: 'x' }] },
      { operation: 'updateMany', rows: [{ id: 2, orgId: 1, name: 'y' }] },
      // A delete's rows are the rows it removed.
      { operation: 'delete', rows: [{ id: 4, orgId: 1, name: 'A4' }] },
    ]);
    // The response carries only what the client selected.
    expect(responses.map((res) => res.data)).toEqual([
      { createItems: [{ name: 'A3' }] },
      { createItemsSingle: { name: 'A4' } },
      { upsertItems: [{ name: 'B3' }] },
      { updateItems: [{ name: 'x' }] },
      { updateItemsMany: [{ name: 'y' }] },
      { deleteItems: [{ name: 'A4' }] },
    ]);
  });

  it("'all' returns every column of the table", async () => {
    const { seen, after } = capture();
    const gqlSchema = buildWith({ onWrite: { Items: { after, columns: 'all' } } });

    const res = await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ updateItems: [{ id: 1 }] });
    expect(seen).toEqual([{ operation: 'update', rows: [{ id: 1, orgId: 1, name: 'x' }] }]);
  });

  it('applies a top-level registration to every table', async () => {
    const { seen, after } = capture();
    const gqlSchema = buildWith({ onWrite: { after, columns: ['id'] } });

    const res = await run(gqlSchema, `mutation { createOrgs(values: [{ id: 2, name: "Globex" }]) { name } }`);

    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ createOrgs: [{ name: 'Globex' }] });
    expect(seen).toEqual([{ operation: 'insert', rows: [{ id: 2, name: 'Globex' }] }]);
  });

  it('leaves the hook-only columns out of what a custom resolver gets back', async () => {
    const { after } = capture();
    const entities: any = buildSchema(db, { onWrite: { Items: { after, columns: ['id', 'orgId'] } } }).entities;
    const returned: any[] = [];
    const generated = entities.mutations.updateItems;
    const customSchema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Query', fields: { items: entities.queries.items } }),
      mutation: new GraphQLObjectType({
        name: 'Mutation',
        fields: {
          customUpdateItems: {
            ...generated,
            resolve: async (source: unknown, args: unknown, context: unknown, info: unknown) => {
              const result = await generated.resolve(source, args, context, info);
              returned.push(result);
              return result;
            },
          },
        },
      }),
    });

    const res = await run(
      customSchema,
      `mutation { customUpdateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { name } }`,
    );

    expect(res.errors).toBeUndefined();
    expect(returned).toEqual([[{ name: 'x' }]]);
  });

  it('changes nothing for a hook that names no columns', async () => {
    const { seen, after } = capture();
    const gqlSchema = buildWith({ onWrite: { Items: { after } } });

    const res = await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { name } }`);

    expect(res.errors).toBeUndefined();
    expect(seen).toEqual([{ operation: 'update', rows: [{ name: 'x' }] }]);
  });

  it('fails the build on a column the table does not have', () => {
    const after = () => {};
    expect(() => buildWith({ onWrite: { Items: { after, columns: ['id', 'nope'] } } })).toThrow(
      "config.onWrite.Items.columns names 'nope', which is not a column of that table.",
    );
    // A column's database name is not its key.
    expect(() => buildWith({ onWrite: { Items: { after, columns: ['org_id'] } } })).toThrow(
      "config.onWrite.Items.columns names 'org_id'",
    );
    // Top level: the column must exist on every table — `orgId` is not on `Orgs`.
    expect(() => buildWith({ onWrite: { after, columns: ['orgId'] } })).toThrow(
      "config.onWrite (on table 'Orgs').columns names 'orgId'",
    );
  });

  it('fails the build on columns without an after hook', () => {
    expect(() => buildWith({ onWrite: { Items: { before: () => {}, columns: ['id'] } } })).toThrow(
      "config.onWrite.Items.columns only applies to an 'after' hook",
    );
  });
});

describe.sequential('SQLite onWrite: count mutations', () => {
  const counted: Partial<BuildSchemaConfig> = { features: { countMutations: true } };

  it('runs both positions around both count mutations', async () => {
    const seen: WriteHookPayload[] = [];
    const hook = async (payload: WriteHookPayload) => {
      seen.push(payload);
      await record(payload);
    };
    const gqlSchema = buildWith({ ...counted, onWrite: { Items: { before: hook, after: hook } } });

    const updated = await run(gqlSchema, `mutation { updateItemsCount(set: { name: "x" }, where: { id: { eq: 1 } }) }`);
    const deleted = await run(gqlSchema, `mutation { deleteItemsCount(where: { id: { eq: 2 } }) }`);

    expect(updated.data).toEqual({ updateItemsCount: 1 });
    expect(deleted.data).toEqual({ deleteItemsCount: 1 });
    expect(seen.map((p) => `${p.operation}:${p.position}:${p.single}`)).toEqual([
      'update:before:false',
      'update:after:false',
      'delete:before:false',
      'delete:after:false',
    ]);
    // No columns named: the after hook gets each written row's key.
    expect(seen[1]!.rows).toEqual([{ id: 1 }]);
    expect(seen[3]!.rows).toEqual([{ id: 2 }]);
    expect((await auditRows()).map((row: any) => `${row.operation}:${row.position}:${row.detail}`)).toEqual([
      'update:before:',
      'update:after:1',
      'delete:before:',
      'delete:after:2',
    ]);
  });

  it('hands the after hook the columns it names', async () => {
    const seen: any[][] = [];
    const gqlSchema = buildWith({
      ...counted,
      onWrite: { Items: { after: (payload) => void seen.push(payload.rows), columns: ['id', 'orgId'] } },
    });

    const res = await run(gqlSchema, `mutation { deleteItemsCount }`);

    expect(res.data).toEqual({ deleteItemsCount: 2 });
    expect([...seen[0]!].sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, orgId: 1 },
      { id: 2, orgId: 1 },
    ]);
  });

  it('throwing rolls the count mutation back', async () => {
    const gqlSchema = buildWith({
      ...counted,
      onWrite: {
        Items: async () => {
          throw new Error('audit failed');
        },
      },
    });

    const updated = await run(gqlSchema, `mutation { updateItemsCount(set: { name: "z" }) }`);
    const deleted = await run(gqlSchema, `mutation { deleteItemsCount }`);

    expect(updated.errors?.[0]?.message).toContain('audit failed');
    expect(deleted.errors?.[0]?.message).toContain('audit failed');
    expect((await db.select().from(Items).orderBy(Items.id)).map((row: any) => row.name)).toEqual(['A1', 'A2']);
  });
});
