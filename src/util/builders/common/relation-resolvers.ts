// The field resolver every relation gets. It returns what the parent already fetched when the
// eager path ran, and otherwise batches all sibling calls in the same execution tick into one
// IN-clause query.

import type { Column, Table } from 'drizzle-orm';
import { and, eq, getColumns, gt, lte, type SQL, sql } from 'drizzle-orm';
import { getOrCreateLoader, getOrCreateRequestValue } from '../../batch-loader/index.ts';
import { remapToGraphQLArrayOutput } from '../../data-mappers/index.ts';
import { executionKey } from '../../execution.ts';
import { relationFieldExtension } from '../../extensions.ts';
import { requestValueNodes } from '../../graphql-variables.ts';
import type { ResolveTree } from '../../parse-resolve-info.ts';
import { parseResolveInfo } from '../../parse-resolve-info.ts';
import type { TableNamedRelations } from '../types.ts';
import type { CursorOrderEntry, NullOrdering } from './cursor.ts';
import {
  attachRowCursors,
  buildCursorCondition,
  cursorOrderExprs,
  cursorOrderingEntries,
  cursorPreciseSelection,
  decodeCursor,
  orderByCursorObstacle,
  primaryKeyTiebreakExprs,
  selectsCursorField,
} from './cursor.ts';
import { distinctRowsCondition } from './distinct.ts';
import { type DrizzleErrorContext, drizzleError, toGraphQLError, withErrorContext } from './errors.ts';
import { resolveExecutor } from './executor.ts';
import { primaryKeyOrderExprs } from './keys.ts';
import type { LimitPolicyFor } from './limits.ts';
import { applyLimitPolicy, assertPagingNotNegative, effectiveOffset, withDefaultOrderBy } from './limits.ts';
import { extractOrderBy } from './order-by.ts';
import type { TablePolicies } from './policies.ts';
import {
  bindPolicies,
  junctionPolicy,
  junctionTableName,
  relationDeletedDefault,
  withRowVisibility,
} from './policies.ts';
import type { RelationFilterBase, RelationFilterContext } from './relation-filters.ts';
import { extractFilters, relationFilterCtx } from './relation-filters.ts';
import type { RelationResolverFactory } from './relations.ts';
import {
  extractJunctionColumns,
  extractRelationJoinColumnPairs,
  joinKeyOf,
  parentJoinValues,
  parentKeyChunks,
  parentKeyCondition,
  relatedRowParents,
  relationOwnCondition,
} from './relations.ts';
import { extractSelectedColumnsFromTreeSQLFormat, subquerySafeSelection } from './selected-columns.ts';

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
  partitionCols: readonly Column[],
  whereCondition: SQL | undefined,
  orderByArg: any,
  limit: number | null,
  offset: number | null,
  pkNames: readonly string[],
  columns: Record<string, Column | SQL.Aliased> | undefined,
  orderCtx?: RelationFilterContext,
  whereArgs?: Record<string, any>,
  junction?: RelationJunction,
): Promise<any[]> => {
  const cols = columns ?? getColumns(targetTable);

  // Always tiebreak the window by the target's primary key so per-parent limit/offset
  // slices are deterministic even when the client supplies no (or a non-unique) orderBy.
  // pkNames is resolved at build time and includes composite keys.
  const orderExprs = [
    ...(orderByArg ? extractOrderBy(targetTable, orderByArg, orderCtx, whereArgs) : []),
    ...primaryKeyTiebreakExprs(targetTable, orderByArg, pkNames, true),
  ];
  const orderClause = orderExprs.length ? sql` order by ${sql.join(orderExprs, sql`, `)}` : sql``;
  // Namespaced alias so it can't collide with a real column on the target table.
  const RN = '__drizzle_graphql_rn';
  // Partitioned by the whole parent key: every join column, or the junction's source column.
  const rowNumber = sql`row_number() over (partition by ${sql.join([...partitionCols], sql`, `)}${orderClause})`.as(RN);

  // Subquery: every target column (and a junction's parent key) plus a per-partition row
  // number. Each comes out aliased to its key, since the outer select reads it back by key and
  // a target column can share a database name with the junction's source column.
  const sub = withJunction(
    db.select({ ...subquerySafeSelection(cols), [RN]: rowNumber }).from(targetTable),
    junction,
    foreignCol,
  )
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

type RelationJunction = { table: Table; sourceCol: Column; targetCol: Column };

/**
 * Alias the parent key is selected under when a relation goes through a junction table. The
 * key lives on the junction, not the target, so it has to be selected explicitly to group the
 * rows by parent — and a target row linked to several parents comes back once per parent.
 */
const PARENT_KEY = '__drizzle_graphql_parent';

/** `from(target)`, joined to the junction table when the relation has one. */
const withJunction = (query: any, junction: RelationJunction | undefined, foreignCol: Column) =>
  junction ? query.innerJoin(junction.table, eq(junction.targetCol, foreignCol)) : query;

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
    // Bound the way the generated resolvers' policies are: a consumer passes them unbound.
    const visibilityOf = bindPolicies(policies, filterCtx)?.visibility;
    const parentTable = tables[tableName];
    const targetTableName = relEntry.targetTableName;
    const targetTable = tables[targetTableName];

    if (!parentTable || !targetTable) {
      return undefined;
    }

    // Every column pair the relation joins on. A row belongs to a parent only when all of them
    // match, so the batch is keyed, filtered, grouped and partitioned by the whole tuple.
    const joinPairs = extractRelationJoinColumnPairs(relEntry, parentTable, targetTable);
    if (!joinPairs) {
      return undefined;
    }

    // The parent's join columns, which a parent key is read from and keyed by.
    const localCols = joinPairs.map((pair) => pair.localCol);
    // The target column a junction is joined on. A usable `.through()` relation has exactly one
    // pair — a composite junction is `null` below and refused.
    const foreignCol = joinPairs[0]!.foreignCol;
    // A `.through()` relation keeps the parent key on its junction table: rows are read with
    // the junction joined in and grouped by its source column. `null` is a junction this
    // resolver cannot express (composite keys); the eager path still serves that relation.
    const junction = extractJunctionColumns(relEntry);
    const groupCols = junction ? [junction.sourceCol] : joinPairs.map((pair) => pair.foreignCol);
    const groupKeys = junction ? [PARENT_KEY] : joinPairs.map((pair) => pair.foreignColPropName);
    // The junction's schema key, which its own `scope` and soft delete are configured under: a
    // link the junction's policies drop links nothing — see `junctionPolicy`.
    const junctionName = junction ? junctionTableName(tables, relEntry) : undefined;
    // The relation's own `where`, which drizzle applies on the eager path.
    const ownCondition = relationOwnCondition(
      relEntry,
      parentTable,
      targetTable,
      joinPairs.map((pair) => pair.localCol),
      groupCols,
    );
    // The mode this field reads its target with when the request passes no `deleted` — see
    // `relationDeletedDefault`. Required to-one relations and `scope: 'root'` tables read
    // marked rows; everything else keeps hiding them.
    const defaultDeleted = relationDeletedDefault(
      policies?.softDelete,
      targetTableName,
      isOne && (relEntry.relation as any)?.optional === false,
    );
    // A relation field is bounded by the policy of the table it reads, not the parent's, with
    // `limits.relations` layered over it when configured.
    const limitPolicy = isOne ? undefined : limits?.(targetTableName, { parent: tableName, name: relationName });
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
        tables,
        namedRelations: filterCtx?.namedRelations,
      });

      const targetColumns = getColumns(targetTable);
      for (const pair of joinPairs) {
        columns[pair.foreignColPropName] = pair.foreignCol;
      }
      for (const [columnName] of cursorEntries ?? []) {
        const column = targetColumns[columnName];
        if (column) {
          columns[columnName] = column;
        }
      }
      return cursorEntries ? { ...columns, ...cursorPreciseSelection(targetTable, cursorEntries) } : columns;
    };

    const resolve = async (parent: any, args: any, context: any, info: any) => {
      // Eager path: the parent resolver pre-fetched this relation via Drizzle's `with`.
      if (parent[relationName] !== undefined) {
        return parent[relationName];
      }

      // A null in any join column matches nothing: SQL equality never holds for it.
      const localValues = parentJoinValues(parent, joinPairs);
      if (localValues.some((value) => value == null)) {
        return isOne ? null : [];
      }

      const { where: whereArg, limit: requestedLimit, offset: requestedOffset, after, deleted } = (args ?? {}) as any;
      // `offset: 0` is the same page as no offset, and batches with it.
      const offset = effectiveOffset(requestedOffset);

      // Everything below is derived from this field alone — its args and its selection — so it is
      // identical for every parent row the batch fetches. Resolvers run once per parent row, so it
      // is computed once per field per request and reused, rather than re-reading the selection and
      // re-stringifying the loader key N times.
      // The memo and the loader below belong to this execution, so a reused context or document
      // never serves one execution another's args.
      const execution = executionKey(context, info);
      const { orderByArg, limit, distinct, cursorEntries, cursorValues, columns, loaderKey } = getOrCreateRequestValue(
        execution,
        requestValueNodes(info),
        `relation:${tableName}::${relationName}`,
        () => {
          // A relation field falls back to the *target* table's default ordering, since that is
          // the table it reads. A to-one relation is a single row and takes no ordering at all.
          const orderByArg = isOne
            ? (args as any)?.orderBy
            : withDefaultOrderBy(args ?? {}, targetTableName, policies?.defaultOrderBy).orderBy;
          const limit = applyLimitPolicy(requestedLimit, limitPolicy, errorCtx);
          assertPagingNotNegative({ offset: requestedOffset }, errorCtx);
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
            const cursorObstacle = orderByCursorObstacle(orderByArg);
            if (cursorObstacle) {
              if (after != null) {
                throw drizzleError(cursorObstacle, { code: 'DRIZZLE_INVALID_CURSOR' });
              }
              // `cursor` was selected under an ordering a cursor cannot express — the field
              // resolves to null and the ordering itself still applies.
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

      if (junction === null) {
        throw drizzleError(
          `Relation '${tableName}.${relationName}' goes through a junction with a composite key, which can only be loaded together with its parent. Leave it to eager loading (eagerLoadRelations).`,
          { code: 'DRIZZLE_UNSUPPORTED_RELATION' },
        );
      }

      const loader = getOrCreateLoader(execution, loaderKey, async (parentKeys: readonly (readonly unknown[])[]) => {
        // Loaders are cached per execution, so every call batched here shares this request's
        // executor — the caller's or this execution's auto-transaction, when there is one.
        const executor = resolveExecutor(db, context, info);
        const uniqueKeys = [...new Map(parentKeys.map((key) => [joinKeyOf(key, localCols), key])).values()];
        // Loaders are keyed per execution too, so the scope resolved here is this request's.
        const visibility = visibilityOf?.(context);

        // One query over a group of parents, returning each parent's result by its key. Every
        // parent's rows come from the query its key is in, so splitting the batch changes
        // nothing a parent sees.
        const loadChunk = async (chunkKeys: readonly (readonly unknown[])[]): Promise<Map<string, any>> => {
          let whereCondition = withRowVisibility(
            visibility,
            targetTableName,
            targetTable,
            and(
              parentKeyCondition(groupCols, chunkKeys),
              ownCondition,
              junction ? junctionPolicy(visibility, junctionName, junction.table) : undefined,
              whereArg
                ? extractFilters(
                    targetTable,
                    targetTableName,
                    whereArg,
                    relationFilterCtx(filterCtx, targetTableName, visibility),
                  )
                : undefined,
              cursorValues ? buildCursorCondition(targetTable, cursorEntries!, cursorValues, nullOrdering) : undefined,
            ),
            deleted ?? defaultDeleted,
          );

          if (distinct) {
            // Partitioned by the foreign key as well as the requested columns, so "one row per
            // distinct value" means one per parent — `users { posts(distinct: [status]) }` gives
            // each user one post per status, not one post per status across all users. The batch
            // query is narrowed to the rows the pass keeps by a subquery, as the root list is —
            // through a junction, to the (parent, row) pairs it keeps. Any per-parent limit/offset
            // is then cut from those rows by the batch query's own window, in the same statement.
            whereCondition = and(
              whereCondition,
              distinctRowsCondition({
                db: executor,
                table: targetTable,
                target: targetTable,
                tableName: targetTableName,
                distinct,
                pkNames: targetPkNames,
                where: whereCondition,
                orderBy: orderByArg,
                partitionBy: groupCols,
                junction: junction
                  ? { table: junction.table, on: eq(junction.targetCol, foreignCol), parentKey: junction.sourceCol }
                  : undefined,
              }),
            );
          }

          // A junction relation selects the parent key from the junction under its own alias.
          const selection = junction
            ? { ...(columns ?? getColumns(targetTable)), [PARENT_KEY]: junction.sourceCol }
            : columns;

          let rows: any[];
          if (limit != null || offset != null) {
            // Per-parent pagination across the whole batch in one query. Its window ordering is
            // the request's orderBy plus the primary key, which is the cursor's total order too,
            // so a cursor page and a limit/offset page agree on row order.
            rows = await batchedPaginatedRelationQuery(
              executor,
              targetTable,
              foreignCol,
              groupCols,
              whereCondition,
              orderByArg,
              limit ?? null,
              offset ?? null,
              targetPkNames,
              selection,
              relationFilterCtx(filterCtx, targetTableName, visibility),
              whereArg,
              junction,
            );
          } else {
            // Use plain db.select() so column refs are never aliased — avoids drizzle-orm v1
            // RQB aliasing requirements that would require referencing via aliasedTable proxy.
            let q = withJunction(
              (selection ? executor.select(selection) : executor.select()).from(targetTable),
              junction,
              foreignCol,
            ).where(whereCondition) as any;
            const orderExprs = cursorEntries
              ? cursorOrderExprs(targetTable, cursorEntries)
              : [
                  ...(orderByArg
                    ? extractOrderBy(
                        targetTable,
                        orderByArg,
                        relationFilterCtx(filterCtx, targetTableName, visibility),
                        whereArg,
                      )
                    : []),
                  // The rows a `distinct` pass kept come back in its order — the request's plus
                  // the primary key — as they do on a root list. Any other ordering gets the
                  // cursor's tiebreak, so tied rows come back as they would with `cursor`.
                  ...(distinct
                    ? primaryKeyOrderExprs(targetTable, targetPkNames)
                    : primaryKeyTiebreakExprs(targetTable, orderByArg, targetPkNames)),
                ];
            if (orderExprs.length) {
              q = q.orderBy(...orderExprs);
            }
            rows = await q;
          }

          // Before remapping, which rewrites dates and bigints into their transport forms.
          if (cursorEntries) {
            attachRowCursors(rows, cursorEntries);
          }

          // Group by parent key before remapping (remapping may delete null fields). A junction
          // relation's key is a helper column, dropped once it has been read. A row's parents
          // are the ones the database matched it to (see relatedRowParents).
          const parentsOf = await relatedRowParents(executor, chunkKeys, localCols, groupCols);
          const keysOf = (row: any) => {
            const keys = parentsOf(groupKeys.map((name) => row[name]));
            if (junction) {
              delete row[PARENT_KEY];
            }
            return keys;
          };

          if (isOne) {
            const byKey = new Map<string, any>();
            for (const row of rows) {
              for (const key of keysOf(row)) {
                byKey.set(key, row);
              }
            }
            remapToGraphQLArrayOutput(rows, targetTableName, targetTable);
            return byKey;
          }

          const grouped = new Map<string, any[]>(chunkKeys.map((key) => [joinKeyOf(key, localCols), []]));
          for (const row of rows) {
            for (const key of keysOf(row)) {
              grouped.get(key)?.push(row);
            }
          }
          remapToGraphQLArrayOutput(rows, targetTableName, targetTable);
          return grouped;
        };

        // A large batch is read in groups, so no query binds more parent keys than the
        // dialects accept. The groups run one after another, on the same executor.
        const results = new Map<string, any>();
        for (const chunk of parentKeyChunks(uniqueKeys, groupCols.length)) {
          for (const [key, value] of await loadChunk(chunk)) {
            results.set(key, value);
          }
        }
        return parentKeys.map((key) => results.get(joinKeyOf(key, localCols)) ?? (isOne ? null : []));
      });

      return loader.load(localValues);
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
