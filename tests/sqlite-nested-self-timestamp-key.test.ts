import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// A self-referencing write re-reads its parent rows by primary key after the child-side
// statements. Keyed by a millisecond timestamp, two rows under a second apart have to stay
// distinct when the re-read rows are matched back to the written ones.
const Nodes = sqliteTable('ts_nodes', {
  id: integer('id', { mode: 'timestamp_ms' }).primaryKey(),
  parentId: integer('parent_id', { mode: 'timestamp_ms' }),
  name: text('name').notNull(),
});
const tables = { Nodes };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Nodes: { children: r.many.Nodes({ from: r.Nodes.id, to: r.Nodes.parentId }) },
});

// A file in a fresh directory: libsql swaps connections around a transaction, which loses an
// in-memory database.
const dir = mkdtempSync(join(tmpdir(), 'nested-self-timestamp-key-'));
let client: Client;
let db: any;
let gqlSchema: GraphQLSchema;
const FIRST = new Date('2024-01-01T00:00:00.100Z');
const SECOND = new Date('2024-01-01T00:00:00.200Z');

beforeAll(async () => {
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  db = (drizzle as any)({ client, schema: { ...tables, relations }, relations });
  await db.run(sql`CREATE TABLE ts_nodes (id integer PRIMARY KEY, parent_id integer, name text NOT NULL)`);
  gqlSchema = buildSchema(db, { features: { nestedWrites: true } }).schema;
});
afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.run(sql`DELETE FROM ts_nodes`);
  await db.insert(Nodes).values([
    { id: FIRST, name: 'first' },
    { id: SECOND, name: 'second' },
  ]);
});

describe('nested write on a self-referencing table keyed by a timestamp', () => {
  it('returns each parent row as itself when the keys are under a second apart', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source:
        'mutation { updateNodes(where: { name: { inArray: ["first", "second"] } }, set: { children: { disconnect: [{ name: { eq: "none" } }] } }) { name } }',
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateNodes.map((row: any) => row.name).sort()).toEqual(['first', 'second']);
  });
});
