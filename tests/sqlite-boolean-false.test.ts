// `eq: false` / `ne: false` on a SQLite boolean (integer mode) column must bind `false`, not be
// dropped — dropping it matched every row on reads and on update/delete alike.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  active: integer('active', { mode: 'boolean' }),
});
const relations = buildRelations({ Users }, {});

let client: Client;
let db: any;
let schema: GraphQLSchema;
const run = (source: string) => graphql({ schema, source, contextValue: {} });

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE users (id integer primary key, name text not null, active integer)`);
  schema = buildSchema(db).schema;
});
beforeEach(async () => {
  await db.run(sql`DELETE FROM users`);
  await db.insert(Users).values([
    { id: 1, name: 'a', active: true },
    { id: 2, name: 'b', active: false },
    { id: 3, name: 'c', active: null },
  ]);
});
afterAll(() => client.close());

describe('sqlite: false as a filter operand', () => {
  it('eq: false returns only the false row', async () => {
    const res = await run(`{ users(where: { active: { eq: false } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['users']).toEqual([{ id: 2 }]);
  });

  it('ne: false returns only the true row', async () => {
    const res = await run(`{ users(where: { active: { ne: false } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['users']).toEqual([{ id: 1 }]);
  });

  it('deleteUsers(where: { active: { eq: false } }) deletes only the false row', async () => {
    const res = await run(`mutation { deleteUsers(where: { active: { eq: false } }) { id } }`);
    expect(res.errors).toBeUndefined();
    expect(res.data?.['deleteUsers']).toEqual([{ id: 2 }]);
  });
});
