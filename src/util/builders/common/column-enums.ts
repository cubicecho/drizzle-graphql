// GraphQL enums naming a table's columns — the operand type for `distinctOn` and for any
// argument that has to name a column rather than carry a value.

import type { Column, Table } from 'drizzle-orm';
import { GraphQLEnumType } from 'graphql';
import { excludedColumnsKey, visibleColumns } from './exclusions.ts';
import type { TypeNameResolver } from './type-names.ts';

/** Alias of the row-number helper column in the `distinct` pass. Namespaced against real columns. */
export const DISTINCT_RN = '__drizzle_graphql_distinct_rn';

const columnEnumCache = new WeakMap<object, Map<string, GraphQLEnumType>>();

/**
 * An enum of a table's column property names, under `enumName`. Cached per (table, enum name,
 * exclusions), like the order/filter inputs, so repeated builds reuse one instance and two
 * enums over the same table never collide.
 *
 * Returns `undefined` when no column qualifies — the caller then omits the argument or
 * input field the enum would have typed, rather than emitting an empty enum, which is
 * invalid GraphQL.
 */
export const generateColumnEnum = (
  table: Table,
  enumName: string,
  description: string,
  predicate: (column: Column, columnName: string) => boolean = () => true,
): GraphQLEnumType | undefined => {
  // The exclusions are part of the key, not a reason to skip the cache: a table's enum is
  // asked for from more than one place in a build (a list query's `distinct` argument and the
  // same argument on a to-many relation field pointing at it), and handing those two call
  // sites separate instances would put two types of the same name in one schema.
  const cacheKey = `${enumName}\u0000${excludedColumnsKey(table)}`;
  let tableCache = columnEnumCache.get(table);
  const cached = tableCache?.get(cacheKey);
  if (cached) {
    return cached;
  }

  const columnNames = Object.entries(visibleColumns(table))
    .filter(([columnName, column]) => predicate(column as Column, columnName))
    .map(([columnName]) => columnName);
  if (!columnNames.length) {
    return undefined;
  }

  const enumType = new GraphQLEnumType({
    name: enumName,
    description,
    values: Object.fromEntries(columnNames.map((columnName) => [columnName, { value: columnName }])),
  });

  if (!tableCache) {
    tableCache = new Map();
    columnEnumCache.set(table, tableCache);
  }
  tableCache.set(cacheKey, enumType);
  return enumType;
};

/**
 * `${typeName}DistinctColumn` — the enum of columns a list query may be made distinct on.
 *
 * @param resolveName the build's naming rule, where the caller has one; the default name is
 *   used as-is when it does not, which is what a consumer calling this directly gets.
 */
export const generateDistinctEnum = (
  table: Table,
  typeName: string,
  resolveName?: TypeNameResolver,
  tableKey?: string,
): GraphQLEnumType | undefined => {
  const defaultName = `${typeName}DistinctColumn`;
  return generateColumnEnum(
    table,
    resolveName?.({ kind: 'columnEnum', defaultName, table: tableKey, operation: 'distinct' }) ?? defaultName,
    `Columns of ${typeName} that a query can be made distinct on`,
  );
};

// ── upsert / conflict handling ────────────────────────────────────────────────
