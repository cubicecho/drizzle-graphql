// `distinctOn` for the dialects with no native support: the window-function key query the
// resolver runs first, and the primary-key restriction it feeds into the real select.

import type { Column, Table } from 'drizzle-orm';
import { and, asc, eq, getColumns, inArray, type SQL, sql } from 'drizzle-orm';
import { DISTINCT_RN } from './column-enums.ts';
import { drizzleError } from './errors.ts';
import { primaryKeyOrderExprs } from './keys.ts';
import { offsetOnlyLimit } from './limits.ts';
import { orderByEntries, orderExpressions } from './order-by.ts';
import { balancedOr } from './relations.ts';
import { subquerySafeSelection } from './selected-columns.ts';

/**
 * Alias the parent key comes back under when the pass runs through a junction table. See
 * `selectDistinctKeys`' `junction` parameter.
 */
export const DISTINCT_PARENT = '__dgql_distinct_parent';

/** Alias prefix of the ordering columns inside the distinct pass's subquery. */
const DISTINCT_ORDER = '__dgql_distinct_o';

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
 *
 * `junction` is for a many-to-many relation: the target is joined to the junction `on` the
 * given condition, and each returned key also carries the parent it was kept for, under
 * {@link DISTINCT_PARENT}. A target row linked to several parents can be kept for one and
 * dropped for another, so a key alone cannot narrow such a batch.
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
  junction?: { table: Table; on: SQL; parentKey: Column };
}): Promise<Record<string, any>[]> => {
  const { db, table, tableName, distinct, pkNames, where, orderBy, limit, offset, partitionBy, junction } = params;
  const cols = getColumns(table);

  if (!pkNames.length) {
    throw drizzleError(`Table ${tableName} has no primary key, so 'distinct' cannot be applied to it.`, {
      code: 'DRIZZLE_INVALID_DISTINCT',
    });
  }

  const requestedCols = distinct.map((name) => cols[name]).filter(Boolean);
  if (!requestedCols.length) {
    throw drizzleError(`No known columns were given to 'distinct' on ${tableName}.`, {
      code: 'DRIZZLE_INVALID_DISTINCT',
    });
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

  // The subquery carries only what the outer query reads back by name: the primary key it
  // returns, the parent key, the row number, and the ordering columns (the request's, then the
  // primary-key tiebreak). Every one has an explicit alias — drizzle selects a SQLite
  // `numeric()` column as an unaliased `cast(… as text)`, which the outer query could not find
  // by name — and the ordering columns are the raw column, so they sort by the stored value
  // rather than its text.
  const orderAlias = (index: number) => `${DISTINCT_ORDER}${index}`;
  const selected = db
    .select({
      ...subquerySafeSelection(Object.fromEntries(pkNames.map((name) => [name, cols[name]!]))),
      ...(junction ? subquerySafeSelection({ [DISTINCT_PARENT]: junction.parentKey }) : {}),
      ...Object.fromEntries(
        [...orderEntries.map(([column]) => column), ...pkNames].map((column, index) => [
          orderAlias(index),
          sql`${cols[column]!}`.as(orderAlias(index)),
        ]),
      ),
      [DISTINCT_RN]: rowNumber,
    })
    .from(table);
  const sub = (junction ? selected.innerJoin(junction.table, junction.on) : selected)
    .where(where)
    .as('__dgql_distinct');

  const outerOrder = [
    ...orderEntries.flatMap(([column, direction, nulls], index) =>
      orderExpressions(sub[orderAlias(index)], direction, nulls, cols[column]!),
    ),
    ...pkNames.map((_, index) => asc(sub[orderAlias(orderEntries.length + index)])),
  ];

  let query = db
    .select({
      ...Object.fromEntries(pkNames.map((name) => [name, sub[name]])),
      ...(junction ? { [DISTINCT_PARENT]: sub[DISTINCT_PARENT] } : {}),
    })
    .from(sub)
    .where(eq(sub[DISTINCT_RN], 1))
    .orderBy(...outerOrder);

  if (offset) {
    query = query.offset(offset);
  }
  const effectiveLimit = offsetOnlyLimit(table, limit, offset);
  if (effectiveLimit != null) {
    // The select builders drop a negative limit, so SQLite's `-1` goes in as a bound value.
    query = query.limit(effectiveLimit < 0 ? sql`${effectiveLimit}` : effectiveLimit);
  }

  return await query;
};

/**
 * Condition matching exactly the rows identified by `keys` — an `IN (…)` for a single-column
 * primary key, an `OR` of per-row equality for a composite one — nested as a balanced tree, so
 * thousands of keys stay within SQLite's expression-depth limit. `table` may be the aliased RQB
 * proxy.
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

  return balancedOr(keys.map((key) => and(...pkNames.map((name) => eq(cols[name]!, key[name])))))!;
};
