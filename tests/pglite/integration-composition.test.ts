import { createServer, type Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, type GeneratedEntities } from '@/index';
import { GraphQLClient } from '../util/query';
import { schema, setupTables, sql, type TestDatabase, teardownTables } from './common';

/**
 * The other integration suite covers how consumers *query* the generated schema. This one
 * covers how they *assemble* it.
 *
 * Handing `buildSchema(db).schema` straight to a server is the getting-started path;
 * anything past a prototype instead takes `entities` and composes: exposing a subset of
 * the generated fields, renaming them, and adding hand-written fields that reuse the
 * generated types and inputs. That is the second example in the README and, judging by
 * how the library is used, the shape most real deployments end up with.
 *
 * It also exercises the library through a different door. The generated root resolvers
 * pre-fetch relations with Drizzle's `with:`; a hand-written resolver returning bare rows
 * does not, so the generated object type has to resolve its own relation fields. Both
 * paths have to produce the same answer, or composing means silently losing relations.
 *
 * Everything here uses the *default* naming — no `typeNameMapper` — because that is what a
 * consumer following the README gets, and it pins the documented entity keys against
 * drift.
 */

const DATA_DIR = `./tests/.temp/pgdata-integration-composition-${Date.now()}`;

let pglite: PGlite;
let db: TestDatabase;
let entities: GeneratedEntities<TestDatabase>;
let server: Server;
let gql: GraphQLClient;

// `setupTables` / `teardownTables` only need `db`, and this suite deliberately does not
// build the default schema that `setupServer` would.
const tableCtx = () => ({ db }) as any;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = drizzle({ client: pglite, relations: schema.relations, logger: !!process.env['LOG_SQL'] });

  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );

  entities = buildSchema(db).entities;

  const composed = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        // Only a subset of the generated queries is exposed, and one of them under a
        // different name than it was generated with.
        users: entities.queries['users']!,
        customer: entities.queries['customersSingle']!,

        // A hand-written field reusing the generated object type and filter input. Its
        // resolver returns bare rows with no relation pre-fetching, which is what a
        // consumer writing their own `db.select()` produces.
        engineers: {
          type: new GraphQLList(new GraphQLNonNull(entities.types['Users'] as GraphQLObjectType)) as any,
          args: { where: { type: entities.inputs['UsersFilters']! } },
          resolve: async () => db.select().from(schema.Users).where(sql`${schema.Users.profession} = 'FirstUserProf'`),
        },
      },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: entities.mutations as any,
    }),
    types: [...Object.values(entities.types), ...Object.values(entities.inputs)],
  });

  server = createServer(createYoga({ schema: composed }));
  server.listen(5281);
  gql = new GraphQLClient('http://localhost:5281/graphql');
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  const { rm } = await import('node:fs/promises');
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

beforeEach(async () => {
  await setupTables(tableCtx());
});
afterEach(async () => {
  await teardownTables(tableCtx());
});

describe.sequential('the entity keys the README tells consumers to reach for', () => {
  it('exposes queries, mutations, types and inputs under their documented default names', () => {
    // A composed schema is written against these keys by hand, so a rename is a silent
    // `undefined` at schema-construction time rather than a type error.
    expect(Object.keys(entities.queries)).toEqual(
      expect.arrayContaining(['users', 'usersSingle', 'usersAggregate', 'usersGroupBy']),
    );
    expect(Object.keys(entities.mutations)).toEqual(
      expect.arrayContaining([
        'createUsers',
        'createUsersSingle',
        'updateUsers',
        'updateUsersSingle',
        'deleteUsers',
        'deleteUsersSingle',
      ]),
    );
    expect(Object.keys(entities.types)).toEqual(expect.arrayContaining(['Users', 'Posts']));
    expect(Object.keys(entities.inputs)).toEqual(
      expect.arrayContaining(['UsersFilters', 'UsersOrderBy', 'CreateUsersInput', 'UpdateUsersInput']),
    );
  });
});

