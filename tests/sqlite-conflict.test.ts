import { type Client, createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import * as schema from './schema/sqlite';

interface Ctx {
  client: Client;
  db: SQLiteAsyncDatabase<'async', any, typeof schema.relations>;
  strict: GraphQLSchema;
  lenient: GraphQLSchema;
}

const ctx: Ctx = {} as any;

const insertDuplicate = (gqlSchema: GraphQLSchema) =>
  graphql({
    schema: gqlSchema,
    source: `mutation { createUsersSingle(values: { id: 1, name: "Duplicate" }) { id name } }`,
  });

beforeAll(async () => {
  ctx.client = createClient({ url: 'file::memory:?cache=shared' });
  ctx.db = drizzle({ client: ctx.client, relations: schema.relations });

  ctx.strict = buildSchema(ctx.db).schema;
  ctx.lenient = buildSchema(ctx.db, { conflictDoNothing: true }).schema;

  await ctx.db.run(sql`CREATE TABLE IF NOT EXISTS \`users\` (
		\`id\` integer PRIMARY KEY NOT NULL,
		\`name\` text NOT NULL,
		\`email\` text,
		\`text_json\` text,
		\`blob_bigint\` blob,
		\`numeric\` numeric,
		\`created_at\` integer,
		\`created_at_ms\` integer,
		\`real\` real,
		\`text\` text(255),
		\`role\` text DEFAULT 'user',
		\`is_confirmed\` integer
	);`);
});

afterAll(() => {
  ctx.client.close();
});

beforeEach(async () => {
  await ctx.db.run(sql`DELETE FROM \`users\``);
  await ctx.db.insert(schema.Users).values({ id: 1, name: 'FirstUser' });
});

// SQLite used to append onConflictDoNothing() to every insert, which swallowed conflicts
// with no way to opt out and did not match PostgreSQL's behaviour for the same config.
describe.sequential('SQLite insert conflict behaviour', () => {
  it('raises an error on a duplicate primary key by default', async () => {
    const result = await insertDuplicate(ctx.strict);

    expect(result.errors).toBeDefined();
    const rows = await ctx.db.select().from(schema.Users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('FirstUser');
  });

  it('silently ignores a duplicate primary key when conflictDoNothing is true', async () => {
    const result = await insertDuplicate(ctx.lenient);

    expect(result.errors).toBeUndefined();
    // onConflictDoNothing inserts nothing, so there is no row to return.
    expect(result.data?.['createUsersSingle']).toBeNull();
    const rows = await ctx.db.select().from(schema.Users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('FirstUser');
  });

  it('still inserts non-conflicting rows when conflictDoNothing is true', async () => {
    const result = await graphql({
      schema: ctx.lenient,
      source: `mutation { createUsersSingle(values: { id: 2, name: "SecondUser" }) { id name } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.['createUsersSingle']).toMatchObject({ id: 2, name: 'SecondUser' });
  });
});
