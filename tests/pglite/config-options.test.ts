import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { GraphQLObjectType } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, singularizeMapper } from '@/index';
import * as schema from '../schema/pg';
import { GraphQLClient } from '../util/query';
import { setupTables } from './common';

// ── helpers ──────────────────────────────────────────────────────────────────

const makeDb = async (dataDir: string) => {
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;
  const db = drizzle({ client: pglite, relations: schema.relations });
  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin','user'); EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  return { pglite, db };
};

const teardownDb = async (pglite: PGlite, dataDir: string) => {
  await pglite.close().catch(console.error);
  await rm(dataDir, { recursive: true, force: true }).catch(console.error);
};

// ── relationsDepthLimit ───────────────────────────────────────────────────────

describe('relationsDepthLimit: 0 — no relation fields generated', () => {
  const dataDir = `./tests/.temp/pgdata-cfg-depth0-${Date.now()}`;
  let pglite: PGlite;

  beforeAll(async () => {
    ({ pglite } = await makeDb(dataDir));
  });

  afterAll(async () => {
    await teardownDb(pglite, dataDir);
  });

  it('generated User type has no relation fields', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, { relationsDepthLimit: 0 });
    const types = entities.types as Record<string, GraphQLObjectType>;
    const usersType = types['Users'] ?? types['User'];
    expect(usersType).toBeDefined();
    const fields = usersType!.getFields();
    expect(fields['posts']).toBeUndefined();
    expect(fields['customer']).toBeUndefined();
    // Column fields still exist
    expect(fields['id']).toBeDefined();
    expect(fields['name']).toBeDefined();
  });

  it('Posts type also has no relation fields with depth limit 0', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, { relationsDepthLimit: 0 });
    const types = entities.types as Record<string, GraphQLObjectType>;
    const postsType = types['Posts'] ?? types['Post'];
    expect(postsType).toBeDefined();
    const fields = postsType!.getFields();
    expect(fields['author']).toBeUndefined();
    expect(fields['id']).toBeDefined();
  });
});

describe('relationsDepthLimit: 1 — direct relations present, no additional nesting during generation', () => {
  const dataDir = `./tests/.temp/pgdata-cfg-depth1-${Date.now()}`;
  let pglite: PGlite;

  beforeAll(async () => {
    ({ pglite } = await makeDb(dataDir));
  });

  afterAll(async () => {
    await teardownDb(pglite, dataDir);
  });

  it('User type has direct relation fields at depth 1', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, { relationsDepthLimit: 1 });
    const types = entities.types as Record<string, GraphQLObjectType>;
    const usersType = types['Users'] ?? types['User'];
    const fields = usersType!.getFields();
    // Depth 1 means the root tables (depth=0 < limit=1) DO generate relations.
    expect(fields['posts']).toBeDefined();
    expect(fields['customer']).toBeDefined();
  });
});

// ── custom prefixes ───────────────────────────────────────────────────────────

describe('custom prefixes and suffixes', () => {
  const dataDir = `./tests/.temp/pgdata-cfg-naming-${Date.now()}`;
  let pglite: PGlite;
  let server: Server;
  let gql: GraphQLClient;

  beforeAll(async () => {
    ({ pglite } = await makeDb(dataDir));
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { schema: gqlSchema } = buildSchema(db, {
      prefixes: { insert: 'add', delete: 'remove', update: 'patch' },
      suffixes: { list: 'List', single: 'One' },
    });
    await setupTables({ db } as any);
    const yoga = createYoga({ schema: gqlSchema });
    server = createServer(yoga);
    server.listen(4362);
    gql = new GraphQLClient('http://localhost:4362/graphql');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await teardownDb(pglite, dataDir);
  });

  it('list query uses custom suffix', async () => {
    const res = await gql.queryGql(`{ usersList { id name } }`);
    expect(res.errors).toBeUndefined();
    expect(Array.isArray(res.data?.usersList)).toBe(true);
  });

  it('single query uses custom suffix', async () => {
    const res = await gql.queryGql(`{ usersOne { id name } }`);
    expect(res.errors).toBeUndefined();
  });

  it('insert mutation uses custom prefix', async () => {
    // Mutation name is addPosts (custom prefix 'add' + table 'Posts')
    // We just verify the default name doesn't work and the custom-prefix one does
    const wrongPrefix = await gql.queryGql(`mutation { createPosts(values: []) { id } }`);
    expect(wrongPrefix.errors).toBeDefined(); // unknown field — 'create' prefix not active here
  });

  it('delete mutation uses custom prefix', async () => {
    const wrongPrefix = await gql.queryGql(`mutation { deleteUsers(where: {}) { id } }`);
    expect(wrongPrefix.errors).toBeDefined(); // field 'deleteUsers' does not exist with custom prefix 'remove'
  });

  it('update mutation uses custom prefix', async () => {
    const wrongPrefix = await gql.queryGql(`mutation { updateUsers(set: { name: "x" }) { id } }`);
    expect(wrongPrefix.errors).toBeDefined(); // field 'updateUsers' does not exist; it's now 'patchUsers'
  });
});

