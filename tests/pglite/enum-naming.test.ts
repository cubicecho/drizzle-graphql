import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { pgEnum, pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import type { GraphQLEnumType, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EnumNameInfo } from '@/index';
import { buildSchema } from '@/index';

// Only the generated schema is inspected, so no tables are ever created — buildSchema reads
// drizzle metadata and never touches the database.
let pglite: PGlite;

// One pgEnum shared by two tables, plus inline value lists that belong to a single column.
const statusEnum = pgEnum('status', ['active', 'archived']);
const snakeEnum = pgEnum('user_status', ['pending', 'verified']);

const Authors = pgTable('authors', {
  id: text('id').primaryKey(),
  status: statusEnum('status').notNull(),
  tier: text('tier', { enum: ['free', 'paid'] }),
  stage: snakeEnum('stage'),
});

const Posts = pgTable('posts', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull(),
  status: statusEnum('status').notNull(),
  tier: text('tier', { enum: ['free', 'paid'] }),
});

const r = createRelationsHelper({ Authors, Posts });
const relations = buildRelations(
  { Authors, Posts },
  {
    Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
    Posts: { author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }) },
  },
);

const build = (enumNameMapper?: (info: EnumNameInfo) => string | undefined): GraphQLSchema => {
  const db = drizzle({ client: pglite, schema: { Authors, Posts }, relations } as any);
  return buildSchema(db as any, enumNameMapper ? { enumNameMapper } : {}).schema;
};

const fieldTypeName = (gqlSchema: GraphQLSchema, typeName: string, fieldName: string): string =>
  String((gqlSchema.getType(typeName) as GraphQLObjectType).getFields()[fieldName]!.type);

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('enum type naming', () => {
  it('generates one enum per pgEnum, shared by every table that uses it', () => {
    const gqlSchema = build();

    // The declared enum name, not the table and column.
    expect(fieldTypeName(gqlSchema, 'Authors', 'status')).toBe('StatusEnum!');
    expect(fieldTypeName(gqlSchema, 'Posts', 'status')).toBe('StatusEnum!');

    // One type object, so a client variable typed StatusEnum! is passable to either table.
    expect(gqlSchema.getType('AuthorsStatusEnum')).toBeUndefined();
    expect(gqlSchema.getType('PostsStatusEnum')).toBeUndefined();
    expect(gqlSchema.getType('StatusEnum')).toBeDefined();
  });

  it('PascalCases a snake_case enum name', () => {
    expect(fieldTypeName(build(), 'Authors', 'stage')).toBe('UserStatusEnum');
  });

  it('keeps a per-column type for inline value lists', () => {
    const gqlSchema = build();

    // `tier` is declared separately on each table — same values, but nothing says they are
    // the same type, so they stay apart.
    expect(fieldTypeName(gqlSchema, 'Authors', 'tier')).toBe('AuthorsTierEnum');
    expect(fieldTypeName(gqlSchema, 'Posts', 'tier')).toBe('PostsTierEnum');
  });

  it('generates one filter input per shared enum rather than one per column', () => {
    const gqlSchema = build();

    expect(gqlSchema.getType('StatusEnumFilter')).toBeDefined();
    expect(gqlSchema.getType('AuthorsStatusEnumFilter')).toBeUndefined();
    expect(gqlSchema.getType('PostsStatusEnumFilter')).toBeUndefined();
  });

  it('lets enumNameMapper rename a shared enum', () => {
    const gqlSchema = build((info) => (info.enumName === 'status' ? 'PublicationStatus' : undefined));

    expect(fieldTypeName(gqlSchema, 'Authors', 'status')).toBe('PublicationStatus!');
    expect(fieldTypeName(gqlSchema, 'Posts', 'status')).toBe('PublicationStatus!');
    expect(gqlSchema.getType('StatusEnum')).toBeUndefined();
  });

  it('passes the declaring column and values to enumNameMapper', () => {
    const seen: EnumNameInfo[] = [];
    build((info) => {
      seen.push(info);
      return undefined;
    });

    const shared = seen.find((i) => i.enumName === 'status')!;
    expect(shared.values).toEqual(['active', 'archived']);
    // Only a schema-qualified enum carries one; a `public` enum reports none.
    expect(shared.schema).toBeUndefined();

    const inline = seen.find((i) => i.columnName === 'tier')!;
    expect(inline.enumName).toBeUndefined();
    expect(inline.values).toEqual(['free', 'paid']);
    expect(inline.tableName).toBe('Authors');
  });

  it('lets enumNameMapper opt a shared enum back into per-column types', () => {
    const gqlSchema = build((info) =>
      info.enumName === 'status' ? `${info.tableName}${info.columnName}Enum` : undefined,
    );

    expect(fieldTypeName(gqlSchema, 'Authors', 'status')).toBe('AuthorsstatusEnum!');
    expect(fieldTypeName(gqlSchema, 'Posts', 'status')).toBe('PostsstatusEnum!');
  });

  it('unifies inline enums the mapper sends to one name, when their values match', () => {
    const gqlSchema = build((info) => (info.columnName === 'tier' ? 'TierEnum' : undefined));

    expect(fieldTypeName(gqlSchema, 'Authors', 'tier')).toBe('TierEnum');
    expect(fieldTypeName(gqlSchema, 'Posts', 'tier')).toBe('TierEnum');
    expect((gqlSchema.getType('TierEnum') as GraphQLEnumType).getValues().map((v) => v.name)).toEqual(['free', 'paid']);
  });

  it('throws when the mapper sends two different value lists to one name', () => {
    // An invalid schema (two enum types, one name) is caught at build time instead.
    expect(() => build(() => 'OneName')).toThrow(/both map to the GraphQL type name 'OneName'/);
  });

  it('does not share enum types between two builds', () => {
    const first = build();
    const second = build((info) => (info.enumName === 'status' ? 'Renamed' : undefined));

    // The second build's naming applies to the second build only — the registry is per-build,
    // so the first build's cached type does not leak into it or get renamed by it.
    expect(fieldTypeName(first, 'Authors', 'status')).toBe('StatusEnum!');
    expect(fieldTypeName(second, 'Authors', 'status')).toBe('Renamed!');
  });

  it('separates identically named enums declared in different Postgres schemas', () => {
    // Two `status` enums that are genuinely different types; without a mapper they collide.
    const other = pgSchema('reporting');
    const otherStatus = other.enum('status', ['open', 'closed']);
    const Reports = pgTable('reports', { id: text('id').primaryKey(), status: otherStatus('status') });
    const rr = createRelationsHelper({ Authors, Reports });
    const rel = buildRelations({ Authors, Reports }, { Authors: {}, Reports: {} });
    const db = drizzle({ client: pglite, schema: { Authors, Reports }, relations: rel } as any);

    expect(() => buildSchema(db as any, {})).toThrow(/both map to the GraphQL type name 'StatusEnum'/);

    const { schema: gqlSchema } = buildSchema(db as any, {
      enumNameMapper: (info) => (info.schema === 'reporting' ? 'ReportingStatusEnum' : undefined),
    });
    expect(fieldTypeName(gqlSchema, 'Authors', 'status')).toBe('StatusEnum!');
    expect(fieldTypeName(gqlSchema, 'Reports', 'status')).toBe('ReportingStatusEnum');
    expect(rr).toBeDefined();
  });
});
