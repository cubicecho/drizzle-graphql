import { createServer, type Server } from 'node:http';
import Docker from 'dockerode';
import { type Relations, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import getPort from 'get-port';
import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  graphql,
} from 'graphql';
import { createYoga } from 'graphql-yoga';
import postgres, { type Sql } from 'postgres';
import { v4 as uuid } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import z from 'zod';
import {
  buildSchema,
  type DeleteResolver,
  type ExtractTables,
  type GeneratedEntities,
  type InsertArrResolver,
  type InsertResolver,
  type SelectResolver,
  type SelectSingleResolver,
  type UpdateManyResolver,
  type UpdateResolver,
} from '@/index';
import * as schema from './schema/pg';
import { GraphQLClient } from './util/query';

interface Context {
  docker: Docker;
  pgContainer: Docker.Container;
  db: PostgresJsDatabase<typeof schema>;
  optInSchema: GraphQLSchema;
  client: Sql;
  schema: GraphQLSchema;
  entities: GeneratedEntities<PostgresJsDatabase<typeof schema>>;
  server: Server;
  gql: GraphQLClient;
}

const ctx: Context = {} as any;

async function createDockerDB(ctx: Context): Promise<string> {
  ctx.docker = new Docker();
  const docker = ctx.docker;
  const port = await getPort({ port: 5432 });
  const image = 'joshuasundance/postgis_pgvector';

  const pullStream = await docker.pull(image);
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve(err))),
  );

  ctx.pgContainer = await docker.createContainer({
    Image: image,
    Env: ['POSTGRES_PASSWORD=postgres', 'POSTGRES_USER=postgres', 'POSTGRES_DB=postgres'],
    name: `drizzle-graphql-pg-tests-${uuid()}`,
    HostConfig: {
      AutoRemove: true,
      PortBindings: {
        '5432/tcp': [{ HostPort: `${port}` }],
      },
    },
  });
  const pgContainer = ctx.pgContainer;

  await pgContainer.start();

  return `postgres://postgres:postgres@localhost:${port}/postgres`;
}

beforeAll(async () => {
  const connectionString = await createDockerDB(ctx);

  const sleep = 1000;
  let timeLeft = 30000;
  let connected = false;
  let lastError: unknown | undefined;

  do {
    try {
      await ctx.client?.end().catch(() => {});
      ctx.client = postgres(connectionString, {
        max: 1,
        onnotice: () => {
          // disable notices
        },
      });
      await ctx.client`select 1`;
      connected = true;
      break;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, sleep));
      timeLeft -= sleep;
    }
  } while (timeLeft > 0);
  if (!connected) {
    console.error('Cannot connect to Postgres');
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

  const port = 4002;
  server.listen(port);
  const gql = new GraphQLClient(`http://localhost:${port}/graphql`);

  // The atomic update operations and the count mutations are opt-in.
  ctx.optInSchema = buildSchema(ctx.db, {
    features: { fieldUpdateOperations: true, countMutations: true },
  }).schema;

  ctx.schema = gqlSchema;
  ctx.entities = entities;
  ctx.server = server;
  ctx.gql = gql;

  await ctx.db.execute(
    sql`
		DO $$ BEGIN
		CREATE TYPE "role" AS ENUM('admin', 'user');
	   	EXCEPTION
		WHEN duplicate_object THEN null;
	   	END $$;
		`,
  );
});

afterAll(async () => {
  await ctx.client?.end().catch(console.error);
  await ctx.pgContainer?.stop().catch(console.error);
});

