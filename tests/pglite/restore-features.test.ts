// A restore un-marks soft-deleted rows with an UPDATE of the marker column, so it follows the
// table's `update` feature: a table whose updates are off offers no restore mutations, while
// its delete mutations — governed by `delete` — stay.
import { PGlite } from '@electric-sql/pglite';
import { defineRelations } from 'drizzle-orm';
import { datetime, int, mysqlTable } from 'drizzle-orm/mysql-core';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BuildSchemaConfig, buildSchema } from '@/index';

const Notes = pgTable('notes', {
  id: integer('id').primaryKey(),
  deletedAt: timestamp('deleted_at'),
});
const Tags = pgTable('tags', {
  id: integer('id').primaryKey(),
  deletedAt: timestamp('deleted_at'),
});

const softDelete = { Notes: 'deletedAt', Tags: 'deletedAt' } as const;
const restoreFields = ['restoreNotes', 'restoreNotesSingle', 'restoreTags', 'restoreTagsSingle'];

let pglite: PGlite;
let db: any;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle({ client: pglite, relations: defineRelations({ Notes, Tags }) });
  await pglite.exec(`
    CREATE TABLE notes (id integer PRIMARY KEY, deleted_at timestamp);
    CREATE TABLE tags (id integer PRIMARY KEY, deleted_at timestamp);
  `);
});

afterAll(async () => {
  await pglite.close().catch(console.error);
});

const mutationNames = (features: BuildSchemaConfig['features']) =>
  Object.keys(buildSchema(db, { softDelete, features }).schema.getMutationType()?.getFields() ?? {});

const presentRestores = (names: string[]) => restoreFields.filter((name) => names.includes(name));

describe('restore mutations follow features.update', () => {
  it('generates them when update is on', () => {
    expect(presentRestores(mutationNames({}))).toEqual(restoreFields);
  });

  it('leaves them out everywhere when update is off build-wide', () => {
    const names = mutationNames({ update: false });
    expect(presentRestores(names)).toEqual([]);
    expect(names).toContain('deleteNotes');
  });

  it('leaves them out only on the tables a predicate turns update off for', () => {
    expect(presentRestores(mutationNames({ update: (table) => table !== 'Notes' }))).toEqual([
      'restoreTags',
      'restoreTagsSingle',
    ]);
  });

  it('omits Mutation when every write, restore included, is off', () => {
    const { schema } = buildSchema(db, {
      softDelete,
      features: { insert: false, update: false, delete: false },
    });
    expect(schema.getMutationType()).toBeUndefined();
  });

  it('still soft-deletes with update off', async () => {
    await pglite.exec(`INSERT INTO notes (id) VALUES (1)`);
    const { schema } = buildSchema(db, { softDelete, features: { update: false } });
    const result = await graphql({
      schema,
      source: 'mutation { deleteNotesSingle(where: { id: { eq: 1 } }) { id } }',
    });
    expect(result.errors).toBeUndefined();
    const { rows } = await pglite.query<{ marked: boolean }>(
      'SELECT deleted_at IS NOT NULL AS marked FROM notes WHERE id = 1',
    );
    expect(rows).toEqual([{ marked: true }]);
  });
});

describe('restore mutations follow features.update on MySQL', () => {
  const Items = mysqlTable('items', {
    id: int('id').primaryKey(),
    deletedAt: datetime('deleted_at'),
  });
  // Building the schema runs no query, so the client is never used.
  const mysqlDb = (mysqlDrizzle as any)({ client: { config: {} }, relations: defineRelations({ Items }) });
  const mysqlMutations = (features: BuildSchemaConfig['features']) =>
    Object.keys(
      buildSchema(mysqlDb, { softDelete: { Items: 'deletedAt' }, features })
        .schema.getMutationType()
        ?.getFields() ?? {},
    );

  it('generates them when update is on', () => {
    expect(mysqlMutations({})).toEqual(expect.arrayContaining(['restoreItems', 'restoreItemsSingle']));
  });

  it('leaves them out when update is off, keeping delete', () => {
    const names = mysqlMutations({ update: (table) => table !== 'Items' });
    expect(names.filter((name) => name.startsWith('restore'))).toEqual([]);
    expect(names).toContain('deleteItems');
  });
});
