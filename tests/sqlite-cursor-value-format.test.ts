// Cursor values are checked against their column's format only where the database constrains
// it. SQLite constrains neither a `text({ enum })` column (the enum is drizzle's, not SQLite's)
// nor a `numeric` one (NUMERIC affinity keeps text it cannot convert), so their rows can hold
// any text, and a cursor issued from one must keep paging.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { defineRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, numeric, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Things = sqliteTable('things', {
  id: integer('id').primaryKey(),
  mood: text('mood', { enum: ['plain', "it's"] }),
  n: numeric('n'),
});
const relations = defineRelations({ Things });

let dir: string;
let client: Client;
let schema: GraphQLSchema;
const forge = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dgql-cursor-value-format-'));
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  const db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE things (id integer primary key, mood text, n numeric)`);
  await db.run(sql`INSERT INTO things VALUES
    (1, 'plain', '1.5'), (2, 'not in the enum', 'abc'), (3, 'it''s', '1e5'), (4, NULL, NULL), (5, 'plain', 'NaN')`);
  schema = buildSchema(db).schema;
});
afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const orderBy = (column: string) => `{ ${column}: { direction: asc, priority: 1 } }`;
const ids = (res: any): number[] => res.data.things.map((row: { id: number }) => row.id);

describe('sqlite: cursor values for columns SQLite does not constrain', () => {
  it.each(['mood', 'n'])('genuine cursors walk every row ordered by %s, off-format values included', async (column) => {
    const all = await run(`{ things(orderBy: ${orderBy(column)}) { id cursor } }`);
    const walked: number[] = [];
    let after: string | undefined;
    for (let page = 0; page < 6; page++) {
      const res: any = await run(
        `{ things(orderBy: ${orderBy(column)}, limit: 1${after ? `, after: "${after}"` : ''}) { id cursor } }`,
      );
      expect(res.errors).toBeUndefined();
      if (!res.data.things.length) {
        break;
      }
      walked.push(...ids(res));
      after = res.data.things.at(-1).cursor;
    }
    expect(walked).toEqual(ids(all));
    expect(walked).toHaveLength(5);
  });

  it.each<[string, string]>([
    ['mood', 'not in the enum'],
    ['n', 'abc'],
  ])('a %s cursor value outside its declared format still pages', async (column, value) => {
    const after = forge({
      o: [
        [column, 'asc'],
        ['id', 'asc'],
      ],
      v: [value, 0],
    });
    const res = await run(`{ things(orderBy: ${orderBy(column)}, after: "${after}") { id } }`);
    expect(res.errors).toBeUndefined();
    expect(ids(res)).toContain(2);
  });
});
