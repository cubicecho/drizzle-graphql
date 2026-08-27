// The `exclude` config. Which columns a table hides, and the cache key that keeps two tables
// excluding different columns from sharing a generated type.

import type { Column, Table } from 'drizzle-orm';
import { getColumns } from 'drizzle-orm';

/**
 * Columns this build keeps out of the generated schema, keyed by the table object.
 *
 * A registry rather than a threaded parameter because the sites that decide schema shape —
 * the object type, every input, the filter, `orderBy`, the aggregates, the column enums —
 * are spread across four files and reach a table with no config in hand. Runtime code keeps
 * calling `getColumns` directly: a primary key that a client cannot name is still the key a
 * cursor is built from, and hiding it there would break pagination rather than secure it.
 *
 * {@link registerColumnExclusions} runs on every build, including with no config, so a
 * second build against the same table objects never inherits the first build's exclusions.
 */
const excludedColumnRegistry = new WeakMap<object, Set<string>>();

/** Installs this build's column exclusions and clears any left by a previous build. */
export const registerColumnExclusions = (
  tables: Record<string, Table>,
  exclude?: { columns?: Record<string, string[]> },
): void => {
  for (const [tableName, table] of Object.entries(tables)) {
    const hidden = exclude?.columns?.[tableName];
    if (hidden?.length) {
      excludedColumnRegistry.set(table, new Set(hidden));
    } else {
      excludedColumnRegistry.delete(table);
    }
  }
};

/** Whether any column of this table was excluded from the schema. */
export const hasExcludedColumns = (table: Table): boolean => excludedColumnRegistry.has(table);

/**
 * A stable string naming this build's exclusions for `table`, empty when it has none. Used to
 * key the caches that hold generated types: two builds of the same table objects with
 * different exclusions must not share an entry, but *within* one build every call site has to
 * get the same instance back or the schema ends up with two types of the same name.
 */
export const excludedColumnsKey = (table: Table): string => {
  const hidden = excludedColumnRegistry.get(table);
  return hidden ? [...hidden].sort().join(',') : '';
};

/**
 * The columns of `table` that this build exposes — every column unless some were excluded.
 * Use this anywhere the result decides what the *schema* contains; use `getColumns` where it
 * decides what SQL to write.
 */
export const visibleColumns = (table: Table): Record<string, Column> => {
  const columns = getColumns(table);
  const hidden = excludedColumnRegistry.get(table);
  if (!hidden) {
    return columns;
  }
  return Object.fromEntries(Object.entries(columns).filter(([columnName]) => !hidden.has(columnName)));
};
