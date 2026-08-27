import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { GraphQLField, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';
import * as schema from '../schema/pg';

// buildSchema only reads the drizzle metadata, so these tests never touch the database.
let pglite: PGlite;
let db: PgliteDatabase<typeof schema.relations>;

const build = (config?: BuildSchemaConfig) => buildSchema(db, config).schema;

const queryFields = (gqlSchema: GraphQLSchema) => gqlSchema.getQueryType()!.getFields();
const userFields = (gqlSchema: GraphQLSchema) => (gqlSchema.getType('Users') as GraphQLObjectType).getFields();

/** What `graphql-query-complexity`'s fieldExtensionsEstimator reads off a field. */
type Estimator = (options: { args: Record<string, any>; childComplexity: number }) => number;

const estimatorOf = (field: GraphQLField<any, any> | undefined): Estimator | undefined =>
  field?.extensions?.['complexity'] as Estimator | undefined;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle({ client: pglite, relations: schema.relations });
});

afterAll(async () => {
  await pglite.close().catch(console.error);
});

describe('complexity hints', () => {
  it('prices a list query by its page size', () => {
    const estimate = estimatorOf(queryFields(build())['users'])!;

    expect(estimate).toBeTypeOf('function');
    expect(estimate({ args: { limit: 5 }, childComplexity: 3 })).toBe(15);
    // No limit given: the assumed page size stands in for it.
    expect(estimate({ args: {}, childComplexity: 3 })).toBe(30);
    // A row is never free, even when only __typename is selected.
    expect(estimate({ args: { limit: 4 }, childComplexity: 0 })).toBe(4);
  });

  it('ignores a limit that cannot be a page size', () => {
    const estimate = estimatorOf(queryFields(build())['users'])!;

    expect(estimate({ args: { limit: 0 }, childComplexity: 2 })).toBe(20);
    expect(estimate({ args: { limit: null }, childComplexity: 2 })).toBe(20);
  });

  it('prices a to-many relation field the same way', () => {
    const estimate = estimatorOf(userFields(build())['posts'])!;

    expect(estimate({ args: { limit: 10 }, childComplexity: 2 })).toBe(20);
    expect(estimate({ args: {}, childComplexity: 2 })).toBe(20);
  });

  it('charges aggregates a flat scan cost', () => {
    const gqlSchema = build();

    expect(estimatorOf(queryFields(gqlSchema)['usersAggregate'])!({ args: {}, childComplexity: 1 })).toBe(11);
    expect(estimatorOf(userFields(gqlSchema)['postsAggregate'])!({ args: {}, childComplexity: 2 })).toBe(12);
  });

  it('leaves flat fields to the estimator default', () => {
    const gqlSchema = build();

    // A single-row query and a to-one relation both return one row, so their cost is whatever
    // is selected inside them plus the estimator's own per-field default.
    expect(estimatorOf(queryFields(gqlSchema)['usersSingle'])).toBeUndefined();
    expect(estimatorOf(userFields(gqlSchema)['customer'])).toBeUndefined();
    expect(estimatorOf(userFields(gqlSchema)['name'])).toBeUndefined();
  });

  it('honours defaultListSize and aggregateCost', () => {
    const gqlSchema = build({ complexity: { defaultListSize: 100, aggregateCost: 250 } });

    expect(estimatorOf(queryFields(gqlSchema)['users'])!({ args: {}, childComplexity: 1 })).toBe(100);
    expect(estimatorOf(userFields(gqlSchema)['posts'])!({ args: {}, childComplexity: 1 })).toBe(100);
    // An explicit limit still wins over the assumed size.
    expect(estimatorOf(queryFields(gqlSchema)['users'])!({ args: { limit: 2 }, childComplexity: 1 })).toBe(2);
    expect(estimatorOf(queryFields(gqlSchema)['usersAggregate'])!({ args: {}, childComplexity: 0 })).toBe(250);
  });

  it('generates no hints when turned off', () => {
    const gqlSchema = build({ complexity: false });

    expect(estimatorOf(queryFields(gqlSchema)['users'])).toBeUndefined();
    expect(estimatorOf(queryFields(gqlSchema)['usersAggregate'])).toBeUndefined();
    expect(estimatorOf(userFields(gqlSchema)['posts'])).toBeUndefined();
    expect(estimatorOf(userFields(gqlSchema)['postsAggregate'])).toBeUndefined();
  });

  it('treats complexity: true as the defaults', () => {
    const gqlSchema = build({ complexity: true });

    expect(estimatorOf(queryFields(gqlSchema)['users'])!({ args: {}, childComplexity: 1 })).toBe(10);
  });
});

describe('complexity hints: whole-query cost', () => {
  // A miniature version of what fieldExtensionsEstimator + simpleEstimator do, so the hints are
  // exercised the way a complexity rule would use them rather than one field at a time.
  const cost = (gqlSchema: GraphQLSchema, typeName: string, selection: Record<string, any>): number => {
    const fields = (gqlSchema.getType(typeName) as GraphQLObjectType).getFields();

    return Object.entries(selection).reduce((total, [fieldName, node]) => {
      const field = fields[fieldName]!;
      const { args = {}, children, type } = node as { args?: any; children?: any; type?: string };
      const childComplexity = children ? cost(gqlSchema, type!, children) : 0;
      const estimate = estimatorOf(field);

      return total + (estimate ? estimate({ args, childComplexity }) : childComplexity + 1);
    }, 0);
  };

  it('multiplies down a nested query', () => {
    const gqlSchema = build();

    // { users(limit: 20) { id posts(limit: 5) { id } } }
    //   → 20 * (1 + 5 * 1) = 120
    expect(
      cost(gqlSchema, 'Query', {
        users: {
          args: { limit: 20 },
          type: 'Users',
          children: { id: {}, posts: { args: { limit: 5 }, type: 'Posts', children: { id: {} } } },
        },
      }),
    ).toBe(120);
  });

  it('collapses to a flat count with the hints off', () => {
    const gqlSchema = build({ complexity: false });

    expect(
      cost(gqlSchema, 'Query', {
        users: {
          args: { limit: 20 },
          type: 'Users',
          children: { id: {}, posts: { args: { limit: 5 }, type: 'Posts', children: { id: {} } } },
        },
      }),
    ).toBe(4);
  });
});
