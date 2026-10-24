import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A one-to-one that shares its primary key — `profiles.user_id` is both the profile's key and
// its reference to `users.id` — joins primary key to primary key, so both directions are
// planned child-side. A `connect` written as `UPDATE <target> SET <key> = …` would rewrite the
// primary key of whichever row the filter picked; it only accepts a row that already holds
// the parent's key, and refuses anything else.

const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
const Profiles = pgTable('profiles', { userId: integer('user_id').primaryKey(), bio: text('bio') });
const tables = { Users, Profiles };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: { profile: r.one.Profiles({ from: r.Users.id, to: r.Profiles.userId }) },
  Profiles: { user: r.one.Users({ from: r.Profiles.userId, to: r.Users.id }) },
});

let db: any;
let schema: GraphQLSchema;
beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(sql`create table users (id int primary key, name text not null)`);
  await db.execute(sql`create table profiles (user_id int primary key, bio text)`);
  schema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});
beforeEach(async () => {
  await db.execute(sql`truncate users, profiles`);
  await db.execute(sql`insert into users values (1, 'ann'), (2, 'bob')`);
  await db.execute(sql`insert into profiles values (1, 'ann bio'), (3, 'orphan')`);
});

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const state = async () => ({
  users: await db.select().from(Users).orderBy(Users.id),
  profiles: await db.select().from(Profiles).orderBy(Profiles.userId),
});
const initial = {
  users: [
    { id: 1, name: 'ann' },
    { id: 2, name: 'bob' },
  ],
  profiles: [
    { userId: 1, bio: 'ann bio' },
    { userId: 3, bio: 'orphan' },
  ],
};

describe('connect through a primary-key-to-primary-key one-to-one', () => {
  it("refuses to rewrite the connected user's primary key", async () => {
    const res = await run(
      'mutation { updateProfilesSingle(where: { userId: { eq: 3 } }, set: { user: { connect: { name: { eq: "bob" } } } }) { userId } }',
    );
    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(await state()).toEqual(initial);
  });

  it("refuses to rewrite the connected profile's primary key from the other side", async () => {
    const res = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 2 } }, set: { profile: { connect: { userId: { eq: 3 } } } }) { id } }',
    );
    expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(await state()).toEqual(initial);
  });

  it('connects a row that already holds the key as it is', async () => {
    const res = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { connect: { userId: { eq: 1 } } } }) { profile { bio } } }',
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as any).updateUsersSingle.profile).toEqual({ bio: 'ann bio' });
    expect(await state()).toEqual(initial);
  });

  it('still creates the related row with the shared key', async () => {
    const res = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 2 } }, set: { profile: { create: { bio: "bob bio" } } }) { profile { userId bio } } }',
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as any).updateUsersSingle.profile).toEqual({ userId: 2, bio: 'bob bio' });
  });
});