beforeEach(async () => {
  await ctx.db.execute(
    sql`CREATE TABLE IF NOT EXISTS "customers" (
			"id" serial PRIMARY KEY NOT NULL,
			"address" text NOT NULL,
			"is_confirmed" boolean,
			"registration_date" timestamp DEFAULT now() NOT NULL,
			"user_id" integer NOT NULL
		);`,
  );

  await ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS "posts" (
		"id" serial PRIMARY KEY NOT NULL,
		"content" text,
		"author_id" integer
	);`);

  await ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS "tags" (
		"id" serial PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"description" text
	);`);

  await ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS "users" (
		"a" integer[],
		"id" serial PRIMARY KEY NOT NULL,
		"name" text NOT NULL,
		"email" text,
		"birthday_string" date,
		"birthday_date" date,
		"created_at" timestamp DEFAULT now() NOT NULL,
		"role" "role",
		"role1" text,
		"role2" text DEFAULT 'user',
		"profession" varchar(20),
		"initials" char(2),
		"is_confirmed" boolean,
		"vector_column" vector(5),
		"geometry_xy" geometry(point),
		"geometry_tuple" geometry(point)
	);`);

  await ctx.db.execute(sql`DO $$ BEGIN
			ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
		EXCEPTION
			WHEN duplicate_object THEN null;
		END $$;
   `);

  await ctx.db.insert(schema.Users).values([
    {
      a: [1, 5, 10, 25, 40],
      id: 1,
      name: 'FirstUser',
      email: 'userOne@notmail.com',
      birthdayString: '2024-04-02T06:44:41.785Z',
      birthdayDate: new Date('2024-04-02T06:44:41.785Z'),
      createdAt: new Date('2024-04-02T06:44:41.785Z'),
      role: 'admin',
      roleText: null,
      profession: 'FirstUserProf',
      initials: 'FU',
      isConfirmed: true,
      vector: [1, 2, 3, 4, 5],
      geoXy: {
        x: 20,
        y: 20.3,
      },
      geoTuple: [20, 20.3],
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

afterEach(async () => {
  await ctx.db.execute(sql`DROP TABLE IF EXISTS "tags" CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE "posts" CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE "customers" CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE "users" CASCADE;`);
});

describe.sequential('Query tests', async () => {
  it(`Select single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
          },
          {
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
						a
						id
						name
						email
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
						vector
						geoXy {
							x
							y
						}
						geoTuple
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
          },
        },
      },
    });
  });

  it(`Select array with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
						a
						id
						name
						email
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
						vector
						geoXy {
							x
							y
						}
						geoTuple
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
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
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            posts: [],
            vector: null,
            geoXy: null,
            geoTuple: null,
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
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
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              vector: null,
              geoXy: null,
              geoTuple: null,
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              vector: null,
              geoXy: null,
              geoTuple: null,
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
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
				a
				id
				name
				email
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
				isConfirmed
				vector
				geoXy {
					x
					y
				}
				geoTuple
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
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
				a
				id
				name
				email
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
				isConfirmed
				vector
				geoXy {
					x
					y
				}
				geoTuple
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
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
          },
          {
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
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
				a
				id
				name
				email
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
				isConfirmed
				vector
				geoXy {
					x
					y
				}
				geoTuple
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
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
				a
				id
				name
				email
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
				isConfirmed
				vector
				geoXy {
					x
					y
				}
				geoTuple
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
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
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            posts: [],
            vector: null,
            geoXy: null,
            geoTuple: null,
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
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
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              vector: null,
              geoXy: null,
              geoTuple: null,
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              vector: null,
              geoXy: null,
              geoTuple: null,
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
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
						a: [1, 5, 10, 25, 40]
						id: 3
						name: "ThirdUser"
						email: "userThree@notmail.com"
						birthdayString: "2024-04-02T06:44:41.785Z"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
						isConfirmed: true
						vector: [1, 2, 3, 4, 5]
						geoXy: {
							x: 20
							y: 20.3
						}
						geoTuple: [20, 20.3]		
					}
				) {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsersSingle: {
          a: [1, 5, 10, 25, 40],
          id: 3,
          name: 'ThirdUser',
          email: 'userThree@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'ThirdUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
							a: [1, 5, 10, 25, 40]
							id: 3
							name: "ThirdUser"
							email: "userThree@notmail.com"
							birthdayString: "2024-04-02T06:44:41.785Z"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
							vector: [1, 2, 3, 4, 5]
							geoXy: {
								x: 20
								y: 20.3
							}
							geoTuple: [20, 20.3]
						}
						{
							a: [1, 5, 10, 25, 40]
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							birthdayString: "2024-04-04"
							birthdayDate: "2024-04-04T00:00:00.000Z"
							createdAt: "2024-04-04T06:44:41.785Z"
							role: user
							roleText: null
							roleText2: user
							profession: "FourthUserProf"
							initials: "SU"
							isConfirmed: false
						}
					]
				) {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: [
          {
            a: [1, 5, 10, 25, 40],
            id: 3,
            name: 'ThirdUser',
            email: 'userThree@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'ThirdUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
          },
          {
            a: [1, 5, 10, 25, 40],
            id: 4,
            name: 'FourthUser',
            email: 'userFour@notmail.com',
            birthdayString: '2024-04-04',
            birthdayDate: '2024-04-04T00:00:00.000Z',
            createdAt: '2024-04-04T06:44:41.785Z',
            role: 'user',
            roleText: null,
            roleText2: 'user',
            profession: 'FourthUserProf',
            initials: 'SU',
            isConfirmed: false,
            vector: null,
            geoXy: null,
            geoTuple: null,
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
					posts(where: { content: { ilike: "2%" } }) {
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
            tagsSingle: z
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
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updateUsersMany: z
              .object({
                args: z
                  .object({
                    updates: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Documents the nullable element, the one mutation whose return type differs.
                description: z.string(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
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
            updateUsersSingle: z
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
            deleteUsersSingle: z
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
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updatePostsMany: z
              .object({
                args: z
                  .object({
                    updates: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Documents the nullable element, the one mutation whose return type differs.
                description: z.string(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
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
            updatePostsSingle: z
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
            deletePostsSingle: z
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
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updateCustomersMany: z
              .object({
                args: z
                  .object({
                    updates: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Documents the nullable element, the one mutation whose return type differs.
                description: z.string(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
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
            updateCustomersSingle: z
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
            deleteCustomersSingle: z
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
            createTagsSingle: z
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
            updateTagsMany: z
              .object({
                args: z
                  .object({
                    updates: z
                      .object({
                        type: z.instanceof(GraphQLNonNull),
                      })
                      .strict(),
                  })
                  .strict(),
                resolve: z.function(),
                // Documents the nullable element, the one mutation whose return type differs.
                description: z.string(),
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z.object({ complexity: z.function() }).strict().optional(),
                type: z.instanceof(GraphQLNonNull),
              })
              .strict(),
            updateTags: z
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
            updateTagsSingle: z
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
            deleteTags: z
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
            deleteTagsSingle: z
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
            Users: z.instanceof(GraphQLObjectType),
            Posts: z.instanceof(GraphQLObjectType),
            Customers: z.instanceof(GraphQLObjectType),
            Tags: z.instanceof(GraphQLObjectType),
            UsersAggregate: z.instanceof(GraphQLObjectType),
            UsersGroupBy: z.instanceof(GraphQLObjectType),
            CustomersAggregate: z.instanceof(GraphQLObjectType),
            CustomersGroupBy: z.instanceof(GraphQLObjectType),
            PostsAggregate: z.instanceof(GraphQLObjectType),
            PostsGroupBy: z.instanceof(GraphQLObjectType),
            TagsAggregate: z.instanceof(GraphQLObjectType),
            TagsGroupBy: z.instanceof(GraphQLObjectType),
          })
          .strict(),
        inputs: z
          .object({
            UsersFilters: z.instanceof(GraphQLInputObjectType),
            UsersHaving: z.instanceof(GraphQLInputObjectType),
            UsersOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateUsersInput: z.instanceof(GraphQLInputObjectType),
            UpdateUsersInput: z.instanceof(GraphQLInputObjectType),
            UpdateUsersManyInput: z.instanceof(GraphQLInputObjectType),
            PostsFilters: z.instanceof(GraphQLInputObjectType),
            PostsHaving: z.instanceof(GraphQLInputObjectType),
            PostsOrderBy: z.instanceof(GraphQLInputObjectType),
            CreatePostsInput: z.instanceof(GraphQLInputObjectType),
            UpdatePostsInput: z.instanceof(GraphQLInputObjectType),
            UpdatePostsManyInput: z.instanceof(GraphQLInputObjectType),
            CustomersFilters: z.instanceof(GraphQLInputObjectType),
            CustomersHaving: z.instanceof(GraphQLInputObjectType),
            CustomersOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateCustomersInput: z.instanceof(GraphQLInputObjectType),
            UpdateCustomersInput: z.instanceof(GraphQLInputObjectType),
            UpdateCustomersManyInput: z.instanceof(GraphQLInputObjectType),
            TagsFilters: z.instanceof(GraphQLInputObjectType),
            TagsHaving: z.instanceof(GraphQLInputObjectType),
            TagsOrderBy: z.instanceof(GraphQLInputObjectType),
            CreateTagsInput: z.instanceof(GraphQLInputObjectType),
            UpdateTagsInput: z.instanceof(GraphQLInputObjectType),
            UpdateTagsManyInput: z.instanceof(GraphQLInputObjectType),
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
        readonly updateCustomersMany: {
          type: GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Customers, false>;
        };
        readonly updatePostsMany: {
          type: GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Posts, false>;
        };
        readonly updateUsersMany: {
          type: GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Users, false>;
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
      } & {
        readonly UpdateUsersManyInput: GraphQLInputObjectType;
        readonly UpdateCustomersManyInput: GraphQLInputObjectType;
        readonly UpdatePostsManyInput: GraphQLInputObjectType;
      }
    >();
  });
});

describe.sequential('__typename only tests', async () => {
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
						a: [1, 5, 10, 25, 40]
						id: 3
						name: "ThirdUser"
						email: "userThree@notmail.com"
						birthdayString: "2024-04-02T06:44:41.785Z"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
						vector: [1, 2, 3, 4, 5]
						geoXy: {
							x: 20
							y: 20.3
						}
						geoTuple: [20, 20.3]
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
							a: [1, 5, 10, 25, 40]
							id: 3
							name: "ThirdUser"
							email: "userThree@notmail.com"
							birthdayString: "2024-04-02T06:44:41.785Z"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
							vector: [1, 2, 3, 4, 5]
							geoXy: {
								x: 20
								y: 20.3
							}
							geoTuple: [20, 20.3]
						}
						{
							a: [1, 5, 10, 25, 40]
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							birthdayString: "2024-04-04"
							birthdayDate: "2024-04-04T00:00:00.000Z"
							createdAt: "2024-04-04T06:44:41.785Z"
							role: user
							roleText: null
							roleText2: user
							profession: "FourthUserProf"
							initials: "SU"
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
            __typename: 'Users',
          },
          {
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
            __typename: 'Users',
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
						a
						id
						name
						email
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
						vector
						geoXy {
							x
							y
						}
						geoTuple
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        usersSingle: {
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
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
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
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
						a
						id
						name
						email
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
						vector
						geoXy {
							x
							y
						}
						geoTuple
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
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
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
            __typename: 'Users',
            posts: [],
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            vector: null,
            geoXy: null,
            geoTuple: null,
            __typename: 'Users',
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
          },
        ],
        posts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            __typename: 'Posts',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
              __typename: 'Users',
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            __typename: 'Posts',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
              __typename: 'Users',
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            __typename: 'Posts',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
              __typename: 'Users',
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            __typename: 'Posts',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              vector: null,
              geoXy: null,
              geoTuple: null,
              __typename: 'Users',
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            __typename: 'Posts',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              vector: null,
              geoXy: null,
              geoTuple: null,
              __typename: 'Users',
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            __typename: 'Posts',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              vector: [1, 2, 3, 4, 5],
              geoXy: {
                x: 20,
                y: 20.3,
              },
              geoTuple: [20, 20.3],
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
						a: [1, 5, 10, 25, 40]
						id: 3
						name: "ThirdUser"
						email: "userThree@notmail.com"
						birthdayString: "2024-04-02T06:44:41.785Z"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
						isConfirmed: true
						vector: [1, 2, 3, 4, 5]
						geoXy: {
							x: 20
							y: 20.3
						},
						geoTuple: [20, 20.3]
					}
				) {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsersSingle: {
          a: [1, 5, 10, 25, 40],
          id: 3,
          name: 'ThirdUser',
          email: 'userThree@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'ThirdUserProf',
          initials: 'FU',
          isConfirmed: true,
          vector: [1, 2, 3, 4, 5],
          geoXy: {
            x: 20,
            y: 20.3,
          },
          geoTuple: [20, 20.3],
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
							a: [1, 5, 10, 25, 40]
							id: 3
							name: "ThirdUser"
							email: "userThree@notmail.com"
							birthdayString: "2024-04-02T06:44:41.785Z"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
							vector: [1, 2, 3, 4, 5]
							geoXy: {
								x: 20
								y: 20.3
							}
							geoTuple: [20, 20.3]
						}
						{
							a: [1, 5, 10, 25, 40]
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							birthdayString: "2024-04-04"
							birthdayDate: "2024-04-04T00:00:00.000Z"
							createdAt: "2024-04-04T06:44:41.785Z"
							role: user
							roleText: null
							roleText2: user
							profession: "FourthUserProf"
							initials: "SU"
							isConfirmed: false
						}
					]
				) {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					vector
					geoXy {
						x
						y
					}
					geoTuple
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: [
          {
            a: [1, 5, 10, 25, 40],
            id: 3,
            name: 'ThirdUser',
            email: 'userThree@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'ThirdUserProf',
            initials: 'FU',
            isConfirmed: true,
            vector: [1, 2, 3, 4, 5],
            geoXy: {
              x: 20,
              y: 20.3,
            },
            geoTuple: [20, 20.3],
            __typename: 'Users',
          },
          {
            a: [1, 5, 10, 25, 40],
            id: 4,
            name: 'FourthUser',
            email: 'userFour@notmail.com',
            birthdayString: '2024-04-04',
            birthdayDate: '2024-04-04T00:00:00.000Z',
            createdAt: '2024-04-04T06:44:41.785Z',
            role: 'user',
            roleText: null,
            roleText2: 'user',
            profession: 'FourthUserProf',
            initials: 'SU',
            isConfirmed: false,
            vector: null,
            geoXy: null,
            geoTuple: null,
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

describe('buildSchema idempotency', () => {
  it('can call buildSchema twice on the same db without type name conflicts', () => {
    expect(() => {
      buildSchema(ctx.db);
      buildSchema(ctx.db);
    }).not.toThrow();
  });
});

describe('Table without relations (Tags)', () => {
  it('Query tags list and single without relations', async () => {
    await ctx.db.insert(schema.Tags).values([{ id: 1, name: 'JavaScript', description: 'JS tag' }]);

    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				tags { id name description }
				tagsSingle { id name description }
			}
		`);

    expect(res.data.tags).toEqual([{ id: 1, name: 'JavaScript', description: 'JS tag' }]);
    expect(res.data.tagsSingle).toEqual({ id: 1, name: 'JavaScript', description: 'JS tag' });
  });

  it('Insert single tag without relations', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createTagsSingle(values: { name: "TypeScript", description: "TS tag" }) {
					id
					name
					description
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.createTagsSingle?.name).toBe('TypeScript');
    expect(res.data?.createTagsSingle?.description).toBe('TS tag');
  });

  it('Insert multiple tags without relations', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createTags(values: [
					{ name: "Go", description: "Go tag" }
					{ name: "Rust", description: "Rust tag" }
				]) {
					id
					name
					description
				}
			}
		`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.createTags).toHaveLength(2);
  });
});

describe('Insert conflict behavior (no onConflictDoNothing by default)', () => {
  it('Insert single raises error on duplicate PK (no onConflictDoNothing)', async () => {
    // id=1 for Users already exists from beforeEach — inserting it again should error
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createUsersSingle(values: { id: 1, name: "Duplicate", createdAt: "2024-04-02T06:44:41.785Z" }) {
					id
					name
				}
			}
		`);

    // Without onConflictDoNothing, duplicate PK must produce a GraphQL error,
    // NOT silently return undefined.
    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
  });
});

