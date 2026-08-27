// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import { and, getColumns, is, One, type Table, type View } from 'drizzle-orm';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import { getTableConfig, type PgAsyncDatabase, type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { GraphQLFieldConfig, GraphQLFieldConfigArgumentMap, ThunkObjMap } from 'graphql';
import {
  GraphQLError,
  type GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLObjectType,
} from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
import type { GeneratedEntities } from '../../types.ts';
import {
  aggregateFieldComplexity,
  applyContextValues,
  applyContextValuesAll,
  applyLimitPolicy,
  assertSingleMatch,
  attachRowCursors,
  attachTargetPrimaryKeys,
  bindPolicies,
  buildCursorCondition,
  buildNamedRelations,
  type CursorOrderEntry,
  computeResolverFieldNames,
  createMutationTxCtx,
  createRelationResolverFactory,
  cursorOrderExprs,
  cursorOrderingEntries,
  type DeletedMode,
  decodeCursor,
  eagerLoadMutationRelations,
  excludedColumnRef,
  extractFilters,
  extractOrderBy,
  extractRelationJoinColumns,
  extractRequiredFilters,
  extractSelectedColumnsFromTreeSQLFormat,
  generateDistinctEnum,
  generateOnConflictInput,
  generateTableTypes,
  generateUpdateManyInput,
  getPrimaryKeyPropNamesFromConfig,
  getUniqueColumnSets,
  isCursorFieldSelected,
  type LimitPolicyFor,
  listFieldComplexity,
  type MutationTxCtx,
  type OnConflictArg,
  orderByCursorObstacle,
  prepareMutationRelationColumns,
  primaryKeyOrderExprs,
  primaryKeyRestriction,
  pruneNonEagerRelations,
  type RelationAggregateFactory,
  type RelationFilterBase,
  type RelationResolverFactory,
  type ResolverPolicies,
  registerColumnExclusions,
  relationFilterCtx,
  resolveConflictPlan,
  resolveQueryExecutor,
  runMutation,
  runRelationalSelect,
  type SelectionCtx,
  selectArrayArgs,
  selectDistinctKeys,
  selectSingleArgs,
  stripContextValues,
  type TablesRelationalConfig,
  type TypeCacheCtx,
  type TypeNameMapper,
  toGraphQLError,
  withScope,
} from '../builders/common.ts';
import {
  remapFromGraphQLArrayInput,
  remapFromGraphQLSingleInput,
  remapToGraphQLArrayOutput,
  remapToGraphQLSingleOutput,
} from '../data-mappers/index.ts';
import { tableFieldExtensions } from '../extensions.ts';
import { resolveTableFeatures } from '../features.ts';
import { registerEnumConfig, registerScalarOverrides } from '../type-converter/index.ts';
import {
  createRelationAggregateFactory,
  generateAggregate,
  generateAggregateTypes,
  generateGroupBy,
  generateGroupByEnum,
  generateGroupByType,
  generateHavingInput,
} from './aggregates.ts';
import {
  buildNestedWritePlans,
  createNestedWriteRuntime,
  createNestedWriteTypes,
  mergedOps,
  type NestedWriteRuntime,
  updateWithNestedOps,
  writeWithNestedOps,
} from './nested-writes.ts';
import type {
  CreatedResolver,
  Filters,
  SchemaGeneratorOptions,
  TableFeatures,
  TableNamedRelations,
  TableSelectArgs,
} from './types.ts';

