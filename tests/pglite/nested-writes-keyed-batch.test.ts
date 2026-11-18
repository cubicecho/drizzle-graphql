import { PGlite } from '@electric-sql/pglite';
import { buildRelations, createRelationsHelper, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, serial, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema } from '@/index';

// Issue #223: a batch insert or upsert whose entries all supply their primary key writes every
// parent in one statement and every relation's `create` rows in another, matching the returned
// parents back to their entries by that key rather than by position. These pin that the
// statement count stops growing with the batch, that each child lands on its own entry's
// parent whatever order the entries come in, and that anything the keyed batch cannot prove
// correct falls back to one write per entry with the same outcome.

const Authors = pgTable('authors', { id: text('id').primaryKey(), name: text('name').notNull() });
const Books = pgTable('books', {
  id: serial('id').primaryKey(),
  authorId: text('author_id').notNull(),
  title: text('title').notNull(),
});
// A to-one whose key is on the child, nullable: attaching one detaches whatever was there.
const Bios = pgTable('bios', {
  id: serial('id').primaryKey(),
  authorId: text('author_id').unique(),
  body: text('body'),
});
// A composite primary key; its relation joins on a single unique column.
const Shelves = pgTable(
  'shelves',
  { room: text('room').notNull(), slot: integer('slot').notNull(), code: text('code').notNull().unique() },
  (t) => [primaryKey({ columns: [t.room, t.slot] })],
);
const Items = pgTable('items', {
  id: serial('id').primaryKey(),
  shelfCode: text('shelf_code').notNull(),
  name: text('name').notNull(),
});
// A uuid key, which PostgreSQL normalizes: an upper-case key comes back lower-case.
const Boxes = pgTable('boxes', { id: uuid('id').primaryKey().defaultRandom(), label: text('label').notNull() });
const Parts = pgTable('parts', { id: serial('id').primaryKey(), boxId: uuid('box_id').notNull(), name: text('name') });

const tables = { Authors, Books, Bios, Shelves, Items, Boxes, Parts };
const r = createRelationsHelper(tables);
const relations = buildRelations(tables, {
  Authors: {
    books: r.many.Books({ from: r.Authors.id, to: r.Books.authorId }),
    bio: r.one.Bios({ from: r.Authors.id, to: r.Bios.authorId }),
  },
  Shelves: { items: r.many.Items({ from: r.Shelves.code, to: r.Items.shelfCode }) },
  Boxes: { parts: r.many.Parts({ from: r.Boxes.id, to: r.Parts.boxId }) },
});

let db: any;
let queries: string[] = [];
beforeAll(async () => {
  db = (drizzle as any)({
    client: new PGlite(),
    relations,
    logger: { logQuery: (query: string) => queries.push(query) },
  });
  await db.execute(sql`create table authors (id text primary key, name text not null)`);
  await db.execute(
    sql`create table books (id serial primary key, author_id text not null references authors(id), title text not null check (title <> 'bad'))`,
  );
  await db.execute(sql`create table bios (id serial primary key, author_id text unique, body text)`);
  await db.execute(
    sql`create table shelves (room text not null, slot integer not null, code text not null unique, primary key (room, slot))`,
  );
  await db.execute(sql`create table items (id serial primary key, shelf_code text not null, name text not null)`);
  await db.execute(sql`create table boxes (id uuid primary key default gen_random_uuid(), label text not null)`);
  await db.execute(sql`create table parts (id serial primary key, box_id uuid not null, name text)`);
});
afterAll(async () => {
  await db.$client.close();
});
beforeEach(async () => {
  await db.execute(sql`truncate authors, books, bios, shelves, items, boxes, parts restart identity`);
});

const run = async (source: string, config: Record<string, any> = {}) => {
  const schema = buildSchema(db, { features: { nestedWrites: true, upsert: true }, ...config }).schema;
  queries = [];
  const result = await graphql({ schema, source, contextValue: {} });
  return { ...result, statements: queries.length };
};

/** One author per key, in the order given, each creating two books. */
const authorEntries = (ids: string[]) =>
  ids
    .map((id) => `{ id: "${id}", name: "n-${id}", books: { create: [{ title: "${id}-1" }, { title: "${id}-2" }] } }`)
    .join(', ');
const ids = (count: number) => Array.from({ length: count }, (_, index) => `a${index}`);

// Walk to the driver's own message under the masked "Internal server error".
const rootMessage = (e: any): string =>
  e?.cause ? rootMessage(e.cause) : e?.originalError ? rootMessage(e.originalError) : e?.message;

/** Whether the last run kept its keyed attempt: its savepoint was released, not rolled back. */
const batched = () => queries.includes('release savepoint sp1') && !queries.includes('rollback to savepoint sp1');
/** Whether the last run's keyed attempt was rolled back and the entries written one at a time. */
const fellBack = () => queries.includes('rollback to savepoint sp1');

/** The list a mutation field returned, or `[]` when it returned none. */
const listOf = (result: { data?: Record<string, any> | null }, field: string): any[] => result.data?.[field] ?? [];

