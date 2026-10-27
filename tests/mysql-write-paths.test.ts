// MySQL write paths that used to differ from PostgreSQL and SQLite:
//
// - An update or delete filtered through a self-referencing relation failed with error 1093
//   ("You can't specify target table … for update in FROM clause"), because the relation
//   filter's subquery reads the table being written.
// - `onConflict: { action: NOTHING }` ran as INSERT IGNORE, which also downgraded truncation
//   and foreign-key errors to warnings.
// - `features.requireWhere` let an `update<Table>Many` entry through without a `where`.
// - `action: NOTHING` ran as `ON DUPLICATE KEY UPDATE pk = pk`, to which drizzle appends every
//   `$onUpdate` column — so a skipped duplicate still had those columns rewritten.
// - A scope whose same-table subquery is a drizzle select *builder* was not seen as reading the
//   table, and still hit error 1093.
// - A soft-delete marker on a `'string'`-mode datetime / timestamp / date column was stamped as
//   an ISO instant, which MySQL refuses for those types.
//
// The connection is tunnelled through `docker exec` into the container rather than a published
// port, which is not reachable from every sandbox. Set MYSQL_TEST_CONTAINER to reuse a running
// `mysql:8` container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, createRelationsHelper, eq, inArray, sql } from 'drizzle-orm';
import { date, datetime, int, mysqlTable, text, timestamp, varchar } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';
import { withRowArrivingBeforeWrite } from './util/write-race';

const Users = mysqlTable('users', {
  id: int('id').primaryKey(),
  name: text('name'),
  managerId: int('manager_id'),
  orgId: int('org_id').notNull().default(1),
  deletedAt: int('deleted_at'),
});
const Orgs = mysqlTable('orgs', { id: int('id').primaryKey() });
const Items = mysqlTable('items', {
  id: int('id').primaryKey(),
  sku: varchar('sku', { length: 8 }).notNull(),
  orgId: int('org_id').references(() => Orgs.id),
});
const Stamped = mysqlTable('stamped', {
  id: int('id').primaryKey(),
  sku: varchar('sku', { length: 8 }).notNull(),
  revision: int('revision')
    .notNull()
    .default(0)
    .$onUpdate(() => 99),
});
const Marked = mysqlTable('marked', {
  id: int('id').primaryKey(),
  deletedAt: datetime('deleted_at', { mode: 'string' }),
});
const MarkedTs = mysqlTable('marked_ts', {
  id: int('id').primaryKey(),
  removedAt: timestamp('removed_at', { mode: 'string' }),
});
const MarkedDay = mysqlTable('marked_day', {
  id: int('id').primaryKey(),
  removedOn: date('removed_on', { mode: 'string' }),
});
const tables = { Users, Orgs, Items, Stamped, Marked, MarkedTs, MarkedDay };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: {
    manager: r.one.Users({ from: r.Users.managerId, to: r.Users.id, alias: 'mgr' }),
    reports: r.many.Users({ from: r.Users.id, to: r.Users.managerId, alias: 'mgr' }),
  },
});

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
let db: any;

const tunnel = (name: string) => () => {
  const child = spawn('docker', [
    'exec',
    '-i',
    name,
    'bash',
    '-c',
    'exec 3<>/dev/tcp/127.0.0.1/3306; cat <&3 & exec cat >&3',
  ]);
  const stream: any = Duplex.from({ readable: child.stdout, writable: child.stdin } as any);
  stream.setNoDelay = () => stream;
  stream.setKeepAlive = () => stream;
  stream.setTimeout = () => stream;
  stream.on('close', () => child.kill());
  return stream;
};

const connect = async (name: string, database?: string) => {
  let last: unknown;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const conn = await mysql.createConnection({
        stream: tunnel(name),
        user: 'root',
        password: 'mysql',
        ...(database ? { database } : {}),
      } as any);
      await conn.query('select 1');
      return conn;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw last;
};

const build = (config: Partial<BuildSchemaConfig> = {}): GraphQLSchema =>
  buildSchema(db, { onError: (error: unknown) => error as Error, ...config } as any).schema;
const run = (schema: GraphQLSchema, source: string, contextValue: Record<string, any> = {}) =>
  graphql({ schema, source, contextValue });
