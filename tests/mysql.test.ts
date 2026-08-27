import { createServer, type Server } from 'node:http';
import Docker from 'dockerode';
import { eq, inArray, type Relations, sql } from 'drizzle-orm';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
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
import * as mysql from 'mysql2/promise';
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
import * as schema from './schema/mysql';
import { GraphQLClient } from './util/query';

interface Context {
  docker: Docker;
  mysqlContainer: Docker.Container;
  db: MySql2Database<typeof schema>;
  client: mysql.Connection;
  schema: GraphQLSchema;
  upsertSchema: GraphQLSchema;
  optInSchema: GraphQLSchema;
  entities: GeneratedEntities<MySql2Database<typeof schema>>;
  server: Server;
  gql: GraphQLClient;
}

const ctx: Context = {} as any;

async function createDockerDB(): Promise<string> {
  const docker = (ctx.docker = new Docker());
  const port = await getPort({ port: 3306 });
  const image = 'mysql:8';

  const pullStream = await docker.pull(image);
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve(err))),
  );

  ctx.mysqlContainer = await docker.createContainer({
    Image: image,
    Env: ['MYSQL_ROOT_PASSWORD=mysql', 'MYSQL_DATABASE=drizzle'],
    name: `drizzle-graphql-mysql-tests-${uuid()}`,
    HostConfig: {
      AutoRemove: true,
      PortBindings: {
        '3306/tcp': [{ HostPort: `${port}` }],
      },
    },
  });

  await ctx.mysqlContainer.start();

  return `mysql://root:mysql@127.0.0.1:${port}/drizzle`;
}

beforeAll(async (_t) => {
  const connectionString = await createDockerDB();

  const sleep = 1000;
  let timeLeft = 60000;
  let connected = false;
  let lastError: unknown | undefined;
  do {
    try {
      await ctx.client?.end().catch(() => {});
      ctx.client = await mysql.createConnection(connectionString);
      await ctx.client.connect();
      connected = true;
      break;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, sleep));
      timeLeft -= sleep;
    }
  } while (timeLeft > 0);
  if (!connected) {
    console.error('Cannot connect to MySQL');
    await ctx.client?.end().catch(console.error);
    await ctx.mysqlContainer?.stop().catch(console.error);
    throw lastError;
  }

  ctx.db = drizzle({
    client: ctx.client,
    schema,
    relations: schema.relations,
    logger: !!process.env.LOG_SQL,
    mode: 'default',
  });

  const { schema: gqlSchema, entities } = buildSchema(ctx.db);
  // Upsert is opt-in, so it needs a schema of its own.
  ctx.upsertSchema = buildSchema(ctx.db, { features: { upsert: true } }).schema;
  // As are the atomic update operations and the count mutations.
  ctx.optInSchema = buildSchema(ctx.db, {
    features: { fieldUpdateOperations: true, countMutations: true },
  }).schema;
  const yoga = createYoga({
    schema: gqlSchema,
  });
  const server = createServer(yoga);

  const port = 4001;
  server.listen(port);
  const gql = new GraphQLClient(`http://localhost:${port}/graphql`);

  ctx.schema = gqlSchema;
  ctx.entities = entities;
  ctx.server = server;
  ctx.gql = gql;
});

afterAll(async (_t) => {
  await ctx.client?.end().catch(console.error);
  await ctx.mysqlContainer?.stop().catch(console.error);
});

