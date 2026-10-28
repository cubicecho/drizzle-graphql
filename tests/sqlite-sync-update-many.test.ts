import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// `update<Table>Many` runs its entries in one transaction. A synchronous driver (node:sqlite
// here, better-sqlite3 alike) commits that transaction the moment the callback returns, so the
// SQLite runner has to execute every entry inside the callback, not after an `await` — otherwise
// the later entries escape the transaction and a failing one can no longer roll the batch back.
// The build keeps the defaults: nestedWrites, transactions: 'auto' and onWrite are refused on a
// sync driver (see sqlite-sync-driver-features.test.ts), and updateMany needs none of them.

// The table carries a CHECK the Drizzle schema does not know about, so an entry setting a
// negative `qty` passes the resolver's own validation and fails in the database, mid-batch.
const Items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty'),
});

let dir: string;
let client: DatabaseSync;
let db: any;
let schema: GraphQLSchema;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'drizzle-graphql-sync-update-many-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  client = new DatabaseSync(join(dir, `db-${Date.now()}-${Math.random()}.sqlite`));
  db = (drizzle as any)({ client, relations: buildRelations({ Items }, { Items: {} }) });
  db.run(sql`CREATE TABLE items (id integer primary key, name text not null, qty integer CHECK (qty >= 0))`);
  db.run(sql`INSERT INTO items VALUES (1, 'One', 1), (2, 'Two', 2), (3, 'Three', 3)`);
  schema = buildSchema(db).schema;
});

afterEach(() => {
  client.close();
});

const items = () => db.all(sql`SELECT id, name, qty FROM items ORDER BY id`);

const UPDATE_MANY = /* GraphQL */ `
  mutation ($updates: [UpdateItemsManyInput!]!) {
    updateItemsMany(updates: $updates) { id name qty }
  }
`;

const run = (updates: unknown[]) =>
  graphql({ schema, source: UPDATE_MANY, variableValues: { updates }, contextValue: {} });

describe.sequential('updateMany on a synchronous SQLite driver', () => {
  it('detects the driver as sync, so the runner takes the sync path', () => {
    expect(db.resultKind).toBe('sync');
  });

  it('applies the entries in order and returns each one’s rows in entry order', async () => {
    const result = await run([
      { where: { id: { eq: 3 } }, set: { qty: 30 } },
      { where: { id: { eq: 1 } }, set: { qty: 10, name: 'OneEdited' } },
      // Same row as the entry before: it sees that entry's write and applies on top of it.
      { where: { id: { eq: 1 } }, set: { qty: 11 } },
    ]);
    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateItemsMany).toEqual([
      { id: 3, name: 'Three', qty: 30 },
      { id: 1, name: 'OneEdited', qty: 10 },
      { id: 1, name: 'OneEdited', qty: 11 },
    ]);
    expect(items()).toEqual([
      { id: 1, name: 'OneEdited', qty: 11 },
      { id: 2, name: 'Two', qty: 2 },
      { id: 3, name: 'Three', qty: 30 },
    ]);
  });

  it('answers null for an entry whose where matches nothing, and still applies the others', async () => {
    const result = await run([
      { where: { id: { eq: 1 } }, set: { qty: 10 } },
      { where: { id: { eq: 999 } }, set: { qty: 990 } },
      { where: { id: { eq: 2 } }, set: { qty: 20 } },
    ]);
    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateItemsMany).toEqual([
      { id: 1, name: 'One', qty: 10 },
      null,
      { id: 2, name: 'Two', qty: 20 },
    ]);
    expect(items()).toEqual([
      { id: 1, name: 'One', qty: 10 },
      { id: 2, name: 'Two', qty: 20 },
      { id: 3, name: 'Three', qty: 3 },
    ]);
  });

  it('rolls back the earlier entries when a later one violates a constraint', async () => {
    const result = await run([
      { where: { id: { eq: 1 } }, set: { qty: 100 } },
      { where: { id: { eq: 3 } }, set: { name: 'ThreeEdited' } },
      { where: { id: { eq: 2 } }, set: { qty: -1 } },
    ]);
    expect(result.errors).toBeDefined();
    // A driver error is masked to the client; the table state below is what proves the rollback.
    expect(result.errors![0]!.extensions['code']).toBe('INTERNAL_SERVER_ERROR');
    expect(items()).toEqual([
      { id: 1, name: 'One', qty: 1 },
      { id: 2, name: 'Two', qty: 2 },
      { id: 3, name: 'Three', qty: 3 },
    ]);
    // The failed batch left no transaction open behind it: the next one commits normally.
    const next = await run([{ where: { id: { eq: 2 } }, set: { qty: 22 } }]);
    expect(next.errors).toBeUndefined();
    expect(items()[1]).toEqual({ id: 2, name: 'Two', qty: 22 });
  });
});
