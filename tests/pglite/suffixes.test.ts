// `suffixes` renames the operations that come in list/single pairs. It used to reach the
// queries only: a build that renamed the list side got `usersAll` next to a bare
// `createUsers`, `{ single: '' }` was honoured by the queries and the insert but ignored by
// update and delete, and the two together gave both insert mutations the name `createUsers`,
// which silently dropped the array insert from the schema (#155).
//
// buildSchema only reads drizzle metadata, so these never touch the database.

import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { GraphQLSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BuildSchemaConfig,
  buildSchema,
  type DrizzleFieldExtension,
  drizzleExtension,
  singularizeMapper,
} from '@/index';
import * as schema from '../schema/pg';

let pglite: PGlite;
let db: PgliteDatabase<typeof schema.relations>;

const build = (config: BuildSchemaConfig): GraphQLSchema => buildSchema(db, config).schema;

/** The generated mutations for one table, as `name → { operation, single }`. */
const mutationsFor = (gqlSchema: GraphQLSchema, table: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const [name, field] of Object.entries(gqlSchema.getMutationType()!.getFields())) {
    const meta = drizzleExtension(field) as DrizzleFieldExtension | undefined;
    if (meta?.table === table) {
      found[name] = `${meta.operation}/${meta.single ? 'single' : 'list'}`;
    }
  }
  return found;
};

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = drizzle({ client: pglite, relations: schema.relations });
});

afterAll(async () => {
  await pglite.close().catch(console.error);
});

describe('suffixes reach the mutations too', () => {
  it('applies the list suffix to the list mutations and the single suffix to the single ones', () => {
    const mutations = mutationsFor(build({ suffixes: { list: 'All', single: 'One' } }), 'Users');

    expect(mutations['createUsersAll']).toBe('insert/list');
    expect(mutations['createUsersOne']).toBe('insert/single');
    expect(mutations['updateUsersAll']).toBe('update/list');
    expect(mutations['updateUsersOne']).toBe('update/single');
    expect(mutations['deleteUsersAll']).toBe('delete/list');
    expect(mutations['deleteUsersOne']).toBe('delete/single');
  });

  it('honours an empty single suffix in update and delete, as the queries already did', () => {
    const gqlSchema = build({ suffixes: { list: 'All', single: '' } });
    const mutations = mutationsFor(gqlSchema, 'Users');

    expect(mutations['updateUsers']).toBe('update/single');
    expect(mutations['deleteUsers']).toBe('delete/single');
    expect(mutations['updateUsersAll']).toBe('update/list');
    expect(mutations['updateUsersSingle']).toBeUndefined();
    expect(mutations['deleteUsersSingle']).toBeUndefined();

    // The queries, unchanged, are what the mutations now agree with.
    const queries = Object.keys(gqlSchema.getQueryType()!.getFields());
    expect(queries).toContain('usersAll');
    expect(queries).toContain('users');
  });

  it('keeps the array insert that used to be overwritten by the single one', () => {
    const mutations = mutationsFor(build({ suffixes: { list: 'All', single: '' } }), 'Users');

    expect(mutations['createUsersAll']).toBe('insert/list');
    expect(mutations['createUsers']).toBe('insert/single');
  });

  it('leaves the default naming alone', () => {
    const mutations = mutationsFor(build({}), 'Users');

    expect(mutations['createUsers']).toBe('insert/list');
    expect(mutations['createUsersSingle']).toBe('insert/single');
    expect(mutations['updateUsers']).toBe('update/list');
    expect(mutations['updateUsersSingle']).toBe('update/single');
    expect(mutations['deleteUsers']).toBe('delete/list');
    expect(mutations['deleteUsersSingle']).toBe('delete/single');
  });

  it('lets a mapper separate the update/delete pair the way it separates the insert one', () => {
    // update/delete used to take the singular noun on *both* sides — the list form included,
    // which read as a single-row operation and was not one — so the pair could only be told
    // apart by a `Single` the mapper had already made unnecessary everywhere else (#171).
    const mutations = mutationsFor(
      build({
        typeNameMapper: 'singularize',
        suffixes: { list: '', single: '' },
      }),
      'Users',
    );

    expect(mutations['updateUsers']).toBe('update/list');
    expect(mutations['updateUser']).toBe('update/single');
    expect(mutations['deleteUsers']).toBe('delete/list');
    expect(mutations['deleteUser']).toBe('delete/single');
    expect(mutations['createUsers']).toBe('insert/list');
    expect(mutations['createUser']).toBe('insert/single');
    expect(mutations['updateUserSingle']).toBeUndefined();
    expect(mutations['deleteUserSingle']).toBeUndefined();
  });

  it('separates the pair with the single suffix when the mapper skips a table', () => {
    // A mapper that returns undefined for one table leaves that table on the unmapped path,
    // where both nouns are the table key and `suffixes.single` is the only separator left.
    const tags = mutationsFor(
      build({
        typeNameMapper: (table) => (table === 'Tags' ? undefined : singularizeMapper(table)),
        suffixes: { list: '', single: 'Single' },
      }),
      'Tags',
    );

    expect(tags['updateTags']).toBe('update/list');
    expect(tags['updateTagsSingle']).toBe('update/single');
    expect(tags['deleteTags']).toBe('delete/list');
    expect(tags['deleteTagsSingle']).toBe('delete/single');
  });
});

describe('colliding generated names', () => {
  it('rejects identical suffixes before it generates anything', () => {
    expect(() => build({ suffixes: { list: 'X', single: 'X' } })).toThrow(
      /List and single query suffixes cannot be the same/,
    );
  });

  it('names the field when two operations collide on something the suffix check cannot see', () => {
    // Two prefixes that agree put the bulk update and the bulk delete on one name, which no
    // amount of comparing suffix strings can notice.
    expect(() => build({ prefixes: { update: 'delete' } })).toThrow(
      /two generated mutation fields are both named 'deleteUsers'/,
    );
  });

  it('catches a skipped table left with nothing to separate its pair', () => {
    // Both suffixes empty is legal once a mapper is configured, because the mapper's
    // singular/plural forms separate each pair — but a table the mapper returns undefined
    // for has neither, and collides on its two query fields.
    expect(() =>
      build({
        typeNameMapper: (table) => (table === 'Tags' ? undefined : singularizeMapper(table)),
        suffixes: { list: '', single: '' },
      }),
    ).toThrow(/two generated query fields are both named 'tags'/);
  });

  it('catches a mapper that gives two tables the same name', () => {
    // Every table answers to `users`, so the first pair of list queries already collides.
    expect(() => build({ typeNameMapper: () => ({ singular: 'user', plural: 'users' }) })).toThrow(
      /two generated query fields are both named 'users'/,
    );
  });
});
