import Docker from 'dockerode';
import { buildRelations, createRelationsHelper, eq, sql } from 'drizzle-orm';
import { boolean, datetime, int, mysqlTable, text } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import getPort from 'get-port';
import { type GraphQLInputObjectType, type GraphQLObjectType, type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, type WriteHookPayload } from '@/index';

// =============================================================================
// The policy layer against a real MySQL server.
//
// `softDelete`, `scope`, `contextValues`, `onWrite` and `limits` were covered against SQLite
// and PGlite only, which left MySQL — the dialect that had its own builder until recently,
// and the one where a write reports `{ isSuccess }` instead of the rows it touched — with no
// execution coverage of any of them. That gap is exactly what let `uniqueKeyFilters` ship
// accepted-but-inert on MySQL: a policy the config takes and the dialect quietly ignores
// looks identical to a working one until something runs it.
//
// Every assertion here therefore checks the database rather than the mutation's answer.
// `{ isSuccess: true }` is all MySQL can say, and it says it whether or not the policy did
// its job.
// =============================================================================

const Orgs = mysqlTable('orgs', {
  id: int('id').primaryKey(),
  name: text('name').notNull(),
});
const Items = mysqlTable('items', {
  id: int('id').primaryKey(),
  orgId: int('org_id').notNull(),
  name: text('name'),
  deletedAt: datetime('deleted_at'),
});
const Flags = mysqlTable('flags', {
  id: int('id').primaryKey(),
  label: text('label').notNull(),
  isArchived: boolean('is_archived').notNull().default(false),
});
// Written only by hooks, so its contents are the record of what committed.
const Audit = mysqlTable('audit', {
  id: int('id').autoincrement().primaryKey(),
  tableName: text('table_name').notNull(),
  operation: text('operation').notNull(),
  position: text('position').notNull(),
  rowCount: int('row_count').notNull(),
});
const r = createRelationsHelper({ Orgs, Items, Flags, Audit });
const relations = buildRelations(
  { Orgs, Items, Flags, Audit },
  {
    Orgs: { items: r.many.Items({ from: r.Orgs.id, to: r.Items.orgId }) },
    Items: { org: r.one.Orgs({ from: r.Items.orgId, to: r.Orgs.id }) },
  },
);

let docker: Docker;
let container: Docker.Container;
let client: mysql.Connection;
let db: any;

const softDelete: Partial<BuildSchemaConfig> = {
  softDelete: {
    Items: 'deletedAt',
    Flags: { column: 'isArchived', deletedValue: true, restoredValue: false },
  },
};

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error: unknown) => error as Error, ...config } as any).schema;

const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue: { ...contextValue } });

/** What actually landed — the only trustworthy answer, since MySQL returns no rows. */
const itemsInDb = async (): Promise<any[]> => await db.select().from(Items).orderBy(Items.id);
const auditRows = async (): Promise<any[]> => await db.select().from(Audit).orderBy(Audit.id);

const record = async (payload: WriteHookPayload) => {
  await payload.tx.insert(Audit).values({
    tableName: payload.table,
    operation: payload.operation,
    position: payload.position,
    rowCount: payload.rows.length,
  });
};

async function createDockerDB(): Promise<string> {
  docker = new Docker();
  const port = await getPort({ port: 3308 });
  const image = 'mysql:8';

  const pullStream = await docker.pull(image);
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve(err))),
  );

  container = await docker.createContainer({
    Image: image,
    Env: ['MYSQL_ROOT_PASSWORD=mysql', 'MYSQL_DATABASE=drizzle'],
    name: `drizzle-graphql-mysql-policies-${uuid()}`,
    HostConfig: { AutoRemove: true, PortBindings: { '3306/tcp': [{ HostPort: `${port}` }] } },
  });
  await container.start();

  return `mysql://root:mysql@127.0.0.1:${port}/drizzle`;
}

