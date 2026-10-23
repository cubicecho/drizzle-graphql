import { DatabaseSync } from 'node:sqlite';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A synchronous SQLite driver (node:sqlite here, better-sqlite3 alike) commits its transaction
// the moment the callback returns, so the features that await inside a transaction cannot be
// honoured on one. `buildSchema` refuses them rather than silently losing the rollback.

const Items = sqliteTable('items', { id: integer('id').primaryKey(), name: text('name') });

const syncDb = () => {
  const db = (drizzle as any)({
    client: new DatabaseSync(':memory:'),
    relations: buildRelations({ Items }, { Items: {} }),
  });
  db.run(sql`CREATE TABLE items (id integer primary key, name text)`);
  return db;
};

describe('features a synchronous SQLite driver cannot run', () => {
  it.each([
    ['a table map', { Items: { after: () => {} } }],
    ['a global hook', () => {}],
  ])('refuses onWrite given as %s', (_label, onWrite) => {
    expect(() => buildSchema(syncDb(), { onWrite: onWrite as any })).toThrow(
      /onWrite requires an asynchronous SQLite driver/,
    );
  });

  it('refuses nestedWrites and transactions: auto', () => {
    expect(() => buildSchema(syncDb(), { features: { nestedWrites: true } })).toThrow(
      /nestedWrites requires an asynchronous SQLite driver/,
    );
    expect(() => buildSchema(syncDb(), { transactions: 'auto' })).toThrow(
      /transactions: 'auto' requires an asynchronous SQLite driver/,
    );
  });

  it('still builds when no table resolves a hook, and writes go through', async () => {
    const db = syncDb();
    const { schema } = buildSchema(db, { onWrite: { Items: {} } as any });
    const result = await graphql({
      schema,
      source: 'mutation { createItemsSingle(values: { id: 1, name: "x" }) { id } }',
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect(db.all(sql`SELECT id FROM items`)).toEqual([{ id: 1 }]);
  });
});
