import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { buildSchema, type GeneratedData, type GeneratedEntities } from '@/index';
import * as schema from '../schema/pg';
import { GraphQLClient } from '../util/query';

export { schema, sql };

/**
 * drizzle-orm v1's database generic is the relations config produced by `buildRelations`,
 * not the schema module — `PgliteDatabase<typeof schema>` silently degraded every derived
 * entity type to `never`, which is why the `expectTypeOf` assertions below were meaningless
 * until the suite was brought under `tsc`.
 */
export type TestDatabase = PgliteDatabase<typeof schema.relations>;

/**
 * The entity maps a default build publishes: no `typeNameMapper`, so every key is the table
 * key itself and the one-row operations keep their `Single` suffix. The fixtures below build
 * with a mapper *function*, whose renames no type can predict, so their own `entities` are
 * keyed loosely — the type suites pin this shape instead, since it is the documented one.
 */
export type DefaultEntities = GeneratedEntities<TestDatabase>;

export interface Context {
  pglite: PGlite;
  db: TestDatabase;
  schema: GraphQLSchema;
  entities: GeneratedData<TestDatabase, 'loose'>['entities'];
  server: Server;
  gql: GraphQLClient;
}

export interface MinimalContext {
  pglite: PGlite;
  db: TestDatabase;
  schema: GraphQLSchema;
  entities: GeneratedData<TestDatabase, 'loose'>['entities'];
}

export const createCtx = (): Context => ({}) as any;
export const createMinimalCtx = (): MinimalContext => ({}) as any;

export const setupServer = async (ctx: Context, port: number, dataDir: string): Promise<void> => {
  ctx.pglite = new PGlite(dataDir);
  await ctx.pglite.waitReady;

  ctx.db = drizzle({
    client: ctx.pglite,
    relations: schema.relations,
    logger: !!process.env['LOG_SQL'],
  });

  const { schema: gqlSchema, entities } = buildSchema(ctx.db, {
    typeNameMapper: (name) => {
      const map: Record<string, { singular: string; plural: string }> = {
        Users: { singular: 'user', plural: 'users' },
        Posts: { singular: 'post', plural: 'posts' },
        Customers: { singular: 'customer', plural: 'customers' },
        Tags: { singular: 'tag', plural: 'tags' },
      };
      return map[name];
    },
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
  });
  const yoga = createYoga({ schema: gqlSchema });
  const server = createServer(yoga);

  server.listen(port);
  const gql = new GraphQLClient(`http://localhost:${port}/graphql`);

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
};

export const teardownServer = async (ctx: Context, dataDir: string): Promise<void> => {
  await ctx.pglite?.close().catch(console.error);
  await rm(dataDir, { recursive: true, force: true }).catch(console.error);
  await new Promise<void>((resolve) => ctx.server?.close(() => resolve()));
};

export const setupMinimal = async (ctx: MinimalContext, dataDir: string): Promise<void> => {
  ctx.pglite = new PGlite(dataDir);
  await ctx.pglite.waitReady;

  ctx.db = drizzle({
    client: ctx.pglite,
    relations: schema.relations,
    logger: !!process.env['LOG_SQL'],
  });

  const { schema: gqlSchema, entities } = buildSchema(ctx.db, {
    typeNameMapper: (name) => {
      const map: Record<string, { singular: string; plural: string }> = {
        Users: { singular: 'user', plural: 'users' },
        Posts: { singular: 'post', plural: 'posts' },
        Customers: { singular: 'customer', plural: 'customers' },
        Tags: { singular: 'tag', plural: 'tags' },
      };
      return map[name];
    },
    prefixes: { insert: 'create', delete: 'delete' },
    suffixes: { single: '', list: '' },
  });

  ctx.schema = gqlSchema;
  ctx.entities = entities;
};

export const teardownMinimal = async (ctx: MinimalContext, dataDir: string): Promise<void> => {
  await ctx.pglite?.close().catch(console.error);
  await rm(dataDir, { recursive: true, force: true }).catch(console.error);
};

export const setupTables = async (ctx: Context | MinimalContext): Promise<void> => {
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
		"vector_column" text,
		"geometry_xy" text,
		"geometry_tuple" text
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
    { id: 1, authorId: 1, content: '1MESSAGE' },
    { id: 2, authorId: 1, content: '2MESSAGE' },
    { id: 3, authorId: 1, content: '3MESSAGE' },
    { id: 4, authorId: 5, content: '1MESSAGE' },
    { id: 5, authorId: 5, content: '2MESSAGE' },
    { id: 6, authorId: 1, content: '4MESSAGE' },
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
};

export const teardownTables = async (ctx: Context | MinimalContext): Promise<void> => {
  await ctx.db.execute(sql`DROP TABLE IF EXISTS "tags" CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE "posts" CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE "customers" CASCADE;`);
  await ctx.db.execute(sql`DROP TABLE "users" CASCADE;`);
};
