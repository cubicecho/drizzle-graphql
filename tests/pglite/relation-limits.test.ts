import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import {
  type GraphQLFieldConfig,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  getNamedType,
  graphql,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, type LimitsConfig, resolveSelection, selectionToWith } from '@/index';
import * as schema from '../schema/pg';
import { setupTables } from './common';

let pglite: PGlite;
let db: any;

const build = (limits?: LimitsConfig, eagerLoadRelations?: boolean) =>
  buildSchema(db, {
    ...(limits ? { limits } : {}),
    ...(eagerLoadRelations === undefined ? {} : { eagerLoadRelations }),
  });

// A fresh context object per call so the request-scoped relation batch loaders behave as they
// would in a real request.
const run = (gqlSchema: GraphQLSchema, source: string, variableValues?: Record<string, any>) =>
  graphql({ schema: gqlSchema, source, variableValues, contextValue: {} });

const estimatorOf = (gqlSchema: GraphQLSchema, typeName: string | undefined, fieldName: string) => {
  const type = typeName ? (gqlSchema.getType(typeName) as GraphQLObjectType) : gqlSchema.getQueryType()!;
  return type.getFields()[fieldName]!.extensions['complexity'] as (options: {
    args: Record<string, any>;
    childComplexity: number;
  }) => number;
};

const byId = `orderBy: { id: { direction: asc, priority: 1 } }`;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations: schema.relations });
  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  await setupTables({ db } as any);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

