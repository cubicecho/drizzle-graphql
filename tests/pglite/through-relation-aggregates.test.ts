import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// `<relation>Aggregate` on a many-to-many (`.through()`) relation has to count through the
// junction table, the same rows the relation field itself returns.

const Users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const Roles = pgTable('roles', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});
const UsersToRoles = pgTable(
  'users_to_roles',
  {
    userId: integer('user_id').notNull(),
    roleId: integer('role_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

const r = createRelationsHelper({ Users, Roles, UsersToRoles });
const relations = buildRelations(
  { Users, Roles, UsersToRoles },
  {
    Users: {
      roles: r.many.Roles({
        from: r.Users.id.through(r.UsersToRoles.userId),
        to: r.Roles.id.through(r.UsersToRoles.roleId),
      }),
    },
    Roles: {
      users: r.many.Users({
        from: r.Roles.id.through(r.UsersToRoles.roleId),
        to: r.Users.id.through(r.UsersToRoles.userId),
      }),
    },
  },
);

const DATA_DIR = `./tests/.temp/pgdata-through-relation-aggregates-${Date.now()}`;
let pglite: PGlite;
let gqlSchema: GraphQLSchema;

const query = async (source: string) => await graphql({ schema: gqlSchema, source, contextValue: {} });

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  const db = (drizzle as any)({ client: pglite, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "users" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "roles" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "users_to_roles" ("user_id" integer NOT NULL, "role_id" integer NOT NULL, PRIMARY KEY ("user_id", "role_id"));`,
  );

  // Ids overlap across the two tables on purpose: an aggregate that compares user ids with
  // role ids directly, skipping the junction, still finds rows and returns wrong numbers.
  await db.insert(Users).values([
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Carol' },
    { id: 4, name: 'Dave' },
  ]);
  await db.insert(Roles).values([
    { id: 1, name: 'admin' },
    { id: 2, name: 'editor' },
    { id: 3, name: 'viewer' },
  ]);
  // Alice: admin + editor; Bob: editor; Carol: viewer; Dave: no roles.
  await db.insert(UsersToRoles).values([
    { userId: 1, roleId: 1 },
    { userId: 1, roleId: 2 },
    { userId: 2, roleId: 2 },
    { userId: 3, roleId: 3 },
  ]);

  gqlSchema = buildSchema(db).schema;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('relation aggregates over a .through() relation', () => {
  it('counts the related rows through the junction', async () => {
    const result = await query(`{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        roles { id }
        rolesAggregate { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const users = result.data?.['users'] as any[];
    expect(users.map((u) => [u.id, u.rolesAggregate.count])).toEqual([
      [1, 2],
      [2, 1],
      [3, 1],
      [4, 0],
    ]);
    // The aggregate agrees with the relation field it summarises.
    for (const user of users) {
      expect(user.rolesAggregate.count).toBe(user.roles.length);
    }
  });

  it('counts from the reverse side of the junction', async () => {
    const result = await query(`{
      roles(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        usersAggregate { count }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data!['roles'] as any[]).map((r) => [r.id, r.usersAggregate.count])).toEqual([
      [1, 1],
      [2, 2],
      [3, 1],
    ]);
  });

  it('applies `where` to the related rows and computes other aggregates over them', async () => {
    const result = await query(`{
      users(orderBy: { id: { direction: asc, priority: 1 } }) {
        id
        editorRoles: rolesAggregate(where: { name: { eq: "editor" } }) { count }
        rolesAggregate { max { id } }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data!['users'] as any[]).map((u) => [u.id, u.editorRoles.count, u.rolesAggregate.max.id])).toEqual([
      [1, 1, 2],
      [2, 1, 2],
      [3, 0, 3],
      [4, 0, null],
    ]);
  });
});