describe.sequential('Atomic column updates, count mutations and relation pagination', () => {
  const optIn = (source: string, variableValues?: Record<string, any>) =>
    graphql({ schema: ctx.optInSchema, source, variableValues, contextValue: {} });
  const run = (source: string, variableValues?: Record<string, any>) =>
    graphql({ schema: ctx.schema, source, variableValues, contextValue: {} });

  it('appends to an array column in the database', async () => {
    const res = await optIn(
      `mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { a: { push: [99] } }) { id a } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((res.data?.['updateUsersSingle'] as any)?.['a']).toStrictEqual([1, 5, 10, 25, 40, 99]);
  });

  it('replaces an array column when given set instead of push', async () => {
    const res = await optIn(`mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { a: { set: [7] } }) { a } }`);

    expect(res.errors).toBeUndefined();
    expect((res.data?.['updateUsersSingle'] as any)?.['a']).toStrictEqual([7]);
  });

  it('rejects an operations input with no operation', async () => {
    const res = await optIn(`mutation { updateUsersSingle(where: { id: { eq: 1 } }, set: { a: {} }) { a } }`);

    expect(res.errors?.[0]?.message).toBe(
      "Field 'a' was given no update operation. Pass exactly one of set, increment, decrement, multiply, divide, push.",
    );
  });

  it('reads the row count out of the postgres.js result shape', async () => {
    // node-postgres reports `rowCount`, PGlite `affectedRows`, postgres.js `count` — this is
    // the driver the count mutations would silently return the wrong number for.
    const res = await optIn(`mutation { updatePostsCount(where: { authorId: { eq: 1 } }, set: { content: "x" }) }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updatePostsCount']).toBe(4);
  });

  it('counts a delete and leaves no rows behind', async () => {
    const res = await optIn(`mutation { deletePostsCount(where: { authorId: { eq: 5 } }) }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['deletePostsCount']).toBe(2);
    expect((await ctx.db.select().from(schema.Posts)).some((row) => row.authorId === 5)).toBe(false);
  });

  it('pages a to-many relation with after, per parent', async () => {
    const first = await run(/* GraphQL */ `
      {
        users(where: { id: { eq: 1 } }) {
          posts(orderBy: { id: { priority: 1, direction: asc } }, limit: 2) {
            id
            cursor
          }
        }
      }
    `);

    expect(first.errors).toBeUndefined();
    const page = (first.data?.['users'] as any[])[0]!['posts'];
    expect(page.map((row: any) => row['id'])).toStrictEqual([1, 2]);

    const second = await run(
      /* GraphQL */ `
        query ($after: String) {
          users(where: { id: { eq: 1 } }) {
            posts(orderBy: { id: { priority: 1, direction: asc } }, after: $after) {
              id
            }
          }
        }
      `,
      { after: page[1]['cursor'] },
    );

    expect(second.errors).toBeUndefined();
    expect(((second.data?.['users'] as any[])[0]!['posts'] as any[]).map((row) => row['id'])).toStrictEqual([3, 6]);
  });

  it('keeps one row per distinct value within each parent', async () => {
    const res = await run(/* GraphQL */ `
      {
        users(orderBy: { id: { priority: 1, direction: asc } }) {
          id
          posts(distinct: [content], orderBy: { id: { priority: 1, direction: asc } }) {
            id
            content
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    const byUser = Object.fromEntries(
      (res.data?.['users'] as any[]).map((user) => [user['id'], user['posts'].map((post: any) => post['id'])]),
    );
    // User 1 wrote 1MESSAGE, 2MESSAGE, 3MESSAGE and 4MESSAGE — all distinct, so all survive.
    expect(byUser[1]).toStrictEqual([1, 2, 3, 6]);
  });
});