// Seed recap: posts 1,2,3,6 belong to user 1 (and so to customer 1), posts 4,5 to user 5.
describe.sequential('limits.relations', () => {
  for (const [label, eager] of [
    ['eagerly loaded', true],
    ['lazily resolved', false],
  ] as const) {
    describe(label, () => {
      it('gives relation fields a default apart from the root list of the table they read', async () => {
        const { schema: gqlSchema } = build({ defaultLimit: 5, relations: { defaultLimit: 1 } }, eager);
        const res = await run(gqlSchema, `{ posts { id } users(${byId}) { id posts(${byId}) { id } } }`);

        expect(res.errors).toBeUndefined();
        expect((res.data as any).posts).toHaveLength(5);
        expect((res.data as any).users.map((user: any) => user.posts)).toEqual([[{ id: 1 }], [], [{ id: 4 }]]);
      });

      it('wins over the target table entry, and a per-relation entry wins over it', async () => {
        const { schema: gqlSchema } = build(
          {
            tables: { Posts: { defaultLimit: 4 } },
            relations: { defaultLimit: 1, tables: { Customers: { posts: { defaultLimit: 3 } } } },
          },
          eager,
        );
        const res = await run(
          gqlSchema,
          `{ posts { id } users(where: { id: { eq: 1 } }) { posts(${byId}) { id } } customers(where: { id: { eq: 1 } }) { posts(${byId}) { id } } }`,
        );

        expect(res.errors).toBeUndefined();
        const data = res.data as any;
        expect(data.posts).toHaveLength(4);
        expect(data.users[0].posts).toEqual([{ id: 1 }]);
        expect(data.customers[0].posts).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      });

      it('inherits the keys it does not set from the target table policy', async () => {
        // No relation maxLimit: the target's (3) still bounds an explicit relation limit.
        const { schema: gqlSchema } = build(
          { tables: { Posts: { maxLimit: 3 } }, relations: { defaultLimit: 1 } },
          eager,
        );
        const res = await run(gqlSchema, `{ users { id posts(limit: 4) { id } } }`);

        expect(res.errors?.[0]?.message).toBe("'limit' of 4 exceeds the maximum of 3.");
      });

      it('rejects a relation limit above the relation maxLimit, whatever the root allows', async () => {
        const { schema: gqlSchema } = build({ maxLimit: 100, relations: { maxLimit: 2 } }, eager);
        const ok = await run(gqlSchema, `{ posts(limit: 6) { id } users { posts(limit: 2) { id } } }`);
        expect(ok.errors).toBeUndefined();

        const res = await run(gqlSchema, `{ users { id posts(limit: 3) { id } } }`);
        expect(res.errors?.[0]?.message).toBe("'limit' of 3 exceeds the maximum of 2.");
        expect(res.errors?.[0]?.extensions?.['code']).toBe('DRIZZLE_LIMIT_EXCEEDED');
        expect(res.errors?.[0]?.extensions?.['drizzle']).toMatchObject({
          table: 'Posts',
          operation: 'relation',
          relation: 'posts',
        });
      });

      it('clamps under a per-relation clampToMax', async () => {
        const { schema: gqlSchema } = build(
          { relations: { maxLimit: 2, tables: { Users: { posts: { clampToMax: true } } } } },
          eager,
        );
        const users = await run(gqlSchema, `{ users(where: { id: { eq: 1 } }) { posts(limit: 4) { id } } }`);
        expect(users.errors).toBeUndefined();
        expect((users.data as any).users[0].posts).toHaveLength(2);

        // The other relation into Posts still rejects.
        const customers = await run(gqlSchema, `{ customers { posts(limit: 4) { id } } }`);
        expect(customers.errors?.[0]?.message).toBe("'limit' of 4 exceeds the maximum of 2.");
      });
    });
  }

  it('applies to a paginated relation window', async () => {
    // `after` and the `cursor` field always go through the batch loader's windowed query.
    const { schema: gqlSchema } = build({ defaultLimit: 10, relations: { defaultLimit: 2 } });
    const first = await run(gqlSchema, `{ users(where: { id: { eq: 1 } }) { posts(${byId}) { id cursor } } }`);
    expect(first.errors).toBeUndefined();
    const page = (first.data as any).users[0].posts;
    expect(page.map((post: any) => post.id)).toEqual([1, 2]);

    const second = await run(
      gqlSchema,
      `query ($after: String) { users(where: { id: { eq: 1 } }) { posts(${byId}, after: $after) { id } } }`,
      { after: page[1].cursor },
    );
    expect(second.errors).toBeUndefined();
    expect((second.data as any).users[0].posts).toEqual([{ id: 3 }, { id: 6 }]);
  });

  it('bounds a relation on a mutation payload', async () => {
    const { schema: gqlSchema } = build({ relations: { defaultLimit: 1 } });
    const res = await run(
      gqlSchema,
      `mutation { updateUsers(set: { profession: "changed" }, where: { id: { eq: 1 } }) { id posts { id } } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data as any).updateUsers[0].posts).toHaveLength(1);
  });

  it('leaves relation aggregates counting every row', async () => {
    const { schema: gqlSchema } = build({ relations: { defaultLimit: 1, maxLimit: 1 } });
    const res = await run(gqlSchema, `{ users(where: { id: { eq: 1 } }) { postsAggregate { count } } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data as any).users[0].postsAggregate.count).toBe(4);
  });

  it('applies to the nested entries of resolveSelection and selectionToWith', async () => {
    const { entities } = buildSchema(db, { limits: { defaultLimit: 10, relations: { defaultLimit: 1 } } });
    const list = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(entities.types['Users'] as GraphQLObjectType)));
    const fields: Record<string, GraphQLFieldConfig<any, any>> = {
      resolved: {
        type: list,
        resolve: (_src, _args, context, info) =>
          resolveSelection(info, { db, table: 'Users', context, where: { id: { eq: 1 } } }),
      },
      withTree: {
        type: list,
        resolve: (_src, _args, context, info) =>
          db.query.Users.findMany({
            where: { id: 1 },
            with: selectionToWith(info, { db, table: 'Users', context }),
          }),
      },
    };
    const gqlSchema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields }) });
    const res = await run(gqlSchema, `{ resolved { posts { id } } withTree { posts { id } } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data as any).resolved[0].posts).toHaveLength(1);
    expect((res.data as any).withTree[0].posts).toHaveLength(1);
  });

  describe('cost hints', () => {
    it('prices a nested list at the relation default instead of the root page', () => {
      const { schema: gqlSchema } = build({
        defaultLimit: 500,
        maxLimit: 1000,
        relations: { defaultLimit: 20, tables: { Customers: { posts: { defaultLimit: 50, maxLimit: 60 } } } },
      });

      const root = estimatorOf(gqlSchema, undefined, 'posts');
      expect(root({ args: {}, childComplexity: 1 })).toBe(500);

      const userPosts = estimatorOf(gqlSchema, 'Users', 'posts');
      expect(userPosts({ args: {}, childComplexity: 2 })).toBe(40);
      expect(userPosts({ args: { limit: 5 }, childComplexity: 2 })).toBe(10);
      // Never priced above the maxLimit the relation inherits from the top level.
      expect(userPosts({ args: { limit: 5000 }, childComplexity: 1 })).toBe(1000);

      const customerPosts = estimatorOf(gqlSchema, 'Customers', 'posts');
      expect(customerPosts({ args: {}, childComplexity: 1 })).toBe(50);
      expect(customerPosts({ args: { limit: 100 }, childComplexity: 1 })).toBe(60);

      // `users { posts }` at the default pages: 500 × (1 + 20 × 1), not 500 × (1 + 500 × 1).
      const users = estimatorOf(gqlSchema, undefined, 'users');
      expect(users({ args: {}, childComplexity: 1 + userPosts({ args: {}, childComplexity: 1 }) })).toBe(10_500);
    });

    it('prices relations that no policy bounds at complexity.defaultListSize', () => {
      const { schema: gqlSchema } = buildSchema(db, {
        limits: {
          tables: { Users: { defaultLimit: 3 } },
          relations: { tables: { Customers: { posts: { maxLimit: 7 } } } },
        },
        complexity: { defaultListSize: 25 },
      });

      expect(estimatorOf(gqlSchema, 'Users', 'posts')({ args: {}, childComplexity: 1 })).toBe(25);
      expect(estimatorOf(gqlSchema, 'Customers', 'posts')({ args: {}, childComplexity: 1 })).toBe(7);
    });
  });

  describe('config validation', () => {
    it('rejects a non-positive relation limit', () => {
      expect(() => build({ relations: { defaultLimit: 0 } })).toThrow(
        /config\.limits\.relations\.defaultLimit must be a positive integer/,
      );
      expect(() => build({ relations: { tables: { Users: { posts: { maxLimit: 2.5 } } } } })).toThrow(
        /config\.limits\.relations\.tables\.Users\.posts\.maxLimit must be a positive integer/,
      );
    });

    it('rejects a table that is not in the schema', () => {
      expect(() => build({ relations: { tables: { Nope: { posts: { defaultLimit: 1 } } } } })).toThrow(
        /config\.limits\.relations\.tables names 'Nope', which is not a table in the Drizzle schema/,
      );
    });

    it('rejects a relation the table does not declare, naming the ones it does', () => {
      // Keyed by the parent: `Posts.posts` does not exist, `Users.posts` does.
      expect(() => build({ relations: { tables: { Posts: { posts: { defaultLimit: 1 } } } } })).toThrow(
        /config\.limits\.relations\.tables\.Posts names 'posts', which is not a relation of 'Posts' \(it has 'author', 'customer'\)/,
      );
    });

    it('rejects a to-one relation', () => {
      expect(() => build({ relations: { tables: { Users: { customer: { defaultLimit: 1 } } } } })).toThrow(
        /config\.limits\.relations\.tables\.Users\.customer is a to-one relation/,
      );
    });
  });

  it('changes nothing in the SDL', async () => {
    const { printSchema } = await import('graphql');
    expect(printSchema(build({ defaultLimit: 5, relations: { defaultLimit: 1 } }).schema)).toBe(
      printSchema(build({ defaultLimit: 5 }).schema),
    );
    // The relation field's `limit` argument carries no default value.
    const usersType = getNamedType(build().schema.getQueryType()!.getFields()['users']!.type) as GraphQLObjectType;
    expect(usersType.getFields()['posts']!.args.find((arg) => arg.name === 'limit')!.defaultValue).toBeUndefined();
  });
});
