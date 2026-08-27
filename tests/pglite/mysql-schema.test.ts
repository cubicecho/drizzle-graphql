// @ts-nocheck — mock db doesn't satisfy the MySqlDatabase type, which is fine for unit testing
// This file tests the MySQL schema-generation code paths without a Docker/MySQL connection.
// It calls generateSchemaData (generateMySQL) directly with a minimal mock db whose resolver
// closures are never invoked — only the schema structure is inspected.

import { sql } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { extractOrderBy } from '@/index';
import { generateMySQL } from '@/util/builders';
import * as schema from '../schema/mysql';

// ── minimal mock ──────────────────────────────────────────────────────────────
// db.query[tableName] must be truthy — MySQL throws if it's undefined.
// The individual methods are closured into resolver functions but never called here.
const mockQueryBuilder = { findMany: async () => [], findFirst: async () => null };

const mockDb: any = {
  query: {
    Users: mockQueryBuilder,
    Customers: mockQueryBuilder,
    Posts: mockQueryBuilder,
  },
  select: () => ({}),
  insert: () => ({}),
  update: () => ({}),
  delete: () => ({}),
};

const tableSchema = { Users: schema.Users, Customers: schema.Customers, Posts: schema.Posts };
const prefixes = { insert: 'create', delete: 'delete', update: 'update' };
const suffixes = { list: '', single: 'Single' };

const entities = generateMySQL(mockDb, tableSchema, schema.relations, {
  relationsDepthLimit: undefined,
  prefixes,
  suffixes,
  conflictDoNothing: false,
  shouldEagerLoad: () => true,
  complexity: { defaultListSize: 10, aggregateCost: 10 },
  features: {
    aggregates: true,
    relationAggregates: true,
    distinct: true,
    insert: true,
    update: true,
    delete: true,
    upsert: false,
  },
}) as any;

// Upsert is opt-in, so a second generation is needed to inspect its shape.
const upsertEntities = generateMySQL(mockDb, tableSchema, schema.relations, {
  relationsDepthLimit: undefined,
  prefixes: { ...prefixes, upsert: 'upsert' },
  suffixes,
  conflictDoNothing: false,
  shouldEagerLoad: () => true,
  features: {
    aggregates: true,
    relationAggregates: true,
    distinct: true,
    insert: true,
    update: true,
    delete: true,
    upsert: true,
  },
}) as any;

// The two flags this file's main generation leaves off, so their shapes can be inspected
// against MySQL's otherwise uniform mutation return type.
const optInEntities = generateMySQL(mockDb, tableSchema, schema.relations, {
  relationsDepthLimit: undefined,
  prefixes,
  suffixes,
  conflictDoNothing: false,
  shouldEagerLoad: () => true,
  features: {
    aggregates: true,
    relationAggregates: true,
    distinct: true,
    insert: true,
    update: true,
    delete: true,
    upsert: false,
    fieldUpdateOperations: true,
    countMutations: true,
  },
}) as any;

// ── query structure ───────────────────────────────────────────────────────────

describe('MySQL generated queries', () => {
  const queryKeys = Object.keys(entities.queries);

  it('generates list and single queries for each table', () => {
    expect(queryKeys).toContain('users');
    expect(queryKeys).toContain('usersSingle');
    expect(queryKeys).toContain('customers');
    expect(queryKeys).toContain('customersSingle');
    expect(queryKeys).toContain('posts');
    expect(queryKeys).toContain('postsSingle');
  });

  it('does not include Tags (not in MySQL schema)', () => {
    expect(queryKeys).not.toContain('tags');
  });

  it('query types are non-null list of the table type (not MutationReturn)', () => {
    const usersQuery = entities.queries['users'];
    expect(usersQuery.type).toBeInstanceOf(GraphQLNonNull);
  });

  it('list queries take a distinct arg listing the table columns', () => {
    const distinctArg = entities.queries['posts'].args['distinct'];
    expect(distinctArg).toBeDefined();
    expect(distinctArg.type.ofType.ofType.name).toBe('PostsDistinctColumn');
    expect(distinctArg.type.ofType.ofType.getValues().map((value: { name: string }) => value.name)).toEqual([
      'id',
      'content',
      'authorId',
    ]);
    expect(entities.queries['postsSingle'].args['distinct']).toBeUndefined();
  });
});

