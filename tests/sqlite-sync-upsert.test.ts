import { DatabaseSync } from 'node:sqlite';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// An upsert batch whose rows supply different columns runs as several statements that must
// commit or fail together. A synchronous driver (node:sqlite here, better-sqlite3 alike) commits
// its transaction the moment the callback returns, so the statements have to run inside the
// callback, not after an `await`.

const People = sqliteTable(
  'people',
  { id: integer('id').primaryKey(), handle: text('handle').notNull(), name: text('name'), email: text('email') },
  (t) => [unique('people_handle').on(t.handle)],
);

let db: any;
let schema: GraphQLSchema;

beforeEach(() => {
  db = (drizzle as any)({
    client: new DatabaseSync(':memory:'),
    relations: buildRelations({ People }, { People: {} }),
  });
  db.run(sql`CREATE TABLE people (id integer primary key, handle text not null unique, name text, email text)`);
  db.run(sql`INSERT INTO people VALUES (1, 'alice', 'Alice', 'a@x'), (2, 'bob', 'Bob', 'b@x')`);
  schema = buildSchema(db, { features: { upsert: true } }).schema;
});

const people = () => db.all(sql`SELECT id, handle, name, email FROM people ORDER BY id`);

describe('a split upsert on a synchronous SQLite driver', () => {
  it('rolls back the earlier statements when a later one fails', async () => {
    const result = await graphql({
      schema,
      contextValue: {},
      // Row 1 updates `name` (statement 1); row 3 writes `email` and collides on bob's handle (statement 2).
      source: `mutation { upsertPeople(values: [{ id: 1, handle: "alice", name: "Alice2" }, { id: 3, handle: "bob", email: "c@x" }]) { id } }`,
    });
    expect(result.errors).toBeDefined();
    expect(people()).toEqual([
      { id: 1, handle: 'alice', name: 'Alice', email: 'a@x' },
      { id: 2, handle: 'bob', name: 'Bob', email: 'b@x' },
    ]);
  });

  it('writes every statement and returns the rows in input order when all succeed', async () => {
    const result = await graphql({
      schema,
      contextValue: {},
      source: `mutation { upsertPeople(values: [
        { id: 1, handle: "alice", name: "Alice2" },
        { id: 2, handle: "bob", email: "bob@x" },
        { id: 3, handle: "carol", name: "Carol" }
      ]) { id name email } }`,
    });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).upsertPeople).toEqual([
      { id: 1, name: 'Alice2', email: 'a@x' },
      { id: 2, name: 'Bob', email: 'bob@x' },
      { id: 3, name: 'Carol', email: null },
    ]);
    expect(people()).toEqual([
      { id: 1, handle: 'alice', name: 'Alice2', email: 'a@x' },
      { id: 2, handle: 'bob', name: 'Bob', email: 'bob@x' },
      { id: 3, handle: 'carol', name: 'Carol', email: null },
    ]);
  });
});