beforeEach(async (_t) => {
  await ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS \`customers\` (
		\`id\` int AUTO_INCREMENT NOT NULL,
		\`address\` text NOT NULL,
		\`is_confirmed\` boolean,
		\`registration_date\` timestamp NOT NULL DEFAULT (now()),
		\`user_id\` int NOT NULL,
		CONSTRAINT \`customers_id\` PRIMARY KEY(\`id\`)
	);`);

  await ctx.db.execute(sql`CREATE TABLE IF NOT EXISTS \`posts\` (
		\`id\` int AUTO_INCREMENT NOT NULL,
		\`content\` text,
		\`author_id\` int,
		CONSTRAINT \`posts_id\` PRIMARY KEY(\`id\`)
	);`);

  await ctx.db.execute(sql`CREATE TABLE \`users\` (
		\`id\` int AUTO_INCREMENT NOT NULL,
		\`name\` text NOT NULL,
		\`email\` text,
		\`big_int\` bigint unsigned,
		\`birthday_string\` date,
		\`birthday_date\` date,
		\`created_at\` timestamp NOT NULL DEFAULT (now()),
		\`role\` enum('admin','user'),
		\`role1\` text,
		\`role2\` text DEFAULT ('user'),
		\`profession\` varchar(20),
		\`initials\` char(2),
		\`is_confirmed\` boolean,
		CONSTRAINT \`users_id\` PRIMARY KEY(\`id\`)
	);`);

  await ctx.db.execute(
    sql`ALTER TABLE \`customers\` ADD CONSTRAINT \`customers_user_id_users_id_fk\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE no action ON UPDATE no action;`,
  );

  await ctx.db.insert(schema.Users).values([
    {
      id: 1,
      name: 'FirstUser',
      email: 'userOne@notmail.com',
      bigint: BigInt(10),
      birthdayString: '2024-04-02',
      birthdayDate: new Date('2024-04-02T06:44:41.785Z'),
      createdAt: new Date('2024-04-02T06:44:41.785Z'),
      role: 'admin',
      roleText: null,
      profession: 'FirstUserProf',
      initials: 'FU',
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
  await ctx.db.execute(sql`SET FOREIGN_KEY_CHECKS = 0;`);
  await ctx.db.execute(sql`DROP TABLE IF EXISTS \`customers\` CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE IF EXISTS \`posts\` CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE IF EXISTS \`users\` CASCADE;`);
  await ctx.db.execute(sql`SET FOREIGN_KEY_CHECKS = 1;`);
});

describe.sequential('Query tests', async () => {
  it(`Select single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				usersSingle {
					id
					name
					email
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
						bigint
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
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
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
						bigint
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
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
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            posts: [],
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
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
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
				bigint
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
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
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
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
				bigint
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
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
				bigint
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
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
				bigint
				birthdayString
				birthdayDate
				createdAt
				role
				roleText
				roleText2
				profession
				initials
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
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
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            posts: [],
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
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
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
						bigint: "15"
						birthdayString: "2024-04-02"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
						isConfirmed: true
					}
				) {
					isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsersSingle: {
          isSuccess: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 3));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
    ]);
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
							bigint: "15"
							birthdayString: "2024-04-02"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
						}
						{
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							bigint: "42"
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
					isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: {
          isSuccess: true,
        },
      },
    });

    const data = await ctx.db
      .select()
      .from(schema.Users)
      .where(inArray(schema.Users.id, [3, 4]));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
      {
        id: 4,
        name: 'FourthUser',
        email: 'userFour@notmail.com',
        bigint: BigInt(42),
        birthdayString: '2024-04-04',
        birthdayDate: new Date('2024-04-04T00:00:00.000Z'),
        createdAt: new Date('2024-04-04T06:44:42.000Z'),
        role: 'user',
        roleText: null,
        roleText2: 'user',
        profession: 'FourthUserProf',
        initials: 'SU',
        isConfirmed: false,
      },
    ]);
  });

  it(`Update`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomers(set: { isConfirmed: true, address: "Edited" }) {
					isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomers: {
          isSuccess: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([
      {
        id: 1,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:54:45.000Z'),
        userId: 1,
      },
      {
        id: 2,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:55:42.000Z'),
        userId: 2,
      },
    ]);
  });

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteCustomers {
					isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteCustomers: {
          isSuccess: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([]);
  });
});

describe.sequential('Aliased query tests', async () => {
  it(`Select single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				user: usersSingle {
					id
					name
					email
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
				}

				post: postsSingle {
					id
					user: authorId
					text: content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        user: {
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
        },
        post: {
          id: 1,
          user: 1,
          text: '1MESSAGE',
        },
      },
    });
  });

  it(`Select array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				user: users {
					id
					name
					email
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
				}

				post: posts {
					id
					author: authorId
					text: content
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        user: [
          {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
          },
        ],
        post: [
          {
            id: 1,
            author: 1,
            text: '1MESSAGE',
          },
          {
            id: 2,
            author: 1,
            text: '2MESSAGE',
          },
          {
            id: 3,
            author: 1,
            text: '3MESSAGE',
          },
          {
            id: 4,
            author: 5,
            text: '1MESSAGE',
          },
          {
            id: 5,
            author: 5,
            text: '2MESSAGE',
          },
          {
            id: 6,
            author: 1,
            text: '4MESSAGE',
          },
        ],
      },
    });
  });

  it(`Select single with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				user: usersSingle {
					id
					name
					email
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					messages: posts {
						id
						authorId
						text: content
					}
				}

				post: postsSingle {
					id
					authorId
					content
					user: author {
						id
						from: name
						email
						bigint
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        user: {
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          messages: [
            {
              id: 1,
              authorId: 1,
              text: '1MESSAGE',
            },
            {
              id: 2,
              authorId: 1,
              text: '2MESSAGE',
            },
            {
              id: 3,
              authorId: 1,
              text: '3MESSAGE',
            },

            {
              id: 6,
              authorId: 1,
              text: '4MESSAGE',
            },
          ],
        },
        post: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
          user: {
            id: 1,
            from: 'FirstUser',
            email: 'userOne@notmail.com',
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
          },
        },
      },
    });
  });

  it(`Select array with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				user: users {
					id
					name
					email
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					messages: posts {
						id
						authorId
						text: content
					}
				}

				post: posts {
					id
					authorId
					content
					user: author {
						id
						from: name
						email
						bigint
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        user: [
          {
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            messages: [
              {
                id: 1,
                authorId: 1,
                text: '1MESSAGE',
              },
              {
                id: 2,
                authorId: 1,
                text: '2MESSAGE',
              },
              {
                id: 3,
                authorId: 1,
                text: '3MESSAGE',
              },
              {
                id: 6,
                authorId: 1,
                text: '4MESSAGE',
              },
            ],
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            messages: [],
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            messages: [
              {
                id: 4,
                authorId: 5,
                text: '1MESSAGE',
              },
              {
                id: 5,
                authorId: 5,
                text: '2MESSAGE',
              },
            ],
          },
        ],
        post: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            user: {
              id: 1,
              from: 'FirstUser',
              email: 'userOne@notmail.com',
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            user: {
              id: 1,
              from: 'FirstUser',
              email: 'userOne@notmail.com',
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            user: {
              id: 1,
              from: 'FirstUser',
              email: 'userOne@notmail.com',
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            user: {
              id: 5,
              from: 'FifthUser',
              email: null,
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            user: {
              id: 5,
              from: 'FifthUser',
              email: null,
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            user: {
              id: 1,
              from: 'FirstUser',
              email: 'userOne@notmail.com',
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
						bigint: "15"
						birthdayString: "2024-04-02"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
						isConfirmed: true
					}
				) {
					success: isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsersSingle: {
          success: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 3));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
    ]);
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
							bigint: "15"
							birthdayString: "2024-04-02"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
						}
						{
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							bigint: "42"
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
					success: isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: {
          success: true,
        },
      },
    });

    const data = await ctx.db
      .select()
      .from(schema.Users)
      .where(inArray(schema.Users.id, [3, 4]));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
      {
        id: 4,
        name: 'FourthUser',
        email: 'userFour@notmail.com',
        bigint: BigInt(42),
        birthdayString: '2024-04-04',
        birthdayDate: new Date('2024-04-04T00:00:00.000Z'),
        createdAt: new Date('2024-04-04T06:44:42.000Z'),
        role: 'user',
        roleText: null,
        roleText2: 'user',
        profession: 'FourthUserProf',
        initials: 'SU',
        isConfirmed: false,
      },
    ]);
  });

  it(`Update`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomers(set: { isConfirmed: true, address: "Edited" }) {
					success: isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomers: {
          success: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([
      {
        id: 1,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:54:45.000Z'),
        userId: 1,
      },
      {
        id: 2,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:55:42.000Z'),
        userId: 2,
      },
    ]);
  });

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteCustomers {
					success: isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteCustomers: {
          success: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([]);
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
					isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updatePosts: {
          isSuccess: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Posts);

    expect(data).toStrictEqual([
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
      {
        id: 6,
        authorId: 1,
        content: '4MESSAGE',
      },
    ]);
  });

  it('Delete filters', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deletePosts(where: { OR: [{ id: { lte: 3 } }, { authorId: { eq: 5 } }] }) {
					isSuccess
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deletePosts: {
          isSuccess: true,
        },
      },
    });

    const data = await ctx.db.select().from(schema.Posts);

    expect(data).toStrictEqual([
      {
        id: 6,
        authorId: 1,
        content: '4MESSAGE',
      },
    ]);
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                // Present only on the fields that carry a complexity hint (lists and aggregates).
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
                type: z.instanceof(GraphQLObjectType),
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
                extensions: z
                  .object({ drizzle: z.object({}).passthrough(), complexity: z.function().optional() })
                  .strict(),
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
            MutationReturn: z.instanceof(GraphQLObjectType),
            UsersAggregate: z.instanceof(GraphQLObjectType),
            UsersGroupBy: z.instanceof(GraphQLObjectType),
            CustomersAggregate: z.instanceof(GraphQLObjectType),
            CustomersGroupBy: z.instanceof(GraphQLObjectType),
            PostsAggregate: z.instanceof(GraphQLObjectType),
            PostsGroupBy: z.instanceof(GraphQLObjectType),
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
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Customers, true>;
        };
        readonly createPosts: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Posts, true>;
        };
        readonly createUsers: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: InsertArrResolver<typeof schema.Users, true>;
        };
      } & {
        readonly createCustomersSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Customers, true>;
        };
        readonly createPostsSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Posts, true>;
        };
        readonly createUsersSingle: {
          type: GraphQLObjectType;
          args: {
            values: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
          };
          resolve: InsertResolver<typeof schema.Users, true>;
        };
      } & {
        readonly updateCustomers: {
          type: GraphQLObjectType;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Customers, true>;
        };
        readonly updatePosts: {
          type: GraphQLObjectType;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Posts, true>;
        };
        readonly updateUsers: {
          type: GraphQLObjectType;
          args: {
            set: {
              type: GraphQLNonNull<GraphQLInputObjectType>;
            };
            where: { type: GraphQLInputObjectType };
          };
          resolve: UpdateResolver<typeof schema.Users, true>;
        };
      } & {
        readonly updateCustomersMany: {
          type: GraphQLObjectType;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Customers, true>;
        };
        readonly updatePostsMany: {
          type: GraphQLObjectType;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Posts, true>;
        };
        readonly updateUsersMany: {
          type: GraphQLObjectType;
          args: {
            updates: {
              type: GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>;
            };
          };
          resolve: UpdateManyResolver<typeof schema.Users, true>;
        };
      } & {
        readonly deleteCustomers: {
          type: GraphQLObjectType;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Customers, true>;
        };
        readonly deletePosts: {
          type: GraphQLObjectType;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Posts, true>;
        };
        readonly deleteUsers: {
          type: GraphQLObjectType;
          args: {
            where: { type: GraphQLInputObjectType };
          };
          resolve: DeleteResolver<typeof schema.Users, true>;
        };
      }
    >();
  });

  it('Types', () => {
    expectTypeOf(ctx.entities.types).toEqualTypeOf<
      {
        MutationReturn: GraphQLObjectType;
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
						id: 3
						name: "ThirdUser"
						email: "userThree@notmail.com"
						bigint: "15"
						birthdayString: "2024-04-02"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
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
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 3));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
    ]);
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
							bigint: "15"
							birthdayString: "2024-04-02"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
						}
						{
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							bigint: "42"
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
        createUsers: {
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db
      .select()
      .from(schema.Users)
      .where(inArray(schema.Users.id, [3, 4]));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
      {
        id: 4,
        name: 'FourthUser',
        email: 'userFour@notmail.com',
        bigint: BigInt(42),
        birthdayString: '2024-04-04',
        birthdayDate: new Date('2024-04-04T00:00:00.000Z'),
        createdAt: new Date('2024-04-04T06:44:42.000Z'),
        role: 'user',
        roleText: null,
        roleText2: 'user',
        profession: 'FourthUserProf',
        initials: 'SU',
        isConfirmed: false,
      },
    ]);
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
        updateCustomers: {
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([
      {
        id: 1,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:54:45.000Z'),
        userId: 1,
      },
      {
        id: 2,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:55:42.000Z'),
        userId: 2,
      },
    ]);
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
        deleteCustomers: {
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([]);
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            __typename: 'Users',
          },
          {
            id: 2,
            name: 'SecondUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            __typename: 'Users',
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
						bigint
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
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
          bigint: '10',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:42.000Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
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
					bigint
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
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
						bigint
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
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
            bigint: '10',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:42.000Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
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
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            __typename: 'Users',
            posts: [],
          },
          {
            id: 5,
            name: 'FifthUser',
            email: null,
            bigint: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:42.000Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
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
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
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
              bigint: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:42.000Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
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
              bigint: '10',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:42.000Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
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
						bigint: "15"
						birthdayString: "2024-04-02"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
						isConfirmed: true
					}
				) {
					isSuccess
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsersSingle: {
          isSuccess: true,
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db.select().from(schema.Users).where(eq(schema.Users.id, 3));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
    ]);
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
							bigint: "15"
							birthdayString: "2024-04-02"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
						}
						{
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							bigint: "42"
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
					isSuccess
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: {
          isSuccess: true,
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db
      .select()
      .from(schema.Users)
      .where(inArray(schema.Users.id, [3, 4]));

    expect(data).toStrictEqual([
      {
        id: 3,
        name: 'ThirdUser',
        email: 'userThree@notmail.com',
        bigint: BigInt(15),
        birthdayString: '2024-04-02',
        birthdayDate: new Date('2024-04-02T00:00:00.000Z'),
        createdAt: new Date('2024-04-02T06:44:42.000Z'),
        role: 'admin',
        roleText: null,
        roleText2: 'user',
        profession: 'ThirdUserProf',
        initials: 'FU',
        isConfirmed: true,
      },
      {
        id: 4,
        name: 'FourthUser',
        email: 'userFour@notmail.com',
        bigint: BigInt(42),
        birthdayString: '2024-04-04',
        birthdayDate: new Date('2024-04-04T00:00:00.000Z'),
        createdAt: new Date('2024-04-04T06:44:42.000Z'),
        role: 'user',
        roleText: null,
        roleText2: 'user',
        profession: 'FourthUserProf',
        initials: 'SU',
        isConfirmed: false,
      },
    ]);
  });

  it(`Update`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomers(set: { isConfirmed: true, address: "Edited" }) {
					isSuccess
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomers: {
          isSuccess: true,
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([
      {
        id: 1,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:54:45.000Z'),
        userId: 1,
      },
      {
        id: 2,
        address: 'Edited',
        isConfirmed: true,
        registrationDate: new Date('2024-03-27T03:55:42.000Z'),
        userId: 2,
      },
    ]);
  });

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteCustomers {
					isSuccess
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteCustomers: {
          isSuccess: true,
          __typename: 'MutationReturn',
        },
      },
    });

    const data = await ctx.db.select().from(schema.Customers);

    expect(data).toStrictEqual([]);
  });
});

describe.sequential('Upsert tests', () => {
  const upsert = (source: string) => graphql({ schema: ctx.upsertSchema, source, contextValue: {} });
  const users = () => ctx.db.select().from(schema.Users).orderBy(schema.Users.id);

  it('inserts a row that does not conflict', async () => {
    const result = await upsert(`mutation { upsertUsersSingle(values: { id: 100, name: "NewUser" }) { isSuccess } }`);

    expect(result.errors).toBeUndefined();
    expect(result.data?.['upsertUsersSingle']).toMatchObject({ isSuccess: true });
    expect((await users()).find((u) => u.id === 100)?.name).toBe('NewUser');
  });

  it('overwrites the conflicting row', async () => {
    const result = await upsert(
      `mutation { upsertUsersSingle(values: { id: 1, name: "Replaced", profession: "Upserted" }) { isSuccess } }`,
    );

    expect(result.errors).toBeUndefined();
    const first = (await users()).find((u) => u.id === 1)!;
    expect(first.name).toBe('Replaced');
    expect(first.profession).toBe('Upserted');
  });

  it('leaves the existing row alone when the action is NOTHING', async () => {
    const result = await upsert(`mutation {
      upsertUsersSingle(values: { id: 1, name: "Ignored" }, onConflict: { action: NOTHING }) { isSuccess }
    }`);

    expect(result.errors).toBeUndefined();
    expect((await users()).find((u) => u.id === 1)?.name).toBe('FirstUser');
  });

  it('updates each row of a batch with its own values', async () => {
    const result = await upsert(`mutation {
      upsertUsers(values: [
        { id: 1, name: "OneUpserted" },
        { id: 2, name: "TwoUpserted" },
        { id: 300, name: "Inserted" }
      ]) { isSuccess }
    }`);

    expect(result.errors).toBeUndefined();
    const rows = await users();
    expect(rows.find((u) => u.id === 1)?.name).toBe('OneUpserted');
    expect(rows.find((u) => u.id === 2)?.name).toBe('TwoUpserted');
    expect(rows.find((u) => u.id === 300)?.name).toBe('Inserted');
  });

  it('overwrites only the listed columns', async () => {
    const result = await upsert(`mutation {
      upsertUsersSingle(
        values: { id: 1, name: "Fresh", profession: "Fresher" }
        onConflict: { update: [profession] }
      ) { isSuccess }
    }`);

    expect(result.errors).toBeUndefined();
    const first = (await users()).find((u) => u.id === 1)!;
    expect(first.name).toBe('FirstUser');
    expect(first.profession).toBe('Fresher');
  });

  it('rejects an update column the values do not supply', async () => {
    const result = await upsert(`mutation {
      upsertUsersSingle(values: { id: 1, name: "Fresh" }, onConflict: { update: [profession] }) { isSuccess }
    }`);

    expect(result.errors?.[0]?.message).toContain('which the values do not supply');
  });
});

describe.sequential('Group by tests', () => {
  // Seeded posts: author 1 has ids 1, 2, 3, 6 — author 5 has ids 4, 5.
  const byAuthor = (rows: any[]) => [...rows].sort((a, b) => a.group.authorId - b.group.authorId);

  it('Group by with aggregates', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
      {
        postsGroupBy(groupBy: [authorId]) {
          group {
            authorId
          }
          count
          sum {
            id
          }
          min {
            id
          }
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(byAuthor(res.data!['postsGroupBy'])).toStrictEqual([
      { group: { authorId: 1 }, count: 4, sum: { id: 12 }, min: { id: 1 } },
      { group: { authorId: 5 }, count: 2, sum: { id: 9 }, min: { id: 4 } },
    ]);
  });

  it('Group by with where and having', async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
      {
        postsGroupBy(groupBy: [authorId], where: { id: { lt: 6 } }, having: { count: { gte: 3 } }) {
          group {
            authorId
          }
          count
        }
      }
    `);

    expect(res.errors).toBeUndefined();
    expect(res.data!['postsGroupBy']).toStrictEqual([{ group: { authorId: 1 }, count: 3 }]);
  });
});