beforeAll(async () => {
  const connectionString = await createDockerDB();

  const sleep = 1000;
  let timeLeft = 60000;
  let connected = false;
  let lastError: unknown;
  do {
    try {
      await client?.end().catch(() => {});
      client = await mysql.createConnection(connectionString);
      await client.connect();
      connected = true;
      break;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, sleep));
      timeLeft -= sleep;
    }
  } while (timeLeft > 0);
  if (!connected) {
    await client?.end().catch(() => {});
    await container?.stop().catch(() => {});
    throw lastError;
  }

  // rc.4 dropped both the separate `schema` argument and the `mode` option: the relations
  // config is the whole table map now.
  db = (drizzle as any)({ client, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE \`orgs\` (
    \`id\` int NOT NULL,
    \`name\` text NOT NULL,
    CONSTRAINT \`orgs_id\` PRIMARY KEY(\`id\`)
  );`);
  await db.execute(sql`CREATE TABLE \`items\` (
    \`id\` int NOT NULL,
    \`org_id\` int NOT NULL,
    \`name\` text,
    \`deleted_at\` datetime NULL DEFAULT NULL,
    CONSTRAINT \`items_id\` PRIMARY KEY(\`id\`)
  );`);
  await db.execute(sql`CREATE TABLE \`flags\` (
    \`id\` int NOT NULL,
    \`label\` text NOT NULL,
    \`is_archived\` boolean NOT NULL DEFAULT false,
    CONSTRAINT \`flags_id\` PRIMARY KEY(\`id\`)
  );`);
  await db.execute(sql`CREATE TABLE \`audit\` (
    \`id\` int AUTO_INCREMENT NOT NULL,
    \`table_name\` text NOT NULL,
    \`operation\` text NOT NULL,
    \`position\` text NOT NULL,
    \`row_count\` int NOT NULL,
    CONSTRAINT \`audit_id\` PRIMARY KEY(\`id\`)
  );`);
});

afterAll(async () => {
  await client?.end().catch(() => {});
  await container?.stop().catch(() => {});
});

// Items 1 and 2 belong to org 1, item 3 to org 2. Item 3 starts out marked.
beforeEach(async () => {
  await db.execute(sql`DELETE FROM \`audit\``);
  await db.execute(sql`DELETE FROM \`items\``);
  await db.execute(sql`DELETE FROM \`flags\``);
  await db.execute(sql`DELETE FROM \`orgs\``);
  await db.insert(Orgs).values([
    { id: 1, name: 'Acme' },
    { id: 2, name: 'Globex' },
  ]);
  await db.insert(Items).values([
    { id: 1, orgId: 1, name: 'A1', deletedAt: null },
    { id: 2, orgId: 1, name: 'A2', deletedAt: null },
    { id: 3, orgId: 2, name: 'G1', deletedAt: new Date('2020-01-01T00:00:00Z') },
  ]);
  await db.insert(Flags).values([
    { id: 1, label: 'live', isArchived: false },
    { id: 2, label: 'archived', isArchived: true },
  ]);
});