// ── mutation structure — returnless (MySQL-specific) ─────────────────────────

describe('MySQL mutations are returnless', () => {
  it('types exposes a MutationReturn type', () => {
    expect(entities.types['MutationReturn']).toBeInstanceOf(GraphQLObjectType);
    expect(entities.types['MutationReturn'].name).toBe('MutationReturn');
    const fields = entities.types['MutationReturn'].getFields();
    expect(fields['isSuccess']).toBeDefined();
  });

  it('insert mutations return MutationReturn, not the table type', () => {
    expect(entities.mutations['createUsers'].type).toBe(entities.types['MutationReturn']);
    expect(entities.mutations['createUsersSingle'].type).toBe(entities.types['MutationReturn']);
  });

  it('update mutations return MutationReturn', () => {
    expect(entities.mutations['updateUsers'].type).toBe(entities.types['MutationReturn']);
    expect(entities.mutations['updateCustomers'].type).toBe(entities.types['MutationReturn']);
  });

  it('delete mutations return MutationReturn', () => {
    expect(entities.mutations['deleteUsers'].type).toBe(entities.types['MutationReturn']);
    expect(entities.mutations['deletePosts'].type).toBe(entities.types['MutationReturn']);
  });

  it('single update/delete variants return MutationReturn and require where', () => {
    expect(entities.mutations['updateUsersSingle'].type).toBe(entities.types['MutationReturn']);
    expect(entities.mutations['deleteUsersSingle'].type).toBe(entities.types['MutationReturn']);
    expect(entities.mutations['updateUsersSingle'].args['where'].type).toBeInstanceOf(GraphQLNonNull);
    expect(entities.mutations['deleteUsersSingle'].args['where'].type).toBeInstanceOf(GraphQLNonNull);
    // Plural where stays nullable by default.
    expect(entities.mutations['updateUsers'].args['where'].type).not.toBeInstanceOf(GraphQLNonNull);
    expect(entities.mutations['deleteUsers'].args['where'].type).not.toBeInstanceOf(GraphQLNonNull);
  });

  it('generates no upsert mutations unless the feature is on', () => {
    expect(entities.mutations['upsertUsers']).toBeUndefined();
    expect(entities.types['UsersOnConflict']).toBeUndefined();
  });

  it('upsert mutations return MutationReturn like every other MySQL mutation', () => {
    expect(upsertEntities.mutations['upsertUsers'].type).toBe(upsertEntities.types['MutationReturn']);
    expect(upsertEntities.mutations['upsertUsersSingle'].type).toBe(upsertEntities.types['MutationReturn']);
  });

  it('omits target and where from the conflict input, which MySQL cannot express', () => {
    const onConflict = upsertEntities.inputs['UsersOnConflict'];
    expect(Object.keys(onConflict.getFields()).sort()).toEqual(['action', 'update']);
    // Every table is upsertable on MySQL — a conflict needs no declared target.
    expect(upsertEntities.mutations['upsertPosts']).toBeDefined();
  });

  it('all mutations exist per table (array+single insert, update, delete, and their single variants)', () => {
    const mutationKeys = Object.keys(entities.mutations);
    // Users
    expect(mutationKeys).toContain('createUsers');
    expect(mutationKeys).toContain('createUsersSingle');
    expect(mutationKeys).toContain('updateUsers');
    expect(mutationKeys).toContain('updateUsersSingle');
    expect(mutationKeys).toContain('deleteUsers');
    expect(mutationKeys).toContain('deleteUsersSingle');
    // Posts
    expect(mutationKeys).toContain('createPosts');
    expect(mutationKeys).toContain('deletePosts');
    expect(mutationKeys).toContain('updatePostsSingle');
    expect(mutationKeys).toContain('deletePostsSingle');
  });
});

// ── aggregates ────────────────────────────────────────────────────────────────

