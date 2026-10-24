import { PGlite } from '@electric-sql/pglite';
import { buildRelations, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, serial, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { graphql } from 'graphql';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, identifyRows } from '@/index';

// identifyRows must only report `complete` when the filter really pins every key column to a
// non-null equality. A null operand compiles to no condition at all, and a second operator on a
// key column can narrow the match away — either way the rows written are not the rows named.

const Posts = pgTable('posts', { id: serial('id').primaryKey(), title: text('title').notNull() });
const Links = pgTable('links', { a: integer('a').notNull(), b: integer('b').notNull(), note: text('note') }, (t) => [
  primaryKey({ columns: [t.a, t.b] }),
]);
const tables = { Posts, Links };
const relations = buildRelations(tables, {});

let db: any;
beforeAll(async () => {
  db = (drizzle as any)({ client: new PGlite(), relations });
  await db.execute(sql`create table posts (id serial primary key, title text not null)`);
  await db.execute(sql`create table links (a int not null, b int not null, note text, primary key (a, b))`);
});
beforeEach(async () => {
  await db.execute(sql`truncate posts, links restart identity`);
  await db.execute(sql`insert into posts (title) values ('a'), ('b'), ('c')`);
  await db.execute(sql`insert into links (a, b) values (1, 1), (1, 2), (2, 1)`);
});

/** Runs a mutation and returns what identifyRows said about it next to what it wrote. */
const runIdentified = async (source: string, variableValues: Record<string, unknown> = {}) => {
  let identified: any;
  const { schema } = buildSchema(db, {
    features: { countMutations: true },
    onWrite: {
      before: ({ info, args }) => {
        identified = identifyRows(info.parentType.getFields()[info.fieldName], args);
      },
    },
  });
  const res = await graphql({ schema, source, variableValues, contextValue: {} });
  expect(res.errors).toBeUndefined();
  return { data: res.data as any, identified };
};

describe('identifyRows against the rows a write reaches', () => {
  it('a null single-key operand names no rows', async () => {
    const { data, identified } = await runIdentified(
      'mutation ($id: Int) { updatePostsCount(where: { id: { eq: $id } }, set: { title: "x" }) }',
      { id: null },
    );
    expect(data.updatePostsCount).toBe(3);
    expect(identified).toMatchObject({ rows: [], complete: false });
  });

  it('a null operand on one column of a composite key names no rows', async () => {
    const { data, identified } = await runIdentified(
      'mutation ($b: Int) { deleteLinks(where: { a: { eq: 1 }, b: { eq: $b } }) { a b } }',
      { b: null },
    );
    expect(data.deleteLinks).toHaveLength(2);
    expect(identified).toMatchObject({ rows: [], complete: false });
  });

  it('a second operator on a composite key column is not a complete key', async () => {
    const { data, identified } = await runIdentified(
      'mutation { deleteLinks(where: { a: { eq: 2, ne: 2 }, b: { eq: 1 } }) { a b } }',
    );
    expect(data.deleteLinks).toHaveLength(0);
    expect(identified).toMatchObject({ rows: [{ a: 2, b: 1 }], complete: false });
  });

  it('an equality on every composite key column is complete', async () => {
    const { data, identified } = await runIdentified(
      'mutation { deleteLinks(where: { a: { eq: 2 }, b: { eq: 1 } }) { a b } }',
    );
    expect(data.deleteLinks).toEqual([{ a: 2, b: 1 }]);
    expect(identified).toMatchObject({ rows: [{ a: 2, b: 1 }], complete: true });
  });
});
