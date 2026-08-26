import { sql } from 'drizzle-orm';
import { getTableConfig, integer, pgTable, primaryKey, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { sqliteTable, getTableConfig as sqliteTableConfig, text as sqliteText } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { generateColumnEnum, getUniqueColumnSets } from '@/util/builders/common';

// getUniqueColumnSets takes the dialect's getTableConfig so one implementation serves all
// three; these helpers stand in for what pg.ts / sqlite.ts pass.
const pgUniqueSets = (table: any): string[][] => getUniqueColumnSets(table, getTableConfig as any);
const sqliteUniqueSets = (table: any): string[][] => getUniqueColumnSets(table, sqliteTableConfig as any);

describe('getUniqueColumnSets', () => {
  it('reports an inline primary key', () => {
    const t = pgTable('inline_pk', { id: integer('id').primaryKey(), name: text('name') });
    expect(pgUniqueSets(t)).toEqual([['id']]);
  });

  it('reports a table-level composite primary key by property name', () => {
    const t = pgTable(
      'composite_pk',
      { orgId: integer('org_id').notNull(), userId: integer('user_id').notNull() },
      (cols) => [primaryKey({ columns: [cols.orgId, cols.userId] })],
    );
    expect(pgUniqueSets(t)).toEqual([['orgId', 'userId']]);
  });

  it('reports a table-level unique constraint alongside the primary key', () => {
    const t = pgTable(
      'unique_constraint',
      { id: integer('id').primaryKey(), tenantId: integer('tenant_id').notNull(), email: text('email').notNull() },
      (cols) => [unique('uq_tenant_email').on(cols.tenantId, cols.email)],
    );
    expect(pgUniqueSets(t)).toEqual([['id'], ['tenantId', 'email']]);
  });

  it('reports a unique index and ignores a non-unique one', () => {
    const t = pgTable(
      'unique_index',
      { id: integer('id').primaryKey(), slug: text('slug').notNull(), name: text('name') },
      (cols) => [uniqueIndex('uq_slug').on(cols.slug)],
    );
    expect(pgUniqueSets(t)).toEqual([['id'], ['slug']]);
  });

  it('reports an inline .unique() column', () => {
    const t = pgTable('inline_unique', { id: integer('id').primaryKey(), email: text('email').unique() });
    expect(pgUniqueSets(t)).toEqual([['id'], ['email']]);
  });

  it('deduplicates a column that is unique twice over', () => {
    const t = pgTable(
      'dedup',
      { id: integer('id').primaryKey(), email: text('email').notNull().unique(), other: text('other').notNull() },
      (cols) => [uniqueIndex('uq_email').on(cols.email), unique('uq_pair').on(cols.other, cols.email)],
    );
    // `email` appears via the unique index and the inline flag but is reported once; the
    // (other, email) pair is a different set and survives. Constraints are listed before
    // indexes, which are listed before inline unique columns.
    expect(pgUniqueSets(t)).toEqual([['id'], ['other', 'email'], ['email']]);
  });

  it('skips an expression index, whose columns have no property to name', () => {
    const t = pgTable('expr_index', { id: integer('id').primaryKey(), email: text('email').notNull() }, () => [
      uniqueIndex('uq_lower_email').on(sql`lower(email)`),
    ]);
    expect(pgUniqueSets(t)).toEqual([['id']]);
  });

  it('returns nothing when the table declares no unique columns at all', () => {
    const t = pgTable('no_keys', { name: text('name'), value: integer('value') });
    expect(pgUniqueSets(t)).toEqual([]);
  });

  it('works the same way on a sqlite table', () => {
    const t = sqliteTable('sqlite_keys', {
      id: sqliteText('id').primaryKey(),
      email: sqliteText('email').unique(),
    });
    expect(sqliteUniqueSets(t)).toEqual([['id'], ['email']]);
  });
});

describe('generateColumnEnum', () => {
  const table = pgTable('enum_source', {
    id: integer('id').primaryKey(),
    userName: text('user_name').notNull(),
    email: text('email'),
  });

  it('builds an enum of every column property name by default', () => {
    const gqlEnum = generateColumnEnum(table, 'EnumSourceAllColumns', 'All of them');

    expect(gqlEnum?.name).toBe('EnumSourceAllColumns');
    expect(gqlEnum?.description).toBe('All of them');
    // Property names, not database column names.
    expect(gqlEnum?.getValues().map((v) => v.name)).toEqual(['id', 'userName', 'email']);
    expect(gqlEnum?.getValue('userName')?.value).toBe('userName');
  });

  it('filters columns with the predicate', () => {
    const gqlEnum = generateColumnEnum(
      table,
      'EnumSourceNotNull',
      'Only the required ones',
      (column) => column.notNull,
    );

    expect(gqlEnum?.getValues().map((v) => v.name)).toEqual(['id', 'userName']);
  });

  it('returns undefined rather than an empty enum when nothing qualifies', () => {
    expect(generateColumnEnum(table, 'EnumSourceNone', 'Nothing', () => false)).toBeUndefined();
  });

  it('caches per table and enum name', () => {
    const first = generateColumnEnum(table, 'EnumSourceCached', 'Cached');
    const second = generateColumnEnum(table, 'EnumSourceCached', 'Cached');
    const other = generateColumnEnum(table, 'EnumSourceCachedOther', 'A different enum');

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it('does not share a cache entry between two tables', () => {
    const otherTable = pgTable('enum_source_two', { id: integer('id').primaryKey() });
    const forFirst = generateColumnEnum(table, 'SharedName', 'x');
    const forOther = generateColumnEnum(otherTable, 'SharedName', 'x');

    expect(forOther).not.toBe(forFirst);
    expect(forOther?.getValues().map((v) => v.name)).toEqual(['id']);
  });
});
