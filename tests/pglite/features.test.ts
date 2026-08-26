import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { GraphQLEnumType, GraphQLInputObjectType, GraphQLObjectType, GraphQLSchema } from 'graphql';
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
    // Upsert is the one flag that is off unless asked for.
    expect(mutations['upsertUsers']).toBeUndefined();
    expect(queryFields(gqlSchema)['usersGroupBy']).toBeDefined();
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

describe('features: groupBy', () => {
  it('generates the group-by query and its types by default', () => {
    const gqlSchema = build().schema;
    const groupBy = queryFields(gqlSchema)['postsGroupBy'];

    expect(groupBy).toBeDefined();
    expect(groupBy!.args.map((a) => a.name).sort()).toEqual(['groupBy', 'having', 'where']);
    expect(gqlSchema.getType('PostsGroupBy')).toBeDefined();
    expect(gqlSchema.getType('PostsGroupKeys')).toBeDefined();
    expect(gqlSchema.getType('PostsGroupByColumn')).toBeDefined();
    expect(gqlSchema.getType('PostsHaving')).toBeDefined();
    expect(gqlSchema.getType('AggregateNumberFilter')).toBeDefined();
  });

  it('reuses the aggregate output types for the grouped result', () => {
    const gqlSchema = build().schema;
    const groupByFields = (gqlSchema.getType('PostsGroupBy') as GraphQLObjectType).getFields();
    const aggregateFields = (gqlSchema.getType('PostsAggregate') as GraphQLObjectType).getFields();

    expect(Object.keys(groupByFields)).toEqual(['group', ...Object.keys(aggregateFields)]);
    // The very same wrapper instances, so the schema holds one PostsAvgAggregate.
    expect(groupByFields['avg']!.type).toBe(aggregateFields['avg']!.type);
  });

  it('offers only groupable columns as keys', () => {
    const gqlSchema = build().schema;
    const columns = (gqlSchema.getType('UsersGroupByColumn') as GraphQLEnumType).getValues().map((v) => v.name);

    expect(columns).toContain('name');
    expect(columns).toContain('isConfirmed');
    expect(columns).toContain('birthdayDate');
    // Arrays and geometry have no equality to group on.
    expect(columns).not.toContain('a');
    expect(columns).not.toContain('geoXy');
    expect(columns).not.toContain('vector');
  });

  it('offers having filters on the aggregates that compare numerically', () => {
    const gqlSchema = build().schema;
    const having = (gqlSchema.getType('PostsHaving') as GraphQLInputObjectType).getFields();

    expect(Object.keys(having).sort()).toEqual(['avg', 'count', 'countDistinct', 'countNonNull', 'max', 'min', 'sum']);
    // min/max are limited to numeric columns, unlike the output type which covers text too.
    const min = (having['min']!.type as GraphQLInputObjectType).getFields();
    expect(Object.keys(min)).toEqual(['id', 'authorId']);
    expect(Object.keys((having['countNonNull']!.type as GraphQLInputObjectType).getFields())).toContain('content');
  });

  it('omits the group-by query and its types when off', () => {
    const { schema: gqlSchema, entities } = build({ groupBy: false });

    expect(queryFields(gqlSchema)['postsGroupBy']).toBeUndefined();
    expect(gqlSchema.getType('PostsGroupBy')).toBeUndefined();
    expect(gqlSchema.getType('PostsHaving')).toBeUndefined();
    expect(Object.keys(entities.queries).some((name) => name.endsWith('GroupBy'))).toBe(false);
    // The aggregate query is a separate switch.
    expect(queryFields(gqlSchema)['postsAggregate']).toBeDefined();
  });

  it('goes away with aggregates, whose types it reuses', () => {
    const gqlSchema = build({ aggregates: false }).schema;

    expect(queryFields(gqlSchema)['postsGroupBy']).toBeUndefined();
    expect(gqlSchema.getType('PostsGroupBy')).toBeUndefined();
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
    expect(mutations['updateUsersSingle']).toBeUndefined();
    expect(gqlSchema.getType('UpdateUsersInput')).toBeUndefined();
    expect(entities.inputs['UpdateUsersInput']).toBeUndefined();
    expect(mutations['createUsers']).toBeDefined();
  });

  it('omits delete mutations when delete is off', () => {
    const mutations = build({ delete: false }).schema.getMutationType()!.getFields();

    expect(mutations['deleteUsers']).toBeUndefined();
    expect(mutations['deleteUsersSingle']).toBeUndefined();
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

describe('features: upsert', () => {
  it('adds the upsert mutations and their conflict input when on', () => {
    const { schema: gqlSchema, entities } = build({ upsert: true });
    const mutations = gqlSchema.getMutationType()!.getFields();

    expect(mutations['upsertUsers']).toBeDefined();
    expect(mutations['upsertUsersSingle']).toBeDefined();
    expect(gqlSchema.getType('UsersOnConflict')).toBeDefined();
    expect(entities.inputs['UsersOnConflict']).toBeDefined();
  });

  it('keeps the insert input, which types the upsert values, even with insert off', () => {
    const gqlSchema = build({ upsert: true, insert: false }).schema;

    expect(gqlSchema.getMutationType()!.getFields()['createUsers']).toBeUndefined();
    expect(gqlSchema.getType('CreateUsersInput')).toBeDefined();
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
