// Unit tests for the column extractors. A selection that names no column of its own — a
// `__typename`-only query, or one that asks for relation fields only — still has to produce a
// column for the statement to select, and which one it picks matters: a handful of SQLite
// column types crash the relational query builder when they are the only column selected.

import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { extractSelectedColumnsFromTree, extractSelectedColumnsFromTreeSQLFormat } from '@/util/builders/common';
import type { ResolveTree } from '@/util/parse-resolve-info';

/** A table whose first column is one the relational query builder cannot stand alone. */
const CrashFirst = sqliteTable('crash_first', {
  blobBigInt: blob('blob_bigint', { mode: 'bigint' }),
  id: integer('id').primaryKey(),
  name: text('name'),
});

/** A table with nothing but crash-prone columns — the fallback has no safe choice to make. */
const AllCrash = sqliteTable('all_crash', {
  blobBigInt: blob('blob_bigint', { mode: 'bigint' }),
  blobJson: blob('blob_json', { mode: 'json' }),
});

const Plain = sqliteTable('plain', {
  id: integer('id').primaryKey(),
  name: text('name'),
});

const field = (name: string): ResolveTree => ({ name, alias: name, args: {}, fieldsByTypeName: {} });

describe('extractSelectedColumnsFromTree', () => {
  it('returns the columns the selection names', () => {
    expect(extractSelectedColumnsFromTree({ name: field('name') }, Plain)).toStrictEqual({ name: true });
  });

  it('ignores fields that are not columns', () => {
    expect(extractSelectedColumnsFromTree({ posts: field('posts') }, Plain)).toStrictEqual({ id: true });
  });

  it('skips a crash-prone column when falling back', () => {
    // The empty selection is what a `__typename`-only query produces.
    expect(extractSelectedColumnsFromTree({}, CrashFirst)).toStrictEqual({ id: true });
  });

  it('falls back to the first column when every column is crash-prone', () => {
    expect(extractSelectedColumnsFromTree({}, AllCrash)).toStrictEqual({ blobBigInt: true });
  });
});

describe('extractSelectedColumnsFromTreeSQLFormat', () => {
  it('returns the same columns as the map form, as column objects', () => {
    const selected = extractSelectedColumnsFromTreeSQLFormat({ name: field('name') }, Plain);

    expect(Object.keys(selected)).toStrictEqual(['name']);
    expect(selected['name']).toBe(Plain.name);
  });

  it('skips a crash-prone column when falling back', () => {
    const selected = extractSelectedColumnsFromTreeSQLFormat({}, CrashFirst);

    expect(Object.keys(selected)).toStrictEqual(['id']);
    expect(selected['id']).toBe(CrashFirst.id);
  });
});