describe.sequential('MySQL soft delete', () => {
  it('marks the row instead of removing it', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 1 } }) { isSuccess } }`);

    expect(res.errors).toBeUndefined();
    expect(res.data!['deleteItems']).toEqual({ isSuccess: true });

    // The answer says nothing about what happened, so the table has to.
    const rows = await itemsInDb();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === 1).deletedAt).not.toBeNull();
  });

  it('hides marked rows from every read path, and the argument opts back in', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(
      gqlSchema,
      `{ items { id } itemsSingle(where: { id: { eq: 3 } }) { id } itemsAggregate { count } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data!['items']).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.data!['itemsSingle']).toBeNull();
    expect((res.data!['itemsAggregate'] as any).count).toBe(2);

    const opened = await run(
      gqlSchema,
      `{ items(deleted: INCLUDE) { id } only: items(deleted: ONLY) { id } itemsAggregate(deleted: INCLUDE) { count } }`,
    );
    expect(opened.errors).toBeUndefined();
    expect((opened.data!['items'] as any[]).map((i) => i.id)).toEqual([1, 2, 3]);
    expect((opened.data!['only'] as any[]).map((i) => i.id)).toEqual([3]);
    expect((opened.data!['itemsAggregate'] as any).count).toBe(3);
  });

  it('hides marked rows inside a relation field and its aggregate', async () => {
    const gqlSchema = buildWith(softDelete);
    const res = await run(
      gqlSchema,
      `{ orgs(orderBy: { id: { priority: 1, direction: asc } }) {
           id items { id } itemsAggregate { count } all: items(deleted: INCLUDE) { id }
         } }`,
    );

    expect(res.errors).toBeUndefined();
    const orgs = res.data!['orgs'] as any[];
    expect(orgs[1].items).toEqual([]);
    expect(orgs[1].itemsAggregate.count).toBe(0);
    expect((orgs[1].all as any[]).map((i) => i.id)).toEqual([3]);
  });

  it('a write cannot reach a marked row, and restore brings it back', async () => {
    const gqlSchema = buildWith(softDelete);
    const updated = await run(
      gqlSchema,
      `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 3 } }) { isSuccess } }`,
    );
    expect(updated.errors).toBeUndefined();
    // MySQL reports success either way, so the row is what says the update was confined.
    expect((await itemsInDb()).find((row) => row.id === 3).name).toBe('G1');

    const restored = await run(gqlSchema, `mutation { restoreItems(where: { id: { eq: 3 } }) { isSuccess } }`);
    expect(restored.errors).toBeUndefined();
    expect((await itemsInDb()).find((row) => row.id === 3).deletedAt).toBeNull();

    const after = await run(gqlSchema, `{ items { id } }`);
    expect((after.data!['items'] as any[]).map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('works the same way for a NOT NULL boolean marker', async () => {
    const gqlSchema = buildWith(softDelete);
    const deleted = await run(gqlSchema, `mutation { deleteFlags(where: { id: { eq: 1 } }) { isSuccess } }`);
    expect(deleted.errors).toBeUndefined();

    const only = await run(gqlSchema, `{ flags(deleted: ONLY) { id } }`);
    expect((only.data!['flags'] as any[]).map((f) => f.id).sort()).toEqual([1, 2]);

    const restored = await run(gqlSchema, `mutation { restoreFlags(where: { id: { eq: 1 } }) { isSuccess } }`);
    expect(restored.errors).toBeUndefined();
    const live = await run(gqlSchema, `{ flags { id } }`);
    expect((live.data!['flags'] as any[]).map((f) => f.id).sort()).toEqual([1]);
  });

  it('keeps the marker out of the write inputs, and leaves an undeclared table alone', async () => {
    const gqlSchema = buildWith(softDelete);
    const createInput = gqlSchema.getType('CreateItemsInput') as GraphQLInputObjectType;
    expect(Object.keys(createInput.getFields())).not.toContain('deletedAt');
    const updateInput = gqlSchema.getType('UpdateItemsInput') as GraphQLInputObjectType;
    expect(Object.keys(updateInput.getFields())).not.toContain('deletedAt');
    // It is still readable and still filterable — only the write side loses it.
    expect(Object.keys((gqlSchema.getType('Items') as GraphQLObjectType).getFields())).toContain('deletedAt');

    const mutations = gqlSchema.getMutationType()!.getFields();
    expect(mutations['restoreItems']).toBeDefined();
    expect(mutations['restoreOrgs']).toBeUndefined();
    expect(
      gqlSchema
        .getQueryType()!
        .getFields()
        ['orgs']!.args.map((a) => a.name),
    ).not.toContain('deleted');

    const res = await run(gqlSchema, `mutation { deleteOrgs(where: { id: { eq: 2 } }) { isSuccess } }`);
    expect(res.errors).toBeUndefined();
    expect(await db.select().from(Orgs)).toHaveLength(1);
  });

  it('opts into a real DELETE with hard: true', async () => {
    const gqlSchema = buildWith({
      softDelete: { Items: { column: 'deletedAt', hardDelete: true } },
    });

    const res = await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 1 } }, hard: true) { isSuccess } }`);
    expect(res.errors).toBeUndefined();
    expect((await itemsInDb()).map((row) => row.id)).toEqual([2, 3]);
  });

  it('composes with a scope, which still applies on top', async () => {
    const gqlSchema = buildWith({
      ...softDelete,
      scope: { Items: (ctx: any, table: any) => eq(table.orgId, ctx.orgId) },
    });

    const mine = await run(gqlSchema, `{ items { id } }`, { orgId: 1 });
    expect(mine.errors).toBeUndefined();
    expect((mine.data!['items'] as any[]).map((i) => i.id)).toEqual([1, 2]);

    // Org 2 owns only the marked row, so even INCLUDE stays inside the scope.
    const theirs = await run(gqlSchema, `{ items(deleted: INCLUDE) { id } }`, { orgId: 2 });
    expect((theirs.data!['items'] as any[]).map((i) => i.id)).toEqual([3]);
    const theirsDefault = await run(gqlSchema, `{ items { id } }`, { orgId: 2 });
    expect(theirsDefault.data!['items']).toEqual([]);
  });
});

describe.sequential('MySQL scope', () => {
  const scoped: Partial<BuildSchemaConfig> = {
    scope: { Items: (ctx: any, table: any) => eq(table.orgId, ctx.orgId) },
  };

  it('confines reads to the caller', async () => {
    const gqlSchema = buildWith(scoped);
    const res = await run(gqlSchema, `{ items { id } itemsAggregate { count } }`, { orgId: 1 });

    expect(res.errors).toBeUndefined();
    expect((res.data!['items'] as any[]).map((i) => i.id)).toEqual([1, 2]);
    expect((res.data!['itemsAggregate'] as any).count).toBe(2);
  });

  // The interesting half on MySQL: an out-of-scope write still answers `{ isSuccess: true }`,
  // so nothing but the table can tell you the scope held.
  it('confines an update, which still reports success', async () => {
    const gqlSchema = buildWith(scoped);
    const res = await run(
      gqlSchema,
      `mutation { updateItems(set: { name: "hacked" }, where: { id: { eq: 3 } }) { isSuccess } }`,
      { orgId: 1 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data!['updateItems']).toEqual({ isSuccess: true });
    expect((await itemsInDb()).find((row) => row.id === 3).name).toBe('G1');
  });

  it('confines a delete', async () => {
    const gqlSchema = buildWith(scoped);
    const res = await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 3 } }) { isSuccess } }`, {
      orgId: 1,
    });

    expect(res.errors).toBeUndefined();
    expect((await itemsInDb()).map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it('leaves a table with no scope alone', async () => {
    const gqlSchema = buildWith(scoped);
    const res = await run(gqlSchema, `{ orgs { id } }`, { orgId: 1 });

    expect((res.data!['orgs'] as any[]).map((o) => o.id)).toEqual([1, 2]);
  });
});

