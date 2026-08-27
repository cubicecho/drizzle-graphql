import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLInputObjectType, type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── Many-to-many (.through()) schema ─────────────────────────────────────────
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
const schema = { Users, Roles, UsersToRoles, relations };

const DATA_DIR = `./tests/.temp/pgdata-through-relation-filters-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

const query = async (source: string) => await graphql({ schema: gqlSchema, source, contextValue: {} });

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "users" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(sql`CREATE TABLE "roles" ("id" integer PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "users_to_roles" ("user_id" integer NOT NULL, "role_id" integer NOT NULL, PRIMARY KEY ("user_id", "role_id"));`,
  );

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

  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('through-relation filters', () => {
  it('filters a table by a through-relation with `some`', async () => {
    const result = await query(`{
      users(where: { roles: { some: { name: { eq: "admin" } } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
        id
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 1 }]);
  });

  it('`some: {}` matches rows with at least one related row', async () => {
    const result = await query(`{
      users(where: { roles: { some: {} } }, orderBy: { id: { direction: asc, priority: 1 } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('filters a table by a through-relation with `none`', async () => {
    const result = await query(`{
      users(where: { roles: { none: { name: { eq: "admin" } } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
        id
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
  });

  it('`none: {}` matches rows with no related rows at all', async () => {
    const result = await query(`{
      users(where: { roles: { none: {} } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 4 }]);
  });

  it('filters a table by a through-relation with `every`', async () => {
    // Bob only holds editor; Dave matches vacuously (no roles).
    const result = await query(`{
      users(where: { roles: { every: { name: { eq: "editor" } } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
        id
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 2 }, { id: 4 }]);
  });

  it('combines several match modes on one through-relation', async () => {
    const result = await query(`{
      users(where: {
        roles: {
          some: { name: { eq: "editor" } }
          none: { name: { eq: "admin" } }
        }
      }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 2 }]);
  });

  it('filters from the reverse side of the junction', async () => {
    const result = await query(`{
      roles(where: { users: { some: { name: { eq: "Alice" } } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
        id
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['roles']).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('ANDs a through-relation filter with column filters', async () => {
    // Names containing "o": Bob and Carol; only Bob holds editor.
    const result = await query(`{
      users(where: { name: { like: "%o%" }, roles: { some: { name: { eq: "editor" } } } }) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 2 }]);
  });

  it('supports through-relation filters inside OR', async () => {
    const result = await query(`{
      users(
        where: { OR: [{ name: { eq: "Carol" } }, { roles: { some: { name: { eq: "admin" } } } }] }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('nests a through-relation filter inside another through-relation filter', async () => {
    // Users sharing a role with Bob (editor): Alice and Bob. Exercises alias uniqueness
    // across nested EXISTS subqueries that each add a junction alias.
    const result = await query(`{
      users(
        where: { roles: { some: { users: { some: { name: { eq: "Bob" } } } } } }
        orderBy: { id: { direction: asc, priority: 1 } }
      ) { id }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['users']).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('applies through-relation filters to aggregate queries', async () => {
    const result = await query(`{
      usersAggregate(where: { roles: { some: { name: { eq: "editor" } } } }) { count }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['usersAggregate']).toEqual({ count: 2 });
  });

  describe('schema shape', () => {
    const input = (name: string) => (entities.inputs as Record<string, GraphQLInputObjectType>)[name]!;

    it('exposes through-relations as the some/none/every wrapper', () => {
      const fields = input('UsersFilters').getFields();

      expect(fields['roles']).toBeDefined();
      const rolesFilter = fields['roles']!.type as GraphQLInputObjectType;
      expect(rolesFilter.name).toBe('RolesListRelationFilter');
      expect(Object.keys(rolesFilter.getFields())).toEqual(['some', 'none', 'every']);
      expect(rolesFilter.getFields()['some']!.type).toBe(input('RolesFilters'));
    });

    it('exposes the reverse through-relation too', () => {
      const fields = input('RolesFilters').getFields();

      expect(fields['users']).toBeDefined();
      expect((fields['users']!.type as GraphQLInputObjectType).name).toBe('UsersListRelationFilter');
    });

    it('offers through-relation filters in the OR variant', () => {
      const orField = input('UsersFilters').getFields()['OR']!;
      const orType = (orField.type as any).ofType.ofType as GraphQLInputObjectType;

      // The recursive filter tree reuses the filters type itself for OR branches.
      expect(orType.name).toBe('UsersFilters');
      expect(orType.getFields()['roles']).toBeDefined();
    });
  });
});
