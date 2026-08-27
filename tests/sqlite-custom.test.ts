import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, type GeneratedEntities } from '@/index';
import * as schema from './schema/sqlite';
import { GraphQLClient } from './util/query';

interface Context {
  db: BaseSQLiteDatabase<'async', any, typeof schema, typeof schema.relations>;
  client: Client;
  schema: GraphQLSchema;
  entities: GeneratedEntities<BaseSQLiteDatabase<'async', any, typeof schema>>;
  server: Server;
  gql: GraphQLClient;
}

const ctx: Context = {} as any;

beforeAll(async () => {
  const sleep = 250;
  let timeLeft = 5000;
  let connected = false;
  let lastError: unknown | undefined;

  do {
    try {
      ctx.client = createClient({
        url: `file://${path.join(__dirname, '/.temp/db-custom.sqlite')}`,
      });
      connected = true;
      break;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, sleep));
      timeLeft -= sleep;
    }
  } while (timeLeft > 0);

  if (!connected) {
    console.error('Cannot connect to libsql');
    throw lastError;
  }

  ctx.db = drizzle({
    client: ctx.client,
    schema,
    relations: schema.relations,
    logger: !!process.env['LOG_SQL'],
  });

  const { entities } = buildSchema(ctx.db);

  const customSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        customUsersSingle: entities.queries.usersSingle,
        customUsers: entities.queries.users,
        customCustomersSingle: entities.queries.customersSingle,
        customCustomers: entities.queries.customers,
        customPostsSingle: entities.queries.postsSingle,
        customPosts: entities.queries.posts,
      },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: {
        deleteFromCustomUsers: entities.mutations.deleteUsers,
        deleteFromCustomCustomers: entities.mutations.deleteCustomers,
        deleteFromCustomPosts: entities.mutations.deletePosts,
        deleteFromCustomPostsSingle: entities.mutations.deletePostsSingle,
        updateCustomUsers: entities.mutations.updateUsers,
        updateCustomUsersMany: entities.mutations.updateUsersMany,
        updateCustomCustomers: entities.mutations.updateCustomers,
        updateCustomPosts: entities.mutations.updatePosts,
        updateCustomPostsSingle: entities.mutations.updatePostsSingle,
        insertIntoCustomUsers: entities.mutations.createUsers,
        insertIntoCustomUsersSingle: entities.mutations.createUsersSingle,
        insertIntoCustomCustomers: entities.mutations.createCustomers,
        insertIntoCustomCustomersSingle: entities.mutations.createCustomersSingle,
        insertIntoCustomPosts: entities.mutations.createPosts,
        insertIntoCustomPostsSingle: entities.mutations.createPostsSingle,
      },
    }),
    types: [...Object.values(entities.types), ...Object.values(entities.inputs)],
  });

  const yoga = createYoga({
    schema: customSchema,
  });
  const server = createServer(yoga);

  const port = 5003;
  server.listen(port);
  const gql = new GraphQLClient(`http://localhost:${port}/graphql`);

  ctx.schema = customSchema;
  ctx.entities = entities;
  ctx.server = server;
  ctx.gql = gql;
});

afterAll(async (_t) => {
  ctx.client.close();
});

