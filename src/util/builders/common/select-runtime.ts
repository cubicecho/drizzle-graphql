// The read path at resolve time: running a relational select with everything the arguments
// asked for, and eager-loading relations onto the rows a mutation returns.

import type { Table } from 'drizzle-orm';
import { and, inArray, type SQL, sql } from 'drizzle-orm';
import { remapToGraphQLArrayOutput, remapToGraphQLSingleOutput } from '../../data-mappers/index.ts';
import type { ResolveTree } from '../../parse-resolve-info.ts';
import type { ProcessedTableSelectArgs, TableNamedRelations } from '../types.ts';
import type { CursorOrderEntry, NullOrdering } from './cursor.ts';
import {
  attachRowCursors,
  buildCursorCondition,
  cursorOrderExprs,
  cursorOrderingEntries,
  decodeCursor,
  isCursorFieldSelected,
  orderByCursorObstacle,
} from './cursor.ts';
import { primaryKeyRestriction, selectDistinctKeys } from './distinct.ts';
import { drizzleError } from './errors.ts';
import { primaryKeyOrderExprs } from './keys.ts';
import type { DefaultOrderByFor, LimitPolicyFor } from './limits.ts';
import type { TypeNameMapper } from './naming.ts';
import { extractOrderBy } from './order-by.ts';
import type { DeletedMode, ScopeResolver } from './policies.ts';
import { withScope } from './policies.ts';
import type { RelationFilterBase } from './relation-filters.ts';
import { extractFilters, relationFilterCtx } from './relation-filters.ts';
import { extractRelationsParams } from './relation-params.ts';
import { extractSelectedColumnsFromTree } from './selected-columns.ts';
import type { TypeNameResolver } from './type-names.ts';

/**
 * Runs the relational-query-builder select shared by every dialect's `generateSelect*`
 * resolver: selected columns + offset/limit + aliased orderBy/where callbacks + the eager
 * `with:` relation params, then remaps the result. `single` switches between
 * findFirst/findMany (and the single path omits `limit`). The PG fallback for tables
 * without RQB support stays in pg.ts; this covers the common RQB path for all three.
 */