const generateSelectArray = (
  db: PgAsyncDatabase<any, any, any>,
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
  const queryBase = db.query[tableName as keyof typeof db.query] as unknown as
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
    resolver: async (_source, args: Partial<TableSelectArgs>, context, info) => {
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
  db: PgAsyncDatabase<any, any, any>,
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
  const queryBase = db.query[tableName as keyof typeof db.query] as unknown as
    | RelationalQueryBuilder<any, any, any>
    | undefined;
  // Tables without relations won't have db.query support — fall back to basic select.

  const queryArgs = selectSingleArgs(orderArgs, filterArgs, policies?.softDelete, tableName);

  const table = tables[tableName]!;
  const pkNames = pgPrimaryKeyPropNames(table as PgTable);

  return {
    name: fieldName,
    resolver: async (_source, args: Partial<TableSelectArgs>, context, info) => {
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

const generateInsertArray = (
  db: PgAsyncDatabase<any, any, any>,
  tableName: string,
  table: PgTable,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  baseType: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  conflictDoNothing: boolean = false,
  txCtx?: MutationTxCtx,
  nested?: NestedWriteRuntime,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(baseType))),
    },
  };

  // Primary-key prop names are constant per table — derive them once at build time
  // rather than re-running getTableConfig on every mutation request.
  const pkNames = pgPrimaryKeyPropNames(table);

  return {
    name: fieldName,
    resolver: async (_source, args: { values: Record<string, any>[] }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          if (!args.values.length) {
            throw new GraphQLError('No values were provided!');
          }

          // Split each row's relation fields off its columns. Only when something is actually
          // nested does the write leave the single multi-row statement below.
          const entries = nested?.enabled(tableName)
            ? args.values.map((values) => nested.split(tableName, values))
            : undefined;
          const nestedEntries = entries?.some((entry) => nested!.hasOps(entry.ops)) ? entries : undefined;
          const contextColumns = policies?.contextValues?.(tableName);
          const scope = policies?.scope?.(context);
          const input = nestedEntries
            ? []
            : applyContextValuesAll(
                remapFromGraphQLArrayInput(entries ? entries.map((entry) => entry.columns) : args.values, table),
                contextColumns,
                context,
              );

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
          });

          const returning = nestedEntries
            ? nested!.withJoinColumns(tableName, mergedOps(nestedEntries), { ...columns }, table)
            : columns;

          const runInsert = async (target: any, values: Record<string, any>[]) => {
            let query = target.insert(table).values(values).returning(returning);
            if (conflictDoNothing) {
              query = query.onConflictDoNothing() as any;
            }
            return (await query) as Record<string, any>[];
          };

          const result = nestedEntries
            ? await writeWithNestedOps({
                executor,
                runtime: nested!,
                tableName,
                entries: nestedEntries,
                remapValues: (values) =>
                  applyContextValues(remapFromGraphQLSingleInput(values, table), contextColumns, context),
                write: (tx, values) => runInsert(tx, [values]),
                context,
              })
            : await runInsert(executor, input);

          const enriched = hasRelations
            ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
            : result;

          return remapToGraphQLArrayOutput(enriched, tableName, table, relationMap);
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateInsertSingle = (
  db: PgAsyncDatabase<any, any, any>,
  tableName: string,
  table: PgTable,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  baseType: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  conflictDoNothing: boolean = false,
  txCtx?: MutationTxCtx,
  nested?: NestedWriteRuntime,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: new GraphQLNonNull(baseType),
    },
  };

  // Derived once at build time — PK prop names don't change per request.
  const pkNames = pgPrimaryKeyPropNames(table);

  return {
    name: fieldName,
    resolver: async (_source, args: { values: Record<string, any> }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const entry = nested?.enabled(tableName) ? nested.split(tableName, args.values) : undefined;
          const nestedEntry = entry && nested!.hasOps(entry.ops) ? entry : undefined;
          const contextColumns = policies?.contextValues?.(tableName);
          const scope = policies?.scope?.(context);
          const input = nestedEntry
            ? {}
            : applyContextValues(
                remapFromGraphQLSingleInput(entry ? entry.columns : args.values, table),
                contextColumns,
                context,
              );

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
          });

          const returning = nestedEntry
            ? nested!.withJoinColumns(tableName, nestedEntry.ops, { ...columns }, table)
            : columns;

          const runInsert = async (target: any, values: Record<string, any>) => {
            let query = target.insert(table).values(values).returning(returning);
            if (conflictDoNothing) {
              query = query.onConflictDoNothing() as any;
            }
            return (await query) as Record<string, any>[];
          };

          const result = nestedEntry
            ? await writeWithNestedOps({
                executor,
                runtime: nested!,
                tableName,
                entries: [nestedEntry],
                remapValues: (values) =>
                  applyContextValues(remapFromGraphQLSingleInput(values, table), contextColumns, context),
                write: runInsert,
                context,
              })
            : await runInsert(executor, input);

          if (!result[0]) {
            return undefined;
          }

          const enriched = hasRelations
            ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
            : result;

          return remapToGraphQLSingleOutput(enriched[0], tableName, table, relationMap);
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

/**
 * `upsert<Table>` / `upsert<Table>Single` — an insert that resolves a unique-key conflict
 * the way the request's `onConflict` argument asks, rather than failing.
 *
 * Shares the insert input: an upsert supplies a whole row, same as a create.
 */