const errorsOf = (res: any) => res.errors?.map((e: any) => e.message);
const users = async (): Promise<{ id: number; name: string | null; deleted: boolean }[]> =>
  (await db.select().from(Users).orderBy(Users.id)).map((u: any) => ({
    id: u.id,
    name: u.name,
    deleted: u.deletedAt !== null,
  }));

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-write-paths-${randomUUID().slice(0, 8)}`;
    const started = spawnSync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      container,
      '-e',
      'MYSQL_ROOT_PASSWORD=mysql',
      'mysql:8',
    ]);
    if (started.status !== 0) {
      throw new Error(`docker run failed: ${started.stderr}`);
    }
    ownContainer = true;
  }
  const database = `write_paths_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  db = (drizzle as any)({ client: connection, relations });

  await connection.query(
    'CREATE TABLE users (id int PRIMARY KEY, name text, manager_id int, org_id int NOT NULL DEFAULT 1, deleted_at int)',
  );
  await connection.query('CREATE TABLE orgs (id int PRIMARY KEY)');
  await connection.query(
    'CREATE TABLE items (id int PRIMARY KEY, sku varchar(8) NOT NULL, org_id int, FOREIGN KEY (org_id) REFERENCES orgs (id))',
  );
  await connection.query(
    'CREATE TABLE stamped (id int PRIMARY KEY, sku varchar(8) NOT NULL, revision int NOT NULL DEFAULT 0)',
  );
  await connection.query('CREATE TABLE marked (id int PRIMARY KEY, deleted_at datetime NULL)');
  await connection.query('CREATE TABLE marked_ts (id int PRIMARY KEY, removed_at timestamp NULL)');
  await connection.query('CREATE TABLE marked_day (id int PRIMARY KEY, removed_on date NULL)');
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

describe.sequential('mysql: writes filtered through a self-referencing relation', () => {
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM users`);
    await db.insert(Users).values([
      { id: 1, name: 'boss' },
      { id: 2, name: 'worker', managerId: 1 },
      { id: 3, name: 'other', managerId: 2 },
    ]);
  });

  it('update', async () => {
    const res = await run(
      build(),
      'mutation { updateUsers(where: { manager: { name: { eq: "boss" } } }, set: { name: "w2" }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.name)).toEqual(['boss', 'w2', 'other']);
  });

  it('updateSingle', async () => {
    const res = await run(
      build(),
      'mutation { updateUsersSingle(where: { manager: { name: { eq: "boss" } } }, set: { name: "w2" }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.name)).toEqual(['boss', 'w2', 'other']);
  });

  it('updateMany', async () => {
    const res = await run(
      build(),
      'mutation { updateUsersMany(updates: [{ where: { reports: { some: { id: { eq: 3 } } } }, set: { name: "mid" } }]) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.name)).toEqual(['boss', 'mid', 'other']);
  });

  it('delete', async () => {
    const res = await run(
      build(),
      'mutation { deleteUsers(where: { reports: { some: { id: { eq: 2 } } } }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.id)).toEqual([2, 3]);
  });

  it('deleteSingle', async () => {
    const res = await run(
      build(),
      'mutation { deleteUsersSingle(where: { reports: { none: {} }, manager: { name: { eq: "worker" } } }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.id)).toEqual([1, 2]);
  });

  it('the count mutations', async () => {
    const schema = build({ features: { countMutations: true } });
    const updated = await run(
      schema,
      'mutation { updateUsersCount(where: { manager: { name: { eq: "boss" } } }, set: { name: "w2" }) }',
    );
    expect(errorsOf(updated)).toBeUndefined();
    expect((updated.data as any).updateUsersCount).toBe(1);

    const deleted = await run(schema, 'mutation { deleteUsersCount(where: { manager: { name: { eq: "w2" } } }) }');
    expect(errorsOf(deleted)).toBeUndefined();
    expect((deleted.data as any).deleteUsersCount).toBe(1);
    expect((await users()).map((u) => u.id)).toEqual([1, 2]);
  });

  it('soft delete and restore', async () => {
    const schema = build({ softDelete: { Users: { column: 'deletedAt', deletedValue: () => 1 } } } as any);
    const deleted = await run(
      schema,
      'mutation { deleteUsers(where: { manager: { name: { eq: "boss" } } }) { isSuccess } }',
    );
    expect(errorsOf(deleted)).toBeUndefined();
    expect((await users()).map((u) => u.deleted)).toEqual([false, true, false]);

    const restored = await run(
      schema,
      'mutation { restoreUsers(where: { manager: { name: { eq: "boss" } } }) { isSuccess } }',
    );
    expect(errorsOf(restored)).toBeUndefined();
    expect((await users()).map((u) => u.deleted)).toEqual([false, false, false]);
  });

  it('a scope that filters through the self relation', async () => {
    const schema = build({ scope: { Users: () => ({ manager: { name: { eq: 'boss' } } }) } } as any);
    const res = await run(schema, 'mutation { updateUsers(set: { name: "scoped" }) { isSuccess } }');
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.name)).toEqual(['boss', 'scoped', 'other']);
  });

  it('a scope whose same-table subquery is a select builder', async () => {
    const schema = build({
      scope: {
        Users: (_ctx: any, t: any) =>
          inArray(t.id, db.select({ id: Users.id }).from(Users).where(eq(Users.managerId, 1))),
      },
    } as any);
    const res = await run(
      schema,
      'mutation { updateUsers(set: { name: "x" }) { isSuccess } deleteUsers(where: { id: { eq: 9 } }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.name)).toEqual(['boss', 'x', 'other']);
  });
});

describe.sequential('mysql: onConflict action NOTHING', () => {
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM items`);
    await db.execute(sql`DELETE FROM orgs`);
    await db.insert(Orgs).values({ id: 1 });
    await db.insert(Items).values({ id: 1, sku: 'A' });
  });

  it('skips a duplicate key and inserts the rest', async () => {
    const res = await run(
      build({ features: { upsert: true } }),
      'mutation { upsertItems(values: [{ id: 1, sku: "B" }, { id: 2, sku: "C" }], onConflict: { action: NOTHING }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect(await db.select().from(Items).orderBy(Items.id)).toEqual([
      { id: 1, sku: 'A', orgId: null },
      { id: 2, sku: 'C', orgId: null },
    ]);
  });

  it('does not truncate a value that is too long', async () => {
    const res = await run(
      build({ features: { upsert: true } }),
      'mutation { upsertItemsSingle(values: { id: 9, sku: "TOOLONGSKU123" }, onConflict: { action: NOTHING }) { isSuccess } }',
    );
    expect(res.errors).toBeDefined();
    expect(await db.select().from(Items).orderBy(Items.id)).toEqual([{ id: 1, sku: 'A', orgId: null }]);
  });

  it('does not drop a row that violates a foreign key', async () => {
    const res = await run(
      build({ features: { upsert: true } }),
      'mutation { upsertItemsSingle(values: { id: 9, sku: "X", orgId: 404 }, onConflict: { action: NOTHING }) { isSuccess } }',
    );
    expect(res.errors).toBeDefined();
  });

  it('leaves the skipped row, and its $onUpdate column, untouched', async () => {
    await db.execute(sql`DELETE FROM stamped`);
    await db.execute(sql`INSERT INTO stamped (id, sku, revision) VALUES (1, 'A', 0)`);
    const res = await run(
      build({ features: { upsert: true } }),
      'mutation { upsertStampedSingle(values: { id: 1, sku: "B" }, onConflict: { action: NOTHING }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect(await db.select().from(Stamped)).toEqual([{ id: 1, sku: 'A', revision: 0 }]);
  });
});