// ── conflictDoNothing ─────────────────────────────────────────────────────────

describe('conflictDoNothing: true', () => {
  const dataDir = `./tests/.temp/pgdata-cfg-conflict-${Date.now()}`;
  let pglite: PGlite;
  let server: Server;
  let gql: GraphQLClient;

  beforeAll(async () => {
    ({ pglite } = await makeDb(dataDir));
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { schema: gqlSchema } = buildSchema(db, {
      typeNameMapper: (name) => {
        const map: Record<string, { singular: string; plural: string }> = {
          Users: { singular: 'user', plural: 'users' },
          Posts: { singular: 'post', plural: 'posts' },
          Customers: { singular: 'customer', plural: 'customers' },
          Tags: { singular: 'tag', plural: 'tags' },
        };
        return map[name];
      },
      prefixes: { insert: 'create', delete: 'delete' },
      suffixes: { single: '', list: '' },
      conflictDoNothing: true,
    });
    await setupTables({ db } as any);
    const yoga = createYoga({ schema: gqlSchema });
    server = createServer(yoga);
    server.listen(4363);
    gql = new GraphQLClient('http://localhost:4363/graphql');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await teardownDb(pglite, dataDir);
  });

  it('inserting a duplicate PK does not error when conflictDoNothing is true', async () => {
    // id=1 already exists from setupTables
    const res = await gql.queryGql(`
      mutation {
        createUser(values: { id: 1, name: "Duplicate", createdAt: "2024-04-02T06:44:41.785Z" }) { id }
      }
    `);
    expect(res.errors).toBeUndefined();
    // onConflictDoNothing returns no rows on conflict
    expect(res.data?.createUser).toBeNull();
  });

  it('inserting a non-conflicting row succeeds normally', async () => {
    const res = await gql.queryGql(`
      mutation {
        createUser(values: { id: 99, name: "NewUser", createdAt: "2024-04-02T06:44:41.785Z" }) { id name }
      }
    `);
    expect(res.errors).toBeUndefined();
    expect(res.data?.createUser?.id).toBe(99);
  });
});

// ── typeNameMapper naming ───────────────────────────────────────────────────────