describe('MySQL generated aggregate queries', () => {
  it('generates an aggregate query per table', () => {
    const queryKeys = Object.keys(entities.queries);
    expect(queryKeys).toContain('usersAggregate');
    expect(queryKeys).toContain('customersAggregate');
    expect(queryKeys).toContain('postsAggregate');
  });

  it('aggregate query returns a non-null aggregate type and takes only a where arg', () => {
    const query = entities.queries['usersAggregate'];
    expect(query.type).toBeInstanceOf(GraphQLNonNull);
    expect(query.type.ofType).toBe(entities.types['UsersAggregate']);
    expect(Object.keys(query.args)).toEqual(['where']);
    expect(query.args['where'].type).toBe(entities.inputs['UsersFilters']);
  });

  it('aggregate type exposes count plus the aggregation groups', () => {
    const fields = entities.types['UsersAggregate'].getFields();
    expect(Object.keys(fields)).toEqual(['count', 'avg', 'sum', 'min', 'max', 'countNonNull', 'countDistinct']);
    expect(fields['count'].type).toBeInstanceOf(GraphQLNonNull);
  });

  it('avg/sum only cover numeric columns', () => {
    const fields = entities.types['UsersAggregate'].getFields();
    expect(Object.keys(fields['avg'].type.getFields())).toEqual(['id']);
    expect(Object.keys(fields['sum'].type.getFields())).toEqual(['id']);
  });

  it('min/max cover orderable columns, including dates, enums, and bigints', () => {
    const fields = entities.types['UsersAggregate'].getFields();
    const minFields = Object.keys(fields['min'].type.getFields());

    expect(minFields).toContain('id');
    expect(minFields).toContain('name');
    expect(minFields).toContain('bigint');
    expect(minFields).toContain('birthdayString');
    expect(minFields).toContain('birthdayDate');
    expect(minFields).toContain('createdAt');
    expect(minFields).toContain('role');
    // Booleans have no useful ordering.
    expect(minFields).not.toContain('isConfirmed');
    expect(Object.keys(fields['max'].type.getFields())).toEqual(minFields);
  });
});

// ── types and inputs ──────────────────────────────────────────────────────────

describe('MySQL generated types and inputs', () => {
  it('generates a GraphQL object type for each table', () => {
    expect(entities.types['Users']).toBeInstanceOf(GraphQLObjectType);
    expect(entities.types['Customers']).toBeInstanceOf(GraphQLObjectType);
    expect(entities.types['Posts']).toBeInstanceOf(GraphQLObjectType);
  });

  it('Users type has column fields', () => {
    const fields = entities.types['Users'].getFields();
    expect(fields['id']).toBeDefined();
    expect(fields['name']).toBeDefined();
    expect(fields['email']).toBeDefined();
    expect(fields['isConfirmed']).toBeDefined();
  });

  it('Users type has relation fields', () => {
    const fields = entities.types['Users'].getFields();
    expect(fields['posts']).toBeDefined();
    expect(fields['customer']).toBeDefined();
  });

  it('generates filter and order inputs for each table', () => {
    expect(entities.inputs['UsersFilters']).toBeDefined();
    expect(entities.inputs['UsersOrderBy']).toBeDefined();
    expect(entities.inputs['CreateUsersInput']).toBeDefined();
    expect(entities.inputs['UpdateUsersInput']).toBeDefined();
  });

  it('OrderBy inputs expose to-one relation fields and the nulls option', () => {
    const userOrderFields = entities.inputs['UsersOrderBy'].getFields();
    // To-one relation gets the target's own OrderBy input; the to-many `posts` does not.
    expect(userOrderFields['customer']).toBeDefined();
    expect(userOrderFields['customer'].type.toString()).toBe('CustomersOrderBy');
    expect(userOrderFields['posts']).toBeUndefined();

    // MySQL keeps the same surface as the other dialects — `nulls` is emulated, not omitted.
    const innerOrderFields = userOrderFields['email'].type.getFields();
    expect(innerOrderFields['nulls']).toBeDefined();
    expect(innerOrderFields['nulls'].type.toString()).toBe('OrderNulls');
  });
});

// ── nulls emulation ───────────────────────────────────────────────────────────