describe.sequential("mysql: soft delete with a 'string'-mode date marker", () => {
  const schema = () =>
    build({ softDelete: { Marked: 'deletedAt', MarkedTs: 'removedAt', MarkedDay: 'removedOn' } } as any);

  it.each([
    ['datetime', 'marked', 'Marked'],
    ['timestamp', 'marked_ts', 'MarkedTs'],
    ['date', 'marked_day', 'MarkedDay'],
  ])('marks a row deleted (%s)', async (_kind, sqlName, typeName) => {
    await db.execute(sql.raw(`DELETE FROM ${sqlName}`));
    await db.execute(sql.raw(`INSERT INTO ${sqlName} (id) VALUES (1), (2)`));
    const deleted = await run(schema(), `mutation { delete${typeName}Single(where: { id: { eq: 1 } }) { isSuccess } }`);
    expect(errorsOf(deleted)).toBeUndefined();
    const field = typeName.charAt(0).toLowerCase() + typeName.slice(1);
    const live = await run(schema(), `{ ${field} { id } }`);
    expect((live.data as any)[field]).toEqual([{ id: 2 }]);
    const trash = await run(schema(), `{ ${field}(deleted: ONLY) { id } }`);
    expect((trash.data as any)[field]).toEqual([{ id: 1 }]);
  });
});

describe.sequential('mysql: requireWhere on updateMany', () => {
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM users`);
    await db.insert(Users).values([{ id: 1, name: 'boss' }]);
  });

  it('rejects an entry without a where, and writes nothing', async () => {
    const res = await run(
      build({ features: { requireWhere: true } }),
      'mutation { updateUsersMany(updates: [{ where: { id: { eq: 1 } }, set: { name: "x" } }, { set: { name: "all" } }]) { isSuccess } }',
    );
    expect((res.errors?.[0] as any)?.extensions?.code).toBe('DRIZZLE_WHERE_REQUIRED');
    expect((await users()).map((u) => u.name)).toEqual(['boss']);
  });
});

describe.sequential('mysql: a row that starts matching during a Single write', () => {
  // The Single write checks that one row matches, then writes. Another writer's row landing
  // between the two must not be written: the write is narrowed to the row the check found.
  const racing = () =>
    buildSchema(
      withRowArrivingBeforeWrite(db, (executor) => executor.insert(Users).values({ id: 2, name: 'boss', orgId: 7 })),
    ).schema;

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM users`);
    await db.insert(Users).values([{ id: 1, name: 'boss', orgId: 7 }]);
  });

  it('update writes only the row the check found', async () => {
    const res = await run(
      racing(),
      'mutation { updateUsersSingle(where: { orgId: { eq: 7 } }, set: { name: "x" }) { isSuccess } }',
    );
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.name)).toEqual(['x', 'boss']);
  });

  it('delete removes only the row the check found', async () => {
    const res = await run(racing(), 'mutation { deleteUsersSingle(where: { orgId: { eq: 7 } }) { isSuccess } }');
    expect(errorsOf(res)).toBeUndefined();
    expect((await users()).map((u) => u.id)).toEqual([2]);
  });
});
