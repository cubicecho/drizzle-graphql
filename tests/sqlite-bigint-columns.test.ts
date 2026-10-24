// SQLite's two bigint column forms, past what a JS number holds:
// - `blob({ mode: 'bigint' })` stores the value's decimal text in a BLOB. Update arithmetic used
//   to compile to a bare `big = big + ?`, which SQLite evaluates numerically and stores back as an
//   INTEGER the column's decoder cannot read — the row was unreadable after the write committed.
// - `numeric({ mode: 'bigint' })` keeps min/max, but the aggregate selected a bare `max(big)`,
//   so the driver received the raw integer and libsql threw a RangeError past 2^53, although
//   drizzle reads the column itself as `cast(big as text)`.
import { type Client, createClient } from '@libsql/client';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { blob, integer, numeric, sqliteTable } from 'drizzle-orm/sqlite-core';
import { type GraphQLSchema, graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

const Accounts = sqliteTable('accounts', { id: integer('id').primaryKey() });
const Ledgers = sqliteTable('ledgers', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  big: numeric('big', { mode: 'bigint' }).notNull(),
  blobBig: blob('blob_big', { mode: 'bigint' }),
});
const tables = { Accounts, Ledgers };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Accounts: { ledgers: r.many.Ledgers({ from: r.Accounts.id, to: r.Ledgers.accountId }) },
});

let client: Client;
let db: any;
let schema: GraphQLSchema;

const run = async (source: string, variableValues?: Record<string, any>) => {
  const result = await graphql({ schema, source, variableValues, contextValue: {} });
  // A driver error reaches the client masked; the innermost original carries SQLite's own message.
  const innermost = (error: any): string => {
    const inner = error.originalError ?? error.cause;
    return inner ? innermost(inner) : error.message;
  };
  return { data: result.data as any, errors: result.errors?.map(innermost) };
};

const blobOf = async (id: number) => {
  const { rows } = await client.execute(
    `select typeof(blob_big) as t, cast(blob_big as text) as v from ledgers where id = ${id}`,
  );
  return { type: rows[0]!['t'], text: rows[0]!['v'] };
};

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = (drizzle as any)({ client, relations });
  await db.run(sql`CREATE TABLE accounts (id integer PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE ledgers (id integer PRIMARY KEY, account_id integer NOT NULL, big numeric NOT NULL, blob_big blob)`,
  );
  schema = buildSchema(db, { features: { fieldUpdateOperations: true } }).schema;
});

afterAll(() => client?.close());

beforeEach(async () => {
  await db.run(sql`DELETE FROM ledgers`);
  await db.run(sql`DELETE FROM accounts`);
  await db.insert(Accounts).values([{ id: 1 }]);
  await db.insert(Ledgers).values([
    { id: 1, accountId: 1, big: 9007199254740993n, blobBig: 10n },
    { id: 2, accountId: 1, big: 5n, blobBig: 9007199254740993n },
    { id: 3, accountId: 1, big: 7n, blobBig: null },
    { id: 4, accountId: 1, big: 8n, blobBig: 9223372036854775807n },
  ]);
});

const updateBlob = (id: number, operation: string) =>
  run(`mutation { updateLedgers(where: { id: { eq: ${id} } }, set: { blobBig: { ${operation} } }) { id blobBig } }`);

describe('sqlite: arithmetic on a blob bigint column', () => {
  it('increment keeps the row readable and the value a bigint blob', async () => {
    const res = await updateBlob(1, 'increment: "1"');
    expect(res.errors).toBeUndefined();
    expect(res.data.updateLedgers).toEqual([{ id: 1, blobBig: '11' }]);
    expect(await blobOf(1)).toEqual({ type: 'blob', text: '11' });

    const read = await run('{ ledgers(where: { blobBig: { eq: "11" } }) { id blobBig } }');
    expect(read.errors).toBeUndefined();
    expect(read.data.ledgers).toEqual([{ id: 1, blobBig: '11' }]);
  });

  it('every operation is exact past 2^53', async () => {
    const cases: [string, string][] = [
      ['increment: "1"', '9007199254740994'],
      ['decrement: "4"', '9007199254740989'],
      ['multiply: "3"', '27021597764222979'],
      ['divide: "2"', '4503599627370496'],
      ['increment: "-9007199254740994"', '-1'],
    ];
    for (const [operation, expected] of cases) {
      await db.update(Ledgers).set({ blobBig: 9007199254740993n }).where(sql`id = 2`);
      const res = await updateBlob(2, operation);
      expect(res.errors, operation).toBeUndefined();
      expect(res.data.updateLedgers, operation).toEqual([{ id: 2, blobBig: expected }]);
      expect(await blobOf(2), operation).toEqual({ type: 'blob', text: expected });
    }
  });

  it('leaves a NULL as NULL', async () => {
    const res = await updateBlob(3, 'increment: "1"');
    expect(res.errors).toBeUndefined();
    expect(res.data.updateLedgers).toEqual([{ id: 3, blobBig: null }]);
  });

  it('raises on overflow and on division by zero, leaving the row as it was', async () => {
    const overflow = await updateBlob(4, 'increment: "1"');
    expect(overflow.errors?.[0]).toMatch(/overflow/i);
    expect(await blobOf(4)).toEqual({ type: 'blob', text: '9223372036854775807' });

    const byZero = await updateBlob(1, 'divide: "0"');
    expect(byZero.errors?.[0]).toMatch(/division by zero/i);
    expect(await blobOf(1)).toEqual({ type: 'blob', text: '10' });
  });
});

describe('sqlite: min/max over a numeric bigint column past 2^53', () => {
  it('root aggregate', async () => {
    const res = await run('{ ledgersAggregate { count min { big } max { big } } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.ledgersAggregate).toEqual({ count: 4, min: { big: '5' }, max: { big: '9007199254740993' } });
  });

  it('relation aggregate', async () => {
    const res = await run('{ accounts { ledgersAggregate { max { big } } } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.accounts[0].ledgersAggregate.max.big).toBe('9007199254740993');
  });

  it('groupBy aggregates', async () => {
    const res = await run('{ ledgersGroupBy(groupBy: [accountId]) { group { accountId } max { big } min { big } } }');
    expect(res.errors).toBeUndefined();
    expect(res.data.ledgersGroupBy).toEqual([
      { group: { accountId: 1 }, max: { big: '9007199254740993' }, min: { big: '5' } },
    ]);
  });
});
