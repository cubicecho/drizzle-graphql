// The field resolver every relation gets. It returns what the parent already fetched when the
// eager path ran, and otherwise batches all sibling calls in the same execution tick into one
// IN-clause query.

import type { Column, Table } from 'drizzle-orm';
import { and, getColumns, gt, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { getOrCreateLoader, getOrCreateRequestValue } from '../../batch-loader/index.ts';
import { remapToGraphQLArrayOutput } from '../../data-mappers/index.ts';
import { relationFieldExtension } from '../../extensions.ts';
import type { ResolveTree } from '../../parse-resolve-info.ts';
import { parseResolveInfo } from '../../parse-resolve-info.ts';
import type { TableNamedRelations } from '../types.ts';
import type { CursorOrderEntry, NullOrdering } from './cursor.ts';
import {
  attachRowCursors,
  buildCursorCondition,
  cursorOrderExprs,
  cursorOrderingEntries,
  decodeCursor,
  orderByHasRelationEntry,
  selectsCursorField,
} from './cursor.ts';
import { primaryKeyRestriction, selectDistinctKeys } from './distinct.ts';
import { type DrizzleErrorContext, drizzleError, toGraphQLError, withErrorContext } from './errors.ts';
import { resolveExecutor } from './executor.ts';
import { primaryKeyOrderExprs } from './keys.ts';
import type { LimitPolicyFor } from './limits.ts';
import { applyLimitPolicy, withDefaultOrderBy } from './limits.ts';
import { extractOrderBy } from './order-by.ts';
import type { TablePolicies } from './policies.ts';
import { relationDeletedDefault, resolveScope, withScope } from './policies.ts';
import type { RelationFilterBase, RelationFilterContext } from './relation-filters.ts';
import { extractFilters, relationFilterCtx } from './relation-filters.ts';
import type { RelationResolverFactory } from './relations.ts';
import { extractRelationJoinColumns } from './relations.ts';
import { extractSelectedColumnsFromTreeSQLFormat } from './selected-columns.ts';

/**
 * Fetches a to-many relation with per-parent limit/offset for ALL parents in a
 * single query, using a window function (ROW_NUMBER() OVER (PARTITION BY fk ...)).
 *
 * This replaces the previous per-parent fallback that issued one query per parent
 * (true N+1) whenever pagination args were present. Each parent gets its own
 * limit/offset window while the database is hit exactly once for the whole batch.
 *
 * Window functions require PostgreSQL, MySQL >= 8.0, or SQLite >= 3.25.
 * Returns raw rows (NOT remapped); the caller groups + remaps them.
 */
const batchedPaginatedRelationQuery = async (
  db: any,
  targetTable: Table,
  foreignCol: Column,
  whereCondition: SQL | undefined,
  orderByArg: any,
  limit: number | null,
  offset: number | null,
  pkNames: readonly string[],
  columns: Record<string, Column> | undefined,
  orderCtx?: RelationFilterContext,
  whereArgs?: Record<string, any>,
): Promise<any[]> => {
  const cols = columns ?? getColumns(targetTable);

  // Always tiebreak the window by the target's primary key so per-parent limit/offset
  // slices are deterministic even when the client supplies no (or a non-unique) orderBy.
  // pkNames is resolved at build time and includes composite keys.
  const orderExprs = [
    ...(orderByArg ? extractOrderBy(targetTable, orderByArg, orderCtx, whereArgs) : []),
    ...primaryKeyOrderExprs(targetTable, pkNames),
  ];
  const orderClause = orderExprs.length ? sql` order by ${sql.join(orderExprs, sql`, `)}` : sql``;
  // Namespaced alias so it can't collide with a real column on the target table.
  const RN = '__drizzle_graphql_rn';
  const rowNumber = sql`row_number() over (partition by ${foreignCol}${orderClause})`.as(RN);

  // Subquery: every target column plus a per-partition row number.
  const sub = db
    .select({ ...cols, [RN]: rowNumber })
    .from(targetTable)
    .where(whereCondition)
    .as('__paginated');

  // Outer: keep only the rows that fall inside each parent's window.
  const lower = offset ?? 0;
  const windowConds: any[] = [gt(sub[RN], lower)];
  if (limit != null) {
    windowConds.push(lte(sub[RN], lower + limit));
  }

  const rows: any[] = await db
    .select()
    .from(sub)
    .where(and(...windowConds))
    .orderBy(sub[RN]);

  // Strip the helper column so it doesn't leak into remapping/output.
  for (const row of rows) {
    delete row[RN];
  }
  return rows;
};

/**
 * Creates a RelationResolverFactory that generates field-level resolvers for each relation.
 * Each resolver:
 *   1. Returns pre-fetched data if the parent resolver already included it (eager path, zero cost).
 *   2. When limit/offset args are present, falls back to a direct per-item query.
 *   3. Otherwise batches all sibling resolver calls within the same GraphQL execution tick
 *      into a single IN-clause query, eliminating N+1 database round-trips.
 *
 * `nullOrdering` is the dialect's native `ORDER BY` placement for `NULL` — the keyset
 * predicate behind a relation's `after` argument has to match it, or rows with a `NULL` in an
 * ordered column would be skipped instead of paged through. It has no sensible default, so
 * each dialect builder states it: `'nulls-largest'` for PostgreSQL, `'nulls-smallest'` for
 * MySQL and SQLite.
 */
export const createRelationResolverFactory =
  (
    db: any,
    tables: Record<string, Table>,
    nullOrdering: NullOrdering,
    filterCtx?: RelationFilterBase,
    limits?: LimitPolicyFor,
    policies?: TablePolicies,
  ): RelationResolverFactory =>
  ({ tableName, relationName, relEntry, isOne }) => {
    const parentTable = tables[tableName];
    const targetTableName = relEntry.targetTableName;
    const targetTable = tables[targetTableName];

    if (!parentTable || !targetTable) {
      return undefined;
    }

    const joinCols = extractRelationJoinColumns(relEntry, parentTable, targetTable);
    if (!joinCols) {
      return undefined;
    }

    const { localColPropName, foreignCol, foreignColPropName } = joinCols;
    // The mode this field reads its target with when the request passes no `deleted` — see
    // `relationDeletedDefault`. Required to-one relations and `scope: 'root'` tables read
    // marked rows; everything else keeps hiding them.
    const defaultDeleted = relationDeletedDefault(
      policies?.softDelete,
      targetTableName,
      isOne && (relEntry.relation as any)?.optional === false,
    );
    // A relation field is bounded by the policy of the table it reads, not the parent's.
    const limitPolicy = isOne ? undefined : limits?.(targetTableName);
    // Resolved at build time (composite keys included) — used to tiebreak paginated batches.
    const targetPkNames = relEntry.targetPkNames ?? [];
    const errorCtx: DrizzleErrorContext = { table: targetTableName, operation: 'relation', relation: relationName };

    /**
     * The columns one batch reads: the ones the selection names, plus the ones the batch needs
     * whatever the client asked for — the key it groups the rows by, and the ordering columns a
     * row cursor is encoded from. Nested relation fields contribute their own join column
     * through the selection context, the same way the root select path narrows.
     *
     * `undefined` means "every column", which is what a resolver with no readable resolve info
     * has to fall back to.
     */
    const selectedColumns = (info: any, cursorEntries: CursorOrderEntry[] | undefined) => {
      const parsed = info ? (parseResolveInfo(info) as ResolveTree | undefined) : undefined;
      if (!parsed) {
        return undefined;
      }
      // A relation field returns one object type, but merging every entry costs nothing and
      // keeps this honest if the target is ever reached through an abstract type.
      const tree: Record<string, ResolveTree> = Object.assign({}, ...Object.values(parsed.fieldsByTypeName));

      const columns = extractSelectedColumnsFromTreeSQLFormat(tree, targetTable, {
        tableName: targetTableName,
        relationMap: filterCtx?.relationMap ?? {},
        tables,
        allRelations: filterCtx?.relationMap,
      });

      const targetColumns = getColumns(targetTable);
      columns[foreignColPropName] = foreignCol;
      for (const [columnName] of cursorEntries ?? []) {
        const column = targetColumns[columnName];
        if (column) {
          columns[columnName] = column;
        }
      }
      return columns;
    };

    const resolve = async (parent: any, args: any, context: any, info: any) => {
      // Eager path: the parent resolver pre-fetched this relation via Drizzle's `with`.
      if (parent[relationName] !== undefined) {
        return parent[relationName];
      }

      const localValue = parent[localColPropName];
      if (localValue == null) {
        return isOne ? null : [];
      }

      const { where: whereArg, limit: requestedLimit, offset, after, deleted } = (args ?? {}) as any;

      // Everything below is derived from this field alone — its args and its selection — so it is
      // identical for every parent row the batch fetches. Resolvers run once per parent row, so it
      // is computed once per field per request and reused, rather than re-reading the selection and
      // re-stringifying the loader key N times.
      const { orderByArg, limit, distinct, cursorEntries, cursorValues, columns, loaderKey } = getOrCreateRequestValue(
        context,
        info?.fieldNodes?.[0],
        `relation:${tableName}::${relationName}`,
        () => {
          // A relation field falls back to the *target* table's default ordering, since that is
          // the table it reads. A to-one relation is a single row and takes no ordering at all.
          const orderByArg = isOne
            ? (args as any)?.orderBy
            : withDefaultOrderBy(args ?? {}, targetTableName, policies?.defaultOrderBy).orderBy;
          const limit = applyLimitPolicy(requestedLimit, limitPolicy, errorCtx);
          const distinct = ((args ?? {}) as any).distinct?.length ? ((args ?? {}) as any).distinct : undefined;

          // ── keyset (cursor) pagination ──
          // The same rules the root list follows, over the related rows of one parent: the cursor
          // is defined over the request's orderBy plus the target's primary-key tiebreak, and the
          // keyset predicate is a plain condition on the target's own columns — so it filters each
          // parent's rows independently even though the batch fetches them all at once.
          const cursorSelected = !isOne && !!info && selectsCursorField(info, targetTable);
          let cursorEntries: CursorOrderEntry[] | undefined;
          if (!isOne && (after != null || cursorSelected)) {
            if (after != null && distinct) {
              throw drizzleError("'after' cannot be combined with 'distinct'.", { code: 'DRIZZLE_INVALID_CURSOR' });
            }
            if (orderByHasRelationEntry(orderByArg)) {
              if (after != null) {
                throw drizzleError(
                  "'after' cannot be combined with an orderBy that orders through a relation — a related row's value cannot be encoded into a cursor.",
                  { code: 'DRIZZLE_INVALID_CURSOR' },
                );
              }
              // `cursor` was selected under a relation ordering — the field resolves to null.
            } else if (!targetPkNames.length) {
              if (after != null) {
                throw drizzleError(
                  `Table ${targetTableName} has no primary key, so cursor pagination cannot be used on it.`,
                  { code: 'DRIZZLE_INVALID_CURSOR' },
                );
              }
              // `cursor` was selected but no total order exists — the field resolves to null.
            } else {
              cursorEntries = cursorOrderingEntries(orderByArg, targetPkNames);
            }
          }
          const cursorValues = after != null && cursorEntries ? decodeCursor(after, cursorEntries) : undefined;

          const columns = selectedColumns(info, cursorEntries);

          // Batch path: collect all sibling calls in this tick and execute one query.
          // Pagination args are part of the loader key so siblings sharing identical
          // args batch together; per-parent limit/offset is applied inside the batch
          // via a window function rather than bailing to a per-parent query (N+1).
          // `cursorEntries` joins the key because it changes the ordering, not just the filter.
          // The column list joins it too: one batch runs one SELECT, so two aliases of the same
          // relation asking for different columns need a batch each.
          const argsKey = JSON.stringify({
            where: whereArg ?? null,
            orderBy: orderByArg ?? null,
            limit: limit ?? null,
            offset: offset ?? null,
            deleted: deleted ?? defaultDeleted ?? null,
            after: after ?? null,
            distinct: distinct ?? null,
            cursor: cursorEntries ? 1 : 0,
            columns: columns ? Object.keys(columns).sort() : null,
          });

          return {
            orderByArg,
            limit,
            distinct,
            cursorEntries,
            cursorValues,
            columns,
            loaderKey: `${tableName}::${relationName}::${argsKey}`,
          };
        },
      );

      const loader = getOrCreateLoader(context, loaderKey, async (parentIds: readonly any[]) => {
        // Loaders are cached per context, so every call batched here shares this request's
        // executor — the transaction on the context, when there is one.
        const executor = resolveExecutor(db, context);
        const uniqueIds = [...new Set(parentIds)];
        // Loaders are keyed per context too, so the scope resolved here is this request's.
        const scope = resolveScope(policies, context, filterCtx);
        let whereCondition = withScope(
          scope,
          targetTableName,
          targetTable,
          and(
            inArray(foreignCol, uniqueIds),
            whereArg
              ? extractFilters(targetTable, targetTableName, whereArg, relationFilterCtx(filterCtx, targetTableName))
              : undefined,
            cursorValues ? buildCursorCondition(targetTable, cursorEntries!, cursorValues, nullOrdering) : undefined,
          ),
          deleted ?? defaultDeleted,
        );

        if (distinct) {
          // Partitioned by the foreign key as well as the requested columns, so "one row per
          // distinct value" means one per parent — `users { posts(distinct: [status]) }` gives
          // each user one post per status, not one post per status across all users. The pass
          // runs first and the batch query is then narrowed to the keys it picked, exactly as
          // the root list does.
          const keys = await selectDistinctKeys({
            db: executor,
            table: targetTable,
            tableName: targetTableName,
            distinct,
            pkNames: targetPkNames,
            where: whereCondition,
            orderBy: orderByArg,
            partitionBy: [foreignCol],
          });
          if (!keys.length) {
            return parentIds.map(() => (isOne ? null : []));
          }
          whereCondition = and(whereCondition, primaryKeyRestriction(targetTable, targetPkNames, keys));
        }

        let rows: any[];
        if (limit != null || offset != null) {
          // Per-parent pagination across the whole batch in one query. Its window ordering is
          // the request's orderBy plus the primary key, which is the cursor's total order too,
          // so a cursor page and a limit/offset page agree on row order.
          rows = await batchedPaginatedRelationQuery(
            executor,
            targetTable,
            foreignCol,
            whereCondition,
            orderByArg,
            limit ?? null,
            offset ?? null,
            targetPkNames,
            columns,
            relationFilterCtx(filterCtx, targetTableName),
            whereArg,
          );
        } else {
          // Use plain db.select() so column refs are never aliased — avoids drizzle-orm v1
          // RQB aliasing requirements that would require referencing via aliasedTable proxy.
          let q = (columns ? executor.select(columns) : executor.select())
            .from(targetTable)
            .where(whereCondition) as any;
          const orderExprs = cursorEntries
            ? cursorOrderExprs(targetTable, cursorEntries)
            : orderByArg
              ? extractOrderBy(targetTable, orderByArg, relationFilterCtx(filterCtx, targetTableName), whereArg)
              : [];
          if (orderExprs.length) {
            q = q.orderBy(...orderExprs);
          }
          rows = await q;
        }

        // Before remapping, which rewrites dates and bigints into their transport forms.
        if (cursorEntries) {
          attachRowCursors(rows, cursorEntries);
        }

        // Group by FK value before remapping (remapping may delete null fields).
        if (isOne) {
          const byKey = new Map(rows.map((row: any) => [String(row[foreignColPropName]), row]));
          remapToGraphQLArrayOutput(rows, targetTableName, targetTable);
          return parentIds.map((id) => byKey.get(String(id)) ?? null);
        }

        const grouped = new Map<string, any[]>(uniqueIds.map((id) => [String(id), []]));
        for (const row of rows) {
          grouped.get(String(row[foreignColPropName]))?.push(row);
        }
        remapToGraphQLArrayOutput(rows, targetTableName, targetTable);
        return parentIds.map((id) => grouped.get(String(id)) ?? []);
      });

      return loader.load(localValue);
    };

    // The context goes on here rather than at each throw: everything this resolver leans on —
    // filter compilation, ordering, the cursor — raises coded errors that know nothing about
    // which relation field called them.
    return async (parent, args, context, info) => {
      try {
        return await resolve(parent, args, context, info);
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    };
  };

/**
 * The `extensions.drizzle` block for one relation field. The relation entry already carries
 * the target table's primary key (resolved at build time for pagination), so the field can
 * publish it without the dialect's key resolver being reachable from here.
 */
export const relationExtensionFor = (
  relEntry: TableNamedRelations,
  parentTable: string,
  relationName: string,
  isOne: boolean,
  aggregate?: boolean,
) =>
  relationFieldExtension({
    targetTable: relEntry.targetTableName,
    parentTable,
    relation: relationName,
    single: isOne,
    primaryKey: relEntry.targetPkNames ?? [],
    aggregate,
  });