describe.sequential('exposing a subset of the generated fields', () => {
  it('serves only the fields the composed schema declares', async () => {
    const res = await gql.queryGql(/* GraphQL */ `
			{
				__schema {
					queryType {
						fields {
							name
						}
					}
				}
			}
		`);

    const names = res.data.__schema.queryType.fields.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['customer', 'engineers', 'users']);
    // The generated queries left out must not leak in through the `types:` array.
    expect(names).not.toContain('posts');
    expect(names).not.toContain('usersSingle');
  });

  it('keeps a generated query fully functional under a different field name', async () => {
    const res = await gql.queryGql(/* GraphQL */ `
			{
				customer(where: { id: { eq: 1 } }) {
					id
					address
					user {
						id
						name
					}
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.customer).toEqual({
      id: 1,
      address: 'AdOne',
      user: { id: 1, name: 'FirstUser' },
    });
  });

  it('resolves relations through a generated query that was cherry-picked', async () => {
    const res = await gql.queryGql(/* GraphQL */ `
			{
				users(where: { id: { eq: 1 } }) {
					id
					posts(orderBy: { id: { priority: 1, direction: asc } }) {
						id
						content
					}
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([
      {
        id: 1,
        posts: [
          { id: 1, content: '1MESSAGE' },
          { id: 2, content: '2MESSAGE' },
          { id: 3, content: '3MESSAGE' },
          { id: 6, content: '4MESSAGE' },
        ],
      },
    ]);
  });
});

describe.sequential('a hand-written field built on the generated types', () => {
  it('resolves scalars off rows a custom resolver returned', async () => {
    const res = await gql.queryGql(/* GraphQL */ `
			{
				engineers {
					id
					name
					profession
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.engineers).toEqual([{ id: 1, name: 'FirstUser', profession: 'FirstUserProf' }]);
  });

  it('resolves relation fields on rows that were never pre-fetched with `with:`', async () => {
    // The custom resolver returns bare `db.select()` rows carrying no `posts` key at all.
    // The generated object type has to go and fetch the relation itself; if it only ever
    // read a pre-fetched key, composing would quietly return null here.
    const res = await gql.queryGql(/* GraphQL */ `
			{
				engineers {
					id
					posts(orderBy: { id: { priority: 1, direction: asc } }) {
						id
					}
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.engineers).toEqual([{ id: 1, posts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }] }]);
  });

  it('agrees with the generated query it sits alongside', async () => {
    // Same rows, same relation, two different resolution paths in one document.
    const res = await gql.queryGql(/* GraphQL */ `
			{
				generated: users(where: { id: { eq: 1 } }) {
					id
					name
					posts(orderBy: { id: { priority: 1, direction: asc } }) {
						id
					}
				}
				engineers {
					id
					name
					posts(orderBy: { id: { priority: 1, direction: asc } }) {
						id
					}
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.engineers).toEqual(res.data.generated);
  });

  it('accepts the reused generated filter input as its own argument type', async () => {
    // `UsersFilters` has to be a valid argument type outside the field it was generated
    // for — including as a variable, which is how a client would send it.
    const res = await gql.queryGql(
      /* GraphQL */ `
				query Custom($where: UsersFilters) {
					engineers(where: $where) {
						id
					}
				}
			`,
      { where: { id: { eq: 1 } } },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data.engineers).toEqual([{ id: 1 }]);
  });
});

describe.sequential('spreading the generated mutations wholesale', () => {
  it('round-trips a row through mutations taken straight from `entities.mutations`', async () => {
    const created = await gql.queryGql(
      /* GraphQL */ `
				mutation Create($values: CreateUsersInput!) {
					createUsersSingle(values: $values) {
						id
						name
						profession
					}
				}
			`,
      { values: { id: 200, name: 'Composed', profession: 'FirstUserProf' } },
    );
    expect(created.errors).toBeUndefined();
    expect(created.data.createUsersSingle).toEqual({
      id: 200,
      name: 'Composed',
      profession: 'FirstUserProf',
    });

    // The hand-written field reads the same table, so the write has to be visible to it.
    const listed = await gql.queryGql(/* GraphQL */ `
			{
				engineers {
					id
				}
			}
		`);
    expect(listed.data.engineers.map((u: { id: number }) => u.id).sort((a: number, b: number) => a - b)).toEqual([
      1, 200,
    ]);

    const deleted = await gql.queryGql(/* GraphQL */ `
			mutation {
				deleteUsersSingle(where: { id: { eq: 200 } }) {
					id
				}
			}
		`);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deleteUsersSingle).toEqual({ id: 200 });
  });

  it('still surfaces write rejections as coded errors inside a composed schema', async () => {
    const res = await gql.queryGql(/* GraphQL */ `
			mutation {
				updateUsersSingle(where: { id: { eq: 1 } }, set: { name: null }) {
					id
				}
			}
		`);

    expect(res.errors).toBeDefined();
    expect(res.errors[0].extensions?.code).toBe('DRIZZLE_NOT_NULL');
  });
});
