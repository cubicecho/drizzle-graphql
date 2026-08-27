// `distinctOn` for the dialects with no native support: the window-function key query the
// resolver runs first, and the primary-key restriction it feeds into the real select.

import type { Column, Table } from 'drizzle-orm';
import { and, asc, eq, getColumns, inArray, or, type SQL, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { DISTINCT_RN } from './column-enums.ts';
import { primaryKeyOrderExprs } from './keys.ts';
import { orderByEntries, orderExpressions } from './order-by.ts';

/**
 * Keeps the first row of each distinct combination of the requested columns, following the
 * query's own ordering, then applies `limit`/`offset` to what survives — and returns the
 * surviving rows' primary key values in that order.
 *
 * The relational query builder has no `distinct` support, so this runs as its own
 * `row_number() over (partition by … order by …)` pass and the main query is narrowed to the
 * keys it returns. `orderExprs` is the full ordering (the request's `orderBy` plus the primary
 * key tiebreak); the caller applies the same ordering to the main query, so the two agree.
 *
 * `partitionBy` prepends extra columns to the window's partition. A to-many relation field
 * uses it to pass the foreign key, which makes the pass distinct *within each parent* rather
 * than across the whole batch — the same meaning `distinct` has on a root list.
 */
export const selectDistinctKeys = async (params: {
  db: any;
  table: Table;
  tableName: string;
  distinct: string[];
  pkNames: readonly string[];
  where: SQL | undefined;
  orderBy: Record<string, any> | undefined;
  limit?: number;
  offset?: number;
  partitionBy?: Column[];
}): Promise<Record<string, any>[]> => {
  const { db, table, tableName, distinct, pkNames, where, orderBy, limit, offset, partitionBy } = params;
  const cols = getColumns(table);

  if (!pkNames.length) {
    throw new GraphQLError(`Table ${tableName} has no primary key, so 'distinct' cannot be applied to it.`);
  }

  const requestedCols = distinct.map((name) => cols[name]).filter(Boolean);
  if (!requestedCols.length) {
    throw new GraphQLError(`No known columns were given to 'distinct' on ${tableName}.`);
  }
  const partitionCols = [...(partitionBy ?? []), ...requestedCols];

  const orderEntries = orderBy ? orderByEntries(orderBy) : [];
  // Both orderings must agree, so build each from the same entries — once against the table
  // (inside the window) and once against the subquery's fields (for the outer row order).
  const windowOrder = [
    ...orderEntries.flatMap(([column, direction, nulls]) =>
      orderExpressions(cols[column]!, direction, nulls, cols[column]!),
    ),
    ...primaryKeyOrderExprs(table, pkNames),
  ];

  const rowNumber = sql`row_number() over (partition by ${sql.join(partitionCols, sql`, `)} order by ${sql.join(
    windowOrder,
    sql`, `,
  )})`.as(DISTINCT_RN);

  const sub = db
    .select({ ...cols, [DISTINCT_RN]: rowNumber })
    .from(table)
    .where(where)
    .as('__dgql_distinct');

  const outerOrder = [
    ...orderEntries.flatMap(([column, direction, nulls]) =>
      orderExpressions(sub[column], direction, nulls, cols[column]!),
    ),
    ...pkNames.filter((name) => sub[name]).map((name) => asc(sub[name])),
  ];

  let query = db
    .select(Object.fromEntries(pkNames.map((name) => [name, sub[name]])))
    .from(sub)
    .where(eq(sub[DISTINCT_RN], 1))
    .orderBy(...outerOrder);

  if (offset) {
    query = query.offset(offset);
  }
  if (limit != null) {
    query = query.limit(limit);
  }

  return await query;
};

/**
 * Condition matching exactly the rows identified by `keys` — an `IN (…)` for a single-column
 * primary key, an `OR` of per-row equality for a composite one. `table` may be the aliased
 * RQB proxy.
 */
export const primaryKeyRestriction = (table: Table, pkNames: readonly string[], keys: Record<string, any>[]): SQL => {
  const cols = getColumns(table);

  if (pkNames.length === 1) {
    const name = pkNames[0]!;
    return inArray(
      cols[name]!,
      keys.map((key) => key[name]),
    );
  }

  return or(...keys.map((key) => and(...pkNames.map((name) => eq(cols[name]!, key[name])))))!;
};
