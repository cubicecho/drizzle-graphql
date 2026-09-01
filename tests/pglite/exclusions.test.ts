import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
  type GraphQLEnumType,
  type GraphQLInputObjectType,
  type GraphQLObjectType,
  type GraphQLSchema,
  graphql,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSchema, type SchemaExclusions } from '@/index';
import * as schema from '../schema/pg';
import { unknownInputField } from '../util/validation-messages';
import { setupTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-exclusions-${Date.now()}`;
let pglite: PGlite;
let db: any;

const buildWith = (exclude?: SchemaExclusions, extra?: Record<string, unknown>): GraphQLSchema =>
  buildSchema(db, {
    features: { upsert: true, nestedWrites: true },
    ...(exclude ? { exclude } : {}),
    ...extra,
  }).schema;

const run = (gqlSchema: GraphQLSchema, source: string) => graphql({ schema: gqlSchema, source, contextValue: {} });

const fieldNames = (gqlSchema: GraphQLSchema, typeName: string): string[] => {
  const type = gqlSchema.getType(typeName) as GraphQLObjectType | GraphQLInputObjectType | undefined;
  return type ? Object.keys(type.getFields()) : [];
};

const enumValues = (gqlSchema: GraphQLSchema, typeName: string): string[] => {
  const type = gqlSchema.getType(typeName) as GraphQLEnumType | undefined;
  return type ? type.getValues().map((value) => value.name) : [];
};

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations: schema.relations, logger: !!process.env['LOG_SQL'] });
  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  await setupTables({ db } as any);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('schema exclusions', () => {
  describe('without an exclude config', () => {
    it('generates every table and column', () => {
      const gqlSchema = buildWith();

      expect(gqlSchema.getType('Customers')).toBeDefined();
      expect(Object.keys(gqlSchema.getQueryType()!.getFields())).toContain('customers');
      expect(fieldNames(gqlSchema, 'Users')).toContain('customer');
      expect(fieldNames(gqlSchema, 'Posts')).toContain('content');
    });
  });

  describe('excluded tables', () => {
    const exclude: SchemaExclusions = { tables: ['Customers'] };

    it('generates no type for the table', () => {
      const gqlSchema = buildWith(exclude);

      expect(gqlSchema.getType('Customers')).toBeUndefined();
      expect(gqlSchema.getType('CustomersFilters')).toBeUndefined();
      expect(gqlSchema.getType('CreateCustomersInput')).toBeUndefined();
      expect(gqlSchema.getType('CustomersAggregate')).toBeUndefined();
    });

    it('generates no root queries or mutations for it', () => {
      const gqlSchema = buildWith(exclude);
      const queries = Object.keys(gqlSchema.getQueryType()!.getFields());
      const mutations = Object.keys(gqlSchema.getMutationType()!.getFields());

      expect(queries.filter((name) => name.toLowerCase().startsWith('customer'))).toEqual([]);
      expect(mutations.filter((name) => name.toLowerCase().includes('customer'))).toEqual([]);
      // The other tables are untouched.
      expect(queries).toContain('users');
      expect(queries).toContain('posts');
    });

    it('removes relation fields that point at it', () => {
      const gqlSchema = buildWith(exclude);

      expect(fieldNames(gqlSchema, 'Users')).not.toContain('customer');
      expect(fieldNames(gqlSchema, 'Posts')).not.toContain('customer');
      // Relations to tables that are still present survive.
      expect(fieldNames(gqlSchema, 'Users')).toContain('posts');
      expect(fieldNames(gqlSchema, 'Posts')).toContain('author');
    });

    it('removes it from relation filters, so it is unreachable rather than merely unnamed', () => {
      const gqlSchema = buildWith(exclude);

      expect(fieldNames(gqlSchema, 'UsersFilters')).not.toContain('customer');
      expect(fieldNames(gqlSchema, 'UsersFilters')).toContain('posts');
    });

    it('rejects a query naming it', async () => {
      const gqlSchema = buildWith(exclude);
      const res = await run(gqlSchema, `{ customers { id } }`);

      expect(res.errors?.[0]?.message).toMatch(/Cannot query field "customers"/);
    });

    it('leaves the surviving tables queryable', async () => {
      const gqlSchema = buildWith(exclude);
      const res = await run(gqlSchema, `{ users { id posts { id } } }`);

      expect(res.errors).toBeUndefined();
      expect((res.data as any).users).toHaveLength(3);
    });
  });

  describe('excluded columns', () => {
    const exclude: SchemaExclusions = { columns: { Posts: ['content'] } };

    it('removes the column from the object type', () => {
      const gqlSchema = buildWith(exclude);

      expect(fieldNames(gqlSchema, 'Posts')).not.toContain('content');
      expect(fieldNames(gqlSchema, 'Posts')).toEqual(expect.arrayContaining(['id', 'authorId']));
    });

    it('removes it from the create, update and upsert inputs', () => {
      const gqlSchema = buildWith(exclude);

      expect(fieldNames(gqlSchema, 'CreatePostsInput')).not.toContain('content');
      expect(fieldNames(gqlSchema, 'UpdatePostsInput')).not.toContain('content');
      // Upsert reuses the create input and adds a conflict target enum of its own.
      expect(enumValues(gqlSchema, 'PostsConflictColumn')).not.toContain('content');
    });

    it('removes it from filters and orderBy — an excluded column is not a filterable oracle', () => {
      const gqlSchema = buildWith(exclude);

      expect(fieldNames(gqlSchema, 'PostsFilters')).not.toContain('content');
      expect(fieldNames(gqlSchema, 'PostsOrderBy')).not.toContain('content');
      expect(fieldNames(gqlSchema, 'PostsOrderBy')).toContain('id');
    });

    it('removes it from the distinct and groupBy enums', () => {
      const gqlSchema = buildWith(exclude);

      expect(enumValues(gqlSchema, 'PostsDistinctColumn')).not.toContain('content');
      expect(enumValues(gqlSchema, 'PostsDistinctColumn')).toContain('id');
      expect(enumValues(gqlSchema, 'PostsGroupByColumn')).not.toContain('content');
    });

    it('removes it from the aggregate fields', () => {
      const gqlSchema = buildWith(exclude);

      expect(fieldNames(gqlSchema, 'PostsMaxAggregate')).not.toContain('content');
      expect(fieldNames(gqlSchema, 'PostsMinAggregate')).not.toContain('content');
    });

    it('rejects a query selecting or filtering on it', async () => {
      const gqlSchema = buildWith(exclude);

      const selected = await run(gqlSchema, `{ posts { id content } }`);
      expect(selected.errors?.[0]?.message).toMatch(/Cannot query field "content"/);

      const filtered = await run(gqlSchema, `{ posts(where: { content: { eq: "1MESSAGE" } }) { id } }`);
      expect(filtered.errors?.[0]?.message).toMatch(unknownInputField('content'));
    });

    it('leaves the rest of the table working, including inserts', async () => {
      const gqlSchema = buildWith(exclude);
      const read = await run(gqlSchema, `{ posts(orderBy: { id: { direction: asc, priority: 1 } }) { id authorId } }`);

      expect(read.errors).toBeUndefined();
      expect((read.data as any).posts[0]).toEqual({ id: 1, authorId: 1 });

      // An explicit id, since the seed rows were inserted with fixed ids and left the sequence behind.
      const written = await run(
        gqlSchema,
        `mutation { createPostsSingle(values: { id: 101, authorId: 1 }) { id authorId } }`,
      );
      expect(written.errors).toBeUndefined();
      expect((written.data as any).createPostsSingle).toEqual({ id: 101, authorId: 1 });
    });

    it('leaves other tables untouched', () => {
      const gqlSchema = buildWith(exclude);

      expect(fieldNames(gqlSchema, 'Tags')).toContain('description');
      expect(fieldNames(gqlSchema, 'Users')).toContain('name');
    });

    it('hides the column on a nested-write payload too', () => {
      const gqlSchema = buildWith(exclude);
      // Users.posts nested create builds its own payload input from the target table.
      expect(fieldNames(gqlSchema, 'UsersPostsNestedCreatePayloadInput')).not.toContain('content');
    });
  });

  describe('cross-build isolation', () => {
    it('does not leak exclusions between builds of the same tables', () => {
      // Order matters: the unfiltered build populates the module-level order and enum caches
      // first, so a leak would show up as the filtered build reusing them (or vice versa).
      const plain = buildWith();
      const filtered = buildWith({ columns: { Posts: ['content'] } });
      const plainAgain = buildWith();

      expect(fieldNames(plain, 'PostsOrderBy')).toContain('content');
      expect(fieldNames(filtered, 'PostsOrderBy')).not.toContain('content');
      expect(fieldNames(plainAgain, 'PostsOrderBy')).toContain('content');

      expect(enumValues(plain, 'PostsDistinctColumn')).toContain('content');
      expect(enumValues(filtered, 'PostsDistinctColumn')).not.toContain('content');
      expect(enumValues(plainAgain, 'PostsDistinctColumn')).toContain('content');
    });
  });

  describe('config validation', () => {
    it('throws for a table that does not exist', () => {
      expect(() => buildWith({ tables: ['Nope'] })).toThrow(/config\.exclude\.tables names 'Nope'/);
    });

    it('throws for a column table that does not exist', () => {
      expect(() => buildWith({ columns: { Nope: ['id'] } })).toThrow(/config\.exclude\.columns names table 'Nope'/);
    });

    it('throws for a column that does not exist', () => {
      expect(() => buildWith({ columns: { Posts: ['nope'] } })).toThrow(/config\.exclude\.columns names 'Posts\.nope'/);
    });

    it('throws when every table is excluded', () => {
      expect(() => buildWith({ tables: ['Users', 'Customers', 'Posts', 'Tags'] })).toThrow(/excludes every table/);
    });

    it('warns when an excluded column is NOT NULL with no default', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        buildWith({ columns: { Tags: ['name'] } });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("'Tags.name' is NOT NULL with no default"));
      } finally {
        warn.mockRestore();
      }
    });

    it('does not warn for a nullable or defaulted column', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        buildWith({ columns: { Tags: ['description'], Users: ['createdAt'] } });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('accepts column entries for a table that is itself excluded', () => {
      expect(() => buildWith({ tables: ['Customers'], columns: { Customers: ['address'] } })).not.toThrow();
    });
  });
});
