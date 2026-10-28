// The `exclude` config. Which columns a table hides, and the cache key that keeps two tables
// excluding different columns from sharing a generated type.

import type { Column, Table } from 'drizzle-orm';
import { getColumns } from 'drizzle-orm';

/**
 * Columns one build keeps out of the generated schema, keyed by the table object. Part of the
 * build's `BuildRegistries`, created by {@link createColumnExclusions}.
 *
 * Looked up rather than threaded as config because the sites that decide schema shape — the
 * object type, every input, the filter, `orderBy`, the aggregates, the column enums — are spread
 * across four files and reach a table with only the build's registries in hand. Runtime code
 * keeps calling `getColumns` directly: a primary key that a client cannot name is still the key
 * a cursor is built from, and hiding it there would break pagination rather than secure it.
 */
export type ColumnExclusions = WeakMap<object, Set<string>>;

/** One build's column exclusions, from its `exclude.columns` config. */
export const createColumnExclusions = (
  tables: Record<string, Table>,
  exclude?: { columns?: Record<string, string[]> },
): ColumnExclusions => {
  const exclusions: ColumnExclusions = new WeakMap();
  for (const [tableName, table] of Object.entries(tables)) {
    const hidden = exclude?.columns?.[tableName];
    if (hidden?.length) {
      exclusions.set(table, new Set(hidden));
    }
  }
  return exclusions;
};

/** Whether the build excluded any column of this table from the schema. */
export const hasExcludedColumns = (exclusions: ColumnExclusions, table: Table): boolean => exclusions.has(table);

/**
 * A stable string naming the build's exclusions for `table`, empty when it has none. Used to
 * key the caches that hold generated types: two builds of the same table objects with
 * different exclusions must not share an entry, but *within* one build every call site has to
 * get the same instance back or the schema ends up with two types of the same name.
 */
export const excludedColumnsKey = (exclusions: ColumnExclusions, table: Table): string => {
  const hidden = exclusions.get(table);
  return hidden ? [...hidden].sort().join(',') : '';
};

/**
 * The columns of `table` that the build exposes — every column unless some were excluded.
 * Use this anywhere the result decides what the *schema* contains; use `getColumns` where it
 * decides what SQL to write.
 */
export const visibleColumns = (exclusions: ColumnExclusions, table: Table): Record<string, Column> => {
  const columns = getColumns(table);
  const hidden = exclusions.get(table);
  if (!hidden) {
    return columns;
  }
  return Object.fromEntries(Object.entries(columns).filter(([columnName]) => !hidden.has(columnName)));
};
