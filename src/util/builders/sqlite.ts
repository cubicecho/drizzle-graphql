// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import { is, One, type Table } from 'drizzle-orm';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import { type BaseSQLiteDatabase, getTableConfig, type SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { GraphQLFieldConfig, GraphQLFieldConfigArgumentMap, GraphQLResolveInfo, ThunkObjMap } from 'graphql';
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
  attachTargetPrimaryKeys,
  bindPolicies,
  buildNamedRelations,
  computeResolverFieldNames,
  createMutationTxCtx,
  createRelationResolverFactory,
  eagerLoadMutationRelations,
  excludedColumnRef,
  extractFilters,
  extractRelationJoinColumns,
  extractRequiredFilters,
  extractSelectedColumnsFromTreeSQLFormat,
  generateDistinctEnum,
  generateOnConflictInput,
  generateTableTypes,
  generateUpdateManyInput,
  getPrimaryKeyPropNamesFromConfig,
  getUniqueColumnSets,
  type LimitPolicyFor,
  listFieldComplexity,
  type MutationTxCtx,
  type OnConflictArg,
  prepareMutationRelationColumns,
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
  db: BaseSQLiteDatabase<any, any, any, any>,
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
  if (!queryBase) {
    throw new Error(
      `Drizzle-GraphQL Error: Table ${tableName} not found in drizzle instance. Did you forget to pass schema to drizzle constructor?`,
    );
  }

  const table = tables[tableName]!;
  const limitPolicy = limits?.(tableName);
  const pkNames = sqlitePrimaryKeyPropNames(table as SQLiteTable);
  const queryArgs = selectArrayArgs(
    orderArgs,
    filterArgs,
    distinctEnabled ? generateDistinctEnum(table, typeName) : undefined,
  );

  return {
    name: fieldName,
    resolver: async (_source: any, args: Partial<TableSelectArgs>, context: any, info: GraphQLResolveInfo) => {
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
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
          limit: applyLimitPolicy(args.limit, limitPolicy, fieldName),
          single: false,
          filterCtx,
          limits,
          pkNames,
          db: executor,
          scope: policies?.scope?.(context),
          // SQLite sorts NULLs as the smallest values (first in ASC).
          nullOrdering: 'nulls-smallest',
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateSelectSingle = (
  db: BaseSQLiteDatabase<any, any, any, any>,
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
  if (!queryBase) {
    throw new Error(
      `Drizzle-GraphQL Error: Table ${tableName} not found in drizzle instance. Did you forget to pass schema to drizzle constructor?`,
    );
  }

  const queryArgs = selectSingleArgs(orderArgs, filterArgs);

  const table = tables[tableName]!;
  const pkNames = sqlitePrimaryKeyPropNames(table as SQLiteTable);

  return {
    name: fieldName,
    resolver: async (_source, args: Partial<TableSelectArgs>, context, info) => {
      try {
        const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
        const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
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
          scope: policies?.scope?.(context),
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

/** Primary-key property names for a SQLite table, including table-level composite keys. */
const sqlitePrimaryKeyPropNames = (table: SQLiteTable): string[] =>
  getPrimaryKeyPropNamesFromConfig(table, getTableConfig);

const generateInsertArray = (
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  table: SQLiteTable,
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
  const pkNames = sqlitePrimaryKeyPropNames(table);

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
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  table: SQLiteTable,
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
  const pkNames = sqlitePrimaryKeyPropNames(table);

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
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  table: SQLiteTable,
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

  const pkNames = sqlitePrimaryKeyPropNames(table);

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
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  table: SQLiteTable,
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
  const pkNames = sqlitePrimaryKeyPropNames(table);

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
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  table: SQLiteTable,
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
  const pkNames = sqlitePrimaryKeyPropNames(table);

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

          const anyNested = entries.some((entry) => entry.ops);
          const returning = anyNested
            ? nested!.withJoinColumns(
                tableName,
                mergedOps(entries.map((entry) => ({ ops: entry.ops ?? {} }))),
                { ...columns },
                table,
              )
            : columns;

          const runEntry = (tx: any, entry: (typeof entries)[number]) => {
            let query = tx.update(table).set(entry.set);
            if (entry.filters) {
              query = query.where(entry.filters);
            }
            // `.all()` instead of awaiting the thenable: a sync driver (better-sqlite3)
            // executes it immediately, which is the only way the statement still runs
            // inside the synchronous native transaction below.
            return query.returning(returning).all();
          };

          // Nested writes need statements interleaved with awaited reads, which only an async
          // driver can do inside a transaction — `features.nestedWrites` rejects a sync driver
          // at build time, so this branch is always on one.
          const runNestedEntry = async (tx: any, entry: (typeof entries)[number]) => {
            const values = entry.ops
              ? { ...entry.set, ...(await nested!.applyParentSide(tx, tableName, entry.ops, context)) }
              : entry.set;

            // Same as the single update: an entry with no column values reads the rows its
            // `where` matched so the nested operations have something to attach to.
            const writes = Object.keys(values).length > 0;
            let query = writes ? tx.update(table).set(values) : tx.select(returning).from(table);
            if (entry.filters) {
              query = query.where(entry.filters);
            }
            const rows = (await (writes ? query.returning(returning) : query)) as Record<string, any>[];

            if (entry.ops) {
              await nested!.applyChildSide(tx, tableName, entry.ops, rows, context);
            }
            return rows;
          };

          // On a caller-supplied transaction — or the shared multi-mutation transaction
          // opened by `runMutation` — this opens a savepoint, so the batch stays atomic
          // without breaking the outer transaction. A sync driver's transaction callback
          // must not be async — it would commit before any awaited statement ran — so the
          // driver kind is probed from the first statement's result instead.
          const perEntry: Record<string, any>[][] = await executor.transaction((tx: any) => {
            if (anyNested) {
              return (async () => {
                const results: Record<string, any>[][] = [];
                for (const entry of entries) {
                  results.push(await runNestedEntry(tx, entry));
                }
                return results;
              })();
            }

            const first = runEntry(tx, entries[0]!);
            if (typeof (first as any)?.then === 'function') {
              // Async driver: await sequentially so the entries apply in input order.
              return (async () => {
                const results: Record<string, any>[][] = [await first];
                for (let i = 1; i < entries.length; i++) {
                  results.push(await runEntry(tx, entries[i]!));
                }
                return results;
              })();
            }
            const results: Record<string, any>[][] = [first];
            for (let i = 1; i < entries.length; i++) {
              results.push(runEntry(tx, entries[i]!));
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
  db: BaseSQLiteDatabase<any, any, any, any>,
  tableName: string,
  table: SQLiteTable,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  single: boolean,
  requireWhere: boolean,
  filterCtx?: RelationFilterBase,
  selectionCtx?: SelectionCtx,
  txCtx?: MutationTxCtx,
  policies?: ResolverPolicies,
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
          const scope = policies?.scope?.(context);

          const parsedInfo = parseResolveInfo(info, {
            deep: true,
          }) as ResolveTree;

          const columns = extractSelectedColumnsFromTreeSQLFormat<SQLiteColumn>(
            parsedInfo.fieldsByTypeName[typeName]!,
            table,
            selectionCtx,
          );

          const relationCtx = relationFilterCtx(filterCtx, tableName);
          // Same rule as update: the scope is ANDed on last, so a delete can only ever reach
          // rows inside it — an out-of-scope row is not matched rather than being refused.
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

export const generateSchemaData = <
  TDrizzleInstance extends BaseSQLiteDatabase<any, any, any, any>,
  TSchema extends Record<string, Table | unknown>,
>(
  db: TDrizzleInstance,
  schema: TSchema,
  relations: TablesRelationalConfig,
  options: SchemaGeneratorOptions,
): GeneratedEntities<TDrizzleInstance, TSchema> => {
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
  const rawSchema = schema;
  const schemaEntries = Object.entries(rawSchema);

  // Excluded tables are dropped here, before anything reads `tableEntries` — which also makes
  // `buildNamedRelations` skip every relation pointing at one, since it resolves targets
  // through this list.
  const excludedTables = new Set(options.exclude?.tables ?? []);
  const tableEntries = schemaEntries.filter(([key, value]) => is(value, SQLiteTable) && !excludedTables.has(key)) as [
    string,
    SQLiteTable,
  ][];
  const tables = Object.fromEntries(tableEntries) as Record<string, SQLiteTable>;

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

  // Build namedRelations from the drizzle-orm v1 relations config.
  const namedRelations = buildNamedRelations(relations ?? {}, tableEntries);
  // Relations *into* an excluded table are already gone (their target no longer resolves);
  // relations *out of* one have no type left to hang a field on.
  for (const excluded of excludedTables) {
    delete namedRelations[excluded];
  }
  // Record each relation target's (composite-aware) primary key for deterministic
  // paginated ordering. Must run before pruning / type generation (shared entry objects).
  attachTargetPrimaryKeys(namedRelations, tables, sqlitePrimaryKeyPropNames);
  // Pruned map for query/mutation resolvers' `with:`; type generation keeps the full map.
  const eagerRelations = pruneNonEagerRelations(namedRelations, shouldEagerLoad);

  const filterCtx: RelationFilterBase = { tables, relationMap: namedRelations };

  // The row scope compiled against this build's relation graph, plus the columns whose value
  // the server supplies. Both stay undefined unless configured.
  const scopes = options.policies?.scope;
  const contextValuesOf = options.policies?.contextValues;
  const policies = bindPolicies(options.policies, filterCtx);

  const resolverFactory: RelationResolverFactory = createRelationResolverFactory(db, tables, filterCtx, limits, scopes);

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
    primaryKeyOf: (name) => (tables[name] ? sqlitePrimaryKeyPropNames(tables[name] as SQLiteTable) : []),
    contextValuesOf,
  };

  // A nested write interleaves reads and writes inside one transaction, which a synchronous
  // driver cannot do — its transaction callback commits before an awaited statement runs.
  if (features.nestedWrites && (db as any).resultKind === 'sync') {
    throw new Error(
      'Drizzle-GraphQL Error: features.nestedWrites requires an asynchronous SQLite driver (e.g. libsql). Synchronous drivers cannot run the multi-statement transaction a nested write needs.',
    );
  }

  // Nested writes: the plans decide which relations are writable at all, the types add their
  // fields to the create/update inputs, and the runtime executes them. All three are left
  // undefined when the feature is off, so the inputs and the resolvers stay as they were.
  const nestedPlans = features.nestedWrites
    ? buildNestedWritePlans(
        tables,
        namedRelations,
        (target) => getUniqueColumnSets(target as SQLiteTable, getTableConfig),
        (target) => sqlitePrimaryKeyPropNames(target as SQLiteTable),
        extractRelationJoinColumns,
      )
    : undefined;
  const nestedTypes = nestedPlans
    ? createNestedWriteTypes({ plans: nestedPlans, cacheCtx, typeNameMapper, insertPrefix: prefixes.insert })
    : undefined;
  const nestedRuntime = nestedPlans
    ? createNestedWriteRuntime({ plans: nestedPlans, filterCtx, scopes, contextValues: contextValuesOf })
    : undefined;

  // Built when at least one table wants relation aggregates; a table that has them off is
  // handed `undefined` below, so `generateTableTypes` emits no `${relation}Aggregate` fields
  // on its object type.
  const relationAggregateFactory: RelationAggregateFactory | undefined = anyTable('relationAggregates')
    ? createRelationAggregateFactory(db, tables, cacheCtx, typeNameMapper, filterCtx, scopes)
    : undefined;

  const queries: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};
  const mutations: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};

  // A synchronous driver (e.g. better-sqlite3) commits the moment its transaction callback
  // returns, so a transaction cannot be held open across resolver calls.
  if (options.transactions && (db as any).resultKind === 'sync') {
    throw new Error(
      "Drizzle-GraphQL Error: transactions: 'auto' requires an asynchronous SQLite driver (e.g. libsql). Synchronous drivers cannot hold a transaction open across resolvers.",
    );
  }
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
    const drizzleMeta = tableFieldExtensions(tableName, sqlitePrimaryKeyPropNames(schema[tableName] as SQLiteTable));
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
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
    const uniqueSets = tableFeatures.upsert
      ? getUniqueColumnSets(schema[tableName] as SQLiteTable, getTableConfig)
      : [];
    const onConflictInput = tableFeatures.upsert
      ? generateOnConflictInput({
          table: schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
    const aggregateType = tableFeatures.aggregates
      ? generateAggregateTypes(schema[tableName] as SQLiteTable, tableName, typeName, cacheCtx)
      : undefined;
    const aggregateGenerated = tableFeatures.aggregates
      ? generateAggregate(
          db,
          tableName,
          schema[tableName] as SQLiteTable,
          typeName,
          aggregateFieldName,
          tableFilters,
          filterCtx,
          scopes,
        )
      : undefined;

    // The grouped result reuses the aggregate output types, so it only exists alongside them.
    const groupByType =
      tableFeatures.aggregates && tableFeatures.groupBy
        ? generateGroupByType(schema[tableName] as SQLiteTable, tableName, typeName, cacheCtx)
        : undefined;
    const groupByEnum = groupByType
      ? generateGroupByEnum(schema[tableName] as SQLiteTable, tableName, typeName)
      : undefined;
    const havingInput = groupByEnum
      ? generateHavingInput(schema[tableName] as SQLiteTable, tableName, typeName)
      : undefined;
    const groupByGenerated =
      groupByType && groupByEnum && havingInput
        ? generateGroupBy(
            db,
            tableName,
            schema[tableName] as SQLiteTable,
            typeName,
            groupByFieldName,
            tableFilters,
            groupByEnum,
            havingInput,
            filterCtx,
            scopes,
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
};
