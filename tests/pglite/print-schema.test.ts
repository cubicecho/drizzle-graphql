import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { printSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';
import * as schema from '../schema/pg';

const DATA_DIR = `./tests/.temp/pgdata-print-schema-${Date.now()}`;

let pglite: PGlite;

beforeAll(async () => {
  pglite = new PGlite(DATA_DIR);
  await pglite.waitReady;
});

afterAll(async () => {
  await pglite?.close().catch(console.error);
  await rm(DATA_DIR, { recursive: true, force: true }).catch(console.error);
});

describe('printSchema', () => {
  it('prints a non-empty GraphQL SDL from buildSchema', () => {
    const db = drizzle({ client: pglite, relations: schema.relations });
    const { schema: gqlSchema } = buildSchema(db, {
      typeNameMapper: (name) => {
        const map: Record<string, { singular: string; plural: string }> = {
          Users: { singular: 'user', plural: 'users' },
          Posts: { singular: 'post', plural: 'posts' },
          Customers: { singular: 'customer', plural: 'customers' },
          Tags: { singular: 'tag', plural: 'tags' },
        };
        return map[name];
      },
      prefixes: {
        insert: 'create',
        delete: 'delete',
        update: 'update',
      },
      suffixes: {
        single: '',
        list: '',
      },
    });
    const sdl = printSchema(gqlSchema);

    console.log(sdl);

    expect(typeof sdl).toBe('string');
    expect(sdl.length).toBeGreaterThan(0);
  });
});
