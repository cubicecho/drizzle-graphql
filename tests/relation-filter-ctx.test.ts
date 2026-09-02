// `relationFilterCtx` is called several times per parent row on the lazy relation path, and
// the object it returns carries the build's whole table and relation maps. These pin that it
// is handed out rather than rebuilt, and that two builds never share one.

import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { type RelationFilterBase, relationFilterCtx } from '@/util/builders/common';

const Users = pgTable('users', { id: integer('id').primaryKey(), name: text('name') });

const baseFor = (): RelationFilterBase => ({ tables: { Users }, relationMap: {}, uniqueKeys: {} });

describe('relationFilterCtx', () => {
  it('returns the same context for the same base and table', () => {
    const base = baseFor();

    expect(relationFilterCtx(base, 'Users')).toBe(relationFilterCtx(base, 'Users'));
  });

  it('narrows to the table it was asked for', () => {
    const base = baseFor();
    const users = relationFilterCtx(base, 'Users');

    expect(users?.tableKey).toBe('Users');
    expect(users?.tables).toBe(base.tables);
    expect(relationFilterCtx(base, 'Posts')).not.toBe(users);
  });

  it('keeps separate builds apart', () => {
    expect(relationFilterCtx(baseFor(), 'Users')).not.toBe(relationFilterCtx(baseFor(), 'Users'));
  });

  it('has nothing to narrow without a base', () => {
    expect(relationFilterCtx(undefined, 'Users')).toBeUndefined();
  });
});
