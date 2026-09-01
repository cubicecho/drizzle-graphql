import { buildClientSchema, getIntrospectionQuery, printSchema } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

/**
 * End-to-end tests written from the client's side of the wire.
 *
 * The rest of the suite covers each generated feature directly. What this file covers is
 * the shape of the requests real consumers actually send: documents produced by Apollo,
 * Relay, urql and graphql-codegen rather than written by hand. Those tools lean on parts
 * of GraphQL the per-feature tests never exercise — introspection, multi-operation
 * documents selected by `operationName`, arguments passed as variables, `@skip`/`@include`,
 * aliases and fragment composition — and they issue requests concurrently.
 *
 * That distinction is not cosmetic. `parseResolveInfo` is vendored in this repo, and it is
 * what turns a selection set into the Drizzle `with:` tree, so a document that merely
 * *reaches* the same fields by a different syntactic route is a genuinely different path
 * through the library.
 *
 * Every test runs against the shared fixture `setupTables` installs: users 1 `FirstUser`,
 * 2 `SecondUser` and 5 `FifthUser`; posts 1, 2, 3 and 6 belong to user 1, posts 4 and 5 to
 * user 5, and user 2 has none.
 */

const DATA_DIR = `./tests/.temp/pgdata-integration-${Date.now()}`;
const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 5280, DATA_DIR);
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

describe.sequential('introspection, as codegen and IDE tooling perform it', () => {
  it('answers the full introspection query and rebuilds into a usable client schema', async () => {
    const res = await ctx.gql.queryGql(getIntrospectionQuery());

    expect(res.errors).toBeUndefined();
    expect(res.data.__schema).toBeDefined();

    // This is the graphql-codegen / Apollo CLI path: the introspection result has to be
    // complete enough to reconstruct the schema, which fails loudly on a malformed or
    // partially described type.
    const clientSchema = buildClientSchema(res.data);

    expect(Object.keys(clientSchema.getQueryType()!.getFields()).sort()).toEqual(
      Object.keys(ctx.schema.getQueryType()!.getFields()).sort(),
    );
    expect(Object.keys(clientSchema.getMutationType()!.getFields()).sort()).toEqual(
      Object.keys(ctx.schema.getMutationType()!.getFields()).sort(),
    );
  });

  it('round-trips to an SDL that still declares the generated inputs and enums', async () => {
    const res = await ctx.gql.queryGql(getIntrospectionQuery());
    const sdl = printSchema(buildClientSchema(res.data));

    // A client that only ever sees the introspection result must still be able to write
    // filters, ordering and writes against it.
    expect(sdl).toContain('input UserFilters');
    expect(sdl).toContain('input UserOrderBy');
    expect(sdl).toContain('input CreateUserInput');
    expect(sdl).toContain('enum RoleEnum');
    expect(sdl).toContain('type User');
  });
});