beforeEach(async (_t) => {
  await ctx.db.run(sql`CREATE TABLE IF NOT EXISTS \`customers\` (
		\`id\` integer PRIMARY KEY NOT NULL,
		\`address\` text NOT NULL,
		\`is_confirmed\` integer,
		\`registration_date\` integer NOT NULL,
		\`user_id\` integer NOT NULL,
		FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
	);`);

  await ctx.db.run(sql`CREATE TABLE IF NOT EXISTS \`posts\` (
		\`id\` integer PRIMARY KEY NOT NULL,
		\`content\` text,
		\`author_id\` integer
	);`);

  await ctx.db.run(sql`CREATE TABLE IF NOT EXISTS \`users\` (
		\`id\` integer PRIMARY KEY NOT NULL,
		\`name\` text NOT NULL,
		\`email\` text,
		\`text_json\` text,
		\`blob_bigint\` blob,
		\`numeric\` numeric,
		\`created_at\` integer,
		\`created_at_ms\` integer,
		\`real\` real,
		\`text\` text(255),
		\`role\` text DEFAULT 'user',
		\`is_confirmed\` integer
	);`);

  await ctx.db.insert(schema.Users).values([
    {
      id: 1,
      name: 'FirstUser',
      email: 'userOne@notmail.com',
      textJson: { field: 'value' },
      blobBigInt: BigInt(10),
      numeric: '250.2',
      createdAt: new Date('2024-04-02T06:44:41.785Z'),
      createdAtMs: new Date('2024-04-02T06:44:41.785Z'),
      real: 13.5,
      text: 'sometext',
      role: 'admin',
      isConfirmed: true,
    },
    {
      id: 2,
      name: 'SecondUser',
      createdAt: new Date('2024-04-02T06:44:41.785Z'),
    },
    {
      id: 5,
      name: 'FifthUser',
      createdAt: new Date('2024-04-02T06:44:41.785Z'),
    },
  ]);

  await ctx.db.insert(schema.Posts).values([
    {
      id: 1,
      authorId: 1,
      content: '1MESSAGE',
    },
    {
      id: 2,
      authorId: 1,
      content: '2MESSAGE',
    },
    {
      id: 3,
      authorId: 1,
      content: '3MESSAGE',
    },
    {
      id: 4,
      authorId: 5,
      content: '1MESSAGE',
    },
    {
      id: 5,
      authorId: 5,
      content: '2MESSAGE',
    },
    {
      id: 6,
      authorId: 1,
      content: '4MESSAGE',
    },
  ]);

  await ctx.db.insert(schema.Customers).values([
    {
      id: 1,
      address: 'AdOne',
      isConfirmed: false,
      registrationDate: new Date('2024-03-27T03:54:45.235Z'),
      userId: 1,
    },
    {
      id: 2,
      address: 'AdTwo',
      isConfirmed: false,
      registrationDate: new Date('2024-03-27T03:55:42.358Z'),
      userId: 2,
    },
  ]);
});

afterEach(async (_t) => {
  await ctx.db.run(sql`PRAGMA foreign_keys = OFF;`);
  await ctx.db.run(sql`DROP TABLE IF EXISTS \`customers\`;`);
  await ctx.db.run(sql`DROP TABLE IF EXISTS \`posts\`;`);
  await ctx.db.run(sql`DROP TABLE IF EXISTS \`users\`;`);
  await ctx.db.run(sql`PRAGMA foreign_keys = ON;`);
});