describe.sequential('MySQL contextValues', () => {
  const fromContext: Partial<BuildSchemaConfig> = {
    contextValues: { Items: { orgId: (ctx: any) => ctx.orgId } },
  };

  it('takes the column out of the write inputs', () => {
    const gqlSchema = buildWith(fromContext);
    expect(Object.keys((gqlSchema.getType('CreateItemsInput') as GraphQLInputObjectType).getFields())).not.toContain(
      'orgId',
    );
    expect(Object.keys((gqlSchema.getType('UpdateItemsInput') as GraphQLInputObjectType).getFields())).not.toContain(
      'orgId',
    );
  });

  it('fills it from the context on insert', async () => {
    const gqlSchema = buildWith(fromContext);
    const res = await run(gqlSchema, `mutation { createItems(values: [{ id: 4, name: "new" }]) { isSuccess } }`, {
      orgId: 2,
    });

    expect(res.errors).toBeUndefined();
    expect((await itemsInDb()).find((row) => row.id === 4).orgId).toBe(2);
  });

  it('fills it on a single insert too', async () => {
    const gqlSchema = buildWith(fromContext);
    const res = await run(gqlSchema, `mutation { createItemsSingle(values: { id: 5, name: "solo" }) { isSuccess } }`, {
      orgId: 2,
    });

    expect(res.errors).toBeUndefined();
    expect((await itemsInDb()).find((row) => row.id === 5).orgId).toBe(2);
  });
});

