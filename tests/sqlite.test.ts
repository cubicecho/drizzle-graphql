import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import {
  type GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
} from 'graphql';
import { createYoga } from 'graphql-yoga';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import z from 'zod';
import {
  type AggregateResolver,
  buildSchema,
  type DeleteResolver,
  type ExtractTables,
  type GeneratedEntities,
  type InsertArrResolver,
  type InsertResolver,
  type SelectResolver,
  type SelectSingleResolver,
  type UpdateResolver,
} from '@/index';
import * as schema from './schema/sqlite';
import { GraphQLClient } from './util/query';

interface Context {
  db: BaseSQLiteDatabase<'async', any, typeof schema>;
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
        url: `file://${path.join(__dirname, '/.temp/db.sqlite')}`,
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
    logger: !!process.env.LOG_SQL,
  });

  const { schema: gqlSchema, entities } = buildSchema(ctx.db);
  const yoga = createYoga({
    schema: gqlSchema,
  });
  const server = createServer(yoga);

  const port = 4003;
  server.listen(port);
  const gql = new GraphQLClient(`http://localhost:${port}/graphql`);

  ctx.schema = gqlSchema;
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
				usersSingle {
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

				postsSingle {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
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
        postsSingle: {
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
				users {
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

				posts {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
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
				usersSingle {
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

				postsSingle {
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
        usersSingle: {
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
        postsSingle: {
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
				users {
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

				posts {
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
        users: [
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
        posts: [
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
				usersSingle {
					...UsersFrag
				}

				postsSingle {
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
        usersSingle: {
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
        postsSingle: {
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
				users {
					...UsersFrag
				}

				posts {
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
        users: [
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
				usersSingle {
					...UsersFrag
				}

				postsSingle {
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
        usersSingle: {
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
        postsSingle: {
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
				users {
					...UsersFrag
				}

				posts {
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
        users: [
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
        posts: [
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
				createUsersSingle(
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
        createUsersSingle: {
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
				createUsers(
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
        createUsers: [
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
				updateCustomers(set: { isConfirmed: true, address: "Edited" }) {
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
        updateCustomers: [
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

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteCustomers {
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
        deleteCustomers: [
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
				posts(
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
				postsSingle(
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
        postsSingle: {
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
				posts(offset: 1, limit: 2) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
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
    });
  });

  it('Offset on single', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				postsSingle(offset: 1) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        postsSingle: {
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
				posts(where: { id: { inArray: [2, 3, 4, 5, 6] }, authorId: { ne: 5 }, content: { ne: "3MESSAGE" } }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        posts: [
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
				posts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
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
				updatePosts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }, set: { content: "UPDATED" }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updatePosts: [
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
				deletePosts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }) {
					id
					authorId
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deletePosts: [
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

  it('Relations orderBy', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
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
        users: [
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
				users {
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
        users: [
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
				users {
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
        users: [
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

describe.sequential('Aggregate query tests', () => {
  it(`Count`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersAggregate {
					count
				}

				postsAggregate {
					count
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersAggregate: { count: 3 },
        postsAggregate: { count: 6 },
      },
    });
  });

  it(`Per-column counts`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				postsAggregate {
					countNonNull {
						content
					}
					countDistinct {
						authorId
						content
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        postsAggregate: {
          countNonNull: { content: 6 },
          countDistinct: { authorId: 2, content: 4 },
        },
      },
    });
  });

  it(`Numeric aggregates`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				postsAggregate {
					count
					avg {
						id
					}
					sum {
						id
					}
					min {
						id
					}
					max {
						id
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        postsAggregate: {
          count: 6,
          avg: { id: 3.5 },
          sum: { id: 21 },
          min: { id: 1 },
          max: { id: 6 },
        },
      },
    });
  });

  it(`Aggregates with where filter`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				postsAggregate(where: { authorId: { eq: 5 } }) {
					count
					sum {
						id
					}
					min {
						id
					}
					max {
						id
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        postsAggregate: {
          count: 2,
          sum: { id: 9 },
          min: { id: 4 },
          max: { id: 5 },
        },
      },
    });
  });

  it(`Min and max on text and timestamp columns`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersAggregate {
					min {
						name
						createdAt
						createdAtMs
					}
					max {
						name
					}
				}

				customersAggregate {
					min {
						registrationDate
					}
					max {
						registrationDate
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersAggregate: {
          min: {
            name: 'FifthUser',
            createdAt: '2024-04-02T06:44:41.000Z',
            createdAtMs: '2024-04-02T06:44:41.785Z',
          },
          max: {
            name: 'SecondUser',
          },
        },
        customersAggregate: {
          min: { registrationDate: '2024-03-27T03:54:45.235Z' },
          max: { registrationDate: '2024-03-27T03:55:42.358Z' },
        },
      },
    });
  });

  it(`Aggregates over an empty result set`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersAggregate(where: { name: { eq: "Nobody" } }) {
					count
					avg {
						id
					}
					min {
						name
					}
					max {
						createdAt
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersAggregate: {
          count: 0,
          avg: { id: null },
          min: { name: null },
          max: { createdAt: null },
        },
      },
    });
  });
});

describe.sequential('Relation aggregate tests', () => {
  it(`Counts related rows per parent`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users(orderBy: { id: { direction: asc, priority: 1 } }) {
					id
					postsAggregate {
						count
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          { id: 1, postsAggregate: { count: 4 } },
          { id: 2, postsAggregate: { count: 0 } },
          { id: 5, postsAggregate: { count: 2 } },
        ],
      },
    });
  });

  it(`Full aggregate set per parent, filtered and unfiltered`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle(where: { id: { eq: 1 } }) {
					all: postsAggregate {
						count
						avg {
							id
						}
						sum {
							id
						}
						min {
							content
						}
						max {
							content
						}
					}
					filtered: postsAggregate(where: { content: { eq: "1MESSAGE" } }) {
						count
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
          all: {
            count: 4,
            avg: { id: 3 },
            sum: { id: 12 },
            min: { content: '1MESSAGE' },
            max: { content: '4MESSAGE' },
          },
          filtered: { count: 1 },
        },
      },
    });
  });

  it(`Empty relations aggregate to count 0 and nulls`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle(where: { id: { eq: 2 } }) {
					postsAggregate {
						count
						avg {
							id
						}
						min {
							content
						}
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
          postsAggregate: {
            count: 0,
            avg: { id: null },
            min: { content: null },
          },
        },
      },
    });
  });
});

describe.sequential('Default pagination order tests', () => {
  it(`Unordered paginated query falls back to primary key order`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 3) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { posts: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
  });

  it(`Unordered single query falls back to primary key order`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				postsSingle {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { postsSingle: { id: 1 } } });
  });

  it(`Explicit orderBy wins over the primary key default`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(limit: 3, orderBy: { id: { direction: desc, priority: 1 } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { posts: [{ id: 6 }, { id: 5 }, { id: 4 }] } });
  });
});

describe.sequential('Distinct tests', () => {
  it(`Keeps the first row of each distinct value`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(distinct: [content]) {
					id
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        posts: [
          { id: 1, content: '1MESSAGE' },
          { id: 2, content: '2MESSAGE' },
          { id: 3, content: '3MESSAGE' },
          { id: 6, content: '4MESSAGE' },
        ],
      },
    });
  });

  it(`Picks the first row according to the requested order`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(distinct: [content], orderBy: { id: { direction: desc, priority: 1 } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { posts: [{ id: 6 }, { id: 5 }, { id: 4 }, { id: 3 }] } });
  });

  it(`Applies limit and offset after the rows are made distinct`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(distinct: [content], limit: 2, offset: 1) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { posts: [{ id: 2 }, { id: 3 }] } });
  });

  it(`Filters before making rows distinct`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(where: { authorId: { eq: 5 } }, distinct: [content]) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({ data: { posts: [{ id: 4 }, { id: 5 }] } });
  });
});

describe.sequential('Relation filter tests', () => {
  it(`Filter by a to-many relation`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				some: users(where: { posts: { some: { content: { eq: "3MESSAGE" } } } }) {
					id
				}

				none: users(where: { posts: { none: {} } }) {
					id
				}

				every: users(where: { posts: { every: { content: { eq: "1MESSAGE" } } } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        some: [{ id: 1 }],
        none: [{ id: 2 }],
        // Users 1 and 5 both own a non-matching post; user 2 owns none, so it matches vacuously.
        every: [{ id: 2 }],
      },
    });
  });

  it(`Filter by a to-one relation`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				posts(where: { author: { name: { eq: "FifthUser" } } }, orderBy: { id: { direction: asc, priority: 1 } }) {
					id
				}

				usersSingle(where: { customer: { address: { eq: "AdTwo" } } }) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        posts: [{ id: 4 }, { id: 5 }],
        usersSingle: { id: 2 },
      },
    });
  });

  it(`Nested relation filters, combined with column filters`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				nested: users(where: { posts: { some: { author: { name: { eq: "FirstUser" } } } } }) {
					id
				}

				withColumns: users(
					where: { name: { like: "F%" }, posts: { some: { content: { eq: "2MESSAGE" } } } }
					orderBy: { id: { direction: asc, priority: 1 } }
				) {
					id
				}

				withOr: users(
					where: { OR: [{ name: { eq: "SecondUser" } }, { posts: { some: { content: { eq: "3MESSAGE" } } } }] }
					orderBy: { id: { direction: asc, priority: 1 } }
				) {
					id
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        nested: [{ id: 1 }],
        withColumns: [{ id: 1 }, { id: 5 }],
        withOr: [{ id: 1 }, { id: 2 }],
      },
    });
  });

  it(`Relation filters on aggregates and relation fields`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersAggregate(where: { posts: { some: {} } }) {
					count
				}

				usersSingle(where: { id: { eq: 1 } }) {
					id
					posts(where: { author: { name: { eq: "SecondUser" } } }) {
						id
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersAggregate: { count: 2 },
        usersSingle: { id: 1, posts: [] },
      },
    });
  });

  it(`Relation filters on mutations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updatePosts(set: { content: "UPDATED" }, where: { author: { name: { eq: "FifthUser" } } }) {
					id
					content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updatePosts: [
          { id: 4, content: 'UPDATED' },
          { id: 5, content: 'UPDATED' },
        ],
      },
    });

    const deleted = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePosts(where: { author: { name: { eq: "FifthUser" } } }) {
					id
				}
			}
		`);

    expect(deleted).toStrictEqual({
      data: {
        deletePosts: [{ id: 4 }, { id: 5 }],
      },
    });
  });
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
            usersSingle: z
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
            postsSingle: z
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
            customersSingle: z
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
            createUsersSingle: z
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
            updateUsers: z
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
            deleteUsers: z
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
            createPostsSingle: z
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
            updatePosts: z
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
            deletePosts: z
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
            createCustomersSingle: z
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
            updateCustomers: z
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
            deleteCustomers: z
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
          })
          .strict(),
        types: z
          .object({
            Users: z.instanceof(GraphQLObjectType),
            Posts: z.instanceof(GraphQLObjectType),
            Customers: z.instanceof(GraphQLObjectType),
            UsersAggregate: z.instanceof(GraphQLObjectType),
            UsersGroupBy: z.instanceof(GraphQLObjectType),
            PostsAggregate: z.instanceof(GraphQLObjectType),
            PostsGroupBy: z.instanceof(GraphQLObjectType),
            CustomersAggregate: z.instanceof(GraphQLObjectType),
            CustomersGroupBy: z.instanceof(GraphQLObjectType),
          })
          .strict(),
        inputs: z
          .object({
            UsersFilters: z.instanceof(GraphQLInputObjectType),
            UsersHaving: z.instanceof(GraphQLInputObjectType),
            UsersOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateUsersInput: z.instanceof(GraphQLInputObjectType),
            UpdateUsersInput: z.instanceof(GraphQLInputObjectType),
            PostsFilters: z.instanceof(GraphQLInputObjectType),
            PostsHaving: z.instanceof(GraphQLInputObjectType),
            PostsOrderBy: z.instanceof(GraphQLInputObjectType),
            CreatePostsInput: z.instanceof(GraphQLInputObjectType),
            UpdatePostsInput: z.instanceof(GraphQLInputObjectType),
            CustomersFilters: z.instanceof(GraphQLInputObjectType),
            CustomersHaving: z.instanceof(GraphQLInputObjectType),
            CustomersOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateCustomersInput: z.instanceof(GraphQLInputObjectType),
            UpdateCustomersInput: z.instanceof(GraphQLInputObjectType),
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
        readonly Users: GraphQLObjectType;
      } & {
        readonly Customers: GraphQLObjectType;
        readonly Posts: GraphQLObjectType;
        readonly Users: GraphQLObjectType;
      } & {
        readonly CustomersAggregate: GraphQLObjectType;
        readonly PostsAggregate: GraphQLObjectType;
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
      } & {
        readonly UsersOrderBy: GraphQLInputObjectType;
        readonly CustomersOrderBy: GraphQLInputObjectType;
        readonly PostsOrderBy: GraphQLInputObjectType;
      } & {
        readonly CreateUsersInput: GraphQLInputObjectType;
        readonly CreateCustomersInput: GraphQLInputObjectType;
        readonly CreatePostsInput: GraphQLInputObjectType;
      } & {
        readonly UpdateUsersInput: GraphQLInputObjectType;
        readonly UpdateCustomersInput: GraphQLInputObjectType;
        readonly UpdatePostsInput: GraphQLInputObjectType;
      }
    >();
  });
});

