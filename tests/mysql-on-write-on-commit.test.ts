// MySQL half of tests/pglite/on-write-on-commit.test.ts: `payload.onCommit` callbacks run
// after the commit — a second connection reads the row from inside the callback — and are
// dropped when the transaction rolls back. MySQL runs `onWrite` hooks but rejects nested
// writes, so this covers the hook-forced transaction and `transactions: 'auto'`.
//
// The connection is tunnelled through `docker exec` into the container, as in
// tests/mysql-write-paths.test.ts. Set MYSQL_TEST_CONTAINER to reuse a running `mysql:8`
// container (root password `mysql`) instead of starting one.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { buildRelations, sql } from 'drizzle-orm';
import { int, mysqlTable, text } from 'drizzle-orm/mysql-core';
import { drizzle } from 'drizzle-orm/mysql2';
import { type GraphQLSchema, graphql } from 'graphql';
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema, type WriteHookPayload } from '@/index';

const Items = mysqlTable('items', {
  id: int('id').primaryKey(),
  name: text('name'),
});
const relations = buildRelations({ Items }, {});

let container: string | undefined;
let ownContainer = false;
let connection: mysql.Connection | undefined;
/** A second session, outside the mutation's transaction: it only sees committed rows. */
let observer: mysql.Connection | undefined;
let db: any;
let events: string[];

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

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error: unknown) => error as Error, ...config } as any).schema;

const committedIds = async () => {
  const [rows] = await observer!.query('SELECT id FROM items ORDER BY id');
  return (rows as { id: number }[]).map((row) => row.id).join(',');
};

const deferRead = (payload: WriteHookPayload) => {
  events.push(`hook:${payload.operation}`);
  payload.onCommit(async () => {
    events.push(`commit:${payload.operation}:${await committedIds()}`);
  });
};

beforeAll(async () => {
  container = process.env['MYSQL_TEST_CONTAINER'];
  if (!container) {
    container = `drizzle-graphql-mysql-on-commit-${randomUUID().slice(0, 8)}`;
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
  const database = `on_commit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = await connect(container);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  connection = await connect(container, database);
  observer = await connect(container, database);
  db = (drizzle as any)({ client: connection, relations });
  await connection.query('CREATE TABLE items (id int PRIMARY KEY, name text)');
}, 180_000);

afterAll(async () => {
  await connection?.end().catch(() => {});
  await observer?.end().catch(() => {});
  if (ownContainer && container) {
    spawnSync('docker', ['stop', container]);
  }
});

beforeEach(async () => {
  events = [];
  await db.execute(sql`DELETE FROM items`);
  await db.insert(Items).values([{ id: 1, name: 'one' }]);
});

describe.sequential('MySQL onCommit', () => {
  it('runs after the commit: another session sees the row', async () => {
    const schema = buildWith({ onWrite: { Items: deferRead } });

    const res = await graphql({
      schema,
      source: 'mutation { createItems(values: [{ id: 2, name: "two" }]) { isSuccess } }',
      contextValue: {},
    });

    expect(res.errors).toBeUndefined();
    expect(events).toEqual(['hook:insert', 'commit:insert:1,2']);
  });

  it('drops the callbacks when a later hook rolls the field back', async () => {
    const schema = buildWith({
      onWrite: {
        Items: {
          before: (payload) => {
            payload.onCommit(() => void events.push('commit:before'));
          },
          after: () => {
            throw new Error('rejected');
          },
        },
      },
    });

    const res = await graphql({
      schema,
      source: 'mutation { createItems(values: [{ id: 2, name: "two" }]) { isSuccess } }',
      contextValue: {},
    });

    expect(res.errors?.[0]?.message).toContain('rejected');
    expect(await committedIds()).toBe('1');
    expect(events).toEqual([]);
  });

  it("under transactions: 'auto', runs after the shared commit and drops on a later field's failure", async () => {
    const schema = buildWith({ transactions: 'auto', onWrite: { Items: deferRead } });

    const ok = await graphql({
      schema,
      source: `mutation {
        a: createItems(values: [{ id: 2 }]) { isSuccess }
        b: createItems(values: [{ id: 3 }]) { isSuccess }
      }`,
      contextValue: {},
    });
    expect(ok.errors).toBeUndefined();
    expect(events).toEqual(['hook:insert', 'hook:insert', 'commit:insert:1,2,3', 'commit:insert:1,2,3']);

    events = [];
    const failed = await graphql({
      schema,
      source: `mutation {
        a: createItems(values: [{ id: 4 }]) { isSuccess }
        b: createItems(values: [{ id: 1 }]) { isSuccess }
      }`,
      contextValue: {},
    });
    expect(failed.errors).toBeDefined();
    expect(await committedIds()).toBe('1,2,3');
    expect(events).toEqual(['hook:insert']);
  });
});
