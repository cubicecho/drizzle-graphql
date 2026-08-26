import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
} from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import z from 'zod';
import { createMinimalCtx, type MinimalContext, setupMinimal, teardownMinimal } from './common';

const DATA_DIR = `./tests/.temp/pgdata-returned-data-${Date.now()}`;

const ctx: MinimalContext = createMinimalCtx();

beforeAll(async () => {
  await setupMinimal(ctx, DATA_DIR);
});

afterAll(async () => {
  await teardownMinimal(ctx, DATA_DIR);
});

describe.sequential('Returned data tests', () => {
  it('Schema', () => {
    expect(ctx.schema instanceof GraphQLSchema).toBe(true);
  });

  it('Entities', () => {
    ctx.entities.mutations;
    const schema = z
      .object({
        queries: z
          .object({
            users: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    limit: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    after: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                        description: z.string(),
                      })
                      .strict(),
                    distinct: z
                      .object({
                        type: z.instanceof(GraphQLList),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            user: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            posts: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    limit: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    after: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                        description: z.string(),
                      })
                      .strict(),
                    distinct: z
                      .object({
                        type: z.instanceof(GraphQLList),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            post: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            customers: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    limit: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    after: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                        description: z.string(),
                      })
                      .strict(),
                    distinct: z
                      .object({
                        type: z.instanceof(GraphQLList),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            customer: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            tags: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    limit: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    after: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                        description: z.string(),
                      })
                      .strict(),
                    distinct: z
                      .object({
                        type: z.instanceof(GraphQLList),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            tag: z
              .object({
                args: z
                  .object({
                    orderBy: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                    offset: z
                      .object({
                        type: z.instanceof(GraphQLScalarType),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            usersAggregate: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            usersGroupBy: z
              .object({
                args: z
                  .object({
                    groupBy: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                        description: z.string(),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                    having: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            postsAggregate: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            postsGroupBy: z
              .object({
                args: z
                  .object({
                    groupBy: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                        description: z.string(),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                    having: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            customersAggregate: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            customersGroupBy: z
              .object({
                args: z
                  .object({
                    groupBy: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                        description: z.string(),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                    having: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            tagsAggregate: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            tagsGroupBy: z
              .object({
                args: z
                  .object({
                    groupBy: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                        description: z.string(),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                    having: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                        description: z.string(),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
          })
          .strict(),
        mutations: z
          .object({
            createUsers: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            createUser: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            updateUser: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updateUserSingle: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            deleteUser: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            deleteUserSingle: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            createPosts: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            createPost: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            updatePost: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updatePostSingle: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            deletePost: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            deletePostSingle: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            createCustomers: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            createCustomer: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            updateCustomer: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updateCustomerSingle: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            deleteCustomer: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            deleteCustomerSingle: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            createTags: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            createTag: z
              .object({
                args: z
                  .object({
                    values: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            updateTag: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updateTagSingle: z
              .object({
                args: z
                  .object({
                    set: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
            deleteTag: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLInputObjectType),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            deleteTagSingle: z
              .object({
                args: z
                  .object({
                    where: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLObjectType),
              })
              .strict(),
          })
          .strict(),
        types: z
          .object({
            User: z.instanceof(GraphQLObjectType),
            User: z.instanceof(GraphQLObjectType),
            Post: z.instanceof(GraphQLObjectType),
            Post: z.instanceof(GraphQLObjectType),
            Customer: z.instanceof(GraphQLObjectType),
            Customer: z.instanceof(GraphQLObjectType),
            Tag: z.instanceof(GraphQLObjectType),
            Tag: z.instanceof(GraphQLObjectType),
            UserAggregate: z.instanceof(GraphQLObjectType),
            UserGroupBy: z.instanceof(GraphQLObjectType),
            PostAggregate: z.instanceof(GraphQLObjectType),
            PostGroupBy: z.instanceof(GraphQLObjectType),
            CustomerAggregate: z.instanceof(GraphQLObjectType),
            CustomerGroupBy: z.instanceof(GraphQLObjectType),
            TagAggregate: z.instanceof(GraphQLObjectType),
            TagGroupBy: z.instanceof(GraphQLObjectType),
          })
          .strict(),
        inputs: z
          .object({
            UserFilters: z.instanceof(GraphQLInputObjectType),
            UserHaving: z.instanceof(GraphQLInputObjectType),
            UserOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateUserInput: z.instanceof(GraphQLInputObjectType),
            UpdateUserInput: z.instanceof(GraphQLInputObjectType),
            PostFilters: z.instanceof(GraphQLInputObjectType),
            PostHaving: z.instanceof(GraphQLInputObjectType),
            PostOrderBy: z.instanceof(GraphQLInputObjectType),
            CreatePostInput: z.instanceof(GraphQLInputObjectType),
            UpdatePostInput: z.instanceof(GraphQLInputObjectType),
            CustomerFilters: z.instanceof(GraphQLInputObjectType),
            CustomerHaving: z.instanceof(GraphQLInputObjectType),
            CustomerOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateCustomerInput: z.instanceof(GraphQLInputObjectType),
            UpdateCustomerInput: z.instanceof(GraphQLInputObjectType),
            TagFilters: z.instanceof(GraphQLInputObjectType),
            TagHaving: z.instanceof(GraphQLInputObjectType),
            TagOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateTagInput: z.instanceof(GraphQLInputObjectType),
            UpdateTagInput: z.instanceof(GraphQLInputObjectType),
          })
          .strict(),
        fieldResolvers: z.record(z.string(), z.record(z.string(), z.function())).optional(),
      })
      .strict();

    const parseRes = schema.safeParse(ctx.entities);

    if (!parseRes.success) {
      console.log(parseRes.error);
    }

    expect(parseRes.success).toEqual(true);
  });
});