describe.sequential('Atomic column updates and count mutations', () => {
  const optIn = (source: string) => graphql({ schema: ctx.optInSchema, source, contextValue: {} });
  const users = () => ctx.db.select().from(schema.Users).orderBy(schema.Users.id);

  it("replaces a numeric column's update field with an operations input", () => {
    const input = ctx.optInSchema.getType('UpdateUsersInput') as GraphQLInputObjectType;

    expect(String(input.getFields()['bigint']!.type)).toBe('BigIntFieldUpdate');
    // A text column has no arithmetic, so it keeps its plain field.
    expect(String(input.getFields()['name']!.type)).toBe('String');
  });

  it('increments in the database rather than through a read', async () => {
    const res = await optIn(
      `mutation { updateUsers(where: { id: { eq: 1 } }, set: { bigint: { increment: "5" } }) { isSuccess } }`,
    );

    expect(res.errors).toBeUndefined();
    expect((await users()).find((u) => u.id === 1)?.bigint).toBe(BigInt(15));
  });

  it('applies the operation per row', async () => {
    await ctx.db
      .update(schema.Users)
      .set({ bigint: BigInt(2) })
      .where(inArray(schema.Users.id, [2, 5]));
    await ctx.db
      .update(schema.Users)
      .set({ bigint: BigInt(4) })
      .where(eq(schema.Users.id, 1));

    const res = await optIn(`mutation { updateUsers(set: { bigint: { multiply: "3" } }) { isSuccess } }`);

    expect(res.errors).toBeUndefined();
    expect((await users()).map((u) => u.bigint)).toStrictEqual([BigInt(12), BigInt(6), BigInt(6)]);
  });

  it('rejects two operations on one column', async () => {
    const res = await optIn(
      `mutation { updateUsers(set: { bigint: { increment: "1", decrement: "1" } }) { isSuccess } }`,
    );

    expect(res.errors?.[0]?.message).toBe(
      "Field 'bigint' takes exactly one update operation, but 2 were given (increment, decrement).",
    );
  });

  it('carries the operations through updateUsersMany', async () => {
    const res = await optIn(`mutation {
			updateUsersMany(updates: [
				{ where: { id: { eq: 1 } }, set: { bigint: { increment: "1" } } },
				{ where: { id: { eq: 2 } }, set: { bigint: { set: "100" } } }
			]) { isSuccess }
		}`);

    expect(res.errors).toBeUndefined();
    const rows = await users();
    expect(rows.find((u) => u.id === 1)?.bigint).toBe(BigInt(11));
    expect(rows.find((u) => u.id === 2)?.bigint).toBe(BigInt(100));
  });

  it('returns a row count instead of the shared success flag', () => {
    const mutations = ctx.optInSchema.getMutationType()!.getFields();

    expect(String(mutations['updateUsersCount']!.type)).toBe('Int!');
    expect(String(mutations['deleteUsersCount']!.type)).toBe('Int!');
    // The row-returning siblings still return MySQL's success flag.
    expect(String(mutations['updateUsers']!.type)).toBe('MutationReturn');
    expect(ctx.schema.getMutationType()!.getFields()['updateUsersCount']).toBeUndefined();
  });

  it('counts the rows an update touched', async () => {
    const res = await optIn(`mutation { updateUsersCount(set: { name: "Renamed" }) }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateUsersCount']).toBe(3);
  });

  it('counts nothing when the filter matches nothing', async () => {
    const res = await optIn(`mutation { updateUsersCount(where: { id: { eq: 999 } }, set: { name: "x" }) }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateUsersCount']).toBe(0);
  });

  it('counts the rows a delete removed', async () => {
    const res = await optIn(`mutation { deleteCustomersCount(where: { id: { eq: 1 } }) }`);

    expect(res.errors).toBeUndefined();
    expect(res.data?.['deleteCustomersCount']).toBe(1);
    expect((await ctx.db.select().from(schema.Customers)).find((c) => c.id === 1)).toBeUndefined();
  });

  it('counts a filtered update alongside an atomic operation', async () => {
    const res = await optIn(
      `mutation { updateUsersCount(where: { id: { eq: 1 } }, set: { bigint: { increment: "7" } }) }`,
    );

    expect(res.errors).toBeUndefined();
    expect(res.data?.['updateUsersCount']).toBe(1);
    expect((await users()).find((u) => u.id === 1)?.bigint).toBe(BigInt(17));
  });

  it('rejects an update with no values', async () => {
    const res = await optIn(`mutation { updateUsersCount(set: {}) }`);

    expect(res.errors?.[0]?.message).toBe('Unable to update with no values specified!');
  });
});
