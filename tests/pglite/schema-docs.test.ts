import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import {
  type GraphQLInputObjectType,
  type GraphQLObjectType,
  type GraphQLSchema,
  isInputObjectType,
  isObjectType,
  printSchema,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildSchemaConfig } from '@/index';
import { buildSchema } from '@/index';

// buildSchema reads drizzle metadata only, so nothing is ever created in the database.
let pglite: PGlite;

const Authors = pgTable('authors', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  bio: text('bio'),
  active: boolean('active'),
  createdAt: timestamp('created_at'),
  tags: text('tags').array(),
});

const Posts = pgTable('posts', {
  id: integer('id').primaryKey(),
  authorId: integer('author_id').notNull(),
  title: text('title').notNull(),
});

const r = createRelationsHelper({ Authors, Posts });
const relations = buildRelations(
  { Authors, Posts },
  {
    Authors: { posts: r.many.Posts({ from: r.Authors.id, to: r.Posts.authorId }) },
    Posts: { author: r.one.Authors({ from: r.Posts.authorId, to: r.Authors.id }) },
  },
);

const build = (config: BuildSchemaConfig = {}): GraphQLSchema => {
  const db = drizzle({ client: pglite, schema: { Authors, Posts }, relations } as any);
  return buildSchema(db as any, config).schema;
};

const outFields = (gqlSchema: GraphQLSchema, typeName: string) =>
  (gqlSchema.getType(typeName) as GraphQLObjectType).getFields();
const inFields = (gqlSchema: GraphQLSchema, typeName: string) =>
  (gqlSchema.getType(typeName) as GraphQLInputObjectType).getFields();

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('generated descriptions', () => {
  it('does not describe a field with the name of its own type', () => {
    const sdl = printSchema(build());

    // The internal conversion label used to be emitted as the description of every field,
    // filter operand and input field it touched.
    for (const label of ['"DateTime"', '"JSON"', '"Boolean"', '"Int"', '"String"', '"Array<String>"']) {
      expect(sdl).not.toContain(label);
    }
  });

  it('describes list filter operands by what they do', () => {
    const gqlSchema = build();
    const stringFilter = inFields(gqlSchema, 'StringFilter');

    // Previously `Array<undefined>` — the label of a list whose element type had none.
    expect(stringFilter['inArray']!.description).toBe('Matches any one of these values (SQL `IN`)');
    expect(stringFilter['notInArray']!.description).toBe('Matches none of these values (SQL `NOT IN`)');
    expect(String(stringFilter['inArray']!.type)).toBe('[String!]');

    expect(printSchema(build())).not.toContain('Array<undefined>');
  });

  it('describes comparison operands by what they do', () => {
    const stringFilter = inFields(build(), 'StringFilter');

    expect(stringFilter['eq']!.description).toBe('Equal to');
    expect(stringFilter['gte']!.description).toBe('Greater than or equal to');
    expect(stringFilter['isNull']!.description).toBeTruthy();
  });

  it('adds no descriptions at all when no hooks are configured', () => {
    const gqlSchema = build();

    // The generated pagination cursor documents itself; the table's own columns say nothing.
    for (const columnName of ['id', 'name', 'bio', 'active', 'createdAt', 'tags']) {
      expect(outFields(gqlSchema, 'Authors')[columnName]!.description).toBeFalsy();
      expect(inFields(gqlSchema, 'CreateAuthorsInput')[columnName]!.description).toBeFalsy();
    }
  });
});

describe('describeColumn', () => {
  const describeColumn: BuildSchemaConfig['describeColumn'] = (_column, { tableName, columnName }) =>
    columnName === 'bio' ? undefined : `${tableName}.${columnName} docs`;

  it('describes select fields', () => {
    const fields = outFields(build({ describeColumn }), 'Authors');

    expect(fields['name']!.description).toBe('Authors.name docs');
    expect(fields['createdAt']!.description).toBe('Authors.createdAt docs');
  });

  it('leaves a column undescribed when the hook returns undefined', () => {
    expect(outFields(build({ describeColumn }), 'Authors')['bio']!.description).toBeFalsy();
  });

  it('describes insert and update input fields', () => {
    const gqlSchema = build({ describeColumn });

    // `name` is NOT NULL, so it is required on create and optional on update — described either way.
    expect(inFields(gqlSchema, 'CreateAuthorsInput')['name']!.description).toBe('Authors.name docs');
    expect(inFields(gqlSchema, 'UpdateAuthorsInput')['name']!.description).toBe('Authors.name docs');
  });

  it('describes the per-column field of the filter input', () => {
    // The operand types (StringFilter, …) are shared by every column of that type, so the
    // column's own documentation belongs on the field that carries them.
    expect(inFields(build({ describeColumn }), 'AuthorsFilters')['name']!.description).toBe('Authors.name docs');
  });

  it('describes aggregate min/max and group key fields', () => {
    const gqlSchema = build({ describeColumn });

    expect(outFields(gqlSchema, 'AuthorsMinAggregate')['createdAt']!.description).toBe('Authors.createdAt docs');
    expect(outFields(gqlSchema, 'AuthorsMaxAggregate')['name']!.description).toBe('Authors.name docs');
    expect(outFields(gqlSchema, 'AuthorsGroupKeys')['name']!.description).toBe('Authors.name docs');
  });

  it('passes the drizzle column itself to the hook', () => {
    const seen: Array<[string, string, boolean]> = [];
    build({
      describeColumn: (column, info) => {
        seen.push([info.tableName, info.columnName, column.notNull]);
        return undefined;
      },
    });

    expect(seen).toContainEqual(['Authors', 'name', true]);
    expect(seen).toContainEqual(['Authors', 'bio', false]);
    expect(seen).toContainEqual(['Posts', 'title', true]);
  });
});

