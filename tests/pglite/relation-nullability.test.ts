import { mkdir, rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  graphql,
  isNonNullType,
  isObjectType,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// ── Schema: required vs optional to-one relations ─────────────────────────────
const Authors = pgTable('authors', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});
const Books = pgTable('books', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id')
    .notNull()
    .references(() => Authors.id),
  editorId: integer('editor_id').references(() => Authors.id),
});
const r = createRelationsHelper({ Authors, Books });
const relations = buildRelations(
  { Authors, Books },
  {
    Authors: {
      books: r.many.Books({ from: r.Authors.id, to: r.Books.authorId }),
      // To-one whose `from` column (Authors.id) is NOT NULL, but with no `optional: false`
      // declaration — an author may have no book, so this must stay nullable.
      featuredBook: r.one.Books({ from: r.Authors.id, to: r.Books.authorId }),
    },
    Books: {
      // NOT NULL FK declared required — emitted as `Authors!`.
      author: r.one.Authors({ from: r.Books.authorId, to: r.Authors.id, optional: false }),
      // Nullable FK, default optionality — stays `Authors`.
      editor: r.one.Authors({ from: r.Books.editorId, to: r.Authors.id }),
    },
  },
);
const schema = { Authors, Books, relations };

const DATA_DIR = `./tests/.temp/pgdata-relation-nullability-${Date.now()}`;
let pglite: PGlite;
let db: any;
let gqlSchema: GraphQLSchema;
let entities: any;

beforeAll(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(sql`CREATE TABLE "authors" ("id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL);`);
  await db.execute(
    sql`CREATE TABLE "books" (
      "id" serial PRIMARY KEY NOT NULL,
      "title" text NOT NULL,
      "author_id" integer NOT NULL REFERENCES "authors"("id"),
      "editor_id" integer REFERENCES "authors"("id")
    );`,
  );
  await db.insert(Authors).values([
    { id: 1, name: 'FirstAuthor' },
    { id: 2, name: 'SecondAuthor' },
  ]);
  await db.insert(Books).values([
    { id: 1, title: 'Edited', authorId: 1, editorId: 2 },
    { id: 2, title: 'Unedited', authorId: 2, editorId: null },
  ]);
  // Seeding used explicit ids; advance the serial sequences so inserts without an id work.
  await db.execute(sql`SELECT setval('authors_id_seq', 100);`);
  await db.execute(sql`SELECT setval('books_id_seq', 100);`);

  const built = buildSchema(db);
  gqlSchema = built.schema;
  entities = built.entities;
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('to-one relation nullability', () => {
  it('emits a to-one relation declared optional: false as Target!', () => {
    const booksType = gqlSchema.getType('Books') as GraphQLObjectType;
    const authorField = booksType.getFields()['author']!;
    expect(isNonNullType(authorField.type)).toBe(true);
    expect((authorField.type as GraphQLNonNull<GraphQLObjectType>).ofType.name).toBe('Authors');
  });

  it('keeps a to-one relation with default optionality nullable', () => {
    const booksType = gqlSchema.getType('Books') as GraphQLObjectType;
    const editorField = booksType.getFields()['editor']!;
    expect(isObjectType(editorField.type)).toBe(true);
    expect((editorField.type as GraphQLObjectType).name).toBe('Authors');
  });

  it('does not infer required-ness from column nullability alone', () => {
    // Authors.featuredBook joins the NOT NULL Authors.id, but no row is guaranteed
    // to exist on the other side — the field must stay nullable.
    const authorsType = gqlSchema.getType('Authors') as GraphQLObjectType;
    const featuredField = authorsType.getFields()['featuredBook']!;
    expect(isNonNullType(featuredField.type)).toBe(false);
    expect((featuredField.type as GraphQLObjectType).name).toBe('Books');
  });

  it('resolves required and optional to-one relations through the generated queries', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ books { id title author { name } editor { name } } }`,
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    const books: any[] = (result.data as any)?.books ?? [];
    expect(books.find((b) => b.id === 1)).toEqual({
      id: 1,
      title: 'Edited',
      author: { name: 'FirstAuthor' },
      editor: { name: 'SecondAuthor' },
    });
    expect(books.find((b) => b.id === 2)).toEqual({
      id: 2,
      title: 'Unedited',
      author: { name: 'SecondAuthor' },
      editor: null,
    });
  });

  it('resolves a required to-one relation through the batch field resolver (lazy path)', async () => {
    const allTypes = entities.types as Record<string, GraphQLObjectType>;
    const BooksType = allTypes['Books']!;
    const lazySchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          books: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BooksType))) as any,
            resolve: () => db.select().from(Books),
          },
        },
      }),
    });
    const result = await graphql({
      schema: lazySchema,
      source: `{ books { id author { name } editor { name } } }`,
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    const books: any[] = (result.data as any)?.books ?? [];
    expect(books.find((b) => b.id === 1)?.author).toEqual({ name: 'FirstAuthor' });
    expect(books.find((b) => b.id === 2)?.author).toEqual({ name: 'SecondAuthor' });
    expect(books.find((b) => b.id === 2)?.editor).toBeNull();
  });

  it('returns the required relation as non-null from mutation payloads', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `mutation {
        createBooks(values: [{ title: "New", authorId: 1 }]) { title author { name } editor { name } }
      }`,
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    const created: any[] = (result.data as any)?.createBooks ?? [];
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({ title: 'New', author: { name: 'FirstAuthor' }, editor: null });
  });
});
