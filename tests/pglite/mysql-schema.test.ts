// @ts-nocheck — mock db doesn't satisfy the MySqlDatabase type, which is fine for unit testing
// This file tests the MySQL schema-generation code paths without a Docker/MySQL connection.
// It calls generateSchemaData (generateMySQL) directly with a minimal mock db whose resolver
// closures are never invoked — only the schema structure is inspected.

import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
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

const entities = generateMySQL(mockDb, tableSchema, schema.relations, undefined, prefixes, suffixes) as any;

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

  it('all 6 mutations exist per table (array+single insert, update, delete)', () => {
    const mutationKeys = Object.keys(entities.mutations);
    // Users
    expect(mutationKeys).toContain('createUsers');
    expect(mutationKeys).toContain('createUsersSingle');
    expect(mutationKeys).toContain('updateUsers');
    expect(mutationKeys).toContain('deleteUsers');
    // Posts
    expect(mutationKeys).toContain('createPosts');
    expect(mutationKeys).toContain('deletePosts');
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
