import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// users.profile is a to-one planned child-side whose key, profiles.user_id, is NOT NULL and not
// unique. The row already attached cannot be detached, so attaching another one is refused
// rather than leaving the user with two profiles.
const Users = sqliteTable('nn_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name'),
});
const Profiles = sqliteTable('nn_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  bio: text('bio'),
});

const tables = { Users, Profiles };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: { profile: r.one.Profiles({ from: r.Users.id, to: r.Profiles.userId }) },
});

// A file in a fresh directory: libsql swaps connections around a transaction, which loses an
// in-memory database.
const dir = mkdtempSync(join(tmpdir(), 'nested-to-one-not-null-'));
let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;
const run = (source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });
const profiles = () => db.select().from(Profiles).orderBy(Profiles.id);
const codeOf = (result: Awaited<ReturnType<typeof run>>) => result.errors?.[0]?.extensions?.['code'];

beforeAll(async () => {
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  db = (drizzle as any)({ client, schema: { ...tables, relations }, relations });
  await db.run(sql`CREATE TABLE nn_users (id integer PRIMARY KEY AUTOINCREMENT, name text)`);
  await db.run(
    sql`CREATE TABLE nn_profiles (id integer PRIMARY KEY AUTOINCREMENT, user_id integer NOT NULL, bio text)`,
  );
  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});
afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.run(sql`DELETE FROM nn_profiles`);
  await db.run(sql`DELETE FROM nn_users`);
  await db.run(sql`DELETE FROM sqlite_sequence`);
  await db.insert(Users).values([{ name: 'Ada' }, { name: 'Bob' }, { name: 'Cy' }]);
});

describe.sequential('nested to-one with a NOT NULL, non-unique key on the child', () => {
  it('refuses a connect while another row is attached, and changes nothing', async () => {
    await db.insert(Profiles).values([
      { userId: 1, bio: 'ada' },
      { userId: 2, bio: 'bob' },
    ]);
    const before = await profiles();
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { connect: { id: { eq: 2 } } } }) { id } }',
    );
    expect(codeOf(result)).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(result.errors?.[0]?.message).toMatch(/cannot be detached/);
    expect(await profiles()).toEqual(before);
  });

  it('refuses a create while a row is attached, and changes nothing', async () => {
    await db.insert(Profiles).values([{ userId: 1, bio: 'old' }]);
    const before = await profiles();
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { create: { bio: "new" } } }) { id } }',
    );
    expect(codeOf(result)).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(await profiles()).toEqual(before);
  });

  it('counts an attached row whose column the connect filter compares to NULL', async () => {
    await db.insert(Profiles).values([
      { userId: 1, bio: null },
      { userId: 2, bio: 'bob' },
    ]);
    const before = await profiles();
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { connect: { bio: { eq: "bob" } } } }) { id } }',
    );
    expect(codeOf(result)).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(await profiles()).toEqual(before);
  });

  it('connects the row already attached as a no-op', async () => {
    await db.insert(Profiles).values([{ userId: 1, bio: 'ada' }]);
    const before = await profiles();
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { connect: { id: { eq: 1 } } } }) { profile { bio } } }',
    );
    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateUsersSingle.profile).toEqual({ bio: 'ada' });
    expect(await profiles()).toEqual(before);
  });

  it("still moves another parent's row to a parent with nothing attached", async () => {
    await db.insert(Profiles).values([{ userId: 2, bio: 'bob' }]);
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { connect: { id: { eq: 1 } } } }) { id } }',
    );
    expect(result.errors).toBeUndefined();
    expect(await profiles()).toEqual([{ id: 1, userId: 1, bio: 'bob' }]);
  });

  it('creates a row for a parent with nothing attached', async () => {
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { create: { bio: "new" } } }) { id } }',
    );
    expect(result.errors).toBeUndefined();
    expect(await profiles()).toEqual([{ id: 1, userId: 1, bio: 'new' }]);
  });

  it('refuses a multi-row update when any one parent already has a row, and changes nothing', async () => {
    await db.insert(Profiles).values([{ userId: 3, bio: 'cy' }]);
    const before = await profiles();
    const result = await run(
      'mutation { updateUsers(where: { id: { gte: 1 } }, set: { profile: { create: { bio: "new" } } }) { id } }',
    );
    expect(codeOf(result)).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(await profiles()).toEqual(before);
  });

  it('creates one row per parent in a multi-row update when none has one', async () => {
    const result = await run(
      'mutation { updateUsers(where: { id: { lte: 2 } }, set: { profile: { create: { bio: "new" } } }) { id } }',
    );
    expect(result.errors).toBeUndefined();
    expect((await profiles()).map((row: any) => row.userId).sort()).toEqual([1, 2]);
  });
});
