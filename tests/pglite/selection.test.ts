import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, resolveSelection, selectionToWith } from '@/index';
import {
  createMinimalCtx,
  type MinimalContext,
  schema,
  setupMinimal,
  setupTables,
  sql,
  teardownMinimal,
  teardownTables,
} from './common';

const DATA_DIR = `./tests/.temp/pgdata-selection-${Date.now()}`;
const ctx: MinimalContext = createMinimalCtx();

// The last `with` tree the override resolver produced, so a test can assert on the
// translation itself and not only on the rows it eventually returns.
let lastWith: Record<string, any> | undefined;
let overrideSchema: GraphQLSchema;

const run = async (source: string) => {
  lastWith = undefined;
  return graphql({ schema: overrideSchema, source });
};

beforeAll(async () => {
  await setupMinimal(ctx, DATA_DIR);
  await ctx.db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  await setupTables(ctx);

  // A second build with the default naming, so the override schema's types are the ones
  // `selectionToWith` resolves against without a mapper.
  const { entities } = buildSchema(ctx.db);
  const UsersType = (entities.types as Record<string, GraphQLObjectType>)['Users']!;

  overrideSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        // What a consumer writes when it replaces a generated resolver: its own query,
        // with the library doing the selection translation.
        usersOverride: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UsersType))) as any,
          resolve: (_source, _args, _context, info) => {
            lastWith = selectionToWith(info, { db: ctx.db, table: 'Users' });
            return ctx.db.query.Users.findMany({ with: lastWith as any, orderBy: { id: 'asc' } });
          },
        },
        // The fuller form: the whole read, run against an explicit executor.
        usersResolved: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UsersType))) as any,
          resolve: (_source, _args, _context, info) =>
            resolveSelection(info, { db: ctx.db, table: 'Users', orderBy: { id: { priority: 1, direction: 'asc' } } }),
        },
      },
    }),
  });
});

afterAll(async () => {
  await teardownTables(ctx);
  await teardownMinimal(ctx, DATA_DIR);
});

describe.sequential('selectionToWith', () => {
  it('returns undefined when the selection asks for no relations', async () => {
    const result = await run('{ usersOverride { id name } }');

    expect(result.errors).toBeUndefined();
    expect(lastWith).toBeUndefined();
  });

  it('keeps relations and drops scalars, aggregates and unknown fields', async () => {
    const result = await run('{ usersOverride { id posts { id } postsAggregate { count } } }');

    expect(result.errors).toBeUndefined();
    expect(Object.keys(lastWith!)).toEqual(['posts']);
  });

  it('compiles a relation’s arguments into its entry', async () => {
    await run('{ usersOverride { id posts(limit: 2, offset: 1, where: { content: { eq: "2MESSAGE" } }) { id } } }');

    expect(lastWith!['posts']).toMatchObject({ limit: 2, offset: 1 });
    expect(lastWith!['posts'].where).toBeDefined();
  });

  it('resolves fragments and inline fragments before walking the selection', async () => {
    const withFragments = await run(`
      { usersOverride { id ...UserRelations ... on Users { customer { id } } } }
      fragment UserRelations on Users { posts { id } }
    `);
    const fragmentTree = lastWith;

    const plain = await run('{ usersOverride { id posts { id } customer { id } } }');

    expect(withFragments.errors).toBeUndefined();
    expect(plain.errors).toBeUndefined();
    expect(Object.keys(fragmentTree!).sort()).toEqual(['customer', 'posts']);
    expect(Object.keys(fragmentTree!).sort()).toEqual(Object.keys(lastWith!).sort());
  });

  it('follows an alias back to the relation it selects', async () => {
    await run('{ usersOverride { id recent: posts(limit: 1) { id } } }');

    expect(lastWith!['posts']).toMatchObject({ limit: 1 });
  });

  it('descends into nested relations', async () => {
    await run('{ usersOverride { id posts { id author { id } } } }');

    expect(lastWith!['posts'].with).toHaveProperty('author');
  });

  it('rejects a table that is not in the schema', () => {
    expect(() =>
      selectionToWith(
        { name: 'x', alias: 'x', args: {}, fieldsByTypeName: {} },
        {
          db: ctx.db,
          table: 'NotATable',
        },
      ),
    ).toThrow(/not a table in the Drizzle schema/);
  });
});

describe.sequential('resolveSelection', () => {
  it('returns rows shaped like the type the override replaced', async () => {
    const result = await run('{ usersResolved { id name posts { id content } } }');

    expect(result.errors).toBeUndefined();
    const users = result.data!['usersResolved'] as any[];
    expect(users.map((user) => user.id)).toEqual([1, 2, 5]);
    expect(users[0].posts).toHaveLength(4);
  });

  it('honours arguments on nested relations, which a hand-written override drops', async () => {
    const result = await run(
      '{ usersResolved { id posts(limit: 1, orderBy: { id: { priority: 1, direction: desc } }) { id } } }',
    );

    expect(result.errors).toBeUndefined();
    const users = result.data!['usersResolved'] as any[];
    expect(users[0].posts).toHaveLength(1);
    // The newest post of user 1, not simply its first.
    expect(users[0].posts[0].id).toBe(6);
  });

  it('reads through the executor it is given, so a transaction sees its own writes', async () => {
    let seen: any[] = [];

    await ctx.db
      .transaction(async (tx) => {
        await tx.insert(schema.Users).values({ id: 900, name: 'InFlight' });

        const overrideWithTx = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: {
              users: {
                type: overrideSchema.getQueryType()!.getFields()['usersResolved']!.type as any,
                resolve: (_source, _args, _context, info) =>
                  resolveSelection(info, {
                    db: ctx.db,
                    table: 'Users',
                    executor: tx,
                    where: { id: { eq: 900 } },
                  }),
              },
            },
          }),
        });

        const result = await graphql({ schema: overrideWithTx, source: '{ users { id name } }' });
        expect(result.errors).toBeUndefined();
        seen = result.data!['users'] as any[];

        // Roll back so the row never reaches the other tests.
        throw new Error('rollback');
      })
      .catch(() => undefined);

    expect(seen).toEqual([{ id: 900, name: 'InFlight' }]);
  });
});