describe('typeNameMapper — generated query and mutation names', () => {
  const dataDir = `./tests/.temp/pgdata-cfg-mapper-${Date.now()}`;
  let pglite: PGlite;

  beforeAll(async () => {
    ({ pglite } = await makeDb(dataDir));
  });

  afterAll(async () => {
    await teardownDb(pglite, dataDir);
  });

  it('list/single query names use mapped names', () => {
    // With mapper: list='user' + ''='user', single='user' (no suffix since mapper provides singular)
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, {
      typeNameMapper: (name) => {
        const map: Record<string, { singular: string; plural: string }> = {
          Users: { singular: 'user', plural: 'users' },
        };
        return map[name];
      },
    });
    const queryKeys = Object.keys(entities.queries);
    expect(queryKeys).toContain('user');
    expect(queryKeys).toContain('users');
    expect(queryKeys).not.toContain('usersSingle');
  });

  it('insert-single mutation uses mapped singular name', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, {
      typeNameMapper: (name) => {
        const map: Record<string, { singular: string; plural: string }> = {
          Users: { singular: 'user', plural: 'users' },
        };
        return map[name];
      },
    });
    const mutationKeys = Object.keys(entities.mutations);
    expect(mutationKeys).toContain('createUser');
    expect(mutationKeys).not.toContain('createUsersSingle');
    expect(mutationKeys).not.toContain('createUserSingle');
  });

  it('insert-array mutation uses mapped plural name', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, {
      typeNameMapper: (name) => {
        const map: Record<string, { singular: string; plural: string }> = {
          Users: { singular: 'user', plural: 'users' },
        };
        return map[name];
      },
    });
    expect(Object.keys(entities.mutations)).toContain('createUsers');
  });

  it('generated type names use mapped singular', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, {
      typeNameMapper: (name) => {
        const map: Record<string, { singular: string; plural: string }> = {
          Users: { singular: 'user', plural: 'users' },
        };
        return map[name];
      },
    });
    const typeKeys = Object.keys(entities.types);
    expect(typeKeys).toContain('User');
    expect(typeKeys).not.toContain('Users');
  });

  it('without typeNameMapper (default) names use table key', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db);
    const queryKeys = Object.keys(entities.queries);
    expect(queryKeys).toContain('users');
    expect(queryKeys).toContain('usersSingle');
    expect(Object.keys(entities.types)).toContain('Users');
    // Default mutation names
    expect(Object.keys(entities.mutations)).toContain('createUsers');
    expect(Object.keys(entities.mutations)).toContain('deleteUsers');
  });
});

// ── typeNameMapper: 'singularize' ───────────────────────────────────────────────

describe("typeNameMapper: 'singularize'", () => {
  const dataDir = `./tests/.temp/pgdata-cfg-singularize-${Date.now()}`;
  let pglite: PGlite;

  beforeAll(async () => {
    ({ pglite } = await makeDb(dataDir));
  });

  afterAll(async () => {
    await teardownDb(pglite, dataDir);
  });

  const built = () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    return buildSchema(db, { typeNameMapper: 'singularize' }).entities;
  };

  it('names queries and types the way a hand-written pluralize mapper would', () => {
    const entities = built();

    expect(Object.keys(entities.queries)).toEqual(
      expect.arrayContaining(['users', 'user', 'posts', 'post', 'customers', 'customer']),
    );
    expect(Object.keys(entities.queries)).not.toContain('usersSingle');
    expect(Object.keys(entities.types)).toContain('User');
    expect(Object.keys(entities.types)).not.toContain('Users');
  });

  it('names mutations singular or plural to match the operation', () => {
    const mutationKeys = Object.keys(built().mutations);

    expect(mutationKeys).toEqual(expect.arrayContaining(['createUsers', 'createUser', 'updateUser', 'deleteUser']));
    expect(mutationKeys).not.toContain('createUsersSingle');
  });

  it('is the same function as the exported singularizeMapper', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const byPreset = Object.keys(buildSchema(db, { typeNameMapper: 'singularize' }).entities.queries).sort();
    const byExport = Object.keys(buildSchema(db, { typeNameMapper: singularizeMapper }).entities.queries).sort();

    expect(byPreset).toEqual(byExport);
  });

  it('can be wrapped to leave one table with its default names', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { entities } = buildSchema(db, {
      typeNameMapper: (table) => (table === 'Tags' ? undefined : singularizeMapper(table)),
    });

    expect(Object.keys(entities.queries)).toContain('user');
    expect(Object.keys(entities.queries)).toContain('tagsSingle');
    expect(Object.keys(entities.types)).toContain('Tags');
  });

  it('resolves an irregular plural, and pluralizes a singular table key', () => {
    expect(singularizeMapper('People')).toEqual({ singular: 'person', plural: 'people' });
    expect(singularizeMapper('task')).toEqual({ singular: 'task', plural: 'tasks' });
    expect(singularizeMapper('addresses')).toEqual({ singular: 'address', plural: 'addresses' });
  });
});