describe.sequential('Query tests', async () => {
  it(`Select single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customUsersSingle {
					id
					name
					email
					textJson
					blobBigInt
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
				}

				customPostsSingle {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsersSingle: {
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          textJson: { field: 'value' },
          blobBigInt: '10',
          numeric: '250.2',
          createdAt: '2024-04-02T06:44:41.000Z',
          createdAtMs: '2024-04-02T06:44:41.785Z',
          real: 13.5,
          text: 'sometext',
          role: 'admin',
          isConfirmed: true,
        },
        customPostsSingle: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
        },
      },
    });
  });

  it(`Select array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customUsers {
					id
					name
					email
					textJson
					blobBigInt
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
				}

				customPosts {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsers: [
          {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            textJson: { field: 'value' },
            blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'admin',
            isConfirmed: true,
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            blobBigInt: null,
            textJson: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: null,
            numeric: null,
            real: null,
            text: null,
            role: 'user',
            isConfirmed: null,
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            role: 'user',
            blobBigInt: null,
            textJson: null,
            createdAtMs: null,
            numeric: null,
            real: null,
            text: null,
            isConfirmed: null,
          },
        ],
        customPosts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
          },
        ],
      },
    });
  });

  it(`Select single with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customUsersSingle {
					id
					name
					email
					textJson
					blobBigInt
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
					posts {
						id
						authorId
						content
					}
				}

				customPostsSingle {
					id
					authorId
					content
					author {
						id
						name
						email
						textJson
						numeric
						createdAt
						createdAtMs
						real
						text
						role
						isConfirmed
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsersSingle: {
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          textJson: { field: 'value' },
          blobBigInt: '10',
          numeric: '250.2',
          createdAt: '2024-04-02T06:44:41.000Z',
          createdAtMs: '2024-04-02T06:44:41.785Z',
          real: 13.5,
          text: 'sometext',
          role: 'admin',
          isConfirmed: true,
          posts: [
            {
              id: 1,
              authorId: 1,
              content: '1MESSAGE',
            },
            {
              id: 2,
              authorId: 1,
              content: '2MESSAGE',
            },
            {
              id: 3,
              authorId: 1,
              content: '3MESSAGE',
            },

            {
              id: 6,
              authorId: 1,
              content: '4MESSAGE',
            },
          ],
        },
        customPostsSingle: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
          author: {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            textJson: { field: 'value' },
            // RQB can't handle blobs in JSON, for now
            // blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'admin',
            isConfirmed: true,
          },
        },
      },
    });
  });

  it(`Select array with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customUsers {
					id
					name
					email
					textJson
					blobBigInt
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
					posts {
						id
						authorId
						content
					}
				}

				customPosts {
					id
					authorId
					content
					author {
						id
						name
						email
						textJson
						numeric
						createdAt
						createdAtMs
						real
						text
						role
						isConfirmed
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsers: [
          {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            textJson: { field: 'value' },
            blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'admin',
            isConfirmed: true,
            posts: [
              {
                id: 1,
                authorId: 1,
                content: '1MESSAGE',
              },
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
              },
              {
                id: 6,
                authorId: 1,
                content: '4MESSAGE',
              },
            ],
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            textJson: null,
            blobBigInt: null,
            numeric: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: null,
            real: null,
            text: null,
            role: 'user',
            isConfirmed: null,
            posts: [],
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            textJson: null,
            blobBigInt: null,
            numeric: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: null,
            real: null,
            text: null,
            role: 'user',
            isConfirmed: null,
            posts: [
              {
                id: 4,
                authorId: 5,
                content: '1MESSAGE',
              },
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
            ],
          },
        ],
        customPosts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            author: {
              id: 5,
              name: 'FifthUser',
              email: null,
              textJson: null,
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: null,
              numeric: null,
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: null,
              real: null,
              text: null,
              role: 'user',
              isConfirmed: null,
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            author: {
              id: 5,
              name: 'FifthUser',
              email: null,
              textJson: null,
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: null,
              numeric: null,
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: null,
              real: null,
              text: null,
              role: 'user',
              isConfirmed: null,
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
        ],
      },
    });
  });

  it(`Select single by fragment`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			query testQuery {
				customUsersSingle {
					...UsersFrag
				}

				customPostsSingle {
					...PostsFrag
				}
			}

			fragment UsersFrag on Users {
				id
				name
				email
				textJson
				blobBigInt
				numeric
				createdAt
				createdAtMs
				real
				text
				role
				isConfirmed
			}

			fragment PostsFrag on Posts {
				id
				authorId
				content
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsersSingle: {
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          textJson: { field: 'value' },
          blobBigInt: '10',
          numeric: '250.2',
          createdAt: '2024-04-02T06:44:41.000Z',
          createdAtMs: '2024-04-02T06:44:41.785Z',
          real: 13.5,
          text: 'sometext',
          role: 'admin',
          isConfirmed: true,
        },
        customPostsSingle: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
        },
      },
    });
  });

  it(`Select array by fragment`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			query testQuery {
				customUsers {
					...UsersFrag
				}

				customPosts {
					...PostsFrag
				}
			}

			fragment UsersFrag on Users {
				id
				name
				email
				textJson
				blobBigInt
				numeric
				createdAt
				createdAtMs
				real
				text
				role
				isConfirmed
			}

			fragment PostsFrag on Posts {
				id
				authorId
				content
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsers: [
          {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            textJson: { field: 'value' },
            blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'admin',
            isConfirmed: true,
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            blobBigInt: null,
            textJson: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: null,
            numeric: null,
            real: null,
            text: null,
            role: 'user',
            isConfirmed: null,
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            role: 'user',
            blobBigInt: null,
            textJson: null,
            createdAtMs: null,
            numeric: null,
            real: null,
            text: null,
            isConfirmed: null,
          },
        ],
        customPosts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
          },
        ],
      },
    });
  });

  it(`Select single with relations by fragment`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			query testQuery {
				customUsersSingle {
					...UsersFrag
				}

				customPostsSingle {
					...PostsFrag
				}
			}

			fragment UsersFrag on Users {
				id
				name
				email
				textJson
				blobBigInt
				numeric
				createdAt
				createdAtMs
				real
				text
				role
				isConfirmed
				posts {
					id
					authorId
					content
				}
			}

			fragment PostsFrag on Posts {
				id
				authorId
				content
				author {
					id
					name
					email
					textJson
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsersSingle: {
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          textJson: { field: 'value' },
          blobBigInt: '10',
          numeric: '250.2',
          createdAt: '2024-04-02T06:44:41.000Z',
          createdAtMs: '2024-04-02T06:44:41.785Z',
          real: 13.5,
          text: 'sometext',
          role: 'admin',
          isConfirmed: true,
          posts: [
            {
              id: 1,
              authorId: 1,
              content: '1MESSAGE',
            },
            {
              id: 2,
              authorId: 1,
              content: '2MESSAGE',
            },
            {
              id: 3,
              authorId: 1,
              content: '3MESSAGE',
            },

            {
              id: 6,
              authorId: 1,
              content: '4MESSAGE',
            },
          ],
        },
        customPostsSingle: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
          author: {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            textJson: { field: 'value' },
            // RQB can't handle blobs in JSON, for now
            // blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'admin',
            isConfirmed: true,
          },
        },
      },
    });
  });

  it(`Select array with relations by fragment`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			query testQuery {
				customUsers {
					...UsersFrag
				}

				customPosts {
					...PostsFrag
				}
			}

			fragment UsersFrag on Users {
				id
				name
				email
				textJson
				blobBigInt
				numeric
				createdAt
				createdAtMs
				real
				text
				role
				isConfirmed
				posts {
					id
					authorId
					content
				}
			}

			fragment PostsFrag on Posts {
				id
				authorId
				content
				author {
					id
					name
					email
					textJson
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsers: [
          {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            textJson: { field: 'value' },
            blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'admin',
            isConfirmed: true,
            posts: [
              {
                id: 1,
                authorId: 1,
                content: '1MESSAGE',
              },
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
              },
              {
                id: 6,
                authorId: 1,
                content: '4MESSAGE',
              },
            ],
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            textJson: null,
            blobBigInt: null,
            numeric: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: null,
            real: null,
            text: null,
            role: 'user',
            isConfirmed: null,
            posts: [],
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            textJson: null,
            blobBigInt: null,
            numeric: null,
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: null,
            real: null,
            text: null,
            role: 'user',
            isConfirmed: null,
            posts: [
              {
                id: 4,
                authorId: 5,
                content: '1MESSAGE',
              },
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
            ],
          },
        ],
        customPosts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            author: {
              id: 5,
              name: 'FifthUser',
              email: null,
              textJson: null,
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: null,
              numeric: null,
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: null,
              real: null,
              text: null,
              role: 'user',
              isConfirmed: null,
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            author: {
              id: 5,
              name: 'FifthUser',
              email: null,
              textJson: null,
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: null,
              numeric: null,
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: null,
              real: null,
              text: null,
              role: 'user',
              isConfirmed: null,
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            author: {
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              textJson: { field: 'value' },
              // RQB can't handle blobs in JSON, for now
              // blobBigInt: '10',
              numeric: '250.2',
              createdAt: '2024-04-02T06:44:41.000Z',
              createdAtMs: '2024-04-02T06:44:41.785Z',
              real: 13.5,
              text: 'sometext',
              role: 'admin',
              isConfirmed: true,
            },
          },
        ],
      },
    });
  });

  it(`Insert single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				insertIntoCustomUsersSingle(
					values: {
						id: 3
						name: "ThirdUser"
						email: "userThree@notmail.com"
						textJson: { field: "value" }
						blobBigInt: "10"
						numeric: "250.2"
						createdAt: "2024-04-02T06:44:41.785Z"
						createdAtMs: "2024-04-02T06:44:41.785Z"
						real: 13.5
						text: "sometext"
						role: admin
						isConfirmed: true
					}
				) {
					id
					name
					email
					textJson
					blobBigInt
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        insertIntoCustomUsersSingle: {
          id: 3,
          name: 'ThirdUser',
          email: 'userThree@notmail.com',
          textJson: { field: 'value' },
          blobBigInt: '10',
          numeric: '250.2',
          createdAt: '2024-04-02T06:44:41.000Z',
          createdAtMs: '2024-04-02T06:44:41.785Z',
          real: 13.5,
          text: 'sometext',
          role: 'admin',
          isConfirmed: true,
        },
      },
    });
  });

  it(`Insert array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				insertIntoCustomUsers(
					values: [
						{
							id: 3
							name: "ThirdUser"
							email: "userThree@notmail.com"
							textJson: { field: "value" }
							blobBigInt: "10"
							numeric: "250.2"
							createdAt: "2024-04-02T06:44:41.785Z"
							createdAtMs: "2024-04-02T06:44:41.785Z"
							real: 13.5
							text: "sometext"
							role: admin
							isConfirmed: true
						}
						{
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							textJson: { field: "value" }
							blobBigInt: "10"
							numeric: "250.2"
							createdAt: "2024-04-02T06:44:41.785Z"
							createdAtMs: "2024-04-02T06:44:41.785Z"
							real: 13.5
							text: "sometext"
							role: user
							isConfirmed: false
						}
					]
				) {
					id
					name
					email
					textJson
					blobBigInt
					numeric
					createdAt
					createdAtMs
					real
					text
					role
					isConfirmed
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        insertIntoCustomUsers: [
          {
            id: 3,
            name: 'ThirdUser',
            email: 'userThree@notmail.com',
            textJson: { field: 'value' },
            blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'admin',
            isConfirmed: true,
          },
          {
            id: 4,
            name: 'FourthUser',
            email: 'userFour@notmail.com',
            textJson: { field: 'value' },
            blobBigInt: '10',
            numeric: '250.2',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
            real: 13.5,
            text: 'sometext',
            role: 'user',
            isConfirmed: false,
          },
        ],
      },
    });
  });

  it(`Update`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomCustomers(set: { isConfirmed: true, address: "Edited" }) {
					id
					address
					isConfirmed
					registrationDate
					userId
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomCustomers: [
          {
            id: 1,
            address: 'Edited',
            isConfirmed: true,
            registrationDate: '2024-03-27T03:54:45.235Z',
            userId: 1,
          },
          {
            id: 2,
            address: 'Edited',
            isConfirmed: true,
            registrationDate: '2024-03-27T03:55:42.358Z',
            userId: 2,
          },
        ],
      },
    });
  });

  it(`Update many`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomUsersMany(
					updates: [
						{ where: { id: { eq: 2 } }, set: { name: "SecondEdited" } }
						{ where: { id: { eq: 999 } }, set: { name: "Nobody" } }
						{ where: { id: { eq: 5 } }, set: { name: "FifthEdited" } }
					]
				) {
					id
					name
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomUsersMany: [{ id: 2, name: 'SecondEdited' }, null, { id: 5, name: 'FifthEdited' }],
      },
    });

    const untouched = await ctx.db.query.Users.findFirst({ where: { id: 1 } });
    expect(untouched?.name).toBe('FirstUser');
  });

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteFromCustomCustomers {
					id
					address
					isConfirmed
					registrationDate
					userId
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteFromCustomCustomers: [
          {
            id: 1,
            address: 'AdOne',
            isConfirmed: false,
            registrationDate: '2024-03-27T03:54:45.235Z',
            userId: 1,
          },
          {
            id: 2,
            address: 'AdTwo',
            isConfirmed: false,
            registrationDate: '2024-03-27T03:55:42.358Z',
            userId: 2,
          },
        ],
      },
    });
  });
});

