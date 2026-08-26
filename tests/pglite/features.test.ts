import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, type SchemaFeatures } from '@/index';
import * as schema from '../schema/pg';

// buildSchema only reads the drizzle metadata, so these tests never touch the database:
// one in-memory client is enough to build as many schemas as we like.
let pglite: PGlite;
let db: PgliteDatabase<typeof schema>;

const build = (features?: SchemaFeatures) => buildSchema(db, features ? { features } : undefined);

const queryFields = (gqlSchema: GraphQLSchema) => gqlSchema.getQueryType()!.getFields();
const userFields = (gqlSchema: GraphQLSchema) => (gqlSchema.getType('Users') as GraphQLObjectType).getFields();

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle({ client: pglite, schema, relations: schema.relations });
});

afterAll(async () => {
  await pglite.close().catch(console.error);
});

describe('features: defaults', () => {
  it('generates every feature when no features block is given', () => {
    const gqlSchema = build().schema;
    const mutations = gqlSchema.getMutationType()!.getFields();

    expect(queryFields(gqlSchema)['usersAggregate']).toBeDefined();
    expect(queryFields(gqlSchema)['users']!.args.map((a) => a.name)).toContain('distinct');
    expect(userFields(gqlSchema)['postsAggregate']).toBeDefined();
    expect(mutations['createUsers']).toBeDefined();
    expect(mutations['updateUsers']).toBeDefined();
    expect(mutations['deleteUsers']).toBeDefined();
  });

  it('treats an empty features block the same as no features block', () => {
    const gqlSchema = build({}).schema;

    expect(queryFields(gqlSchema)['usersAggregate']).toBeDefined();
    expect(queryFields(gqlSchema)['users']!.args.map((a) => a.name)).toContain('distinct');
    expect(gqlSchema.getMutationType()!.getFields()['createUsers']).toBeDefined();
  });
});

describe('features: aggregates', () => {
  it('omits the aggregate queries and their output types when off', () => {
    const { schema: gqlSchema, entities } = build({ aggregates: false });

    expect(queryFields(gqlSchema)['usersAggregate']).toBeUndefined();
    expect(gqlSchema.getType('UsersAggregate')).toBeUndefined();
    expect(Object.keys(entities.queries).some((name) => name.endsWith('Aggregate'))).toBe(false);
    // The list and single queries are untouched.
    expect(queryFields(gqlSchema)['users']).toBeDefined();
    expect(queryFields(gqlSchema)['usersSingle']).toBeDefined();
  });

  it('keeps relation aggregates, which are a separate switch', () => {
    expect(userFields(build({ aggregates: false }).schema)['postsAggregate']).toBeDefined();
  });
});

describe('features: relationAggregates', () => {
  it('omits the per-relation aggregate fields when off', () => {
    const gqlSchema = build({ relationAggregates: false }).schema;

    expect(userFields(gqlSchema)['postsAggregate']).toBeUndefined();
    // The relation itself is still there, and root aggregates are a separate switch.
    expect(userFields(gqlSchema)['posts']).toBeDefined();
    expect(queryFields(gqlSchema)['usersAggregate']).toBeDefined();
  });
});

describe('features: distinct', () => {
  it('omits the distinct argument and its enum when off', () => {
    const gqlSchema = build({ distinct: false }).schema;

    expect(queryFields(gqlSchema)['users']!.args.map((a) => a.name)).not.toContain('distinct');
    expect(gqlSchema.getType('UsersDistinctColumn')).toBeUndefined();
    // Other list arguments survive.
    expect(queryFields(gqlSchema)['users']!.args.map((a) => a.name)).toEqual(
      expect.arrayContaining(['where', 'orderBy', 'offset', 'limit']),
    );
  });
});

describe('features: mutations', () => {
  it('omits insert mutations and the insert input when insert is off', () => {
    const { schema: gqlSchema, entities } = build({ insert: false });
    const mutations = gqlSchema.getMutationType()!.getFields();

    expect(mutations['createUsers']).toBeUndefined();
    expect(mutations['createUsersSingle']).toBeUndefined();
    expect(gqlSchema.getType('CreateUsersInput')).toBeUndefined();
    expect(entities.inputs['CreateUsersInput']).toBeUndefined();
    expect(mutations['updateUsers']).toBeDefined();
    expect(mutations['deleteUsers']).toBeDefined();
  });

  it('omits update mutations and the update input when update is off', () => {
    const { schema: gqlSchema, entities } = build({ update: false });
    const mutations = gqlSchema.getMutationType()!.getFields();

    expect(mutations['updateUsers']).toBeUndefined();
    expect(gqlSchema.getType('UpdateUsersInput')).toBeUndefined();
    expect(entities.inputs['UpdateUsersInput']).toBeUndefined();
    expect(mutations['createUsers']).toBeDefined();
  });

  it('omits delete mutations when delete is off', () => {
    const mutations = build({ delete: false }).schema.getMutationType()!.getFields();

    expect(mutations['deleteUsers']).toBeUndefined();
    expect(mutations['createUsers']).toBeDefined();
  });

  it('omits the Mutation type entirely when every mutation feature is off', () => {
    const { schema: gqlSchema, entities } = build({ insert: false, update: false, delete: false });

    expect(gqlSchema.getMutationType()).toBeUndefined();
    expect(Object.keys(entities.mutations)).toHaveLength(0);
    // Queries are unaffected.
    expect(queryFields(gqlSchema)['users']).toBeDefined();
  });
});

describe('features: everything optional turned off', () => {
  it('still builds a valid query-only schema', () => {
    const gqlSchema = build({
      aggregates: false,
      relationAggregates: false,
      distinct: false,
      insert: false,
      update: false,
      delete: false,
    }).schema;

    expect(Object.keys(queryFields(gqlSchema)).sort()).toEqual([
      'customers',
      'customersSingle',
      'posts',
      'postsSingle',
      'tags',
      'tagsSingle',
      'users',
      'usersSingle',
    ]);
    expect(gqlSchema.getMutationType()).toBeUndefined();
  });
});