describe('MySQL nulls first/last emulation', () => {
  const dialect = new MySqlDialect();
  const render = (exprs: any[]) => dialect.sqlToQuery(sql.join(exprs, sql`, `)).sql.toLowerCase();

  it('compiles nulls: first to an IS NULL sort key instead of NULLS FIRST', () => {
    const exprs = extractOrderBy(schema.Users, { email: { direction: 'asc', priority: 1, nulls: 'first' } });
    expect(exprs).toHaveLength(2);

    const rendered = render(exprs);
    expect(rendered).toContain('is null');
    expect(rendered).not.toContain('nulls first');
    // Nulls-first means the IS NULL key sorts descending (true before false).
    expect(rendered).toMatch(/is null\) desc/);
  });

  it('compiles nulls: last to an ascending IS NULL sort key', () => {
    const exprs = extractOrderBy(schema.Users, { email: { direction: 'desc', priority: 1, nulls: 'last' } });
    expect(exprs).toHaveLength(2);

    const rendered = render(exprs);
    expect(rendered).not.toContain('nulls last');
    expect(rendered).toMatch(/is null\) asc/);
  });
});

// ── fieldResolvers ────────────────────────────────────────────────────────────

describe('MySQL fieldResolvers', () => {
  it('exposes relation field resolvers for each table', () => {
    expect(typeof entities.fieldResolvers['Users']?.['posts']).toBe('function');
    expect(typeof entities.fieldResolvers['Users']?.['customer']).toBe('function');
    expect(typeof entities.fieldResolvers['Posts']?.['author']).toBe('function');
  });

  it('Tags has no fieldResolvers entry (not in MySQL schema)', () => {
    expect(entities.fieldResolvers['Tags']).toBeUndefined();
  });
});

// ── complexity hints ──────────────────────────────────────────────────────────

describe('MySQL complexity hints', () => {
  const estimate = (field: any, args: any, childComplexity: number) =>
    field.extensions.complexity({ args, childComplexity });

  // The Users object type is reachable through the list query it is returned from.
  const userFields = () => (entities.queries['users'].type.ofType.ofType.ofType as GraphQLObjectType).getFields();

  it('prices list queries and to-many relations by page size', () => {
    expect(estimate(entities.queries['users'], { limit: 3 }, 2)).toBe(6);
    expect(estimate(entities.queries['users'], {}, 2)).toBe(20);

    expect(estimate(userFields()['posts'], { limit: 4 }, 1)).toBe(4);
  });

  it('charges aggregates a flat scan cost', () => {
    expect(estimate(entities.queries['usersAggregate'], {}, 1)).toBe(11);
    expect(estimate(userFields()['postsAggregate'], {}, 0)).toBe(10);
  });

  it('leaves single queries flat', () => {
    // The identity block is always published; a single query just has no cost hint beside it.
    expect(entities.queries['usersSingle'].extensions['complexity']).toBeUndefined();
  });
});

// ── the two opt-in mutation shapes ────────────────────────────────────────────

describe('MySQL count mutations', () => {
  it('are absent unless the feature is on', () => {
    expect(entities.mutations['updateUsersCount']).toBeUndefined();
    expect(entities.mutations['deleteUsersCount']).toBeUndefined();
  });

  it('return Int! — the one mutation pair that is not MutationReturn', () => {
    expect(String(optInEntities.mutations['updateUsersCount'].type)).toBe('Int!');
    expect(String(optInEntities.mutations['deleteUsersCount'].type)).toBe('Int!');
    // Which is the point: MySQL's writes report nothing but success, so a count is the only
    // way to learn how many rows a bulk write touched.
    expect(optInEntities.mutations['updateUsers'].type).toBe(optInEntities.types['MutationReturn']);
  });

  it('take the same arguments as the writes they mirror', () => {
    expect(Object.keys(optInEntities.mutations['updateUsersCount'].args)).toEqual(['set', 'where']);
    expect(Object.keys(optInEntities.mutations['deleteUsersCount'].args)).toEqual(['where']);
  });
});

describe('MySQL field update operations', () => {
  it("replaces a numeric column's update field with an operations input", () => {
    const fields = optInEntities.inputs['UpdateUsersInput'].getFields();

    expect(String(fields['id'].type)).toBe('IntFieldUpdate');
    expect(String(fields['name'].type)).toBe('String');
  });

  it('leaves the update input set-only when the flag is off', () => {
    expect(String(entities.inputs['UpdateUsersInput'].getFields()['id'].type)).toBe('Int');
  });
});
