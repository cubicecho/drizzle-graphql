import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// The Postgres side of tests/sqlite-nested-to-one-not-null.test.ts: the check that refuses a
// second attached row compiles the connect filter into `not coalesce(…, false)`, which has to
// be valid boolean SQL here too.
const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name') });
const Profiles = pgTable('profiles', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  bio: text('bio'),
});
const tables = { Users, Profiles };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Users: { profile: r.one.Profiles({ from: r.Users.id, to: r.Profiles.userId }) },
});

let db: any;
let schema: GraphQLSchema;
const run = (source: string) => graphql({ schema, source, contextValue: {} });
const profiles = () => db.select().from(Profiles).orderBy(Profiles.id);

beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(sql`create table users (id int primary key, name text)`);
  await db.execute(sql`create table profiles (id int primary key, user_id int not null, bio text)`);
  schema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});
beforeEach(async () => {
  await db.execute(sql`truncate users, profiles`);
  await db.execute(sql`insert into users values (1, 'ann'), (2, 'bob'), (3, 'cy')`);
  await db.execute(sql`insert into profiles values (1, 1, null), (2, 2, 'bob')`);
});

describe('nested to-one with a NOT NULL, non-unique key on the child (Postgres)', () => {
  it('refuses a connect while another row is attached, and changes nothing', async () => {
    const before = await profiles();
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { profile: { connect: { bio: { eq: "bob" } } } }) { id } }',
    );
    expect(result.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(await profiles()).toEqual(before);
  });

  it('connects the row already attached as a no-op', async () => {
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 2 } }, set: { profile: { connect: { bio: { eq: "bob" } } } }) { id } }',
    );
    expect(result.errors).toBeUndefined();
  });

  it("moves another parent's row to a parent with nothing attached", async () => {
    const result = await run(
      'mutation { updateUsersSingle(where: { id: { eq: 3 } }, set: { profile: { connect: { id: { eq: 2 } } } }) { id } }',
    );
    expect(result.errors).toBeUndefined();
    expect(await profiles()).toEqual([
      { id: 1, userId: 1, bio: null },
      { id: 2, userId: 3, bio: 'bob' },
    ]);
  });

  it('refuses a multi-row create when any parent already has a row', async () => {
    const before = await profiles();
    const result = await run(
      'mutation { updateUsers(where: { id: { gte: 2 } }, set: { profile: { create: { id: 9, bio: "new" } } }) { id } }',
    );
    expect(result.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_NESTED_WRITE_INVALID');
    expect(await profiles()).toEqual(before);
  });
});
