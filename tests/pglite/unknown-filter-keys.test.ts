import { getColumns } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildNamedRelations,
  extractFilters,
  extractFiltersColumn,
  type RelationFilterContext,
} from '@/util/builders/common';
import { type Context, createCtx, schema, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-unknown-filter-keys-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5180, DATA_DIR);
});
afterAll(async () => {
  await teardownServer(ctx, DATA_DIR);
});
beforeEach(async () => {
  await setupTables(ctx);
});
afterEach(async () => {
  await teardownTables(ctx);
});

const tables = {
  Users: schema.Users,
  Customers: schema.Customers,
  Posts: schema.Posts,
  Tags: schema.Tags,
};

/**
 * Builds the same relation filter context the generators hand to every resolver, narrowed
 * to one table — so these tests exercise extractFilters exactly the way a resolver does
 * when a stitched/merged schema lets foreign keys through input validation.
 */
const relationCtxFor = (tableKey: string): RelationFilterContext => ({
  tables,
  relationMap: buildNamedRelations((ctx.db as any)._.relations ?? {}, Object.entries(tables)),
  tableKey,
});

describe('extractFilters unknown key handling (stitched-schema scenario)', () => {
  it('throws a GraphQLError for a key that is neither a column nor a relation', () => {
    expect(() => extractFilters(schema.Users, 'users', { equals: { eq: 1 } } as any, relationCtxFor('Users'))).toThrow(
      /Unknown filter key: equals/,
    );

    try {
      extractFilters(schema.Users, 'users', { equals: { eq: 1 } } as any, relationCtxFor('Users'));
      expect.unreachable('extractFilters should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
    }
  });

  it('throws for an unknown key even without a relation filter context', () => {
    expect(() => extractFilters(schema.Tags, 'tags', { contains: 'foo' } as any)).toThrow(
      /WHERE tags: Unknown filter key: contains/,
    );
  });

  it('throws for a relation key when no relation filter context is available', () => {
    expect(() => extractFilters(schema.Users, 'users', { posts: { some: { id: { eq: 1 } } } } as any)).toThrow(
      /WHERE users: Unknown filter key: posts/,
    );
  });

  it('throws for an unknown key inside a table-level OR variant', () => {
    expect(() =>
      extractFilters(schema.Users, 'users', { OR: [{ id: { eq: 1 } }, { equals: 1 }] } as any, relationCtxFor('Users')),
    ).toThrow(/Unknown filter key: equals/);
  });

  it('throws for an unknown key inside a to-many relation wrapper', () => {
    expect(() =>
      extractFilters(schema.Users, 'users', { posts: { equals: { id: { eq: 1 } } } } as any, relationCtxFor('Users')),
    ).toThrow(/WHERE posts: Unknown relation filter key: equals/);
  });

  it('throws for an unknown key nested inside a some/none/every filter', () => {
    expect(() =>
      extractFilters(schema.Users, 'users', { posts: { some: { foo: { eq: 1 } } } } as any, relationCtxFor('Users')),
    ).toThrow(/Unknown filter key: foo/);
  });

  it('throws for an unknown key inside a to-one relation filter', () => {
    expect(() =>
      extractFilters(schema.Users, 'users', { customer: { equals: 1 } } as any, relationCtxFor('Users')),
    ).toThrow(/Unknown filter key: equals/);
  });
});

describe('extractFiltersColumn unknown operator handling', () => {
  const nameColumn = getColumns(schema.Users).name;

  it('throws a GraphQLError for an unrecognized operator', () => {
    expect(() => extractFiltersColumn(nameColumn, 'name', { contains: 'First' } as any)).toThrow(
      /WHERE name: Unknown operator: contains/,
    );

    try {
      extractFiltersColumn(nameColumn, 'name', { equals: 'First' } as any);
      expect.unreachable('extractFiltersColumn should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
    }
  });

  it('throws for an unrecognized operator via extractFilters', () => {
    expect(() => extractFilters(schema.Users, 'users', { name: { mode: 'insensitive' } } as any)).toThrow(
      /WHERE name: Unknown operator: mode/,
    );
  });

  it('throws for an unrecognized operator inside a column-level OR variant', () => {
    expect(() => extractFiltersColumn(nameColumn, 'name', { OR: [{ eq: 'a' }, { contains: 'b' }] } as any)).toThrow(
      /WHERE name: Unknown operator: contains/,
    );
  });
});

describe('legitimate filters are unaffected', () => {
  it('extracts column operators, OR variants and null-valued keys without throwing', () => {
    expect(extractFilters(schema.Users, 'users', { id: { eq: 1 }, name: { ilike: '%user%' } } as any)).toBeDefined();
    expect(extractFilters(schema.Users, 'users', { OR: [{ id: { eq: 1 } }, { id: { eq: 2 } }] } as any)).toBeDefined();
    expect(extractFilters(schema.Users, 'users', { email: { isNull: true } } as any)).toBeDefined();
    // Explicit nulls mean "no filter" and are still skipped, not treated as unknown.
    expect(extractFilters(schema.Users, 'users', { name: null, id: { eq: 1 } } as any)).toBeDefined();
    expect(extractFilters(schema.Users, 'users', { name: { isNull: false } } as any)).toBeUndefined();
  });

  it('extracts relation filters (some/none/every and to-one) without throwing', () => {
    const relationCtx = relationCtxFor('Users');
    expect(
      extractFilters(schema.Users, 'users', { posts: { some: { content: { eq: '1MESSAGE' } } } } as any, relationCtx),
    ).toBeDefined();
    expect(
      extractFilters(
        schema.Users,
        'users',
        { posts: { none: { content: { eq: 'x' } }, every: { content: { isNotNull: true } } } } as any,
        relationCtx,
      ),
    ).toBeDefined();
    expect(
      extractFilters(schema.Users, 'users', { customer: { address: { eq: 'AdOne' } } } as any, relationCtx),
    ).toBeDefined();
  });
});

describe.sequential('end-to-end: valid filters still resolve', () => {
  it('filters by column and relation through the generated schema', async () => {
    const res = await ctx.gql.queryGql(`{
      users(where: { name: { eq: "FirstUser" }, posts: { some: { content: { eq: "1MESSAGE" } } } }) { id }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.users).toEqual([{ id: 1 }]);
  });

  it('filters a relation field with a nested where argument', async () => {
    const res = await ctx.gql.queryGql(`{
      users(where: { id: { eq: 1 } }) { id posts(where: { content: { like: "1%" } }) { id content } }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.users).toEqual([{ id: 1, posts: [{ id: 1, content: '1MESSAGE' }] }]);
  });
});