export const runRelationalSelect = async (opts: {
  queryBase: any;
  tables: Record<string, Table>;
  tableName: string;
  table: Table;
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  typeName: string;
  typeNameMapper: TypeNameMapper | undefined;
  parsedInfo: ResolveTree;
  offset?: number;
  limit?: number;
  orderBy?: any;
  where?: any;
  single: boolean;
  filterCtx?: RelationFilterBase;
  pkNames?: readonly string[];
  db?: any;
  distinct?: string[];
  after?: string;
  nullOrdering?: NullOrdering;
  limits?: LimitPolicyFor;
  scope?: ScopeResolver;
  defaultOrderBy?: DefaultOrderByFor;
  deleted?: DeletedMode;
  /** The build's type-naming rule, so a relation's target type is looked up under its real name. */
  resolveName?: TypeNameResolver;
}): Promise<any> => {
  const {
    queryBase,
    tables,
    tableName,
    table,
    relationMap,
    typeName,
    typeNameMapper,
    parsedInfo,
    offset,
    orderBy,
    where,
    single,
    filterCtx,
    pkNames,
    after,
    scope,
    deleted,
  } = opts;
  const distinct = opts.distinct?.length ? opts.distinct : undefined;

  // ── keyset (cursor) pagination ──
  // Active when the request passes `after` or selects the `cursor` meta field. The cursor is
  // defined over a total order — the request's orderBy plus the primary-key tiebreak — so both
  // need the PK; a table without one gets an error for `after` and null cursors otherwise.
  const cursorSelected = !single && isCursorFieldSelected(parsedInfo.fieldsByTypeName[typeName], table);
  let cursorEntries: CursorOrderEntry[] | undefined;
  if (!single && (after != null || cursorSelected)) {
    if (after != null && distinct) {
      throw drizzleError("'after' cannot be combined with 'distinct'.", { code: 'DRIZZLE_INVALID_CURSOR' });
    }
    const cursorObstacle = orderByCursorObstacle(orderBy);
    if (cursorObstacle) {
      if (after != null) {
        throw drizzleError(cursorObstacle, { code: 'DRIZZLE_INVALID_CURSOR' });
      }
      // `cursor` was selected under an ordering a cursor cannot express — the field resolves
      // to null and the ordering itself still applies.
    } else if (!pkNames?.length) {
      if (after != null) {
        throw drizzleError(`Table ${tableName} has no primary key, so cursor pagination cannot be used on it.`, {
          code: 'DRIZZLE_INVALID_CURSOR',
        });
      }
      // `cursor` was selected but no total order exists — the field resolves to null.
    } else {
      cursorEntries = cursorOrderingEntries(orderBy, pkNames);
    }
  }
  const cursorValues = after != null && cursorEntries ? decodeCursor(after, cursorEntries) : undefined;
  // Taking a slice of an unordered result lets the database return any rows it likes, so
  // `limit`/`offset` pages can overlap or skip rows between requests, and a single query
  // can return a different row each time. Default to the primary key whenever the query is
  // narrowed to a subset, mirroring the relation-level default in extractRelationsParamsInner.
  const needsDefaultOrder = single || offset != null || opts.limit != null;

  // `distinct` runs as its own pass — the relational query builder cannot express it — and
  // the main query is then narrowed to the primary keys it picked, with the same ordering
  // and without re-applying limit/offset.
  let distinctKeys: Record<string, any>[] | undefined;
  if (distinct) {
    distinctKeys = await selectDistinctKeys({
      db: opts.db,
      table,
      tableName,
      distinct,
      pkNames: pkNames ?? [],
      where: withScope(
        scope,
        tableName,
        table,
        where ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)) : undefined,
        deleted,
      ),
      orderBy,
      limit: single ? 1 : opts.limit,
      offset,
    });

    if (!distinctKeys.length) {
      return single ? undefined : [];
    }
  }

  const params: any = {
    columns: extractSelectedColumnsFromTree(parsedInfo.fieldsByTypeName[typeName]!, table, {
      tableName,
      relationMap,
      tables,
      allRelations: filterCtx?.relationMap,
    }),
    offset: distinctKeys ? undefined : offset,
    // drizzle-orm v1 RQB calls orderBy/where with the aliased table proxy — use it
    // directly so column refs match the CTE alias.
    orderBy: distinctKeys
      ? (aliasedTable: Table) => [
          ...(orderBy ? extractOrderBy(aliasedTable, orderBy, relationFilterCtx(filterCtx, tableName), where) : []),
          ...primaryKeyOrderExprs(aliasedTable, pkNames!),
        ]
      : cursorEntries
        ? // Cursor pagination needs a total order: the request's orderBy plus the PK tiebreak,
          // exactly the ordering the cursor encodes and the keyset predicate compares against.
          (aliasedTable: Table) => cursorOrderExprs(aliasedTable, cursorEntries!)
        : orderBy
          ? (aliasedTable: Table) =>
              extractOrderBy(aliasedTable, orderBy, relationFilterCtx(filterCtx, tableName), where)
          : needsDefaultOrder && pkNames?.length
            ? (aliasedTable: Table) => primaryKeyOrderExprs(aliasedTable, pkNames)
            : undefined,
    where: distinctKeys
      ? // The distinct pass already ran inside the scope, so the keys it picked are in it.
        { RAW: (aliasedTable: Table) => primaryKeyRestriction(aliasedTable, pkNames!, distinctKeys!) }
      : where || cursorValues || scope?.has(tableName, deleted)
        ? {
            RAW: (aliasedTable: Table) =>
              withScope(
                scope,
                tableName,
                aliasedTable,
                and(
                  where
                    ? extractFilters(aliasedTable, tableName, where, relationFilterCtx(filterCtx, tableName))
                    : undefined,
                  cursorValues
                    ? buildCursorCondition(
                        aliasedTable,
                        cursorEntries!,
                        cursorValues,
                        opts.nullOrdering ?? 'nulls-smallest',
                      )
                    : undefined,
                ),
                deleted,
              ),
          }
        : undefined,
    with: relationMap[tableName]
      ? extractRelationsParams(
          relationMap,
          tables,
          tableName,
          parsedInfo,
          typeName,
          typeNameMapper,
          filterCtx,
          opts.limits,
          scope,
          opts.defaultOrderBy,
          opts.resolveName,
        )
      : undefined,
  };

  if (single) {
    const result = await queryBase.findFirst(params);
    return result ? remapToGraphQLSingleOutput(result, tableName, table, relationMap) : undefined;
  }

  // Computing each row's cursor needs the whole ordering tuple, which the client has no
  // reason to have selected — force those columns into the fetch (GraphQL only returns
  // the fields the query asked for, so extra properties never leak into the response).
  if (cursorEntries && cursorSelected) {
    for (const [column] of cursorEntries) {
      params.columns[column] = true;
    }
  }

  params.limit = distinctKeys ? undefined : opts.limit;
  const result = await queryBase.findMany(params);
  if (cursorEntries && cursorSelected) {
    // On the raw rows, before remapping rewrites dates/bigints into transport forms.
    attachRowCursors(result, cursorEntries);
  }
  return remapToGraphQLArrayOutput(result, tableName, table, relationMap);
};