describe.sequential('documents carrying more than one operation', () => {
  const DOCUMENT = /* GraphQL */ `
		query ListUsers($limit: Int) {
			users(limit: $limit, orderBy: { id: { priority: 1, direction: asc } }) {
				id
				name
			}
		}

		query ListPosts($limit: Int) {
			posts(limit: $limit, orderBy: { id: { priority: 1, direction: asc } }) {
				id
				content
			}
		}

		mutation AddUser($values: CreateUserInput!) {
			createUser(values: $values) {
				id
				name
			}
		}
	`;

  it('runs only the operation named by operationName', async () => {
    const users = await ctx.gql.queryGql(DOCUMENT, { limit: 2 }, 'ListUsers');

    expect(users.errors).toBeUndefined();
    expect(users.data).toEqual({
      users: [
        { id: 1, name: 'FirstUser' },
        { id: 2, name: 'SecondUser' },
      ],
    });
    // The sibling operations must not contribute to the response at all.
    expect(users.data.posts).toBeUndefined();
    expect(users.data.createUser).toBeUndefined();

    const posts = await ctx.gql.queryGql(DOCUMENT, { limit: 1 }, 'ListPosts');
    expect(posts.errors).toBeUndefined();
    expect(posts.data).toEqual({ posts: [{ id: 1, content: '1MESSAGE' }] });
  });

  it('leaves the database untouched when a query is selected out of a document that also defines a mutation', async () => {
    await ctx.gql.queryGql(DOCUMENT, { limit: 5 }, 'ListUsers');

    // If operation selection leaked, `AddUser` would have inserted a row.
    const after = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					id
				}
			}
		`);
    expect(after.data.users).toHaveLength(3);
  });

  it('selects the mutation from the same document when it is the one named', async () => {
    const created = await ctx.gql.queryGql(DOCUMENT, { values: { id: 4, name: 'FourthUser' } }, 'AddUser');

    expect(created.errors).toBeUndefined();
    expect(created.data.createUser).toEqual({ id: 4, name: 'FourthUser' });
  });

  it('rejects an unnamed request against a multi-operation document', async () => {
    const res = await ctx.gql.queryGql(DOCUMENT, { limit: 1 });

    // Per the spec this is a request error, and it has to surface as one rather than the
    // server silently picking an operation.
    expect(res.errors).toBeDefined();
    expect(res.data).toBeFalsy();
  });
});

describe.sequential('arguments supplied as variables', () => {
  it('drives filtering, ordering and pagination entirely from variables', async () => {
    const res = await ctx.gql.queryGql(
      /* GraphQL */ `
				query Page($where: UserFilters, $orderBy: UserOrderBy, $limit: Int, $offset: Int) {
					users(where: $where, orderBy: $orderBy, limit: $limit, offset: $offset) {
						id
						name
					}
				}
			`,
      {
        where: { id: { gt: 1 } },
        orderBy: { id: { priority: 1, direction: 'desc' } },
        limit: 1,
        offset: 0,
      },
    );

    expect(res.errors).toBeUndefined();
    // Users 2 and 5 clear the filter; descending by id puts 5 first, and the limit keeps
    // only that one.
    expect(res.data.users).toEqual([{ id: 5, name: 'FifthUser' }]);
  });

  it('applies an offset supplied as a variable', async () => {
    const res = await ctx.gql.queryGql(
      /* GraphQL */ `
				query Page($limit: Int, $offset: Int) {
					users(orderBy: { id: { priority: 1, direction: asc } }, limit: $limit, offset: $offset) {
						id
					}
				}
			`,
      { limit: 2, offset: 1 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 2 }, { id: 5 }]);
  });

  it('accepts variables for arguments on a relation field', async () => {
    const res = await ctx.gql.queryGql(
      /* GraphQL */ `
				query AuthorWithPosts($id: Int!, $postLimit: Int) {
					users(where: { id: { eq: $id } }) {
						id
						posts(limit: $postLimit, orderBy: { id: { priority: 1, direction: asc } }) {
							id
						}
					}
				}
			`,
      { id: 1, postLimit: 2 },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 1, posts: [{ id: 1 }, { id: 2 }] }]);
  });

  it('reports a variable of the wrong type as a request error rather than coercing it', async () => {
    const res = await ctx.gql.queryGql(
      /* GraphQL */ `
				query Bad($limit: Int) {
					users(limit: $limit) {
						id
					}
				}
			`,
      { limit: 'not-a-number' },
    );

    expect(res.errors).toBeDefined();
    expect(res.errors[0].message).toMatch(/limit/i);
  });
});

describe.sequential('@skip and @include', () => {
  const DOCUMENT = /* GraphQL */ `
		query Conditional($withPosts: Boolean!, $hideEmail: Boolean!) {
			users(where: { id: { eq: 1 } }) {
				id
				name
				email @skip(if: $hideEmail)
				posts(orderBy: { id: { priority: 1, direction: asc } }) @include(if: $withPosts) {
					id
				}
			}
		}
	`;

  it('includes a relation when the directive resolves to true', async () => {
    const res = await ctx.gql.queryGql(DOCUMENT, { withPosts: true, hideEmail: false });

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([
      {
        id: 1,
        name: 'FirstUser',
        email: 'userOne@notmail.com',
        posts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }],
      },
    ]);
  });

  it('omits the relation and the skipped scalar when the directives invert', async () => {
    const res = await ctx.gql.queryGql(DOCUMENT, { withPosts: false, hideEmail: true });

    expect(res.errors).toBeUndefined();
    // Excluded fields have to be absent rather than present-and-null: the relation is
    // never requested from the database, so `posts` has no key in the response at all.
    expect(res.data.users).toEqual([{ id: 1, name: 'FirstUser' }]);
    expect(res.data.users[0]).not.toHaveProperty('posts');
    expect(res.data.users[0]).not.toHaveProperty('email');
  });

  it('honours a directive placed on a fragment spread', async () => {
    const res = await ctx.gql.queryGql(
      /* GraphQL */ `
				query SpreadDirective($withDetail: Boolean!) {
					users(where: { id: { eq: 2 } }) {
						id
						...Detail @include(if: $withDetail)
					}
				}

				fragment Detail on User {
					name
					profession
				}
			`,
      { withDetail: false },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 2 }]);
  });

  it('includes the same fragment spread when the directive flips', async () => {
    const res = await ctx.gql.queryGql(
      /* GraphQL */ `
				query SpreadDirective($withDetail: Boolean!) {
					users(where: { id: { eq: 1 } }) {
						id
						...Detail @include(if: $withDetail)
					}
				}

				fragment Detail on User {
					name
					profession
				}
			`,
      { withDetail: true },
    );

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 1, name: 'FirstUser', profession: 'FirstUserProf' }]);
  });
});

describe.sequential('aliases', () => {
  it('resolves the same root field several times under different aliases and arguments', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				first: users(where: { id: { eq: 1 } }) {
					id
					name
				}
				rest: users(where: { id: { gt: 1 } }, orderBy: { id: { priority: 1, direction: asc } }) {
					id
				}
				everyone: users {
					id
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.first).toEqual([{ id: 1, name: 'FirstUser' }]);
    expect(res.data.rest).toEqual([{ id: 2 }, { id: 5 }]);
    expect(res.data.everyone).toHaveLength(3);
  });

  it('aliases a relation field twice with different arguments under one parent', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { id: { eq: 1 } }) {
					id
					firstPost: posts(limit: 1, orderBy: { id: { priority: 1, direction: asc } }) {
						id
					}
					lastPost: posts(limit: 1, orderBy: { id: { priority: 1, direction: desc } }) {
						id
					}
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 1, firstPost: [{ id: 1 }], lastPost: [{ id: 6 }] }]);
  });
});

describe.sequential('fragment composition, as generated clients emit it', () => {
  it('resolves named fragments spread across a relation boundary', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { id: { eq: 5 } }) {
					...UserFields
				}
			}

			fragment UserFields on User {
				id
				name
				posts(orderBy: { id: { priority: 1, direction: asc } }) {
					...PostFields
				}
			}

			fragment PostFields on Post {
				id
				content
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([
      {
        id: 5,
        name: 'FifthUser',
        posts: [
          { id: 4, content: '1MESSAGE' },
          { id: 5, content: '2MESSAGE' },
        ],
      },
    ]);
  });

  it('merges a fragment with sibling fields selected directly', async () => {
    // Codegen output routinely selects a field both inline and through a fragment; the two
    // selections have to merge rather than one shadowing the other.
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { id: { eq: 1 } }) {
					id
					...Contact
					profession
				}
			}

			fragment Contact on User {
				id
				email
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 1, email: 'userOne@notmail.com', profession: 'FirstUserProf' }]);
  });

  it('resolves fragments nested inside other fragments', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { id: { eq: 1 } }) {
					...Outer
				}
			}

			fragment Outer on User {
				id
				...Inner
			}

			fragment Inner on User {
				name
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 1, name: 'FirstUser' }]);
  });

  it('resolves an inline fragment on the enclosing type', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(where: { id: { eq: 1 } }) {
					id
					... on User {
						name
						posts(limit: 1, orderBy: { id: { priority: 1, direction: asc } }) {
							id
						}
					}
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data.users).toEqual([{ id: 1, name: 'FirstUser', posts: [{ id: 1 }] }]);
  });
});

describe.sequential('concurrent requests', () => {
  it('keeps results separate across many in-flight requests', async () => {
    // Relation resolvers dedupe sibling loads keyed on the GraphQL context. Requests in
    // flight at the same time carry distinct contexts, so a key that is not genuinely
    // per-request would show up here as one request's rows landing in another's response.
    const wanted = [1, 2, 5, 1, 2, 5, 1, 2, 5, 1, 2, 5];
    const results = await Promise.all(
      wanted.map((id) =>
        ctx.gql.queryGql(
          /* GraphQL */ `
						query One($id: Int!) {
							users(where: { id: { eq: $id } }) {
								id
								name
								posts(orderBy: { id: { priority: 1, direction: asc } }) {
									id
								}
							}
						}
					`,
          { id },
        ),
      ),
    );

    const expected: Record<number, unknown> = {
      1: {
        id: 1,
        name: 'FirstUser',
        posts: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 6 }],
      },
      2: { id: 2, name: 'SecondUser', posts: [] },
      5: { id: 5, name: 'FifthUser', posts: [{ id: 4 }, { id: 5 }] },
    };

    results.forEach((res, i) => {
      const label = `request ${i} (user ${wanted[i]})`;
      expect(res.errors, label).toBeUndefined();
      expect(res.data.users, label).toEqual([expected[wanted[i]!]]);
    });
  });

  it('keeps concurrent writes consistent', async () => {
    const ids = [10, 11, 12, 13];
    const results = await Promise.all(
      ids.map((id) =>
        ctx.gql.queryGql(
          /* GraphQL */ `
						mutation Add($values: CreateUserInput!) {
							createUser(values: $values) {
								id
								name
							}
						}
					`,
          { values: { id, name: `User${id}` } },
        ),
      ),
    );

    for (const res of results) {
      expect(res.errors).toBeUndefined();
    }
    expect(results.map((r) => r.data.createUser.id).sort((a: number, b: number) => a - b)).toEqual(ids);

    const after = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					id
				}
			}
		`);
    // The three fixture rows plus the four just written, with nothing lost to a race.
    expect(after.data.users).toHaveLength(7);
  });
});