const booksByAuthor = async () => {
  const rows = await db.select().from(Books).orderBy(Books.id);
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    grouped[row.authorId] = [...(grouped[row.authorId] ?? []), row.title];
  }
  return grouped;
};

describe.sequential('keyed nested-write batches', () => {
  it('writes a batch in a number of statements that does not grow with its entries', async () => {
    const few = await run(`mutation { createAuthors(values: [${authorEntries(ids(3))}]) { id } }`);
    expect(few.errors).toBeUndefined();
    await db.execute(sql`truncate authors, books restart identity`);
    const many = await run(`mutation { createAuthors(values: [${authorEntries(ids(20))}]) { id } }`);
    expect(many.errors).toBeUndefined();
    // A savepoint around one insert of every author and one of every book, where one write per
    // entry ran an author insert and a book insert for each.
    expect(queries).toEqual([
      'savepoint sp1',
      expect.stringMatching(/^insert into "authors"/),
      expect.stringMatching(/^insert into "books"/),
      'release savepoint sp1',
    ]);
    expect(few.statements).toBe(many.statements);
    expect(Object.keys(await booksByAuthor())).toHaveLength(20);
  });

  it('attaches each entry’s children to its own parent, and returns the entries in input order', async () => {
    // Neither sorted nor reverse-sorted, so no natural order of the keys lines up with it.
    const order = ['m', 'c', 'x', 'a', 'q', 'b'];
    const res = await run(`mutation { createAuthors(values: [${authorEntries(order)}]) { id name books { title } } }`);
    expect(res.errors).toBeUndefined();
    expect(listOf(res, 'createAuthors').map((author) => author.id)).toEqual(order);
    for (const author of listOf(res, 'createAuthors')) {
      expect(author.name).toBe(`n-${author.id}`);
      expect(author.books.map((book: any) => book.title).sort()).toEqual([`${author.id}-1`, `${author.id}-2`]);
    }
    const grouped = await booksByAuthor();
    for (const id of order) {
      expect(grouped[id]).toEqual([`${id}-1`, `${id}-2`]);
    }
  });

  it('falls back to one write per entry when an entry leaves its primary key out', async () => {
    const boxes = (count: number) =>
      Array.from({ length: count }, (_, index) => {
        // The first entry leaves its key to the column default.
        const key = index === 0 ? '' : `id: "00000000-0000-0000-0000-00000000000${index}", `;
        return `{ ${key}label: "b${index}", parts: { create: [{ name: "p${index}" }] } }`;
      }).join(', ');
    const few = await run(`mutation { createBoxes(values: [${boxes(2)}]) { id label parts { name } } }`);
    expect(few.errors).toBeUndefined();
    await db.execute(sql`truncate boxes, parts restart identity`);
    const many = await run(`mutation { createBoxes(values: [${boxes(5)}]) { id label parts { name } } }`);
    expect(many.errors).toBeUndefined();
    // Not even attempted: the keyless entry leaves nothing to match its row by.
    expect(queries).not.toContain('savepoint sp1');
    expect(many.statements).toBeGreaterThan(few.statements);
    expect(listOf(many, 'createBoxes').map((box) => box.label)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    for (const box of listOf(many, 'createBoxes')) {
      expect(box.parts).toEqual([{ name: box.label.replace('b', 'p') }]);
    }
  });

  it('falls back when the database hands a key back in another form than it was given', async () => {
    const upper = ['B', 'A', 'C'].map((digit) => `${digit.repeat(8)}-0000-0000-0000-000000000000`);
    const entries = upper.map((id) => `{ id: "${id}", label: "${id}", parts: { create: [{ name: "${id}" }] } }`);
    const res = await run(`mutation { createBoxes(values: [${entries.join(', ')}]) { id label } }`);
    expect(res.errors).toBeUndefined();
    // The keyed attempt's insert in its savepoint, rolled back, then one insert of a box and one
    // of its part per entry.
    expect(queries.slice(0, 3)).toEqual([
      'savepoint sp1',
      expect.stringMatching(/^insert into "boxes"/),
      'rollback to savepoint sp1',
    ]);
    expect(res.statements).toBe(3 + 2 * upper.length);
    expect(listOf(res, 'createBoxes').map((box) => box.label)).toEqual(upper);
    const parts = await db.select().from(Parts).orderBy(Parts.id);
    expect(parts.map((part: any) => [part.boxId.toUpperCase(), part.name])).toEqual(upper.map((id) => [id, id]));
  });

  it('batches a to-one create, detaching what each parent held', async () => {
    await db.insert(Authors).values({ id: 'held', name: 'h' });
    await db.insert(Bios).values({ authorId: 'held', body: 'old' });
    const res = await run(
      `mutation { upsertAuthors(values: [{ id: "new", name: "n", bio: { create: { body: "fresh" } } }, { id: "held", name: "h2", bio: { create: { body: "replaced" } } }]) { id name bio { body } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(batched()).toBe(true);
    expect(res.data?.['upsertAuthors']).toEqual([
      { id: 'new', name: 'n', bio: { body: 'fresh' } },
      { id: 'held', name: 'h2', bio: { body: 'replaced' } },
    ]);
    const bios = await db.select().from(Bios).orderBy(Bios.id);
    expect(bios.map((bio: any) => [bio.authorId, bio.body])).toEqual([
      [null, 'old'],
      ['new', 'fresh'],
      ['held', 'replaced'],
    ]);
  });

  it('batches an upsert, attaching to the rows that already existed', async () => {
    await db.insert(Authors).values([
      { id: 'b', name: 'old-b' },
      { id: 'd', name: 'old-d' },
    ]);
    const order = ['d', 'a', 'b', 'c'];
    const res = await run(`mutation { upsertAuthors(values: [${authorEntries(order)}]) { id name } }`);
    expect(res.errors).toBeUndefined();
    expect(batched()).toBe(true);
    expect(res.data?.['upsertAuthors']).toEqual(order.map((id) => ({ id, name: `n-${id}` })));
    const grouped = await booksByAuthor();
    for (const id of order) {
      expect(grouped[id]).toEqual([`${id}-1`, `${id}-2`]);
    }

    // Twice the entries, the same statements.
    const before = res.statements;
    await db.execute(sql`truncate authors, books restart identity`);
    const doubled = await run(
      `mutation { upsertAuthors(values: [${authorEntries([...order, 'e', 'f', 'g', 'h'])}]) { id name } }`,
    );
    expect(doubled.errors).toBeUndefined();
    expect(doubled.statements).toBe(before);
  });

  it('leaves an entry whose upsert wrote no row without children, as one write per entry does', async () => {
    await db.insert(Authors).values({ id: 'kept', name: 'k' });
    const res = await run(
      `mutation { upsertAuthors(values: [${authorEntries(['fresh', 'kept'])}], onConflict: { action: NOTHING }) { id } }`,
    );
    expect(res.errors).toBeUndefined();
    // `kept` came back with no row, so the rows cannot be matched one to one.
    expect(fellBack()).toBe(true);
    expect(res.data?.['upsertAuthors']).toEqual([{ id: 'fresh' }]);
    expect(await booksByAuthor()).toEqual({ fresh: ['fresh-1', 'fresh-2'] });
  });

  it('matches a composite primary key', async () => {
    const shelf = (room: string, slot: number) =>
      `{ room: "${room}", slot: ${slot}, code: "${room}${slot}", items: { create: [{ name: "on-${room}${slot}" }] } }`;
    const res = await run(
      `mutation { createShelves(values: [${[shelf('b', 2), shelf('a', 2), shelf('b', 1), shelf('a', 1)].join(', ')}]) { code items { name } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(batched()).toBe(true);
    expect(res.data?.['createShelves']).toEqual(
      ['b2', 'a2', 'b1', 'a1'].map((code) => ({ code, items: [{ name: `on-${code}` }] })),
    );
    const items = await db.select().from(Items).orderBy(Items.id);
    expect(items.map((item: any) => [item.shelfCode, item.name])).toEqual(
      ['b2', 'a2', 'b1', 'a1'].map((code) => [code, `on-${code}`]),
    );
  });

  it('reports a failing statement as one write per entry would, and writes nothing', async () => {
    // A child the second entry creates breaks a check constraint.
    const badChild = await run(
      `mutation { createAuthors(values: [{ id: "a", name: "a", books: { create: [{ title: "ok" }] } }, { id: "b", name: "b", books: { create: [{ title: "bad" }] } }]) { id } }`,
    );
    expect(rootMessage(badChild.errors?.[0])).toMatch(/books_title_check/);
    // The error is the one the per-entry writes raise, after the attempt was rolled back.
    expect(fellBack()).toBe(true);
    // Two entries share a key, which one multi-row statement could not tell apart.
    const sharedKey = await run(
      `mutation { createAuthors(values: [{ id: "a", name: "a", books: { create: [{ title: "ok" }] } }, { id: "a", name: "again", books: { create: [{ title: "dup" }] } }]) { id } }`,
    );
    expect(rootMessage(sharedKey.errors?.[0])).toMatch(/authors_pkey/);
    expect(await db.select().from(Authors)).toEqual([]);
    expect(await db.select().from(Books)).toEqual([]);
  });

  it('keeps one write per entry when the child table has an onWrite hook, so it is called per entry', async () => {
    const calls: string[] = [];
    const hook = { after: (payload: any) => void calls.push(payload.rows.map((row: any) => row.authorId).join(',')) };
    const res = await run(`mutation { createAuthors(values: [${authorEntries(['y', 'z'])}]) { id } }`, {
      onWrite: { Books: hook },
    });
    expect(res.errors).toBeUndefined();
    expect(queries).not.toContain('savepoint sp1');
    expect(calls).toEqual(['y,y', 'z,z']);
  });
});
