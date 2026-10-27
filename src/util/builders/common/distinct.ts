// `distinct` for the relational query builder, which has no support for it: a window-function
// pass over the table, embedded in the read as the condition selecting the rows it keeps.

import type { Column, Table } from 'drizzle-orm';
import { asc, eq, getColumns, type SQL, sql } from 'drizzle-orm';
import { DISTINCT_RN } from './column-enums.ts';
import { drizzleError } from './errors.ts';
import { primaryKeyOrderExprs } from './keys.ts';
import { offsetOnlyLimit } from './limits.ts';
import { orderByEntries, orderExpressions } from './order-by.ts';

/** Alias prefix of the ordering columns inside the distinct pass's subquery. */
const DISTINCT_ORDER = '__dgql_distinct_o';

/** Alias of the parent key inside the distinct pass's subquery, when it runs through a junction. */
const DISTINCT_PARENT = '__dgql_distinct_parent';

/**
 * Condition matching the rows `distinct` keeps: the first row of each distinct combination of
 * the requested columns, following the query's own ordering, with `limit`/`offset` applied to
 * what survives. It is a subquery of the read it narrows — `pk in (select … from (<pass>) where
 * rn = 1 …)` — so the read stays one statement and binds no list of keys, however many rows
 * survive. (It used to return the keys to JS and bind them back as an `IN (…)` list, which past
 * the dialects' parameter limits failed or, on PGlite, silently matched nothing.)
 *
 * The pass is a `row_number() over (partition by … order by …)` window over `table`, filtered
 * by `where`. Its ordering is the request's `orderBy` plus the primary-key tiebreak; the caller
 * applies the same ordering to the read itself, so the two agree on which rows come first.
 *
 * `target` is the table the condition is written against — the RQB's aliased proxy on a root
 * list, the table itself on a relation batch. The pass reads `table` inside a derived table, so
 * its references never resolve to the outer query's.
 *
 * `partitionBy` prepends extra columns to the window's partition. A to-many relation field
 * uses it to pass the foreign key, which makes the pass distinct *within each parent* rather
 * than across the whole batch — the same meaning `distinct` has on a root list.
 *
 * `junction` is for a many-to-many relation: the target is joined to the junction `on` the
 * given condition, and the condition matches (parent, row) pairs rather than rows — a target
 * row linked to several parents can be kept for one and dropped for another. `parentKey` is the
 * junction column the outer query joins too, so it names the pair's parent on both sides.
 */
export const distinctRowsCondition = (params: {
  db: any;
  table: Table;
  target: Table;
  tableName: string;
  distinct: string[];
  pkNames: readonly string[];
  where: SQL | undefined;
  orderBy: Record<string, any> | undefined;
  limit?: number;
  offset?: number;
  partitionBy?: Column[];
  junction?: { table: Table; on: SQL; parentKey: Column };
}): SQL => {
  const { db, table, target, tableName, distinct, pkNames, where, orderBy, limit, offset, partitionBy, junction } =
    params;
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
  // (inside the window) and once against the subquery's fields (for the page's row order).
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

  // The subquery carries only what is read back from it by name: the parent key, the row
  // number, and the ordering columns — the request's, then the primary key, which is both the
  // tiebreak and the key the condition matches on. Each is the raw column under an explicit
  // alias: drizzle selects a SQLite `numeric()` column as an unaliased `cast(… as text)`, which
  // could not be found by name, and the raw column sorts and compares by its stored value.
  const orderAlias = (index: number) => `${DISTINCT_ORDER}${index}`;
  const orderColumns = [...orderEntries.map(([column]) => column), ...pkNames];
  const selected = db
    .select({
      ...(junction ? { [DISTINCT_PARENT]: sql`${junction.parentKey}`.as(DISTINCT_PARENT) } : {}),
      ...Object.fromEntries(
        orderColumns.map((column, index) => [orderAlias(index), sql`${cols[column]!}`.as(orderAlias(index))]),
      ),
      [DISTINCT_RN]: rowNumber,
    })
    .from(table);
  const sub = (junction ? selected.innerJoin(junction.table, junction.on) : selected)
    .where(where)
    .as('__dgql_distinct');

  const keyFields = [
    ...(junction ? [sub[DISTINCT_PARENT]] : []),
    ...pkNames.map((_, index) => sub[orderAlias(orderEntries.length + index)]),
  ];
  const keyName = (index: number) => `${DISTINCT_ORDER}k${index}`;
  let kept = db
    .select(Object.fromEntries(keyFields.map((field, index) => [keyName(index), field])))
    .from(sub)
    .where(eq(sub[DISTINCT_RN], 1));

  // Without a page to cut, which rows survive does not depend on their order, and the read
  // orders them itself.
  const effectiveLimit = offsetOnlyLimit(table, limit, offset);
  if (offset || effectiveLimit != null) {
    kept = kept.orderBy(
      ...orderEntries.flatMap(([column, direction, nulls], index) =>
        orderExpressions(sub[orderAlias(index)], direction, nulls, cols[column]!),
      ),
      ...pkNames.map((_, index) => asc(sub[orderAlias(orderEntries.length + index)])),
    );
    if (offset) {
      kept = kept.offset(offset);
    }
    if (effectiveLimit != null) {
      // The select builders drop a negative limit, so SQLite's `-1` goes in as a bound value.
      kept = kept.limit(effectiveLimit < 0 ? sql`${effectiveLimit}` : effectiveLimit);
    }
    // MySQL refuses a `LIMIT` inside an `IN` subquery, but not inside a derived table one reads.
    const page = kept.as('__dgql_distinct_page');
    kept = db
      .select(Object.fromEntries(keyFields.map((_, index) => [keyName(index), page[keyName(index)]])))
      .from(page);
  }

  const targetCols = getColumns(target);
  const lhs = [...(junction ? [junction.parentKey] : []), ...pkNames.map((name) => targetCols[name]!)];
  // A row-value `IN` over a subquery for a composite key — every dialect here accepts it.
  return lhs.length === 1 ? sql`${lhs[0]} in ${kept}` : sql`(${sql.join(lhs, sql`, `)}) in ${kept}`;
};