describe.sequential('Arguments tests', async () => {
  it('Order by', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPosts(
					orderBy: { authorId: { priority: 1, direction: desc }, content: { priority: 0, direction: asc } }
				) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customPosts: [
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },

          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
          },
        ],
      },
    });
  });

  it('Order by on single', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPostsSingle(
					orderBy: { authorId: { priority: 1, direction: desc }, content: { priority: 0, direction: asc } }
				) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customPostsSingle: {
          id: 4,
          authorId: 5,
          content: '1MESSAGE',
        },
      },
    });
  });

  it('Offset & limit', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPosts(offset: 1, limit: 2) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customPosts: [
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
        ],
      },
    });
  });

  it('Offset on single', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPostsSingle(offset: 1) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customPostsSingle: {
          id: 2,
          authorId: 1,
          content: '2MESSAGE',
        },
      },
    });
  });

  it('Filters - top level AND', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPosts(where: { id: { inArray: [2, 3, 4, 5, 6] }, authorId: { ne: 5 }, content: { ne: "3MESSAGE" } }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customPosts: [
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
          },
        ],
      },
    });
  });

  it('Filters - top level OR', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPosts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customPosts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
        ],
      },
    });
  });

  it('Update filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomPosts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }, set: { content: "UPDATED" }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomPosts: [
          {
            id: 1,
            authorId: 1,
            content: 'UPDATED',
          },
          {
            id: 2,
            authorId: 1,
            content: 'UPDATED',
          },
          {
            id: 3,
            authorId: 1,
            content: 'UPDATED',
          },
          {
            id: 4,
            authorId: 5,
            content: 'UPDATED',
          },
          {
            id: 5,
            authorId: 5,
            content: 'UPDATED',
          },
        ],
      },
    });
  });

  it('Delete filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteFromCustomPosts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteFromCustomPosts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
          },
        ],
      },
    });
  });

  it('Update single', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomPostsSingle(where: { id: { eq: 6 } }, set: { content: "UPDATED" }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomPostsSingle: {
          id: 6,
          authorId: 1,
          content: 'UPDATED',
        },
      },
    });
  });

  it('Update single with no match returns null', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomPostsSingle(where: { id: { eq: 999 } }, set: { content: "UPDATED" }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomPostsSingle: null,
      },
    });
  });

  it('Update single with multiple matches throws and writes nothing', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomPostsSingle(where: { authorId: { eq: 5 } }, set: { content: "UPDATED" }) {
					id
				}
			}
		`);

    expect(res.errors?.[0]?.message).toContain('matched more than one row');

    const check = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPosts(where: { content: { eq: "UPDATED" } }) {
					id
				}
			}
		`);
    expect(check).toStrictEqual({ data: { customPosts: [] } });
  });

  it('Update single without where is rejected by validation', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomPostsSingle(set: { content: "UPDATED" }) {
					id
				}
			}
		`);

    expect(res.errors).toBeDefined();
  });

  it('Delete single', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteFromCustomPostsSingle(where: { id: { eq: 6 } }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteFromCustomPostsSingle: {
          id: 6,
          authorId: 1,
          content: '4MESSAGE',
        },
      },
    });

    const check = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPosts(where: { id: { eq: 6 } }) {
					id
				}
			}
		`);
    expect(check).toStrictEqual({ data: { customPosts: [] } });
  });

  it('Delete single with multiple matches throws and deletes nothing', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteFromCustomPostsSingle(where: { authorId: { eq: 5 } }) {
					id
				}
			}
		`);

    expect(res.errors?.[0]?.message).toContain('matched more than one row');

    const check = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customPosts(where: { authorId: { eq: 5 } }) {
					id
				}
			}
		`);
    expect(check).toStrictEqual({
      data: {
        customPosts: [{ id: 4 }, { id: 5 }],
      },
    });
  });

  it('Relations orderBy', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customUsers {
					id
					posts(orderBy: { id: { priority: 1, direction: desc } }) {
						id
						authorId
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsers: [
          {
            id: 1,
            posts: [
              {
                id: 6,
                authorId: 1,
                content: '4MESSAGE',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
              },
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
              {
                id: 1,
                authorId: 1,
                content: '1MESSAGE',
              },
            ],
          },
          {
            id: 2,
            posts: [],
          },
          {
            id: 5,
            posts: [
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
              {
                id: 4,
                authorId: 5,
                content: '1MESSAGE',
              },
            ],
          },
        ],
      },
    });
  });

  it('Relations offset & limit', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customUsers {
					id
					posts(offset: 1, limit: 2) {
						id
						authorId
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsers: [
          {
            id: 1,
            posts: [
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
              },
            ],
          },
          {
            id: 2,
            posts: [],
          },
          {
            id: 5,
            posts: [
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
            ],
          },
        ],
      },
    });
  });

  it('Relations filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				customUsers {
					id
					posts(where: { content: { like: "2%" } }) {
						id
						authorId
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        customUsers: [
          {
            id: 1,
            posts: [
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
              },
            ],
          },
          {
            id: 2,
            posts: [],
          },
          {
            id: 5,
            posts: [
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
              },
            ],
          },
        ],
      },
    });
  });
});