describe.sequential('a full create/read/update/delete cycle', () => {
  it('carries a row through every generated mutation using variables throughout', async () => {
    const created = await ctx.gql.queryGql(
      /* GraphQL */ `
				mutation Create($values: CreateUserInput!) {
					createUser(values: $values) {
						id
						name
						email
					}
				}
			`,
      { values: { id: 100, name: 'Dana', email: 'dana@example.com' } },
    );
    expect(created.errors).toBeUndefined();
    expect(created.data.createUser).toEqual({
      id: 100,
      name: 'Dana',
      email: 'dana@example.com',
    });

    const read = await ctx.gql.queryGql(
      /* GraphQL */ `
				query Read($id: Int!) {
					user(where: { id: { eq: $id } }) {
						id
						name
						email
					}
				}
			`,
      { id: 100 },
    );
    expect(read.data.user).toEqual({ id: 100, name: 'Dana', email: 'dana@example.com' });

    const updated = await ctx.gql.queryGql(
      /* GraphQL */ `
				mutation Update($id: Int!, $set: UpdateUserInput!) {
					updateUserSingle(where: { id: { eq: $id } }, set: $set) {
						id
						name
						email
					}
				}
			`,
      { id: 100, set: { name: 'Dana Renamed', email: null } },
    );
    expect(updated.errors).toBeUndefined();
    // `email` is nullable, so an explicit null here is a real update rather than an
    // omission to be dropped from the statement.
    expect(updated.data.updateUserSingle).toEqual({
      id: 100,
      name: 'Dana Renamed',
      email: null,
    });

    const deleted = await ctx.gql.queryGql(
      /* GraphQL */ `
				mutation Delete($id: Int!) {
					deleteUser(where: { id: { eq: $id } }) {
						id
					}
				}
			`,
      { id: 100 },
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deleteUser).toEqual([{ id: 100 }]);

    const gone = await ctx.gql.queryGql(
      /* GraphQL */ `
				query Read($id: Int!) {
					user(where: { id: { eq: $id } }) {
						id
					}
				}
			`,
      { id: 100 },
    );
    expect(gone.data.user).toBeNull();
  });

  it('surfaces a write rejection as a GraphQL error carrying a machine-readable code', async () => {
    // `name` is NOT NULL; setting it to null on update has to be refused rather than
    // silently dropped from the statement and reported as a success.
    const res = await ctx.gql.queryGql(
      /* GraphQL */ `
				mutation Break($id: Int!) {
					updateUserSingle(where: { id: { eq: $id } }, set: { name: null }) {
						id
					}
				}
			`,
      { id: 1 },
    );

    expect(res.errors).toBeDefined();
    expect(res.errors[0].extensions?.code).toBe('DRIZZLE_NOT_NULL');

    // The rejected write must not have partially applied.
    const unchanged = await ctx.gql.queryGql(/* GraphQL */ `
			{
				user(where: { id: { eq: 1 } }) {
					name
				}
			}
		`);
    expect(unchanged.data.user).toEqual({ name: 'FirstUser' });
  });
});
