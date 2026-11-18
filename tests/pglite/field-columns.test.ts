import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { extendSchema, type GraphQLObjectType, type GraphQLSchema, graphql, parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema, type FieldColumns } from '@/index';
import * as schema from '../schema/pg';
import { setupTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-field-columns-${Date.now()}`;
let pglite: PGlite;
let db: any;

/**
 * Builds a schema and adds `Posts.label`, which reads only the row's `content`, the way a consumer
 * adds a field the generated CRUD cannot express. `content` is no key, so nothing else selects it.
 */
const buildWithLabel = (fieldColumns?: FieldColumns): GraphQLSchema => {
  const { schema: generated } = buildSchema(db, {
    features: { upsert: true },
    ...(fieldColumns ? { fieldColumns } : {}),
  });
  const extended = extendSchema(generated, parse('extend type Posts { label: String }'));
  const posts = extended.getType('Posts') as GraphQLObjectType;
  posts.getFields()['label']!.resolve = (parent: { content?: string | null }) =>
    parent.content === undefined ? 'no content' : `post: ${parent.content}`;
  return extended;
};

const run = async (gqlSchema: GraphQLSchema, source: string) => {
  const result = await graphql({ schema: gqlSchema, source, contextValue: {} });
  expect(result.errors).toBeUndefined();
  return result.data as any;
};

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, schema, relations: schema.relations });
  await db.execute(
    sql`DO $$ BEGIN CREATE TYPE "role" AS ENUM('admin', 'user');
        EXCEPTION WHEN duplicate_object THEN null; END $$;`,
  );
  await setupTables({ db } as any);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe.sequential('fieldColumns', () => {
  it('leaves an added field without the columns the query did not name, by default', async () => {
    const data = await run(buildWithLabel(), `{ postsSingle(where: { id: { eq: 1 } }) { id label } }`);
    expect(data.postsSingle.label).toBe('no content');
  });

  it('selects the columns an added field names, on a root read', async () => {
    const gqlSchema = buildWithLabel({ Posts: { label: ['content'] } });
    const data = await run(gqlSchema, `{ postsSingle(where: { id: { eq: 1 } }) { id label } }`);
    expect(data.postsSingle.label).toMatch(/^post: /);
  });

  it('selects them through a relation field', async () => {
    const gqlSchema = buildWithLabel({ Posts: { label: ['content'] } });
    const data = await run(gqlSchema, `{ usersSingle(where: { id: { eq: 1 } }) { posts(limit: 1) { label } } }`);
    expect(data.usersSingle.posts[0].label).toMatch(/^post: /);
  });

  it('selects them on a mutation result', async () => {
    const gqlSchema = buildWithLabel({ Posts: { label: ['content'] } });
    const created = await run(
      gqlSchema,
      `mutation { createPostsSingle(values: { id: 301, content: "x", authorId: 2 }) { id label } }`,
    );
    expect(created.createPostsSingle.label).toBe('post: x');

    const deleted = await run(gqlSchema, `mutation { deletePosts(where: { id: { eq: 301 } }) { label } }`);
    expect(deleted.deletePosts).toEqual([{ label: 'post: x' }]);
  });

  it.each([
    [{ Nope: { label: ['id'] } }, /config\.fieldColumns names table 'Nope'/],
    [{ Posts: { label: ['nope'] } }, /config\.fieldColumns\.Posts\.label names 'nope'/],
    [{ Posts: { content: ['id'] } }, /config\.fieldColumns\.Posts names 'content', which is a column/],
  ])('throws for a config naming nothing it can select (%o)', (fieldColumns, message) => {
    expect(() => buildSchema(db, { fieldColumns })).toThrow(message);
  });
});