describe.sequential('__typename only tests', () => {
  it(`Select single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle {
					__typename
				}

				postsSingle {
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
          __typename: 'Users',
        },
        postsSingle: {
          __typename: 'Posts',
        },
      },
    });
  });

  it(`Select array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					__typename
				}

				posts {
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            __typename: 'Users',
          },
          {
            __typename: 'Users',
          },
          {
            __typename: 'Users',
          },
        ],
        posts: [
          {
            __typename: 'Posts',
          },
          {
            __typename: 'Posts',
          },
          {
            __typename: 'Posts',
          },
          {
            __typename: 'Posts',
          },
          {
            __typename: 'Posts',
          },
          {
            __typename: 'Posts',
          },
        ],
      },
    });
  });

  it(`Select single with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle {
					__typename
					posts {
						__typename
					}
				}

				postsSingle {
					__typename
					author {
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
          __typename: 'Users',
          posts: [
            {
              __typename: 'Posts',
            },
            {
              __typename: 'Posts',
            },
            {
              __typename: 'Posts',
            },

            {
              __typename: 'Posts',
            },
          ],
        },
        postsSingle: {
          __typename: 'Posts',
          author: {
            __typename: 'Users',
          },
        },
      },
    });
  });

  it(`Select array with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					__typename
					posts {
						__typename
					}
				}
				posts {
					__typename
					author {
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            __typename: 'Users',
            posts: [
              {
                __typename: 'Posts',
              },
              {
                __typename: 'Posts',
              },
              {
                __typename: 'Posts',
              },
              {
                __typename: 'Posts',
              },
            ],
          },
          {
            __typename: 'Users',
            posts: [],
          },
          {
            __typename: 'Users',
            posts: [
              {
                __typename: 'Posts',
              },
              {
                __typename: 'Posts',
              },
            ],
          },
        ],
        posts: [
          {
            __typename: 'Posts',
            author: {
              __typename: 'Users',
            },
          },
          {
            __typename: 'Posts',
            author: {
              __typename: 'Users',
            },
          },
          {
            __typename: 'Posts',
            author: {
              __typename: 'Users',
            },
          },
          {
            __typename: 'Posts',
            author: {
              __typename: 'Users',
            },
          },
          {
            __typename: 'Posts',
            author: {
              __typename: 'Users',
            },
          },
          {
            __typename: 'Posts',
            author: {
              __typename: 'Users',
            },
          },
        ],
      },
    });
  });

  it(`Insert single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createUsersSingle(
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
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsersSingle: {
          __typename: 'Users',
        },
      },
    });
  });

  it(`Insert array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createUsers(
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
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: [
          {
            __typename: 'Users',
          },
          {
            __typename: 'Users',
          },
        ],
      },
    });
  });

  it(`Update`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomers(set: { isConfirmed: true, address: "Edited" }) {
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomers: [
          {
            __typename: 'Customers',
          },
          {
            __typename: 'Customers',
          },
        ],
      },
    });
  });

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteCustomers {
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteCustomers: [
          {
            __typename: 'Customers',
          },
          {
            __typename: 'Customers',
          },
        ],
      },
    });
  });
});

