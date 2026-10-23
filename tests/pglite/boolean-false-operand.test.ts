// `false` is a value like any other for a value operator (`eq`, `ne`, `has`, …): it must bind
// as an operand rather than be dropped, or the filter silently matches every row. Only the
// flag operators (`isNull` / `isNotNull` / `isEmpty`) read `false` as "no restriction".
import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Flags = pgTable('flags', {
  id: integer('id').primaryKey(),
  active: boolean('active'),
  votes: boolean('votes').array(),
  meta: jsonb('meta'),
});
const relations = buildRelations({ Flags }, {});

let pglite: PGlite;
let db: any;
let schema: GraphQLSchema;

const run = (source: string) => graphql({ schema, source, contextValue: {} });

const ids = async (where: string): Promise<number[]> => {
  const res = await run(`{ flags(where: ${where}, orderBy: { id: { direction: asc, priority: 1 } }) { id } }`);
  expect(res.errors).toBeUndefined();
  return (res.data as any).flags.map((row: any) => row.id);
};

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  db = (drizzle as any)({ client: pglite, relations });
  await db.execute(sql`CREATE TABLE flags (id integer primary key, active boolean, votes boolean[], meta jsonb)`);
  schema = buildSchema(db).schema;
});
beforeEach(async () => {
  await db.execute(sql`DELETE FROM flags`);
  await db.insert(Flags).values([
    { id: 1, active: true, votes: [true], meta: { on: true } },
    { id: 2, active: false, votes: [false], meta: { on: false } },
    { id: 3, active: null, votes: [], meta: {} },
  ]);
});
afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe('false as a filter operand', () => {
  it('eq: false matches only the false row', async () => {
    expect(await ids(`{ active: { eq: false } }`)).toEqual([2]);
  });

  it('ne: false matches only the true row', async () => {
    expect(await ids(`{ active: { ne: false } }`)).toEqual([1]);
  });

  it('eq: false composes under NOT and OR', async () => {
    expect(await ids(`{ NOT: { active: { eq: false } } }`)).toEqual([1]);
    expect(await ids(`{ OR: [{ active: { eq: false } }, { id: { eq: 3 } }] }`)).toEqual([2, 3]);
  });

  it('inArray: [false] matches only the false row', async () => {
    expect(await ids(`{ active: { inArray: [false] } }`)).toEqual([2]);
  });

  it('has: false on a boolean array matches arrays holding false', async () => {
    expect(await ids(`{ votes: { has: false } }`)).toEqual([2]);
  });

  it('a JSON path eq: false compares against false', async () => {
    expect(await ids(`{ meta: { path: { path: ["on"], eq: false } } }`)).toEqual([2]);
  });

  it('flag operators still read false as no restriction', async () => {
    expect(await ids(`{ active: { isNull: false } }`)).toEqual([1, 2, 3]);
    expect(await ids(`{ active: { isNotNull: false } }`)).toEqual([1, 2, 3]);
    expect(await ids(`{ votes: { isEmpty: false } }`)).toEqual([1, 2, 3]);
  });

  it('a null operand is still ignored', async () => {
    expect(await ids(`{ active: { eq: null } }`)).toEqual([1, 2, 3]);
  });

  it('deleteFlags(where: { active: { eq: false } }) deletes only the false row', async () => {
    const res = await run(`mutation { deleteFlags(where: { active: { eq: false } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).deleteFlags).toEqual([{ id: 2 }]);
    expect(await ids('{}')).toEqual([1, 3]);
  });

  it('updateFlags(where: { active: { ne: false } }) updates only the true row', async () => {
    const res = await run(`mutation { updateFlags(where: { active: { ne: false } }, set: { active: false }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as any).updateFlags).toEqual([{ id: 1 }]);
  });
});
