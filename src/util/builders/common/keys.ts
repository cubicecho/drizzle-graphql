// Primary keys and unique column sets, read off a table however its dialect stores them.

import type { Column, Table } from 'drizzle-orm';
import { asc, getColumns, type SQL } from 'drizzle-orm';
import { type ColumnExclusions, visibleColumns } from './exclusions.ts';

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
 * A unique column set, and the predicate it holds under when it comes from a partial unique
 * index (`uniqueIndex().on(…).where(…)`). `where` is absent for a constraint that covers
 * every row.
 */
export type UniqueTarget = { columns: string[]; where?: SQL };

type UniqueTableConfig = {
  primaryKeys: { columns: { name: string }[] }[];
  uniqueConstraints?: { columns: { name: string }[] }[];
  indexes?: { config: { unique?: boolean; columns: any[]; where?: SQL } }[];
};

/**
 * Every set of columns that is unique on `table`: the primary key first, then each unique
 * constraint and unique index, then each column declared `.unique()` inline. Sets are
 * property names (what GraphQL inputs use), not database column names.
 *
 * `getTableConfig` is the dialect's own — the three dialects expose the same
 * `{ primaryKeys, uniqueConstraints, indexes }` shape but from different modules, so the
 * caller passes theirs in, as `getPrimaryKeyPropNamesFromConfig` does.
 *
 * Index entries whose columns are SQL expressions rather than plain columns are skipped:
 * an expression index is a valid conflict target in the database but cannot be named by a
 * column enum. Deduplicated, order-insensitive — a column that is both the primary key and
 * a unique constraint yields one set, and a set that is unique both outright and under a
 * partial index keeps the outright one.
 *
 * A partial unique index carries its predicate as `where`: it is a conflict target only
 * together with that predicate, and it does not make the set unique across the whole table.
 */
export const getUniqueTargets = <TTable extends Table>(
  exclusions: ColumnExclusions,
  table: TTable,
  getTableConfig: (table: TTable) => UniqueTableConfig,
): UniqueTarget[] => uniqueTargetsOver(table, visibleColumns(exclusions, table), getTableConfig);

/** {@link getUniqueTargets} over the columns given: the visible ones for the schema, all of them for SQL. */
const uniqueTargetsOver = <TTable extends Table>(
  table: TTable,
  cols: Record<string, Column>,
  getTableConfig: (table: TTable) => UniqueTableConfig,
): UniqueTarget[] => {
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
  const whole = (columns: string[] | undefined): UniqueTarget | undefined => (columns ? { columns } : undefined);

  const config = getTableConfig(table);
  const candidates: (UniqueTarget | undefined)[] = [
    // Inline `.primaryKey()` columns, then table-level `primaryKey({ columns })`.
    whole(
      Object.entries(cols)
        .filter(([, col]) => (col as any).primary)
        .map(([propName]) => propName),
    ),
    ...config.primaryKeys.map((pk) => whole(toPropNames(pk.columns.map((c) => c.name)))),
    ...(config.uniqueConstraints ?? []).map((uc) => whole(toPropNames(uc.columns.map((c) => c.name)))),
    ...(config.indexes ?? [])
      .filter((index) => index.config.unique)
      .map((index) => {
        const columns = toPropNames(index.config.columns.map((c) => (c as any)?.name));
        return columns ? { columns, ...(index.config.where ? { where: index.config.where } : {}) } : undefined;
      }),
    ...Object.entries(cols)
      .filter(([, col]) => (col as any).isUnique)
      .map(([propName]) => ({ columns: [propName] })),
  ];

  const byKey = new Map<string, UniqueTarget>();
  for (const candidate of candidates) {
    if (!candidate?.columns.length) {
      continue;
    }
    const key = [...candidate.columns].sort().join(',');
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, candidate);
    } else if (seen.where && !candidate.where) {
      // Whole-table uniqueness wins over a partial index on the same columns: it is the
      // stronger guarantee, and conflicting on it needs no predicate.
      byKey.set(key, { columns: seen.columns });
    }
  }
  return [...byKey.values()];
};

/**
 * The column sets that identify at most one row of `table` — {@link getUniqueTargets}
 * without the partial unique indexes, which only constrain the rows their predicate
 * matches (a soft-deleted duplicate is allowed), and so do not.
 *
 * Pass `{ partial: true }` to keep them, for callers that only need to know a set is
 * unique among the rows that matter.
 */
export const getUniqueColumnSets = <TTable extends Table>(
  exclusions: ColumnExclusions,
  table: TTable,
  getTableConfig: (table: TTable) => UniqueTableConfig,
  options: { partial?: boolean } = {},
): string[][] =>
  getUniqueTargets(exclusions, table, getTableConfig)
    .filter((target) => options.partial || !target.where)
    .map((target) => target.columns);

/**
 * The column sets a `Single` update or delete can pin its write to, in the order it tries them
 * (`mutation-helpers.narrowToSingleMatch` uses the first whose values on the checked row are all
 * non-null):
 *
 * - the primary key, when there is one;
 * - otherwise the first unique set whose columns are all NOT NULL, which always names one row;
 * - otherwise every unique set, since one with a nullable column still names one row when the
 *   checked row holds a value in each of its columns. NULLs never collide in a unique
 *   constraint, so a NULL names no row and `IS NULL` would match every row holding one.
 *
 * Partial unique indexes are left out: they only hold where their predicate does. Excluded
 * columns are not: this decides what SQL to write, not what the schema shows. Empty when the
 * table has no key at all, and then nothing narrows the write.
 */
export const getRowKeyCandidates = <TTable extends Table>(
  table: TTable,
  getTableConfig: (table: TTable) => UniqueTableConfig,
): string[][] => {
  const primaryKey = getPrimaryKeyPropNamesFromConfig(table, getTableConfig);
  if (primaryKey.length) {
    return [primaryKey];
  }
  const cols = getColumns(table) as Record<string, Column>;
  const sets = uniqueTargetsOver(table, cols, getTableConfig)
    .filter((target) => !target.where)
    .map((target) => target.columns);
  const notNull = sets.find((set) => set.every((name) => cols[name]!.notNull));
  return notNull ? [notNull] : sets;
};
