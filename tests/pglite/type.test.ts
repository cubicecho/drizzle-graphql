import type { Relations } from 'drizzle-orm';
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
  ExtractTables,
  InsertArrResolver,
  InsertResolver,
  SelectResolver,
  SelectSingleResolver,
  UpdateResolver,
} from '@/index';
import type * as schema from '../schema/pg';
import { createMinimalCtx, type MinimalContext, setupMinimal, teardownMinimal } from './common';

const DATA_DIR = `./tests/.temp/pgdata-type-${Date.now()}`;

const ctx: MinimalContext = createMinimalCtx();

beforeAll(async () => {
  await setupMinimal(ctx, DATA_DIR);
});

afterAll(async () => {
  await teardownMinimal(ctx, DATA_DIR);
});

describe.sequential('Type tests', () => {
  it('Schema', () => {
    expectTypeOf(ctx.schema).toEqualTypeOf<GraphQLSchema>();
  });

  it('Queries', () => {
    expectTypeOf(ctx.entities.queries).toEqualTypeOf<
      {
        readonly customers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<
            typeof schema.Customers,
            ExtractTables<typeof schema>,
            typeof schema.customersRelations extends Relations<any, infer RelConf> ? RelConf : never
          >;
        };
        readonly posts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<
            typeof schema.Posts,
            ExtractTables<typeof schema>,
            typeof schema.postsRelations extends Relations<any, infer RelConf> ? RelConf : never
          >;
        };
        readonly tags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<typeof schema.Tags, ExtractTables<typeof schema>, never>;
        };
        readonly users: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            limit: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
            distinct: { type: GraphQLList<GraphQLNonNull<GraphQLEnumType>> };
          };
          resolve: SelectResolver<
            typeof schema.Users,
            ExtractTables<typeof schema>,
            typeof schema.usersRelations extends Relations<any, infer RelConf> ? RelConf : never
          >;
        };
      } & {
        readonly customersSingle: {
          type: GraphQLObjectType;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<
            typeof schema.Customers,
            ExtractTables<typeof schema>,
            typeof schema.customersRelations extends Relations<any, infer RelConf> ? RelConf : never
          >;
        };
        readonly postsSingle: {
          type: GraphQLObjectType;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<
            typeof schema.Posts,
            ExtractTables<typeof schema>,
            typeof schema.postsRelations extends Relations<any, infer RelConf> ? RelConf : never
          >;
        };
        readonly tagsSingle: {
          type: GraphQLObjectType;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<typeof schema.Tags, ExtractTables<typeof schema>, never>;
        };
        readonly usersSingle: {
          type: GraphQLObjectType;
          args: {
            orderBy: { type: GraphQLInputObjectType };
            offset: { type: GraphQLScalarType<number, number> };
            where: { type: GraphQLInputObjectType };
          };
          resolve: SelectSingleResolver<
            typeof schema.Users,
            ExtractTables<typeof schema>,
            typeof schema.usersRelations extends Relations<any, infer RelConf> ? RelConf : never
          >;
        };
      } & {
        readonly customersAggregate: {
          type: GraphQLNonNull<GraphQLObjectType>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: AggregateResolver<typeof schema.Customers>;
        };
        readonly postsAggregate: {
          type: GraphQLNonNull<GraphQLObjectType>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: AggregateResolver<typeof schema.Posts>;
        };
        readonly tagsAggregate: {
          type: GraphQLNonNull<GraphQLObjectType>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: AggregateResolver<typeof schema.Tags>;
        };
        readonly usersAggregate: {
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
    expectTypeOf(ctx.entities.mutations).toEqualTypeOf<
      {
        readonly createCustomers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Customers, false>;
        };
        readonly createPosts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Posts, false>;
        };
        readonly createTags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Tags, false>;
        };
        readonly createUsers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Users, false>;
        };
      } & {
        readonly createCustomersSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Customers, false>;
        };
        readonly createPostsSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Posts, false>;
        };
        readonly createTagsSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Tags, false>;
        };
        readonly createUsersSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Users, false>;
        };
      } & {
        readonly updateCustomers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Customers, false>;
        };
        readonly updatePosts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Posts, false>;
        };
        readonly updateTags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Tags, false>;
        };
        readonly updateUsers: {
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
        readonly deleteCustomers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Customers, false>;
        };
        readonly deletePosts: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Posts, false>;
        };
        readonly deleteTags: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Tags, false>;
        };
        readonly deleteUsers: {
          type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Users, false>;
        };
      }
    >();
  });

  it('Types', () => {
    expectTypeOf(ctx.entities.types).toEqualTypeOf<
      {
        readonly Customers: GraphQLObjectType;
        readonly Posts: GraphQLObjectType;
        readonly Tags: GraphQLObjectType;
        readonly Users: GraphQLObjectType;
      } & {
        readonly Customers: GraphQLObjectType;
        readonly Posts: GraphQLObjectType;
        readonly Tags: GraphQLObjectType;
        readonly Users: GraphQLObjectType;
      } & {
        readonly CustomersAggregate: GraphQLObjectType;
        readonly PostsAggregate: GraphQLObjectType;
        readonly TagsAggregate: GraphQLObjectType;
        readonly UsersAggregate: GraphQLObjectType;
      }
    >();
  });

  it('Inputs', () => {
    expectTypeOf(ctx.entities.inputs).toEqualTypeOf<
      {
        readonly UsersFilters: GraphQLInputObjectType;
        readonly CustomersFilters: GraphQLInputObjectType;
        readonly PostsFilters: GraphQLInputObjectType;
        readonly TagsFilters: GraphQLInputObjectType;
      } & {
        readonly UsersOrderBy: GraphQLInputObjectType;
        readonly CustomersOrderBy: GraphQLInputObjectType;
        readonly PostsOrderBy: GraphQLInputObjectType;
        readonly TagsOrderBy: GraphQLInputObjectType;
      } & {
        readonly CreateUsersInput: GraphQLInputObjectType;
        readonly CreateCustomersInput: GraphQLInputObjectType;
        readonly CreatePostsInput: GraphQLInputObjectType;
        readonly CreateTagsInput: GraphQLInputObjectType;
      } & {
        readonly UpdateUsersInput: GraphQLInputObjectType;
        readonly UpdateCustomersInput: GraphQLInputObjectType;
        readonly UpdatePostsInput: GraphQLInputObjectType;
        readonly UpdateTagsInput: GraphQLInputObjectType;
      }
    >();
  });
});
