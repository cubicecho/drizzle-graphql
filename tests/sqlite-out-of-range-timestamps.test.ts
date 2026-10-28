// A SQLite integer `timestamp` / `timestamp_ms` column can hold a number too large for a JS Date
// (more than about 8.64e12 seconds or 8.64e15 milliseconds from 1970), which drizzle reads as an
// invalid Date. A row like that must still page: its cursor carries the stored integer, which
// `after` compares the column against as it is. Every other row's cursor keeps the Date form it
// always had, so cursors issued before still decode.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Groups = sqliteTable('groups', { id: integer('id').primaryKey() });
const Ticks = sqliteTable('ticks', {
  id: integer('id').primaryKey(),
  groupId: integer('group_id').notNull(),
  at: integer('at', { mode: 'timestamp' }).notNull(),
  atMs: integer('at_ms', { mode: 'timestamp_ms' }).notNull(),
  maybeAt: integer('maybe_at', { mode: 'timestamp' }),
});
const tables = { Groups, Ticks };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Groups: { ticks: r.many.Ticks({ from: r.Groups.id, to: r.Ticks.groupId }) },
});

let dir: string;
let client: Client;
let schema: GraphQLSchema;

// Past a JS Date at both ends, and two ordinary instants. `timestamp_ms` stays below 2^53.
const ROWS = [
  [1, 1e13, 9e15, 1e13],
  [2, 1_700_000_000, 1_700_000_000_000, 1_700_000_000],
  [3, -1e13, -9e15, -1e13],
  [4, 0, 0, null],
] as const;
/** Every column's values, ascending: -huge, 0, 1.7e9, +huge, and row 5's infinity. */
const ASCENDING = [3, 4, 2, 1, 5];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'drizzle-graphql-sqlite-out-of-range-'));
  client = createClient({ url: `file:${join(dir, 'db.sqlite')}` });
  const db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE groups (id integer PRIMARY KEY)`);
  await db.run(sql`CREATE TABLE ticks (
    id integer PRIMARY KEY, group_id integer NOT NULL, at integer NOT NULL, at_ms integer NOT NULL, maybe_at integer
  )`);
  await db.run(sql`INSERT INTO groups VALUES (1)`);
  for (const [id, at, atMs, maybeAt] of ROWS) {
    await db.run(sql`INSERT INTO ticks VALUES (${id}, 1, ${at}, ${atMs}, ${maybeAt})`);
  }
  // A REAL infinity, which SQLite stores in an integer column as it is; drivers will not bind one.
  await db.run(sql`INSERT INTO ticks VALUES (5, 1, 9e999, 9e999, 9e999)`);
  schema = buildSchema(db).schema;
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (source: string) => graphql({ schema, source, contextValue: {} });
const payloadOf = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

describe('sqlite: integer timestamps a JS Date cannot hold', () => {
  it('pages past every row by cursor, on the root list and the relation list', async () => {
    for (const column of ['at', 'atMs', 'maybeAt'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        // NULLs sort first ascending on SQLite; `maybeAt` is NULL only on row 4, the second-smallest.
        const ascending = column === 'maybeAt' ? [4, 3, 2, 1, 5] : ASCENDING;
        const expected = direction === 'asc' ? ascending : [...ascending].reverse();
        const orderBy = `orderBy: { ${column}: { direction: ${direction}, priority: 1 } }`;
        const pages = {
          root: async (after: string) => (await run(`{ ticks(${orderBy}, limit: 1${after}) { id cursor } }`)) as any,
          relation: async (after: string) => {
            const res: any = await run(`{ groups { ticks(${orderBy}, limit: 1${after}) { id cursor } } }`);
            return { ...res, data: res.data && { ticks: res.data.groups[0].ticks } };
          },
        };
        for (const [path, page] of Object.entries(pages)) {
          const seen: number[] = [];
          let after = '';
          for (let i = 0; i <= expected.length; i++) {
            const res = await page(after);
            const label = `${path} ${column} ${direction}`;
            expect(
              res.errors?.map((error: Error) => error.message),
              label,
            ).toBeUndefined();
            const rows = res.data.ticks;
            if (!rows.length) {
              break;
            }
            seen.push(rows[0].id);
            after = `, after: "${rows[0].cursor}"`;
          }
          expect(seen, `${path} ${column} ${direction}`).toEqual(expected);
        }
      }
    }
  });

  it('keeps the Date form for every value a Date holds, and carries the stored integer otherwise', async () => {
    const res: any = await run(`{ ticks(orderBy: { at: { direction: asc, priority: 1 } }) { id cursor } }`);
    const values = Object.fromEntries(res.data.ticks.map((row: any) => [row.id, payloadOf(row.cursor).v[0]]));
    expect(values[2]).toEqual({ $type: 'date', value: '2023-11-14T22:13:20.000Z' });
    expect(values[4]).toEqual({ $type: 'date', value: '1970-01-01T00:00:00.000Z' });
    expect(values[1]).toBe(1e13);
    expect(values[3]).toBe(-1e13);
    expect(values[5]).toEqual({ $type: 'float', value: 'Infinity' });
  });
});