describe('describeTable and describeRelation', () => {
  it('describes the table object type', () => {
    const gqlSchema = build({ describeTable: (tableName) => `All ${tableName}` });

    expect(gqlSchema.getType('Authors')!.description).toBe('All Authors');
    expect(gqlSchema.getType('Posts')!.description).toBe('All Posts');
  });

  it('describes relation fields on both sides', () => {
    const gqlSchema = build({
      describeRelation: (tableName, relationName) => `${tableName} -> ${relationName}`,
    });

    expect(outFields(gqlSchema, 'Authors')['posts']!.description).toBe('Authors -> posts');
    expect(outFields(gqlSchema, 'Posts')['author']!.description).toBe('Posts -> author');
  });

  it('leaves a relation undescribed when the hook returns undefined', () => {
    const gqlSchema = build({
      describeRelation: (_tableName, relationName) => (relationName === 'posts' ? 'the posts' : undefined),
    });

    expect(outFields(gqlSchema, 'Authors')['posts']!.description).toBe('the posts');
    expect(outFields(gqlSchema, 'Posts')['author']!.description).toBeFalsy();
  });
});

describe('deprecateColumn', () => {
  const deprecateColumn: BuildSchemaConfig['deprecateColumn'] = (_column, { columnName }) =>
    columnName === 'bio' || columnName === 'name' ? `${columnName} is going away` : undefined;

  it('deprecates select fields', () => {
    const fields = outFields(build({ deprecateColumn }), 'Authors');

    expect(fields['bio']!.deprecationReason).toBe('bio is going away');
    expect(fields['createdAt']!.deprecationReason).toBeFalsy();
  });

  it('deprecates optional input fields', () => {
    const gqlSchema = build({ deprecateColumn });

    expect(inFields(gqlSchema, 'CreateAuthorsInput')['bio']!.deprecationReason).toBe('bio is going away');
    // `name` is NOT NULL, so it is optional on update and can be deprecated there.
    expect(inFields(gqlSchema, 'UpdateAuthorsInput')['name']!.deprecationReason).toBe('name is going away');
  });

  it('skips required input fields, which graphql-js refuses to let anyone deprecate', () => {
    const gqlSchema = build({ deprecateColumn });
    const required = inFields(gqlSchema, 'CreateAuthorsInput')['name']!;

    expect(String(required.type)).toBe('String!');
    expect(required.deprecationReason).toBeFalsy();
  });

  it('does not deprecate filter or orderBy fields', () => {
    // Filtering on a deprecated column is how a caller finds the rows that still use it.
    const gqlSchema = build({ deprecateColumn });

    expect(inFields(gqlSchema, 'AuthorsFilters')['bio']!.deprecationReason).toBeFalsy();
    expect(inFields(gqlSchema, 'AuthorsOrderBy')['bio']!.deprecationReason).toBeFalsy();
  });

  it('deprecates everything the hook asks for without producing an invalid schema', () => {
    const gqlSchema = build({ deprecateColumn: (_c, { columnName }) => `no more ${columnName}` });

    // A schema that deprecated a required input field would fail validation outright.
    expect(gqlSchema.toConfig()).toBeDefined();
    expect(printSchema(gqlSchema)).toContain('@deprecated');
  });
});

describe('documentation hooks together', () => {
  it('describe and deprecate the same field', () => {
    const gqlSchema = build({
      describeColumn: (_c, { columnName }) => `about ${columnName}`,
      deprecateColumn: (_c, { columnName }) => (columnName === 'bio' ? 'use name' : undefined),
    });
    const bio = outFields(gqlSchema, 'Authors')['bio']!;

    expect(bio.description).toBe('about bio');
    expect(bio.deprecationReason).toBe('use name');
  });

  it('never writes an empty description onto a type or field', () => {
    // A hook that returns undefined must leave the key unset rather than set it to undefined,
    // which printSchema would render as an empty description block.
    const gqlSchema = build({
      describeColumn: () => undefined,
      describeTable: () => undefined,
      describeRelation: () => undefined,
    });

    for (const type of Object.values(gqlSchema.getTypeMap())) {
      if (type.name.startsWith('__')) {
        continue;
      }
      expect(type.description ?? 'unset').not.toBe('');
      if (isObjectType(type) || isInputObjectType(type)) {
        for (const field of Object.values(type.getFields())) {
          expect(field.description ?? 'unset').not.toBe('');
        }
      }
    }
  });
});
