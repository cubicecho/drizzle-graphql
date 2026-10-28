// SQLite half of tests/pglite/on-write-on-commit.test.ts: `payload.onCommit` callbacks run
// after the commit and are dropped on rollback. A file database in a temp dir, because libsql
// gives `transaction()` a fresh connection, which on `:memory:` is a different, empty database.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type BuildSchemaConfig,
  buildSchema,
  drizzleExecutorKey,
  runCommitCallbacks,
  type WriteHookPayload,
} from '@/index';

const Authors = sqliteTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Articles = sqliteTable('articles', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id'),
});
const r = createRelationsHelper({ Authors, Articles });
const relations = buildRelations(
  { Authors, Articles },
  { Authors: { articles: r.many.Articles({ from: r.Authors.id, to: r.Articles.authorId }) } },
);
const schema = { Authors, Articles, relations };

let dir: string;
let client: Client;
let db: any;
let events: string[];

const buildWith = (config: Partial<BuildSchemaConfig>): GraphQLSchema =>
  buildSchema(db, { onError: (error: unknown) => error as Error, ...config } as any).schema;

const run = (gqlSchema: GraphQLSchema, source: string, contextValue: Record<PropertyKey, any> = {}) =>
  graphql({ schema: gqlSchema, source, contextValue });

const articleIds = async () => (await db.select().from(Articles).orderBy(Articles.id)).map((row: any) => row.id);

/** Queues a callback that records what a separate read through `db` sees once it runs. */
const deferRead = (payload: WriteHookPayload) => {
  const label = `${payload.table}:${payload.operation}${payload.nested ? `:${payload.nested.op}` : ''}`;
  events.push(`hook:${label}`);
  payload.onCommit(async () => {
    events.push(`commit:${label}:${(await articleIds()).join(',')}`);
  });
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dgql-on-commit-'));
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  db = (drizzle as any)({ client, schema, relations });
  await db.run(sql`CREATE TABLE "authors" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.run(
    sql`CREATE TABLE "articles" ("id" integer PRIMARY KEY NOT NULL, "title" text NOT NULL, "author_id" integer);`,
  );
});

afterAll(async () => {
  client?.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  events = [];
  await db.run(sql`DELETE FROM "articles"`);
  await db.run(sql`DELETE FROM "authors"`);
  await db.insert(Authors).values([{ id: 1, name: 'Ada' }]);
  await db.insert(Articles).values([{ id: 1, title: 'first', authorId: 1 }]);
});

describe.sequential('SQLite onCommit', () => {
  it('runs after the commit: a separate read sees the row', async () => {
    const gqlSchema = buildWith({ onWrite: { Articles: deferRead } });

    const res = await run(gqlSchema, `mutation { createArticles(values: [{ id: 2, title: "a" }]) { id } }`);

    expect(res.errors).toBeUndefined();
    expect(events).toEqual(['hook:Articles:insert', 'commit:Articles:insert:1,2']);
  });

  it("runs a nested statement's callbacks after the tree commits, and drops them when a later hook throws", async () => {
    const ok = buildWith({ features: { nestedWrites: true }, onWrite: { Articles: deferRead } });
    const created = await run(
      ok,
      `mutation { createAuthorsSingle(values: { id: 2, name: "g", articles: { create: [{ id: 3, title: "t" }] } }) { id } }`,
    );
    expect(created.errors).toBeUndefined();
    expect(events).toEqual(['hook:Articles:insert:create', 'commit:Articles:insert:create:1,3']);

    events = [];
    const failing = buildWith({
      features: { nestedWrites: true },
      onWrite: {
        Articles: deferRead,
        Authors: () => {
          throw new Error('author rejected');
        },
      },
    });
    const rejected = await run(
      failing,
      `mutation { createAuthorsSingle(values: { id: 4, name: "h", articles: { create: [{ id: 5, title: "t" }] } }) { id } }`,
    );
    expect(rejected.errors?.[0]?.message).toContain('author rejected');
    expect(events).toEqual(['hook:Articles:insert:create']);
  });

  it("under transactions: 'auto', runs every field's callbacks after the shared commit", async () => {
    const gqlSchema = buildWith({ transactions: 'auto', onWrite: { Articles: deferRead } });

    const res = await run(
      gqlSchema,
      `mutation {
        a: createArticles(values: [{ id: 2, title: "a" }]) { id }
        b: createArticles(values: [{ id: 3, title: "b" }]) { id }
      }`,
    );

    expect(res.errors).toBeUndefined();
    expect(events).toEqual([
      'hook:Articles:insert',
      'hook:Articles:insert',
      'commit:Articles:insert:1,2,3',
      'commit:Articles:insert:1,2,3',
    ]);
  });

  it("under transactions: 'auto', drops them when a later field fails", async () => {
    const gqlSchema = buildWith({ transactions: 'auto', onWrite: { Articles: deferRead } });

    const res = await run(
      gqlSchema,
      `mutation {
        a: createArticles(values: [{ id: 2, title: "a" }]) { id }
        b: createArticles(values: [{ id: 1, title: "dup" }]) { id }
      }`,
    );

    expect(res.errors).toBeDefined();
    expect(await articleIds()).toEqual([1]);
    expect(events).toEqual(['hook:Articles:insert']);
  });

  it('under a caller-supplied executor, waits for runCommitCallbacks', async () => {
    const gqlSchema = buildWith({ onWrite: { Articles: deferRead } });
    const contextValue: Record<PropertyKey, any> = {};

    await db.transaction(async (tx: any) => {
      contextValue[drizzleExecutorKey] = tx;
      const res = await run(
        gqlSchema,
        `mutation { createArticles(values: [{ id: 2, title: "a" }]) { id } }`,
        contextValue,
      );
      expect(res.errors).toBeUndefined();
    });
    expect(events).toEqual(['hook:Articles:insert']);

    await runCommitCallbacks(contextValue);
    expect(events).toEqual(['hook:Articles:insert', 'commit:Articles:insert:1,2']);
  });
});
