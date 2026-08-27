import { and, getColumns, type Table } from 'drizzle-orm';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import { getTableConfig, type PgAsyncDatabase, type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { GraphQLFieldConfigArgumentMap } from 'graphql';
import { GraphQLError, type GraphQLInputObjectType, GraphQLList, GraphQLNonNull } from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
import type { GeneratedEntities } from '../../types.ts';
import {
  applyLimitPolicy,
  attachRowCursors,
  buildCursorCondition,
  type CursorOrderEntry,
  cursorOrderExprs,
  cursorOrderingEntries,
  type DeletedMode,
  decodeCursor,
  eagerLoadMutationRelations,
  extractFilters,
  extractOrderBy,
  extractSelectedColumnsFromTreeSQLFormat,
  generateDistinctEnum,
  getPrimaryKeyPropNamesFromConfig,
  isCursorFieldSelected,
  type LimitPolicyFor,
  type MutationTxCtx,
  orderByCursorObstacle,
  prepareMutationRelationColumns,
  primaryKeyOrderExprs,
  primaryKeyRestriction,
  type RelationFilterBase,
  type ResolverPolicies,
  relationFilterCtx,
  resolveQueryExecutor,
  runMutation,
  runRelationalSelect,
  runWriteHook,
  selectArrayArgs,
  selectDistinctKeys,
  selectSingleArgs,
  stripContextValues,
  type TablesRelationalConfig,
  type TypeNameMapper,
  toGraphQLError,
  withDefaultOrderBy,
  withScope,
} from '../builders/common.ts';
import { remapToGraphQLArrayOutput, remapToGraphQLSingleOutput } from '../data-mappers/index.ts';
import { remapUpdateInput } from './field-updates.ts';
import { mergedOps, type NestedWriteRuntime } from './nested-writes.ts';
import { createSchemaDataGenerator } from './schema-data.ts';
import type {
  CreatedResolver,
  Filters,
  SchemaGeneratorOptions,
  TableNamedRelations,
  TableSelectArgs,
} from './types.ts';

const generateSelectArray = (
  db: PgAsyncDatabase<any, any>,
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  distinctEnabled: boolean = true,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryBase = db.query[tableName as keyof typeof db.query & string] as unknown as
    | RelationalQueryBuilder<any, any, any>
    | undefined;
  // Tables without relations won't have db.query support — fall back to basic select.

  const table = tables[tableName]!;
  const limitPolicy = limits?.(tableName);
  const pkNames = pgPrimaryKeyPropNames(table as PgTable);
  const queryArgs = selectArrayArgs(
    orderArgs,
    filterArgs,
    distinctEnabled ? generateDistinctEnum(table, typeName) : undefined,
    policies?.softDelete,
    tableName,
  );

  return {
    name: fieldName,
    resolver: async (_source, rawArgs: Partial<TableSelectArgs>, context, info) => {
      // An omitted `orderBy` falls back to the table's configured default ordering here,
      // before anything reads the arguments — the cursor tuple, a `distinct` pass and the
      // plain-select fallback all have to agree on one effective ordering.
      const args = withDefaultOrderBy(rawArgs, tableName, policies?.defaultOrderBy);
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
        const scope = policies?.scope?.(context);
        // Resolved once here so the relational path and the plain-select fallback below both
        // see the same effective limit.
        const limit = applyLimitPolicy(args.limit, limitPolicy, fieldName);

        if (requestQueryBase) {
          return await runRelationalSelect({
            queryBase: requestQueryBase,
            tables,
            tableName,
            table,
            relationMap,
            typeName,
            typeNameMapper,
            parsedInfo,
            ...args,
            limit,
            single: false,
            filterCtx,
            limits,
            defaultOrderBy: policies?.defaultOrderBy,
            pkNames,
            db: executor,
            scope,
            // PostgreSQL sorts NULLs as the largest values (last in ASC).
            nullOrdering: 'nulls-largest',
          });
        }

        // Fallback for tables without relational query builder support.
        // Use SQL column objects (not Record<string,true>) so db.select() receives valid expressions.
        const { offset, orderBy, where, distinct, after, deleted } = args as Partial<TableSelectArgs> & {
          deleted?: DeletedMode;
        };
        const selectedColumnsSql = extractSelectedColumnsFromTreeSQLFormat<PgColumn>(
          parsedInfo.fieldsByTypeName[typeName]!,
          table,
          { tableName, relationMap, tables },
        );

        // Keyset pagination (see runRelationalSelect, which handles the RQB path).
        const cursorSelected = isCursorFieldSelected(parsedInfo.fieldsByTypeName[typeName], table);
        let cursorEntries: CursorOrderEntry[] | undefined;
        if (after != null || cursorSelected) {
          if (after != null && distinct?.length) {
            throw new GraphQLError("'after' cannot be combined with 'distinct'.");
          }
          const cursorObstacle = orderByCursorObstacle(orderBy);
          if (cursorObstacle) {
            if (after != null) {
              throw new GraphQLError(cursorObstacle);
            }
            // `cursor` selected under an ordering a cursor cannot express — resolves to null;
            // the ordering itself still applies.
          } else if (!pkNames.length) {
            if (after != null) {
              throw new GraphQLError(
                `Table ${tableName} has no primary key, so cursor pagination cannot be used on it.`,
              );
            }
          } else {
            cursorEntries = cursorOrderingEntries(orderBy, pkNames);
            if (cursorSelected) {
              // The whole ordering tuple is needed to compute each row's cursor.
              const allColumns = getColumns(table);
              for (const [column] of cursorEntries) {
                selectedColumnsSql[column] ??= allColumns[column] as PgColumn;
              }
            }
          }
        }
        const cursorCondition =
          after != null && cursorEntries
            ? buildCursorCondition(table, cursorEntries, decodeCursor(after, cursorEntries), 'nulls-largest')
            : undefined;

        const baseWhereSql = withScope(
          scope,
          tableName,
          table,
          where ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)) : undefined,
          deleted,
        );
        const whereSql = cursorCondition ? and(baseWhereSql, cursorCondition) : baseWhereSql;

        // `distinct` picks the surviving rows in its own pass; the main query is then narrowed
        // to those primary keys and re-orders them the same way. See runRelationalSelect.
        let distinctKeys: Record<string, any>[] | undefined;
        if (distinct?.length) {
          distinctKeys = await selectDistinctKeys({
            db: executor,
            table,
            tableName,
            distinct,
            pkNames,
            where: whereSql,
            orderBy,
            limit,
            offset,
          });
          if (!distinctKeys.length) {
            return [];
          }
        }

        let q = executor.select(selectedColumnsSql).from(table);
        if (distinctKeys) {
          q = q.where(primaryKeyRestriction(table, pkNames, distinctKeys)) as any;
        } else if (whereSql) {
          q = q.where(whereSql) as any;
        }
        if (cursorEntries && !distinctKeys) {
          // Cursor pagination pages over a total order: orderBy plus the PK tiebreak.
          q = q.orderBy(...cursorOrderExprs(table, cursorEntries)) as any;
        } else if (orderBy) {
          q = q.orderBy(
            ...extractOrderBy(table, orderBy, relationFilterCtx(filterCtx, tableName), where),
            ...(distinctKeys ? primaryKeyOrderExprs(table, pkNames) : []),
          ) as any;
        } else if ((distinctKeys || offset != null || limit != null) && pkNames.length) {
          // See runRelationalSelect: an unordered slice is not stable between requests.
          q = q.orderBy(...primaryKeyOrderExprs(table, pkNames)) as any;
        }
        if (!distinctKeys) {
          if (offset) {
            q = q.offset(offset) as any;
          }
          if (limit) {
            q = q.limit(limit) as any;
          }
        }
        const rows = await q;
        if (cursorEntries && cursorSelected) {
          attachRowCursors(rows, cursorEntries);
        }
        return remapToGraphQLArrayOutput(rows, tableName, table, relationMap);
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateSelectSingle = (
  db: PgAsyncDatabase<any, any>,
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryBase = db.query[tableName as keyof typeof db.query & string] as unknown as
    | RelationalQueryBuilder<any, any, any>
    | undefined;
  // Tables without relations won't have db.query support — fall back to basic select.

  const queryArgs = selectSingleArgs(orderArgs, filterArgs, policies?.softDelete, tableName);

  const table = tables[tableName]!;
  const pkNames = pgPrimaryKeyPropNames(table as PgTable);

  return {
    name: fieldName,
    resolver: async (_source, rawArgs: Partial<TableSelectArgs>, context, info) => {
      // An omitted `orderBy` falls back to the table's configured default ordering here,
      // before anything reads the arguments — the cursor tuple, a `distinct` pass and the
      // plain-select fallback all have to agree on one effective ordering.
      const args = withDefaultOrderBy(rawArgs, tableName, policies?.defaultOrderBy);
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
        const scope = policies?.scope?.(context);

        if (requestQueryBase) {
          return await runRelationalSelect({
            queryBase: requestQueryBase,
            tables,
            tableName,
            table,
            relationMap,
            typeName,
            typeNameMapper,
            parsedInfo,
            ...args,
            single: true,
            filterCtx,
            limits,
            defaultOrderBy: policies?.defaultOrderBy,
            pkNames,
            db: executor,
            scope,
          });
        }

        // Fallback for tables without relational query builder support.
        const { offset, orderBy, where, deleted } = args as Partial<TableSelectArgs> & { deleted?: DeletedMode };
        const selectedColumnsSql = extractSelectedColumnsFromTreeSQLFormat<PgColumn>(
          parsedInfo.fieldsByTypeName[typeName]!,
          table,
          { tableName, relationMap, tables },
        );
        let q = executor.select(selectedColumnsSql).from(table);
        const whereSql = withScope(
          scope,
          tableName,
          table,
          where ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)) : undefined,
          deleted,
        );
        if (whereSql) {
          q = q.where(whereSql) as any;
        }
        if (orderBy) {
          q = q.orderBy(...extractOrderBy(table, orderBy, relationFilterCtx(filterCtx, tableName), where)) as any;
        } else if (pkNames.length) {
          // A single query is an implicit `limit 1` — order it so the row is deterministic.
          q = q.orderBy(...primaryKeyOrderExprs(table, pkNames)) as any;
        }
        if (offset) {
          q = q.offset(offset) as any;
        }
        const rows = await q.limit(1);
        const result = rows[0];
        return result ? remapToGraphQLSingleOutput(result, tableName, table, relationMap) : undefined;
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

/** Primary-key property names for a PG table, including table-level composite keys. */
const pgPrimaryKeyPropNames = (table: PgTable): string[] => getPrimaryKeyPropNamesFromConfig(table, getTableConfig);

/**
 * `update<Table>Many` — batch update with a per-entry `set` and `where`.
 *
 * The entries run as one UPDATE statement each, in input order, inside a single
 * transaction (a savepoint when the request context already carries one), so a failing
 * entry rolls the whole batch back and a row matched by several entries sees them applied
 * in order. The result lists each entry's updated rows in entry order, with `null`
 * standing in for an entry whose `where` matched no rows, so the common one-row-per-entry
 * case stays aligned with the input.
 */
const generateUpdateMany = (
  db: PgAsyncDatabase<any, any>,
  tableName: string,
  table: PgTable,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  updateManyInput: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
  nested?: NestedWriteRuntime,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs = {
    updates: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(updateManyInput))),
    },
  } as const satisfies GraphQLFieldConfigArgumentMap;

  // Derived once at build time — PK prop names don't change per request.
  const pkNames = pgPrimaryKeyPropNames(table);
  const hooks = policies?.onWrite?.(tableName, 'updateMany');

  return {
    name: fieldName,
    resolver: async (
      _source,
      args: { updates: { where?: Filters<Table>; set: Record<string, any> }[] },
      context,
      info,
    ) => {
      try {
        return await runMutation(
          db,
          context,
          info,
          txCtx,
          async (executor) => {
            const { updates } = args;
            if (!updates.length) {
              throw new GraphQLError('No updates were provided!');
            }
            await runWriteHook(hooks, 'before', {
              table: tableName,
              operation: 'updateMany',
              single: false,
              args,
              context,
              info,
              tx: executor,
            });
            const scope = policies?.scope?.(context);
            const contextColumns = policies?.contextValues?.(tableName);

            const parsedInfo = parseResolveInfo(info, {
              deep: true,
            }) as ResolveTree;

            const { columns, hasRelations, withParams } = prepareMutationRelationColumns({
              relationMap,
              tables,
              tableName,
              typeName,
              typeNameMapper,
              table,
              pkNames,
              parsedInfo,
              limits,
              scope,
              defaultOrderBy: policies?.defaultOrderBy,
            });

            // Remap and validate every entry before the transaction opens, so a malformed
            // entry rejects the request instead of rolling back mid-batch.
            const entries = updates.map(({ where, set }) => {
              const split = nested?.enabled(tableName) ? nested.split(tableName, set) : undefined;
              const ops = split && nested!.hasOps(split.ops) ? split.ops : undefined;
              const input = stripContextValues(
                remapUpdateInput(split ? split.columns : set, table, tableName),
                contextColumns,
              );
              // An entry that only writes through a relation still has work to do.
              if (!Object.keys(input).length && !ops) {
                throw new GraphQLError('Unable to update with no values specified!');
              }
              return {
                set: input,
                ops,
                filters: withScope(
                  scope,
                  tableName,
                  table,
                  where ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)) : undefined,
                ),
              };
            });

            const returning = entries.some((entry) => entry.ops)
              ? nested!.withJoinColumns(
                  tableName,
                  mergedOps(entries.map((entry) => ({ ops: entry.ops ?? {} }))),
                  {
                    ...columns,
                  },
                  table,
                )
              : columns;

            // On a caller-supplied transaction — or the shared multi-mutation transaction
            // opened by `runMutation` — this opens a savepoint, so the batch stays atomic
            // without breaking the outer transaction.
            const perEntry: Record<string, any>[][] = await executor.transaction(async (tx: any) => {
              const results: Record<string, any>[][] = [];
              for (const entry of entries) {
                const values = entry.ops
                  ? { ...entry.set, ...(await nested!.applyParentSide(tx, tableName, entry.ops, context)) }
                  : entry.set;

                // Same as the single update: an entry with no column values reads the rows its
                // `where` matched so the nested operations have something to attach to.
                const writes = Object.keys(values).length > 0;
                let query = writes ? tx.update(table).set(values) : tx.select(returning).from(table);
                if (entry.filters) {
                  query = query.where(entry.filters) as any;
                }
                const rows = (await (writes ? (query.returning(returning) as any) : query)) as Record<string, any>[];

                if (entry.ops) {
                  await nested!.applyChildSide(tx, tableName, entry.ops, rows, context);
                }
                results.push(rows);
              }
              return results;
            });

            const flatRows = perEntry.flat();
            await runWriteHook(hooks, 'after', {
              table: tableName,
              operation: 'updateMany',
              single: false,
              args,
              rows: flatRows,
              context,
              info,
              tx: executor,
            });

            const enriched = hasRelations
              ? await eagerLoadMutationRelations(executor, tableName, flatRows, pkNames, withParams)
              : flatRows;

            // Rebuild the per-entry slots: a no-match entry contributes `null`, a multi-match
            // entry contributes each of its rows.
            const output: (Record<string, any> | null)[] = [];
            let offset = 0;
            for (const rows of perEntry) {
              if (!rows.length) {
                output.push(null);
                continue;
              }
              for (let i = 0; i < rows.length; i++) {
                output.push(remapToGraphQLSingleOutput(enriched[offset + i], tableName, table, relationMap));
              }
              offset += rows.length;
            }
            return output;
          },
          !!hooks,
        );
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const pgSchemaData = createSchemaDataGenerator({
  tableClass: PgTable,
  getTableConfig,
  primaryKeyPropNames: pgPrimaryKeyPropNames,
  // PostgreSQL sorts NULLs as the largest values (last in ASC).
  nullOrdering: 'nulls-largest',
  generateSelectArray,
  generateSelectSingle,
  generateUpdateMany,
});

export const generateSchemaData = <
  TDrizzleInstance extends PgAsyncDatabase<any, any>,
  TSchema extends Record<string, Table | unknown>,
>(
  db: TDrizzleInstance,
  schema: TSchema,
  relations: TablesRelationalConfig,
  options: SchemaGeneratorOptions,
): GeneratedEntities<TDrizzleInstance, TSchema> => pgSchemaData(db, schema, relations, options);