/**
 * After a mutation, re-fetch the mutated rows through the relational query builder so the
 * selected relations are eagerly loaded in a single query, then merge those relations onto
 * the `.returning()` rows — making the per-field BatchLoader fallback unnecessary.
 *
 * `withParams` is the pre-computed relation selection (from extractRelationsParams); the
 * caller only invokes this when relations are actually selected, so it also gates whether
 * the PK was forced into RETURNING.
 *
 * Falls back to the original `.returning()` rows (relations then resolve via the
 * field-level BatchLoader) when the table has no RQB support, no primary key columns can be
 * determined, or the re-fetch fails. Supports single- and multi-column primary keys.
 */
export const eagerLoadMutationRelations = async (
  db: any,
  tableName: string,
  rows: any[],
  pkNames: readonly string[],
  withParams: Record<string, Partial<ProcessedTableSelectArgs>> | undefined,
): Promise<any[]> => {
  if (!rows.length || !pkNames.length || !withParams || !Object.keys(withParams).length) {
    return rows;
  }

  const queryBase = db.query?.[tableName];
  if (!queryBase) {
    return rows;
  }

  // Only rows that carry every PK value can be re-keyed. Callers force the PK into
  // RETURNING, but if a value is still missing for some rows, eager-load just those that
  // are keyable and leave the rest untouched (their relations resolve lazily) rather than
  // bailing the whole batch.
  const keyableRows = rows.filter((row) => pkNames.every((n) => row[n] != null));
  if (!keyableRows.length) {
    return rows;
  }

  // Re-fetch ONLY the primary key + relations: the scalar columns are already present
  // on `rows` from RETURNING, so re-selecting them would transfer them a second time
  // (and would lose them on the fallback path). We merge the fetched relations back in.
  const pkColumns: Record<string, true> = {};
  for (const pk of pkNames) {
    pkColumns[pk] = true;
  }
  const relationNames = Object.keys(withParams);

  // Normalize bigint PK values to strings: JSON.stringify throws on bigint, and a
  // bigint and its string form never collide within a single column's values.
  const keyOf = (row: any) =>
    JSON.stringify(pkNames.map((n) => (typeof row[n] === 'bigint' ? row[n].toString() : row[n])));

  let whereRaw: (aliased: any) => SQL | undefined;
  if (pkNames.length === 1) {
    const pkName = pkNames[0]!;
    const ids = keyableRows.map((r) => r[pkName]);
    // drizzle-orm v1 RQB calls the where callback with the aliased table proxy;
    // reference the PK through it so the column ref matches the CTE alias.
    whereRaw = (aliased: any) => inArray(aliased[pkName], ids);
  } else {
    // Composite PK: use a row-value IN — `(a, b) IN ((..), (..))` — so the database can
    // plan it as a set membership test, instead of an OR of N per-row AND-tuples that
    // blows up for large bulk mutations.
    whereRaw = (aliased: any) => {
      const lhs = sql.join(
        pkNames.map((n) => sql`${aliased[n]}`),
        sql`, `,
      );
      const tuples = sql.join(
        keyableRows.map(
          (row) =>
            sql`(${sql.join(
              pkNames.map((n) => sql`${row[n]}`),
              sql`, `,
            )})`,
        ),
        sql`, `,
      );
      return sql`(${lhs}) in (${tuples})`;
    };
  }

  let enriched: any[];
  try {
    enriched = await queryBase.findMany({
      columns: pkColumns,
      where: { RAW: whereRaw },
      with: withParams,
    });
  } catch (err) {
    // The write has already committed; a re-fetch failure (e.g. an RQB-incompatible
    // column or relation) must not turn a successful mutation into an error. Fall back
    // to the raw rows — relations then resolve lazily via the batch loader — but surface
    // the cause so a genuine misconfiguration isn't silently hidden.
    console.warn(
      `[drizzle-graphql] eager-loading relations for a "${tableName}" mutation failed; ` +
        'falling back to lazy resolution.',
      err,
    );
    return rows;
  }

  // Merge the fetched relations onto the RETURNING rows in place, preserving order. A row
  // the re-fetch didn't return (e.g. deleted concurrently) keeps its scalar columns and
  // its relations resolve lazily, so the result never reports fewer rows than were mutated.
  const byKey = new Map(enriched.map((e) => [keyOf(e), e]));
  for (const row of rows) {
    const match = byKey.get(keyOf(row));
    if (!match) {
      continue;
    }
    for (const rel of relationNames) {
      row[rel] = match[rel];
    }
  }
  return rows;
};
