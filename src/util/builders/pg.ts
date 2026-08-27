// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import { and, getColumns, is, One, type Table, type View } from 'drizzle-orm';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import { getTableConfig, type PgAsyncDatabase, type PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { GraphQLFieldConfig, GraphQLFieldConfigArgumentMap, ThunkObjMap } from 'graphql';
import {
  GraphQLError,
  type GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLObjectType,
} from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
import type { GeneratedEntities } from '../../types.ts';
import {
  aggregateFieldComplexity,
  applyLimitPolicy,
  assertSingleMatch,
  attachRowCursors,
  attachTargetPrimaryKeys,
  buildCursorCondition,
  buildNamedRelations,
  type CursorOrderEntry,
  computeResolverFieldNames,
  createMutationTxCtx,
  createRelationResolverFactory,
  cursorOrderExprs,
  cursorOrderingEntries,
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
  generateWriteCount,
  getPrimaryKeyPropNamesFromConfig,
  getUniqueColumnSets,
  isCursorFieldSelected,
  type LimitPolicyFor,
  listFieldComplexity,
  type MutationTxCtx,
  type OnConflictArg,
  orderByHasRelationEntry,
  prepareMutationRelationColumns,
  primaryKeyOrderExprs,
  primaryKeyRestriction,
  pruneNonEagerRelations,
  type RelationAggregateFactory,
  type RelationFilterBase,
  type RelationResolverFactory,
  relationFilterCtx,
  resolveConflictPlan,
  resolveQueryExecutor,
  runMutation,
  runRelationalSelect,
  type SelectionCtx,
  selectArrayArgs,
  selectDistinctKeys,
  selectSingleArgs,
  type TablesRelationalConfig,
  type TypeCacheCtx,
  type TypeNameMapper,
  toGraphQLError,
} from '../builders/common.ts';
import {
  remapFromGraphQLArrayInput,
  remapFromGraphQLSingleInput,
  remapToGraphQLArrayOutput,
  remapToGraphQLSingleOutput,
} from '../data-mappers/index.ts';
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
import { remapUpdateInput } from './field-updates.ts';
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
  );

  return {
    name: fieldName,
    resolver: async (_source, args: Partial<TableSelectArgs>, context, info) => {
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
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
            // PostgreSQL sorts NULLs as the largest values (last in ASC).
            nullOrdering: 'nulls-largest',
          });
        }

        // Fallback for tables without relational query builder support.
        // Use SQL column objects (not Record<string,true>) so db.select() receives valid expressions.
        const { offset, orderBy, where, distinct, after } = args;
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
          if (orderByHasRelationEntry(orderBy)) {
            if (after != null) {
              throw new GraphQLError(
                "'after' cannot be combined with an orderBy that orders through a relation — a related row's value cannot be encoded into a cursor.",
              );
            }
            // `cursor` selected under a relation ordering — resolves to null; ordering still applies.
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

        const baseWhereSql = where
          ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName))
          : undefined;
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
            ...extractOrderBy(table, orderBy, relationFilterCtx(filterCtx, tableName)),
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
): CreatedResolver => {
  const queryBase = db.query[tableName as keyof typeof db.query] as unknown as
    | RelationalQueryBuilder<any, any, any>
    | undefined;
  // Tables without relations won't have db.query support — fall back to basic select.

  const queryArgs = selectSingleArgs(orderArgs, filterArgs);

  const table = tables[tableName]!;
  const pkNames = pgPrimaryKeyPropNames(table as PgTable);

  return {
    name: fieldName,
    resolver: async (_source, args: Partial<TableSelectArgs>, context, info) => {
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);

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
          });
        }

        // Fallback for tables without relational query builder support.
        const { offset, orderBy, where } = args;
        const selectedColumnsSql = extractSelectedColumnsFromTreeSQLFormat<PgColumn>(
          parsedInfo.fieldsByTypeName[typeName]!,
          table,
          { tableName, relationMap, tables },
        );
        let q = executor.select(selectedColumnsSql).from(table);
        if (where) {
          q = q.where(extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName))) as any;
        }
        if (orderBy) {
          q = q.orderBy(...extractOrderBy(table, orderBy, relationFilterCtx(filterCtx, tableName))) as any;
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
          const input = nestedEntries
            ? []
            : remapFromGraphQLArrayInput(entries ? entries.map((entry) => entry.columns) : args.values, table);

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
                remapValues: (values) => remapFromGraphQLSingleInput(values, table),
                write: (tx, values) => runInsert(tx, [values]),
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
          const input = nestedEntry ? {} : remapFromGraphQLSingleInput(entry ? entry.columns : args.values, table);

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
                remapValues: (values) => remapFromGraphQLSingleInput(values, table),
                write: runInsert,
              })
            : await runInsert(executor, input);

          if (!result[0]) {
            // Only reachable under `conflictDoNothing`, which is why the field is nullable
            // there and non-null everywhere else.
            if (!conflictDoNothing) {
              throw new GraphQLError(`${fieldName}: the insert returned no row.`);
            }
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
          const input = nestedEntries
            ? []
            : remapFromGraphQLArrayInput(entries ? entries.map((entry) => entry.columns) : supplied, table);

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
            query =
              plan.action === 'NOTHING'
                ? (query.onConflictDoNothing(plan.target ? { target: plan.target } : undefined) as any)
                : (query.onConflictDoUpdate({ target: plan.target!, set: plan.set, setWhere: plan.setWhere }) as any);

            return (await query) as Record<string, any>[];
          };

          const result = nestedEntries
            ? await writeWithNestedOps({
                executor,
                runtime: nested!,
                tableName,
                entries: nestedEntries,
                remapValues: (values) => remapFromGraphQLSingleInput(values, table),
                write: (tx, values) => runUpsert(tx, [values]),
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
          });

          const entry = nested?.enabled(tableName) ? nested.split(tableName, set) : undefined;
          const nestedOps = entry && nested!.hasOps(entry.ops) ? entry.ops : undefined;
          const input = remapUpdateInput(entry ? entry.columns : set, table, tableName);
          // A `set` that carries only nested operations is a legitimate update — of the
          // relation rather than of the row — so it is only empty when neither is present.
          if (!Object.keys(input).length && !nestedOps) {
            throw new GraphQLError('Unable to update with no values specified!');
          }

          const relationCtx = relationFilterCtx(filterCtx, tableName);
          const filters =
            single || requireWhere
              ? extractRequiredFilters(table, tableName, where, fieldName, relationCtx)
              : where
                ? extractFilters(table, tableName, where, relationCtx)
                : undefined;

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
          });

          // Remap and validate every entry before the transaction opens, so a malformed
          // entry rejects the request instead of rolling back mid-batch.
          const entries = updates.map(({ where, set }) => {
            const split = nested?.enabled(tableName) ? nested.split(tableName, set) : undefined;
            const ops = split && nested!.hasOps(split.ops) ? split.ops : undefined;
            const input = remapUpdateInput(split ? split.columns : set, table, tableName);
            // An entry that only writes through a relation still has work to do.
            if (!Object.keys(input).length && !ops) {
              throw new GraphQLError('Unable to update with no values specified!');
            }
            return {
              set: input,
              ops,
              filters: where
                ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName))
                : undefined,
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
                ? { ...entry.set, ...(await nested!.applyParentSide(tx, tableName, entry.ops)) }
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
                await nested!.applyChildSide(tx, tableName, entry.ops, rows);
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
): CreatedResolver => {
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

          const parsedInfo = parseResolveInfo(info, {
            deep: true,
          }) as ResolveTree;

          const columns = extractSelectedColumnsFromTreeSQLFormat<PgColumn>(
            parsedInfo.fieldsByTypeName[typeName]!,
            table,
            selectionCtx,
          );

          const relationCtx = relationFilterCtx(filterCtx, tableName);
          const filters =
            single || requireWhere
              ? extractRequiredFilters(table, tableName, where, fieldName, relationCtx)
              : where
                ? extractFilters(table, tableName, where, relationCtx)
                : undefined;

          if (single) {
            await assertSingleMatch(executor, table, filters!, fieldName);
          }

          let query = executor.delete(table);
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
  const tableEntries = schemaEntries.filter(([_key, value]) => is(value, PgTable)) as [string, PgTable][];
  const tables = Object.fromEntries(tableEntries) as Record<string, PgTable>;

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

  // Flatten drizzle-orm v1 TablesRelationalConfig into the canonical shape
  // used throughout common.ts: Record<tableName, Record<relName, TableNamedRelations>>
  const namedRelations = buildNamedRelations(relations ?? {}, tableEntries);
  // Record each relation target's primary key (composite-aware) so paginated relations
  // default to a deterministic PK order. Must run before pruning / type generation, which
  // share these entry objects.
  attachTargetPrimaryKeys(namedRelations, tables, pgPrimaryKeyPropNames);
  // Relations to eager-load via `with:`. Query/mutation resolvers use this pruned map so
  // opted-out relations never overfetch; type generation keeps the full map so their
  // fields still exist and resolve lazily.
  const eagerRelations = pruneNonEagerRelations(namedRelations, shouldEagerLoad);

  const filterCtx: RelationFilterBase = { tables, relationMap: namedRelations };

  const resolverFactory: RelationResolverFactory = createRelationResolverFactory(
    db,
    tables,
    'nulls-largest',
    filterCtx,
    limits,
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
    features,
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
  const nestedRuntime = nestedPlans ? createNestedWriteRuntime({ plans: nestedPlans, filterCtx }) : undefined;

  // Left undefined when the feature is off — generateTableTypes then emits no
  // `${relation}Aggregate` fields at all.
  const relationAggregateFactory: RelationAggregateFactory | undefined = features.relationAggregates
    ? createRelationAggregateFactory(db, tables, cacheCtx, typeNameMapper, filterCtx)
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
        relationAggregateFactory,
        nestedTypes,
      ),
    ]),
  );

  const inputs: Record<string, GraphQLInputObjectType> = {};
  const outputs: Record<string, GraphQLObjectType> = {};

  for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
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
      updateCountFieldName,
      deleteFieldName,
      deleteSingleFieldName,
      deleteCountFieldName,
    } = computeResolverFieldNames(tableName, typeNameMapper, prefixes, suffixes);

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
      features.distinct,
      limits,
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
    );
    const insertArrGenerated = features.insert
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
        )
      : undefined;
    const insertSingleGenerated = features.insert
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
        )
      : undefined;
    // An upsert needs something to conflict on, so a table with no primary key and no
    // unique constraint gets no upsert mutations rather than ones that always fail.
    const uniqueSets = features.upsert ? getUniqueColumnSets(schema[tableName] as PgTable, getTableConfig) : [];
    const onConflictInput = features.upsert
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
        )
      : undefined;
    const updateGenerated = features.update
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
          features.requireWhere,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
          nestedRuntime,
          limits,
        )
      : undefined;
    const updateSingleGenerated = features.update
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
          features.requireWhere,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
          nestedRuntime,
          limits,
        )
      : undefined;
    // The batch update reuses the update `set` input, so it needs `update` on too.
    const updateManyInput =
      features.update && features.updateMany
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
        )
      : undefined;
    const deleteGenerated = features.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as PgTable,
          tableFilters,
          deleteFieldName,
          typeName,
          false,
          features.requireWhere,
          filterCtx,
          { tableName, relationMap: namedRelations, tables },
          mutationTxCtx,
        )
      : undefined;
    const deleteSingleGenerated = features.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as PgTable,
          tableFilters,
          deleteSingleFieldName,
          typeName,
          true,
          features.requireWhere,
          filterCtx,
          { tableName, relationMap: namedRelations, tables },
          mutationTxCtx,
        )
      : undefined;
    // The count variants are the plural write with its payload left off, so each follows the
    // same feature switch as the write it mirrors.
    const updateCountGenerated =
      features.update && features.countMutations
        ? generateWriteCount({
            db,
            tableName,
            table: schema[tableName] as PgTable,
            kind: 'update',
            setArgs: updateInput,
            filterArgs: tableFilters,
            fieldName: updateCountFieldName,
            requireWhere: features.requireWhere,
            filterCtx,
            txCtx: mutationTxCtx,
            nested: nestedRuntime,
          })
        : undefined;
    const deleteCountGenerated =
      features.delete && features.countMutations
        ? generateWriteCount({
            db,
            tableName,
            table: schema[tableName] as PgTable,
            kind: 'delete',
            filterArgs: tableFilters,
            fieldName: deleteCountFieldName,
            requireWhere: features.requireWhere,
            filterCtx,
            txCtx: mutationTxCtx,
          })
        : undefined;
    const aggregateType = features.aggregates
      ? generateAggregateTypes(schema[tableName] as PgTable, tableName, typeName, cacheCtx)
      : undefined;
    const aggregateGenerated = features.aggregates
      ? generateAggregate(
          db,
          tableName,
          schema[tableName] as PgTable,
          typeName,
          aggregateFieldName,
          tableFilters,
          filterCtx,
        )
      : undefined;

    // The grouped result reuses the aggregate output types, so it only exists alongside them.
    const groupByType =
      features.aggregates && features.groupBy
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
          )
        : undefined;

    queries[selectArrGenerated.name] = {
      type: selectArrOutput,
      args: selectArrGenerated.args,
      resolve: selectArrGenerated.resolver,
      ...(complexity ? { extensions: { complexity: listFieldComplexity(complexity, limits?.(tableName)) } } : {}),
    };
    queries[selectSingleGenerated.name] = {
      type: selectSingleOutput,
      args: selectSingleGenerated.args,
      resolve: selectSingleGenerated.resolver,
    };
    if (aggregateGenerated && aggregateType) {
      queries[aggregateGenerated.name] = {
        type: new GraphQLNonNull(aggregateType),
        args: aggregateGenerated.args,
        resolve: aggregateGenerated.resolver,
        ...(complexity ? { extensions: { complexity: aggregateFieldComplexity(complexity) } } : {}),
      };
    }
    if (groupByGenerated && groupByType) {
      queries[groupByGenerated.name] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(groupByType))),
        args: groupByGenerated.args,
        resolve: groupByGenerated.resolver,
        ...(complexity ? { extensions: { complexity: aggregateFieldComplexity(complexity) } } : {}),
      };
    }
    if (insertArrGenerated) {
      mutations[insertArrGenerated.name] = {
        type: arrTableItemOutput,
        args: insertArrGenerated.args,
        resolve: insertArrGenerated.resolver,
      };
    }
    if (insertSingleGenerated) {
      mutations[insertSingleGenerated.name] = {
        // An insert either returns the row it inserted or throws — the one path to `null` is
        // `conflictDoNothing` swallowing the insert, so the field is nullable only there.
        type: conflictDoNothing ? singleTableItemOutput : new GraphQLNonNull(singleTableItemOutput),
        args: insertSingleGenerated.args,
        resolve: insertSingleGenerated.resolver,
      };
    }
    if (upsertArrGenerated) {
      mutations[upsertArrGenerated.name] = {
        type: arrTableItemOutput,
        args: upsertArrGenerated.args,
        resolve: upsertArrGenerated.resolver,
      };
    }
    if (upsertSingleGenerated) {
      mutations[upsertSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: upsertSingleGenerated.args,
        resolve: upsertSingleGenerated.resolver,
      };
    }
    if (updateGenerated) {
      mutations[updateGenerated.name] = {
        type: arrTableItemOutput,
        args: updateGenerated.args,
        resolve: updateGenerated.resolver,
      };
    }
    if (updateManyGenerated) {
      mutations[updateManyGenerated.name] = {
        type: new GraphQLNonNull(new GraphQLList(singleTableItemOutput)),
        args: updateManyGenerated.args,
        resolve: updateManyGenerated.resolver,
        // The nullable element is deliberate, and the reason this mutation's return type
        // differs from every sibling's: the result is aligned with the input, one slot per
        // entry, so an entry that matched nothing has to be able to say so.
        description:
          "Each entry's updated rows, in entry order. An entry whose `where` matched no rows contributes `null` in its slot; an entry that matched several contributes each of its rows.",
      };
    }
    if (updateSingleGenerated) {
      mutations[updateSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: updateSingleGenerated.args,
        resolve: updateSingleGenerated.resolver,
      };
    }
    if (deleteGenerated) {
      mutations[deleteGenerated.name] = {
        type: arrTableItemOutput,
        args: deleteGenerated.args,
        resolve: deleteGenerated.resolver,
      };
    }
    if (deleteSingleGenerated) {
      mutations[deleteSingleGenerated.name] = {
        type: singleTableItemOutput,
        args: deleteSingleGenerated.args,
        resolve: deleteSingleGenerated.resolver,
      };
    }
    if (updateCountGenerated) {
      mutations[updateCountGenerated.name] = {
        type: new GraphQLNonNull(GraphQLInt),
        args: updateCountGenerated.args,
        resolve: updateCountGenerated.resolver,
        description:
          'How many rows the update touched. The rows themselves are not read back, which is the point of this mutation.',
      };
    }
    if (deleteCountGenerated) {
      mutations[deleteCountGenerated.name] = {
        type: new GraphQLNonNull(GraphQLInt),
        args: deleteCountGenerated.args,
        resolve: deleteCountGenerated.resolver,
        description:
          'How many rows the delete removed. The rows themselves are not read back, which is the point of this mutation.',
      };
    }
    // The insert/update inputs are still built (they type the mutations that survive) but
    // only reach the schema's type map when a mutation actually references them.
    const activeInputs = [
      // The insert input types the upsert mutations too, so either feature keeps it.
      ...(features.insert || onConflictInput ? [insertInput] : []),
      ...(onConflictInput ? [onConflictInput] : []),
      ...(features.update ? [updateInput] : []),
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
