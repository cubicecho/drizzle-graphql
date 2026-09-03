import type {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
} from 'graphql';
import { afterAll, beforeAll, describe, expectTypeOf, it } from 'vitest';
import type {
  AggregateResolver,
  DeleteResolver,
  DeleteSingleResolver,
  ExtractTables,
  InsertArrResolver,
  InsertResolver,
  SelectResolver,
  SelectSingleResolver,
  UpdateManyResolver,
  UpdateResolver,
  UpdateSingleResolver,
  UpsertArrResolver,
  UpsertResolver,
} from '@/index';
import type * as schema from '../schema/pg';
import { createMinimalCtx, type DefaultEntities, type MinimalContext, setupMinimal, teardownMinimal } from './common';

const DATA_DIR = `./tests/.temp/pgdata-type-${Date.now()}`;

const ctx: MinimalContext = createMinimalCtx();

// The keys below are the ones a *default* build publishes. The fixture renames its types with
// a mapper function, which keys its own entities loosely, so these assertions are made against
// the default shape rather than through the fixture's context.

beforeAll(async () => {
  await setupMinimal(ctx, DATA_DIR);
});

afterAll(async () => {
  await teardownMinimal(ctx, DATA_DIR);
});

// The generated-entity keys below are written WITHOUT `readonly`, unlike the SQLite and
// MySQL suites. `ExtractTables` maps homomorphically over whatever the database handle's
// generic slot holds, so the modifier is inherited from there: SQLite/MySQL still carry the
// schema module, and a namespace import's properties are readonly, while a PostgreSQL handle
// carries `typeof schema.relations` — a plain object type — whose properties are mutable.
// `toEqualTypeOf` compares modifiers, so the two dialects genuinely differ here.
describe.sequential('Type tests', () => {
  it('Schema', () => {
    expectTypeOf(ctx.schema).toEqualTypeOf<GraphQLSchema>();
  });

  it('Queries', () => {
    expectTypeOf<DefaultEntities['queries']>().toEqualTypeOf<
      {
        customers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<typeof schema.Customers, ExtractTables<typeof schema>, never>;
        };
        posts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<typeof schema.Posts, ExtractTables<typeof schema>, never>;
        };
        tags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<typeof schema.Tags, ExtractTables<typeof schema>, never>;
        };
        users: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<typeof schema.Users, ExtractTables<typeof schema>, never>;
        };
      } & {
        customersSingle: {
          type: GraphQLObjectType;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<typeof schema.Customers, ExtractTables<typeof schema>, never>;
        };
        postsSingle: {
          type: GraphQLObjectType;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<typeof schema.Posts, ExtractTables<typeof schema>, never>;
        };
        tagsSingle: {
          type: GraphQLObjectType;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<typeof schema.Tags, ExtractTables<typeof schema>, never>;
        };
        usersSingle: {
          type: GraphQLObjectType;
          args: {
            offset: { type: GraphQLScalarType<number, number> };
            orderBy: { type: GraphQLInputObjectType };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<typeof schema.Users, ExtractTables<typeof schema>, never>;
        };
      } & {
        customersAggregate: {
          type: GraphQLNonNull<GraphQLObjectType>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: AggregateResolver<typeof schema.Customers>;
        };
        postsAggregate: {
          type: GraphQLNonNull<GraphQLObjectType>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: AggregateResolver<typeof schema.Posts>;
        };
        tagsAggregate: {
          type: GraphQLNonNull<GraphQLObjectType>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: AggregateResolver<typeof schema.Tags>;
        };
        usersAggregate: {
          type: GraphQLNonNull<GraphQLObjectType>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: AggregateResolver<typeof schema.Users>;
        };
      }
    >();
  });

  it('Mutations', () => {
    expectTypeOf<DefaultEntities['mutations']>().toEqualTypeOf<
      {
        createCustomers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Customers, false>;
        };
        createPosts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Posts, false>;
        };
        createTags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Tags, false>;
        };
        createUsers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Users, false>;
        };
      } & {
        createCustomersSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Customers, false>;
        };
        createPostsSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Posts, false>;
        };
        createTagsSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Tags, false>;
        };
        createUsersSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Users, false>;
        };
      } & {
        upsertCustomers?: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertArrResolver<typeof schema.Customers, false>;
        };
        upsertPosts?: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertArrResolver<typeof schema.Posts, false>;
        };
        upsertTags?: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertArrResolver<typeof schema.Tags, false>;
        };
        upsertUsers?: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertArrResolver<typeof schema.Users, false>;
        };
      } & {
        upsertCustomersSingle?: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertResolver<typeof schema.Customers, false>;
        };
        upsertPostsSingle?: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertResolver<typeof schema.Posts, false>;
        };
        upsertTagsSingle?: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertResolver<typeof schema.Tags, false>;
        };
        upsertUsersSingle?: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            onConflict: { type: GraphQLInputObjectType };
          };
          resolve: UpsertResolver<typeof schema.Users, false>;
        };
      } & {
        updateCustomers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Customers, false>;
        };
        updatePosts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Posts, false>;
        };
        updateTags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Tags, false>;
        };
        updateUsers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Users, false>;
        };
      } & {
        updateCustomersMany: {
          type: GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Customers, false>;
        };
        updatePostsMany: {
          type: GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Posts, false>;
        };
        updateTagsMany: {
          type: GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Tags, false>;
        };
        updateUsersMany: {
          type: GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Users, false>;
        };
      } & {
        updateCustomersSingle: {
          type: GraphQLObjectType;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: UpdateSingleResolver<typeof schema.Customers, false>;
        };
        updatePostsSingle: {
          type: GraphQLObjectType;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: UpdateSingleResolver<typeof schema.Posts, false>;
        };
        updateTagsSingle: {
          type: GraphQLObjectType;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: UpdateSingleResolver<typeof schema.Tags, false>;
        };
        updateUsersSingle: {
          type: GraphQLObjectType;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: UpdateSingleResolver<typeof schema.Users, false>;
        };
      } & {
        deleteCustomers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Customers, false>;
        };
        deletePosts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Posts, false>;
        };
        deleteTags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Tags, false>;
        };
        deleteUsers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Users, false>;
        };
      } & {
        deleteCustomersSingle: {
          type: GraphQLObjectType;
          args: {
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: DeleteSingleResolver<typeof schema.Customers, false>;
        };
        deletePostsSingle: {
          type: GraphQLObjectType;
          args: {
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: DeleteSingleResolver<typeof schema.Posts, false>;
        };
        deleteTagsSingle: {
          type: GraphQLObjectType;
          args: {
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: DeleteSingleResolver<typeof schema.Tags, false>;
        };
        deleteUsersSingle: {
          type: GraphQLObjectType;
          args: {
            where: { type: GraphQLNonNull<GraphQLInputObjectType> };
          };
          resolve: DeleteSingleResolver<typeof schema.Users, false>;
        };
      }
    >();
  });

  it('Types', () => {
    expectTypeOf<DefaultEntities['types']>().toEqualTypeOf<
      {
        Customers: GraphQLObjectType;
        Posts: GraphQLObjectType;
        Tags: GraphQLObjectType;
        Users: GraphQLObjectType;
      } & {
        CustomersAggregate: GraphQLObjectType;
        PostsAggregate: GraphQLObjectType;
        TagsAggregate: GraphQLObjectType;
        UsersAggregate: GraphQLObjectType;
      } & {
        Customers: GraphQLObjectType;
        Posts: GraphQLObjectType;
        Tags: GraphQLObjectType;
        Users: GraphQLObjectType;
      }
    >();
  });

  it('Inputs', () => {
    expectTypeOf<DefaultEntities['inputs']>().toEqualTypeOf<
      {
        CreateCustomersInput: GraphQLInputObjectType;
        CreatePostsInput: GraphQLInputObjectType;
        CreateTagsInput: GraphQLInputObjectType;
        CreateUsersInput: GraphQLInputObjectType;
      } & {
        UpdateCustomersInput: GraphQLInputObjectType;
        UpdatePostsInput: GraphQLInputObjectType;
        UpdateTagsInput: GraphQLInputObjectType;
        UpdateUsersInput: GraphQLInputObjectType;
      } & {
        UpdateCustomersManyInput: GraphQLInputObjectType;
        UpdatePostsManyInput: GraphQLInputObjectType;
        UpdateTagsManyInput: GraphQLInputObjectType;
        UpdateUsersManyInput: GraphQLInputObjectType;
      } & {
        CustomersOrderBy: GraphQLInputObjectType;
        PostsOrderBy: GraphQLInputObjectType;
        TagsOrderBy: GraphQLInputObjectType;
        UsersOrderBy: GraphQLInputObjectType;
      } & {
        CustomersFilters: GraphQLInputObjectType;
        PostsFilters: GraphQLInputObjectType;
        TagsFilters: GraphQLInputObjectType;
        UsersFilters: GraphQLInputObjectType;
      }
    >();
  });
});
