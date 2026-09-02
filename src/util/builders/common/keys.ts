// Primary keys and unique column sets, read off a table however its dialect stores them.

import type { Table } from 'drizzle-orm';
import { asc, getColumns } from 'drizzle-orm';
import { visibleColumns } from './exclusions.ts';

/**
 * Returns the property names of a table's primary key column(s).
 *
 * drizzle-orm marks inline `.primaryKey()` columns with `column.primary === true`,
 * but table-level composite keys (`primaryKey({ columns })`) leave `column.primary`
 * false on each member — those are only visible via the per-dialect `getTableConfig`.
 * Dialect builders pass the composite members' DB column names in via
 * `compositePkColumnNames`; we map them back to property names here.
 *
 * Resolution order: inline PK columns → composite PK columns → empty. We deliberately
 * do NOT guess a column named `id`: if no real primary key is declared, returning empty
 * lets callers fall back to the batch loader rather than re-keying on a possibly
 * non-unique column.
 */
export const getPrimaryKeyPropNames = (table: Table, compositePkColumnNames?: readonly string[]): string[] => {
  const cols = getColumns(table);
  const entries = Object.entries(cols);

  // Inline single `.primaryKey()` columns.
  const inlinePks = entries.filter(([, c]) => (c as any).primary).map(([k]) => k);
  if (inlinePks.length) {
    return inlinePks;
  }

  // Composite primary key (DB column names supplied by the dialect builder).
  if (compositePkColumnNames?.length) {
    const wanted = new Set(compositePkColumnNames);
    const fromComposite = entries.filter(([, c]) => wanted.has((c as any).name)).map(([k]) => k);
    if (fromComposite.length) {
      return fromComposite;
    }
  }

  // No declared primary key — let the caller fall back to the batch loader.
  return [];
};

/**
 * Ensures a selected-columns map (SQL format: prop name → Column) includes the table's
 * primary-key columns. Mutation resolvers pass their RETURNING columns through this so
 * the eager-loader can re-key rows by PK even when the client didn't select it. Mutates
 * and returns the same map.
 */
export const withPrimaryKeyColumns = <T extends Record<string, any>>(
  columns: T,
  table: Table,
  pkNames: readonly string[],
): T => {
  const allCols = getColumns(table);
  for (const pk of pkNames) {
    if (!(pk in columns) && allCols[pk]) {
      (columns as any)[pk] = allCols[pk];
    }
  }
  return columns;
};

/**
 * Wraps a dialect's `getTableConfig` in a per-table cache.
 *
 * The dialect implementations are not lookups: each call re-runs the table's
 * `extraConfigBuilder` and rebuilds every index, check, unique constraint, primary key and
 * foreign key it declares. Nothing about a table changes after it is defined, so the result
 * is the same every time — but a build asks for it many times per table (primary-key names,
 * unique column sets, conflict targets, one per relation that keys off the target's PK), and
 * an overriding resolver asks again at request time.
 *
 * The cache is a `WeakMap` on the table object, so it costs nothing once the table is gone.
 * Bind it once per dialect module, at module scope, so the cache outlives a single
 * `buildSchema` call.
 */
export const memoizeTableConfig = <TTable extends Table, TConfig>(
  getTableConfig: (table: TTable) => TConfig,
): ((table: TTable) => TConfig) => {
  const cache = new WeakMap<TTable, TConfig>();
  return (table: TTable): TConfig => {
    let config = cache.get(table);
    if (config === undefined) {
      config = getTableConfig(table);
      cache.set(table, config);
    }
    return config;
  };
};

/**
 * Resolves a table's primary-key property names using a dialect's `getTableConfig` to
 * surface table-level composite keys (whose member columns aren't flagged `.primary`).
 * Each dialect builder binds this with its own getTableConfig and reuses the binding for
 * both relation pagination and mutation re-fetch keying.
 */
export const getPrimaryKeyPropNamesFromConfig = <TTable extends Table>(
  table: TTable,
  getTableConfig: (table: TTable) => { primaryKeys: { columns: { name: string }[] }[] },
): string[] => {
  const compositePkColumnNames = getTableConfig(table).primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));
  return getPrimaryKeyPropNames(table, compositePkColumnNames);
};

/**
 * Ascending order expressions for a table's primary key — the deterministic tiebreak for
 * paginated relations. Shared by the window-function batch path and the eager `with:`
 * orderBy default so both order identically. `table` may be the aliased RQB proxy.
 */
export const primaryKeyOrderExprs = (table: Table, pkNames: readonly string[]): any[] => {
  const cols = getColumns(table);
  return pkNames
    .map((n) => cols[n])
    .filter(Boolean)
    .map((col) => asc(col!));
};

// ── cursor (keyset) pagination ───────────────────────────────────────────────

/**
 * Every set of columns that uniquely identifies a row of `table`: the primary key first,
 * then each unique constraint and unique index, then each column declared `.unique()`
 * inline. Sets are property names (what GraphQL inputs use), not database column names.
 *
 * `getTableConfig` is the dialect's own — the three dialects expose the same
 * `{ primaryKeys, uniqueConstraints, indexes }` shape but from different modules, so the
 * caller passes theirs in, as `getPrimaryKeyPropNamesFromConfig` does.
 *
 * Index entries whose columns are SQL expressions rather than plain columns are skipped:
 * an expression index is a valid conflict target in the database but cannot be named by a
 * column enum. Deduplicated, order-insensitive — a column that is both the primary key and
 * a unique constraint yields one set.
 */
export const getUniqueColumnSets = <TTable extends Table>(
  table: TTable,
  getTableConfig: (table: TTable) => {
    primaryKeys: { columns: { name: string }[] }[];
    uniqueConstraints?: { columns: { name: string }[] }[];
    indexes?: { config: { unique?: boolean; columns: any[] } }[];
  },
): string[][] => {
  const cols = visibleColumns(table);
  const propNameByColumnName = new Map(Object.entries(cols).map(([propName, col]) => [(col as any).name, propName]));
  // A set is usable only if every one of its columns maps back to a property on the table.
  const toPropNames = (columnNames: (string | undefined)[]): string[] | undefined => {
    const propNames: string[] = [];
    for (const columnName of columnNames) {
      const propName = columnName === undefined ? undefined : propNameByColumnName.get(columnName);
      if (!propName) {
        return undefined;
      }
      propNames.push(propName);
    }
    return propNames.length ? propNames : undefined;
  };

  const config = getTableConfig(table);
  const candidates: (string[] | undefined)[] = [
    // Inline `.primaryKey()` columns, then table-level `primaryKey({ columns })`.
    Object.entries(cols)
      .filter(([, col]) => (col as any).primary)
      .map(([propName]) => propName),
    ...config.primaryKeys.map((pk) => toPropNames(pk.columns.map((c) => c.name))),
    ...(config.uniqueConstraints ?? []).map((uc) => toPropNames(uc.columns.map((c) => c.name))),
    ...(config.indexes ?? [])
      .filter((index) => index.config.unique)
      .map((index) => toPropNames(index.config.columns.map((c) => (c as any)?.name))),
    ...Object.entries(cols)
      .filter(([, col]) => (col as any).isUnique)
      .map(([propName]) => [propName]),
  ];

  const seen = new Set<string>();
  const sets: string[][] = [];
  for (const set of candidates) {
    if (!set?.length) {
      continue;
    }
    const key = [...set].sort().join(',');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sets.push(set);
  }
  return sets;
};