describe.sequential('__typename with data tests', async () => {
  it(`Select single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle {
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
					__typename
				}

				postsSingle {
					id
					authorId
					content
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
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
          __typename: 'Users',
        },
        postsSingle: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
          __typename: 'Posts',
        },
      },
    });
  });

  it(`Select array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
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
					__typename
				}

				posts {
					id
					authorId
					content
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
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
            __typename: 'Users',
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
            __typename: 'Users',
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
            __typename: 'Users',
          },
        ],
        posts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            __typename: 'Posts',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            __typename: 'Posts',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            __typename: 'Posts',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            __typename: 'Posts',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            __typename: 'Posts',
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            __typename: 'Posts',
          },
        ],
      },
    });
  });

  it(`Select single with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle {
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
					__typename
					posts {
						id
						authorId
						content
						__typename
					}
				}

				postsSingle {
					id
					authorId
					content
					__typename
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
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
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
          __typename: 'Users',
          posts: [
            {
              id: 1,
              authorId: 1,
              content: '1MESSAGE',
              __typename: 'Posts',
            },
            {
              id: 2,
              authorId: 1,
              content: '2MESSAGE',
              __typename: 'Posts',
            },
            {
              id: 3,
              authorId: 1,
              content: '3MESSAGE',
              __typename: 'Posts',
            },

            {
              id: 6,
              authorId: 1,
              content: '4MESSAGE',
              __typename: 'Posts',
            },
          ],
        },
        postsSingle: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
          __typename: 'Posts',
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
            __typename: 'Users',
          },
        },
      },
    });
  });

  it(`Select array with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
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
					__typename
					posts {
						id
						authorId
						content
						__typename
					}
				}

				posts {
					id
					authorId
					content
					__typename
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
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
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
            __typename: 'Users',
            posts: [
              {
                id: 1,
                authorId: 1,
                content: '1MESSAGE',
                __typename: 'Posts',
              },
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
                __typename: 'Posts',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
                __typename: 'Posts',
              },
              {
                id: 6,
                authorId: 1,
                content: '4MESSAGE',
                __typename: 'Posts',
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
            __typename: 'Users',
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
                __typename: 'Posts',
              },
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
                __typename: 'Posts',
              },
            ],
            __typename: 'Users',
          },
        ],
        posts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            __typename: 'Posts',
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
              __typename: 'Users',
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            __typename: 'Posts',
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
              __typename: 'Users',
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            __typename: 'Posts',
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
              __typename: 'Users',
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            __typename: 'Posts',
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
              __typename: 'Users',
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            __typename: 'Posts',
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
              __typename: 'Users',
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            __typename: 'Posts',
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
              __typename: 'Users',
            },
          },
        ],
      },
    });
  });

  it(`Insert single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createUsersSingle(
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
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsersSingle: {
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
          __typename: 'Users',
        },
      },
    });
  });

  it(`Insert array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createUsers(
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
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: [
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
            __typename: 'Users',
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
            __typename: 'Users',
          },
        ],
      },
    });
  });

  it(`Update`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomers(set: { isConfirmed: true, address: "Edited" }) {
					id
					address
					isConfirmed
					registrationDate
					userId
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomers: [
          {
            id: 1,
            address: 'Edited',
            isConfirmed: true,
            registrationDate: '2024-03-27T03:54:45.235Z',
            userId: 1,
            __typename: 'Customers',
          },
          {
            id: 2,
            address: 'Edited',
            isConfirmed: true,
            registrationDate: '2024-03-27T03:55:42.358Z',
            userId: 2,
            __typename: 'Customers',
          },
        ],
      },
    });
  });

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteCustomers {
					id
					address
					isConfirmed
					registrationDate
					userId
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteCustomers: [
          {
            id: 1,
            address: 'AdOne',
            isConfirmed: false,
            registrationDate: '2024-03-27T03:54:45.235Z',
            userId: 1,
            __typename: 'Customers',
          },
          {
            id: 2,
            address: 'AdTwo',
            isConfirmed: false,
            registrationDate: '2024-03-27T03:55:42.358Z',
            userId: 2,
            __typename: 'Customers',
          },
        ],
      },
    });
  });
});

describe.sequential('Mutation relation eager-load tests', () => {
  it('insert single selecting a relation but NOT the primary key resolves the relation', async () => {
    // Selection omits `id`; the PK must be force-included in RETURNING so the eager
    // re-fetch keys on it. Before the fix this returned a null relation.
    const res = await ctx.gql.queryGql(/* GraphQL */ `
      mutation {
        createPostsSingle(values: { id: 9100, authorId: 1, content: "NOPK" }) {
          content
          author { id name }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data?.createPostsSingle).toStrictEqual({
      content: 'NOPK',
      author: { id: 1, name: 'FirstUser' },
    });
  });

  it('insert array selecting a relation but NOT the primary key returns every row with its relation', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
      mutation {
        createPosts(values: [
          { id: 9201, authorId: 1, content: "A" },
          { id: 9202, authorId: 5, content: "B" }
        ]) {
          content
          author { id name }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    const posts: any[] = res.data?.createPosts ?? [];
    expect(posts).toHaveLength(2);
    expect(posts.find((p) => p.content === 'A')?.author?.name).toBe('FirstUser');
    expect(posts.find((p) => p.content === 'B')?.author?.id).toBe(5);
  });
});