const generateUpsert = (
  db: PgAsyncDatabase<any, any, any>,
  tableName: string,
  table: PgTable,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  baseType: GraphQLInputObjectType,
  onConflictType: GraphQLInputObjectType,
  uniqueSets: string[][],
  fieldName: string,
  typeName: string,
  single: boolean,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
  nested?: NestedWriteRuntime,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: single ? new GraphQLNonNull(baseType) : new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(baseType))),
    },
    onConflict: {
      type: onConflictType,
      description: 'How a conflicting row is resolved. Defaults to overwriting it on the primary key.',
    },
  };

  const pkNames = pgPrimaryKeyPropNames(table);

  return {
    name: fieldName,
    resolver: async (
      _source,
      args: { values: Record<string, any> | Record<string, any>[]; onConflict?: OnConflictArg },
      context,
      info,
    ) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const supplied = single ? [args.values as Record<string, any>] : (args.values as Record<string, any>[]);
          if (!supplied.length) {
            throw new GraphQLError('No values were provided!');
          }

          const entries = nested?.enabled(tableName)
            ? supplied.map((values) => nested.split(tableName, values))
            : undefined;
          const nestedEntries = entries?.some((entry) => nested!.hasOps(entry.ops)) ? entries : undefined;
          const contextColumns = policies?.contextValues?.(tableName);
          const scope = policies?.scope?.(context);
          const input = nestedEntries
            ? []
            : applyContextValuesAll(
                remapFromGraphQLArrayInput(entries ? entries.map((entry) => entry.columns) : supplied, table),
                contextColumns,
                context,
              );

          const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;

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
          });

          const returning = nestedEntries
            ? nested!.withJoinColumns(tableName, mergedOps(nestedEntries), { ...columns }, table)
            : columns;

          // The conflict plan reads the columns the write actually supplies, so a nested write
          // — whose rows go in one at a time, each already carrying whatever its parent-side
          // operations produced — resolves its plan per row rather than once for the batch.
          const runUpsert = async (target: any, values: Record<string, any>[]) => {
            const plan = resolveConflictPlan({
              table,
              values,
              onConflict: args.onConflict,
              pkNames,
              uniqueSets,
              excludedRef: excludedColumnRef,
              withTarget: true,
              buildWhere: (where) => extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)),
            });

            let query = target.insert(table).values(values).returning(returning);
            // On conflict the statement updates a row that already exists, so the scope applies
            // to it exactly as it would to `update<Table>`: a conflicting row the caller cannot
            // see is left alone rather than taken over.
            const setWhere = withScope(scope, tableName, table, plan.setWhere);
            query =
              plan.action === 'NOTHING'
                ? (query.onConflictDoNothing(plan.target ? { target: plan.target } : undefined) as any)
                : (query.onConflictDoUpdate({ target: plan.target!, set: plan.set, setWhere }) as any);

            return (await query) as Record<string, any>[];
          };

          const result = nestedEntries
            ? await writeWithNestedOps({
                executor,
                runtime: nested!,
                tableName,
                entries: nestedEntries,
                remapValues: (values) =>
                  applyContextValues(remapFromGraphQLSingleInput(values, table), contextColumns, context),
                write: (tx, values) => runUpsert(tx, [values]),
                context,
              })
            : await runUpsert(executor, input);

          if (single && !result[0]) {
            return undefined;
          }

          const enriched = hasRelations
            ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
            : result;

          return single
            ? remapToGraphQLSingleOutput(enriched[0], tableName, table, relationMap)
            : remapToGraphQLArrayOutput(enriched, tableName, table, relationMap);
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateUpdate = (
  db: PgAsyncDatabase<any, any, any>,
  tableName: string,
  table: PgTable,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  setArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  single: boolean,
  requireWhere: boolean,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
  nested?: NestedWriteRuntime,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs = {
    set: {
      type: new GraphQLNonNull(setArgs),
    },
    where: {
      type: single || requireWhere ? new GraphQLNonNull(filterArgs) : filterArgs,
    },
  } as const satisfies GraphQLFieldConfigArgumentMap;

  // Derived once at build time — PK prop names don't change per request.
  const pkNames = pgPrimaryKeyPropNames(table);

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table>; set: Record<string, any> }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const { where, set } = args;
          const scope = policies?.scope?.(context);

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
          });

          const entry = nested?.enabled(tableName) ? nested.split(tableName, set) : undefined;
          const nestedOps = entry && nested!.hasOps(entry.ops) ? entry.ops : undefined;
          // A context-derived column is the server's to set, so an update never reassigns
          // one — that is what stops a row being handed to another owner.
          const input = stripContextValues(
            remapFromGraphQLSingleInput(entry ? entry.columns : set, table),
            policies?.contextValues?.(tableName),
          );
          // A `set` that carries only nested operations is a legitimate update — of the
          // relation rather than of the row — so it is only empty when neither is present.
          if (!Object.keys(input).length && !nestedOps) {
            throw new GraphQLError('Unable to update with no values specified!');
          }

          const relationCtx = relationFilterCtx(filterCtx, tableName);
          // The scope is ANDed on last, so a caller-supplied `where` can only narrow it.
          const filters = withScope(
            scope,
            tableName,
            table,
            single || requireWhere
              ? extractRequiredFilters(table, tableName, where, fieldName, relationCtx)
              : where
                ? extractFilters(table, tableName, where, relationCtx)
                : undefined,
          );

          if (single) {
            await assertSingleMatch(executor, table, filters!, fieldName);
          }

          const returning = nestedOps ? nested!.withJoinColumns(tableName, nestedOps, { ...columns }, table) : columns;

          const runUpdate = async (target: any, values: Record<string, any>) => {
            // Nothing to write to the row itself: the operations attach to whatever the
            // `where` matched, so the rows are read rather than rewritten.
            const writes = Object.keys(values).length > 0;
            let query = writes ? target.update(table).set(values) : target.select(returning).from(table);
            if (filters) {
              query = query.where(filters) as any;
            }
            return (await (writes ? (query.returning(returning) as any) : query)) as Record<string, any>[];
          };

          const result = nestedOps
            ? await updateWithNestedOps({
                executor,
                runtime: nested!,
                tableName,
                columns: input,
                ops: nestedOps,
                remapValues: (values) => values,
                write: runUpdate,
                context,
              })
            : await runUpdate(executor, input);

          if (single && result.length > 1) {
            // A row started matching between the pre-check and the write.
            throw new GraphQLError(`${fieldName}: 'where' matched more than one row!`);
          }

          if (single && !result[0]) {
            return undefined;
          }

          const enriched = hasRelations
            ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
            : result;

          return single
            ? remapToGraphQLSingleOutput(enriched[0], tableName, table, relationMap)
            : remapToGraphQLArrayOutput(enriched, tableName, table, relationMap);
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

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
  db: PgAsyncDatabase<any, any, any>,
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

  return {
    name: fieldName,
    resolver: async (
      _source,
      args: { updates: { where?: Filters<Table>; set: Record<string, any> }[] },
      context,
      info,
    ) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const { updates } = args;
          if (!updates.length) {
            throw new GraphQLError('No updates were provided!');
          }
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
          });

          // Remap and validate every entry before the transaction opens, so a malformed
          // entry rejects the request instead of rolling back mid-batch.
          const entries = updates.map(({ where, set }) => {
            const split = nested?.enabled(tableName) ? nested.split(tableName, set) : undefined;
            const ops = split && nested!.hasOps(split.ops) ? split.ops : undefined;
            const input = stripContextValues(
              remapFromGraphQLSingleInput(split ? split.columns : set, table),
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
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

/**
 * `delete<Table>` and, for a table that declares a soft-delete column, `restore<Table>`.
 *
 * A soft-deleting table never issues a `DELETE`: both mutations are an `UPDATE` of the marker
 * column, and the rows they return are the rows as they now stand. `restore` is the same
 * resolver reading the other way — it matches only marked rows (`deleted: ONLY`) and writes
 * the restored value.
 */
const generateDelete = (
  db: PgAsyncDatabase<any, any, any>,
  tableName: string,
  table: PgTable,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  single: boolean,
  requireWhere: boolean,
  filterCtx?: RelationFilterBase,
  selectionCtx?: SelectionCtx,
  txCtx?: MutationTxCtx,
  policies?: ResolverPolicies,
  restore: boolean = false,
): CreatedResolver => {
  const softDelete = policies?.softDelete?.(tableName);
  const queryArgs = {
    where: {
      type: single || requireWhere ? new GraphQLNonNull(filterArgs) : filterArgs,
    },
  } as const satisfies GraphQLFieldConfigArgumentMap;

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table> }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const { where } = args;
          const scope = policies?.scope?.(context);

          const parsedInfo = parseResolveInfo(info, {
            deep: true,
          }) as ResolveTree;

          const columns = extractSelectedColumnsFromTreeSQLFormat<PgColumn>(
            parsedInfo.fieldsByTypeName[typeName]!,
            table,
            selectionCtx,
          );

          const relationCtx = relationFilterCtx(filterCtx, tableName);
          // Same rule as update: the scope is ANDed on last, so a delete can only ever reach
          // rows inside it — an out-of-scope row is not matched rather than being refused.
          // A soft-deleting table adds the marker predicate the same way: `delete` only sees
          // rows that are not already marked, `restore` only sees the ones that are.
          const filters = withScope(
            scope,
            tableName,
            table,
            single || requireWhere
              ? extractRequiredFilters(table, tableName, where, fieldName, relationCtx)
              : where
                ? extractFilters(table, tableName, where, relationCtx)
                : undefined,
            restore ? 'ONLY' : undefined,
          );

          if (single) {
            await assertSingleMatch(executor, table, filters!, fieldName);
          }

          let query = softDelete
            ? executor
                .update(table)
                .set({ [softDelete.columnName]: restore ? softDelete.writeRestored : softDelete.writeDeleted() })
            : executor.delete(table);
          if (filters) {
            query = query.where(filters) as any;
          }

          query = query.returning(columns) as any;

          const result = await query;

          if (single && result.length > 1) {
            // A row started matching between the pre-check and the write.
            throw new GraphQLError(`${fieldName}: 'where' matched more than one row!`);
          }

          if (single) {
            return result[0] ? remapToGraphQLSingleOutput(result[0], tableName, table) : undefined;
          }

          return remapToGraphQLArrayOutput(result, tableName, table);
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

type SchemaEntry = Table<any> | View<string, boolean, any>;

export function generateSchemaData<
  TDrizzleInstance extends PgAsyncDatabase<any, any>,
  TRelations extends TablesRelationalConfig,
  TSchema extends Record<string, SchemaEntry>,
>(
  db: TDrizzleInstance,
  schema: TSchema,
  relations: TRelations,
  options: SchemaGeneratorOptions,
): GeneratedEntities<TDrizzleInstance, TSchema> {
  const {
    relationsDepthLimit,
    prefixes,
    suffixes,
    conflictDoNothing,
    typeNameMapper,
    shouldEagerLoad,
    features,
    complexity,
    limits,
  } = options;
  const schemaEntries = Object.entries(schema);
  // Excluded tables are dropped here, before anything reads `tableEntries` — which also makes
  // `buildNamedRelations` skip every relation pointing at one, since it resolves targets
  // through this list.
  const excludedTables = new Set(options.exclude?.tables ?? []);
  const tableEntries = schemaEntries.filter(([key, value]) => is(value, PgTable) && !excludedTables.has(key)) as [
    string,
    PgTable,
  ][];
  const tables = Object.fromEntries(tableEntries) as Record<string, PgTable>;

  // A feature flag may be a per-table predicate, so every flag is resolved against the table
  // it applies to. `anyTable` answers the build-wide question — whether machinery shared
  // across tables is worth constructing at all.
  const featureOf = resolveTableFeatures(features);
  const anyTable = (feature: keyof TableFeatures) => tableEntries.some(([name]) => featureOf(name)[feature]);

  if (!tableEntries.length) {
    throw new Error(
      "Drizzle-GraphQL Error: No tables detected in Drizzle-ORM's database instance. Did you forget to pass schema to drizzle constructor?",
    );
  }

  // Resolve scalar overrides into the type-converter's registry before any type generation —
  // every subsequent column→GraphQL type decision and runtime value remap consults it.
  registerScalarOverrides(tables, options);
  // Same lifecycle: the enum registry is per-build, so a second build never reuses the first
  // build's enum types (and with them its naming decisions).
  registerEnumConfig(options);
  // And the same for column exclusions: a per-build registry read by every site that decides
  // what the schema contains, reset here so a rebuild never inherits the previous build's.
  registerColumnExclusions(tables, options.exclude);

  // Flatten drizzle-orm v1 TablesRelationalConfig into the canonical shape
  // used throughout common.ts: Record<tableName, Record<relName, TableNamedRelations>>
  const namedRelations = buildNamedRelations(relations ?? {}, tableEntries);
  // Relations *into* an excluded table are already gone (their target no longer resolves);
  // relations *out of* one have no type left to hang a field on.
  for (const excluded of excludedTables) {
    delete namedRelations[excluded];
  }
  // Record each relation target's primary key (composite-aware) so paginated relations
  // default to a deterministic PK order. Must run before pruning / type generation, which
  // share these entry objects.
  attachTargetPrimaryKeys(namedRelations, tables, pgPrimaryKeyPropNames);
  // Relations to eager-load via `with:`. Query/mutation resolvers use this pruned map so
  // opted-out relations never overfetch; type generation keeps the full map so their
  // fields still exist and resolve lazily.
  const eagerRelations = pruneNonEagerRelations(namedRelations, shouldEagerLoad);

  const filterCtx: RelationFilterBase = { tables, relationMap: namedRelations };

  // The row scope compiled against this build's relation graph, plus the columns whose value
  // the server supplies. Both stay undefined unless configured.
  const tablePolicies = options.policies;
  const contextValuesOf = tablePolicies?.contextValues;
  const softDeleteOf = tablePolicies?.softDelete;
  const policies = bindPolicies(tablePolicies, filterCtx);

  const resolverFactory: RelationResolverFactory = createRelationResolverFactory(
    db,
    tables,
    filterCtx,
    limits,
    tablePolicies,
  );

  // Fresh cache per generateSchemaData call — prevents type name collisions
  // when buildSchema() is called multiple times.
  const cacheCtx: TypeCacheCtx = {
    genericFilterCache: new Map(),
    objectTypeCache: new Map(),
    relationFieldContainers: new Map(),
    fullyBuiltTables: new Set(),
    relationTypeCache: new Map(),
    selectFieldCache: new WeakMap(),
    filterFieldCache: new WeakMap(),
    orderTypeCache: new WeakMap(),
    filterTypeCache: new WeakMap(),
    listRelationFilterCache: new Map(),
    aggregateTypeCache: new Map(),
    complexity,
    limits,
    docs: options.docs ?? {},
    primaryKeyOf: (name) => (tables[name] ? pgPrimaryKeyPropNames(tables[name] as PgTable) : []),
    contextValuesOf,
    softDeleteOf,
  };

  // Nested writes: the plans decide which relations are writable at all, the types add their
  // fields to the create/update inputs, and the runtime executes them. All three are left
  // undefined when the feature is off, so the inputs and the resolvers stay as they were.
  const nestedPlans = features.nestedWrites
    ? buildNestedWritePlans(
        tables,
        namedRelations,
        (target) => getUniqueColumnSets(target as PgTable, getTableConfig),
        (target) => pgPrimaryKeyPropNames(target as PgTable),
        extractRelationJoinColumns,
      )
    : undefined;
  const nestedTypes = nestedPlans
    ? createNestedWriteTypes({ plans: nestedPlans, cacheCtx, typeNameMapper, insertPrefix: prefixes.insert })
    : undefined;
  const nestedRuntime = nestedPlans
    ? createNestedWriteRuntime({
        plans: nestedPlans,
        filterCtx,
        policies: tablePolicies,
        contextValues: contextValuesOf,
      })
    : undefined;

  // Built when at least one table wants relation aggregates; a table that has them off is
  // handed `undefined` below, so `generateTableTypes` emits no `${relation}Aggregate` fields
  // on its object type.
  const relationAggregateFactory: RelationAggregateFactory | undefined = anyTable('relationAggregates')
    ? createRelationAggregateFactory(db, tables, cacheCtx, typeNameMapper, filterCtx, tablePolicies)
    : undefined;

  const queries: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};
  const mutations: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};

  // Shared per-request transaction machinery for multi-mutation documents; undefined
  // unless `transactions: 'auto'`. Its field-name set is filled once all mutations exist.
  const mutationTxCtx = createMutationTxCtx(options.transactions);

  const gqlSchemaTypes = Object.fromEntries(
    Object.entries(tables).map(([tableName, _table]) => [
      tableName,
      generateTableTypes(
        tableName,
        tables,
        namedRelations,
        true,
        relationsDepthLimit,
        cacheCtx,
        typeNameMapper,
        prefixes.insert,
        prefixes.update,
        resolverFactory,
        featureOf(tableName).relationAggregates ? relationAggregateFactory : undefined,
        nestedTypes,
      ),
    ]),
  );

  const inputs: Record<string, GraphQLInputObjectType> = {};
  const outputs: Record<string, GraphQLObjectType> = {};

  for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
    // Everything this table generates, with any per-table predicate already run.
    const tableFeatures = featureOf(tableName);
    // What every field this table generates publishes about itself under `extensions.drizzle`,
    // so a wrapper can read a field's identity instead of parsing its configurable name.
    const drizzleMeta = tableFieldExtensions(tableName, pgPrimaryKeyPropNames(schema[tableName] as PgTable));
    const { insertInput, updateInput, tableFilters, tableOrder } = tableTypes.inputs;
    const { selectSingleOutput, selectArrOutput, singleTableItemOutput, arrTableItemOutput } = tableTypes.outputs;

    // Compute field names using the mapper logic
    const {
      typeName,
      listFieldName,
      singleFieldName,
      aggregateFieldName,
      groupByFieldName,
      createArrayFieldName,
      createSingleFieldName,
      upsertArrayFieldName,
      upsertSingleFieldName,
      updateFieldName,
      updateManyFieldName,
      updateSingleFieldName,
      deleteFieldName,
      deleteSingleFieldName,
      restoreFieldName,
      restoreSingleFieldName,
    } = computeResolverFieldNames(tableName, typeNameMapper, prefixes, suffixes);
    // A table that marks rows deleted instead of removing them also gets the mutation that
    // reverses it — clearing the column through an ordinary update is not possible, since the
    // column is not in the update input and a marked row is invisible to a `where` anyway.
    const softDeleteInfo = softDeleteOf?.(tableName);

    const selectArrGenerated = generateSelectArray(
      db,
      tableName,
      tables,
      eagerRelations,
      tableOrder,
      tableFilters,
      listFieldName,
      typeName,
      typeNameMapper,
      filterCtx,
      tableFeatures.distinct,
      limits,
      policies,
    );
    const selectSingleGenerated = generateSelectSingle(
      db,
      tableName,
      tables,
      eagerRelations,
      tableOrder,
      tableFilters,
      singleFieldName,
      typeName,
      typeNameMapper,
      filterCtx,
      limits,
      policies,
    );
    const insertArrGenerated = tableFeatures.insert
      ? generateInsertArray(
          db,
          tableName,
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          insertInput,
          createArrayFieldName,
          typeName,
          typeNameMapper,
          conflictDoNothing,
          mutationTxCtx,
          nestedRuntime,
          limits,
          policies,
        )
      : undefined;
    const insertSingleGenerated = tableFeatures.insert
      ? generateInsertSingle(
          db,
          tableName,
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          insertInput,
          createSingleFieldName,
          typeName,
          typeNameMapper,
          conflictDoNothing,
          mutationTxCtx,
          nestedRuntime,
          limits,
          policies,
        )
      : undefined;
    // An upsert needs something to conflict on, so a table with no primary key and no
    // unique constraint gets no upsert mutations rather than ones that always fail.
    const uniqueSets = tableFeatures.upsert ? getUniqueColumnSets(schema[tableName] as PgTable, getTableConfig) : [];
    const onConflictInput = tableFeatures.upsert
      ? generateOnConflictInput({
          table: schema[tableName] as PgTable,
          typeName,
          uniqueSets,
          tableFilters,
          withTarget: true,
        })
      : undefined;
    const upsertArrGenerated = onConflictInput
      ? generateUpsert(
          db,
          tableName,
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          insertInput,
          onConflictInput,
          uniqueSets,
          upsertArrayFieldName,
          typeName,
          false,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
          nestedRuntime,
          limits,
          policies,
        )
      : undefined;
    const upsertSingleGenerated = onConflictInput
      ? generateUpsert(
          db,
          tableName,
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          insertInput,
          onConflictInput,
          uniqueSets,
          upsertSingleFieldName,
          typeName,
          true,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
          nestedRuntime,
          limits,
          policies,
        )
      : undefined;
    const updateGenerated = tableFeatures.update
      ? generateUpdate(
          db,
          tableName,
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          updateInput,
          tableFilters,
          updateFieldName,
          typeName,
          false,
          tableFeatures.requireWhere,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
          nestedRuntime,
          limits,
          policies,
        )
      : undefined;
    const updateSingleGenerated = tableFeatures.update
      ? generateUpdate(
          db,
          tableName,
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          updateInput,
          tableFilters,
          updateSingleFieldName,
          typeName,
          true,
          tableFeatures.requireWhere,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
          nestedRuntime,
          limits,
          policies,
        )
      : undefined;
    // The batch update reuses the update `set` input, so it needs `update` on too.
    const updateManyInput =
      tableFeatures.update && tableFeatures.updateMany
        ? generateUpdateManyInput({ typeName, updatePrefix: prefixes.update, updateInput, tableFilters })
        : undefined;
    const updateManyGenerated = updateManyInput
      ? generateUpdateMany(
          db,
          tableName,
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          updateManyInput,
          updateManyFieldName,
          typeName,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
          nestedRuntime,
          limits,
          policies,
        )
      : undefined;
    const deleteGenerated = tableFeatures.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as PgTable,
          tableFilters,
          deleteFieldName,
          typeName,
          false,
          tableFeatures.requireWhere,
          filterCtx,
          { tableName, relationMap: namedRelations, tables },
          mutationTxCtx,
          policies,
        )
      : undefined;
    const deleteSingleGenerated = tableFeatures.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as PgTable,
          tableFilters,
          deleteSingleFieldName,
          typeName,
          true,
          tableFeatures.requireWhere,
          filterCtx,
          { tableName, relationMap: namedRelations, tables },
          mutationTxCtx,
          policies,
        )
      : undefined;
    const restoreGenerated = softDeleteInfo
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as PgTable,
          tableFilters,
          restoreFieldName,
          typeName,
          false,
          tableFeatures.requireWhere,
          filterCtx,
          { tableName, relationMap: namedRelations, tables },
          mutationTxCtx,
          policies,
          true,
        )
      : undefined;
    const restoreSingleGenerated = softDeleteInfo
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as PgTable,
          tableFilters,
          restoreSingleFieldName,
          typeName,
          true,
          tableFeatures.requireWhere,
          filterCtx,
          { tableName, relationMap: namedRelations, tables },
          mutationTxCtx,
          policies,
          true,
        )
      : undefined;
    const aggregateType = tableFeatures.aggregates
      ? generateAggregateTypes(schema[tableName] as PgTable, tableName, typeName, cacheCtx)
      : undefined;
    const aggregateGenerated = tableFeatures.aggregates
      ? generateAggregate(
          db,
          tableName,
          schema[tableName] as PgTable,
          typeName,
          aggregateFieldName,
          tableFilters,
          filterCtx,
          tablePolicies,
        )
      : undefined;

    // The grouped result reuses the aggregate output types, so it only exists alongside them.
    const groupByType =
      tableFeatures.aggregates && tableFeatures.groupBy
        ? generateGroupByType(schema[tableName] as PgTable, tableName, typeName, cacheCtx)
        : undefined;
    const groupByEnum = groupByType
      ? generateGroupByEnum(schema[tableName] as PgTable, tableName, typeName)
      : undefined;
    const havingInput = groupByEnum
      ? generateHavingInput(schema[tableName] as PgTable, tableName, typeName)
      : undefined;
    const groupByGenerated =
      groupByType && groupByEnum && havingInput
        ? generateGroupBy(
            db,
            tableName,
            schema[tableName] as PgTable,
            typeName,
            groupByFieldName,
            tableFilters,
            groupByEnum,
            havingInput,
            filterCtx,
            tablePolicies,
          )
        : undefined;

    queries[selectArrGenerated.name] = {
      type: selectArrOutput,
      args: selectArrGenerated.args,
      resolve: selectArrGenerated.resolver,
      extensions: {
        drizzle: drizzleMeta({ kind: 'query', operation: 'select', single: false, targetArg: 'where' }),
        ...(complexity ? { complexity: listFieldComplexity(complexity, limits?.(tableName)) } : {}),
      },
    };
    queries[selectSingleGenerated.name] = {
      type: selectSingleOutput,
      args: selectSingleGenerated.args,
      resolve: selectSingleGenerated.resolver,
      extensions: {
        drizzle: drizzleMeta({ kind: 'query', operation: 'select', single: true, targetArg: 'where' }),
      },
    };
    if (aggregateGenerated && aggregateType) {
      queries[aggregateGenerated.name] = {
        type: new GraphQLNonNull(aggregateType),
        args: aggregateGenerated.args,
        resolve: aggregateGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'aggregate', operation: 'aggregate', single: true, targetArg: 'where' }),
          ...(complexity ? { complexity: aggregateFieldComplexity(complexity) } : {}),
        },
      };
    }
    if (groupByGenerated && groupByType) {
      queries[groupByGenerated.name] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(groupByType))),
        args: groupByGenerated.args,
        resolve: groupByGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'aggregate', operation: 'groupBy', single: false, targetArg: 'where' }),
          ...(complexity ? { complexity: aggregateFieldComplexity(complexity) } : {}),
        },
      };
    }
    if (insertArrGenerated) {
      mutations[insertArrGenerated.name] = {
        type: arrTableItemOutput,
        args: insertArrGenerated.args,
        resolve: insertArrGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'insert', single: false, targetArg: 'values' }),
        },
      };
    }
    if (insertSingleGenerated) {
      mutations[insertSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: insertSingleGenerated.args,
        resolve: insertSingleGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'insert', single: true, targetArg: 'values' }),
        },
      };
    }
    if (upsertArrGenerated) {
      mutations[upsertArrGenerated.name] = {
        type: arrTableItemOutput,
        args: upsertArrGenerated.args,
        resolve: upsertArrGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'upsert', single: false, targetArg: 'values' }),
        },
      };
    }
    if (upsertSingleGenerated) {
      mutations[upsertSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: upsertSingleGenerated.args,
        resolve: upsertSingleGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'upsert', single: true, targetArg: 'values' }),
        },
      };
    }
    if (updateGenerated) {
      mutations[updateGenerated.name] = {
        type: arrTableItemOutput,
        args: updateGenerated.args,
        resolve: updateGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'update', single: false, targetArg: 'where' }),
        },
      };
    }
    if (updateManyGenerated) {
      mutations[updateManyGenerated.name] = {
        // Nullable items: a no-match entry yields `null` in its slot.
        type: new GraphQLNonNull(new GraphQLList(singleTableItemOutput)),
        args: updateManyGenerated.args,
        resolve: updateManyGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'updateMany', single: false, targetArg: 'updates' }),
        },
      };
    }
    if (updateSingleGenerated) {
      mutations[updateSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: updateSingleGenerated.args,
        resolve: updateSingleGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'update', single: true, targetArg: 'where' }),
        },
      };
    }
    if (deleteGenerated) {
      mutations[deleteGenerated.name] = {
        type: arrTableItemOutput,
        args: deleteGenerated.args,
        resolve: deleteGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'delete', single: false, targetArg: 'where' }),
        },
      };
    }
    if (deleteSingleGenerated) {
      mutations[deleteSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: deleteSingleGenerated.args,
        resolve: deleteSingleGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'delete', single: true, targetArg: 'where' }),
        },
      };
    }
    if (restoreGenerated) {
      mutations[restoreGenerated.name] = {
        type: arrTableItemOutput,
        args: restoreGenerated.args,
        resolve: restoreGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'restore', single: false, targetArg: 'where' }),
        },
      };
    }
    if (restoreSingleGenerated) {
      mutations[restoreSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: restoreSingleGenerated.args,
        resolve: restoreSingleGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'mutation', operation: 'restore', single: true, targetArg: 'where' }),
        },
      };
    }
    // The insert/update inputs are still built (they type the mutations that survive) but
    // only reach the schema's type map when a mutation actually references them.
    const activeInputs = [
      // The insert input types the upsert mutations too, so either feature keeps it.
      ...(tableFeatures.insert || onConflictInput ? [insertInput] : []),
      ...(onConflictInput ? [onConflictInput] : []),
      ...(tableFeatures.update ? [updateInput] : []),
      ...(updateManyInput ? [updateManyInput] : []),
      tableFilters,
      tableOrder,
    ];
    activeInputs.forEach((e) => {
      inputs[e.name] = e;
    });
    outputs[selectSingleOutput.name] = selectSingleOutput;
    outputs[singleTableItemOutput.name] = singleTableItemOutput;
    if (aggregateType) {
      outputs[aggregateType.name] = aggregateType;
    }
    if (groupByType && havingInput) {
      outputs[groupByType.name] = groupByType;
      inputs[havingInput.name] = havingInput;
    }
  }

  // Every generated mutation name is now known — the first mutation resolver of a request
  // uses this set to count the document's root mutation fields (and to leave documents
  // containing consumer-added mutations alone).
  if (mutationTxCtx) {
    for (const name of Object.keys(mutations)) {
      mutationTxCtx.fieldNames.add(name);
    }
  }

  const fieldResolvers: Record<string, Record<string, any>> = {};
  for (const [tableName, tableRelations] of Object.entries(namedRelations)) {
    const relResolvers: Record<string, any> = {};
    for (const [relName, relEntry] of Object.entries(tableRelations)) {
      const isOne = is((relEntry as any).relation ?? relEntry, One);
      const resolver = resolverFactory({ tableName, relationName: relName, relEntry, isOne });
      if (resolver) {
        relResolvers[relName] = resolver;
      }
    }
    if (Object.keys(relResolvers).length > 0) {
      fieldResolvers[tableName] = relResolvers;
    }
  }

  return { queries, mutations, inputs, types: outputs, fieldResolvers } as any;
}