describe.sequential('MySQL onWrite', () => {
  it('runs after the write and commits with the mutation', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: record } });
    const res = await run(gqlSchema, `mutation { createItems(values: [{ id: 4, orgId: 1 }]) { isSuccess } }`);

    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([
      expect.objectContaining({ tableName: 'Items', operation: 'insert', position: 'after' }),
    ]);
  });

  // The dialect difference the hook contract has to state: with no RETURNING there are no rows
  // to hand an `after` hook, so it is handed an empty list rather than left undefined. A hook
  // written against PostgreSQL that reads `payload.rows` keeps working here; it just sees none.
  it('hands an after hook an empty row list, because MySQL returns none', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: record } });
    await run(gqlSchema, `mutation { createItems(values: [{ id: 4, orgId: 1 }]) { isSuccess } }`);

    expect((await auditRows())[0]!.rowCount).toBe(0);
  });

  it('throwing rolls the mutation back', async () => {
    const gqlSchema = buildWith({
      onWrite: {
        Items: async () => {
          throw new Error('audit failed');
        },
      },
    });

    const res = await run(gqlSchema, `mutation { createItems(values: [{ id: 4, orgId: 1 }]) { isSuccess } }`);
    expect(res.errors?.[0]?.message).toContain('audit failed');
    expect((await itemsInDb()).map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it('names both positions, and fires for update and delete too', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: { before: record, after: record } } });

    await run(gqlSchema, `mutation { updateItems(set: { name: "x" }, where: { id: { eq: 1 } }) { isSuccess } }`);
    await run(gqlSchema, `mutation { deleteItems(where: { id: { eq: 2 } }) { isSuccess } }`);

    expect((await auditRows()).map((row) => `${row.operation}:${row.position}`)).toEqual([
      'update:before',
      'update:after',
      'delete:before',
      'delete:after',
    ]);
  });

  it('is registered per table', async () => {
    const gqlSchema = buildWith({ onWrite: { Items: record } });
    const res = await run(gqlSchema, `mutation { createOrgs(values: [{ id: 3, name: "Initech" }]) { isSuccess } }`);

    expect(res.errors).toBeUndefined();
    expect(await auditRows()).toEqual([]);
  });
});

describe.sequential('MySQL limits', () => {
  it('rejects a limit above the maximum, with a code to match on', async () => {
    const gqlSchema = buildWith({ limits: { tables: { Items: { defaultLimit: 1, maxLimit: 2 } } } });
    const res = await run(gqlSchema, `{ items(limit: 50) { id } }`);

    expect(res.errors).toBeDefined();
    expect((res.errors![0] as any).extensions?.code).toBe('DRIZZLE_LIMIT_EXCEEDED');
  });

  it('applies the default limit when the query names none', async () => {
    const gqlSchema = buildWith({ limits: { tables: { Items: { defaultLimit: 1, maxLimit: 2 } } } });
    const res = await run(gqlSchema, `{ items { id } }`);

    expect(res.errors).toBeUndefined();
    expect(res.data!['items']).toHaveLength(1);
  });
});
