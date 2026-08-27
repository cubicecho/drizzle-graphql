// The five write resolvers PostgreSQL and SQLite generate identically.
//
// Both dialects insert/upsert/update/delete through the same drizzle-orm surface, so these
// bodies were duplicated verbatim between pg.ts and sqlite.ts. The only differences were the
// dialect spellings of `db` and `table` and how primary-key prop names are derived — the
// first two collapse into the union/base types below, the third is the factory's parameter.
// MySQL is NOT built from here: its mutations return no rows, so it re-selects after every
// write and its resolvers have a genuinely different shape.

import type { Table } from 'drizzle-orm';
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import {
  GraphQLError,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
} from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
import {
  remapFromGraphQLArrayInput,
  remapFromGraphQLSingleInput,
  remapToGraphQLArrayOutput,
  remapToGraphQLSingleOutput,
} from '../data-mappers/index.ts';
import {
  applyContextValues,
  applyContextValuesAll,
  assertSingleMatch,
  eagerLoadMutationRelations,
  excludedColumnRef,
  extractFilters,
  extractRequiredFilters,
  extractSelectedColumnsFromTreeSQLFormat,
  type LimitPolicyFor,
  type MutationTxCtx,
  type OnConflictArg,
  prepareMutationRelationColumns,
  type RelationFilterBase,
  type ResolverPolicies,
  relationFilterCtx,
  resolveConflictPlan,
  runMutation,
  runWriteHook,
  type SelectionCtx,
  stripContextValues,
  type TypeNameMapper,
  toGraphQLError,
  type WriteOperation,
  withScope,
} from './common.ts';
import { remapUpdateInput } from './field-updates.ts';
import { mergedOps, type NestedWriteRuntime, updateWithNestedOps, writeWithNestedOps } from './nested-writes.ts';
import type { CreatedResolver, Filters, TableNamedRelations } from './types.ts';

/** Every database handle these resolvers can run on. `runMutation` takes `any`, so this is purely a call-site guard. */
export type WriteDatabase = PgAsyncDatabase<any, any> | BaseSQLiteDatabase<any, any, any, any>;

/**
 * The dialect's build-time primary-key lookup (`getTableConfig`-based, so it cannot be shared).
 * Typed on `any` because `PgTable` and `SQLiteTable` are unrelated subtypes of `Table`, and a
 * parameter of the base type would not accept either dialect's narrower function.
 */
export type PrimaryKeyPropNames = (table: any) => string[];

/**
 * Binds the five resolvers to one dialect. Call once per dialect module and destructure the
 * result, so the generator call sites read exactly as they did when the functions were local.
 */
export const buildWriteResolvers = (primaryKeyPropNames: PrimaryKeyPropNames) => {
  const generateInsertArray = (
    db: WriteDatabase,
    tableName: string,
    table: Table,
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
    const pkNames = primaryKeyPropNames(table);
    const hooks = policies?.onWrite?.(tableName, 'insert');

    return {
      name: fieldName,
      resolver: async (_source, args: { values: Record<string, any>[] }, context, info) => {
        try {
          return await runMutation(
            db,
            context,
            info,
            txCtx,
            async (executor) => {
              if (!args.values.length) {
                throw new GraphQLError('No values were provided!');
              }
              await runWriteHook(hooks, 'before', {
                table: tableName,
                operation: 'insert',
                single: false,
                args,
                context,
                info,
                tx: executor,
              });

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
                defaultOrderBy: policies?.defaultOrderBy,
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

              await runWriteHook(hooks, 'after', {
                table: tableName,
                operation: 'insert',
                single: false,
                args,
                rows: result,
                context,
                info,
                tx: executor,
              });

              const enriched = hasRelations
                ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
                : result;

              return remapToGraphQLArrayOutput(enriched, tableName, table, relationMap);
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

  const generateInsertSingle = (
    db: WriteDatabase,
    tableName: string,
    table: Table,
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
    const pkNames = primaryKeyPropNames(table);
    const hooks = policies?.onWrite?.(tableName, 'insert');

    return {
      name: fieldName,
      resolver: async (_source, args: { values: Record<string, any> }, context, info) => {
        try {
          return await runMutation(
            db,
            context,
            info,
            txCtx,
            async (executor) => {
              await runWriteHook(hooks, 'before', {
                table: tableName,
                operation: 'insert',
                single: true,
                args,
                context,
                info,
                tx: executor,
              });
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
                defaultOrderBy: policies?.defaultOrderBy,
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

              await runWriteHook(hooks, 'after', {
                table: tableName,
                operation: 'insert',
                single: true,
                args,
                rows: result,
                context,
                info,
                tx: executor,
              });

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

  /**
   * `upsert<Table>` / `upsert<Table>Single` — an insert that resolves a unique-key conflict
   * the way the request's `onConflict` argument asks, rather than failing.
   *
   * Shares the insert input: an upsert supplies a whole row, same as a create.
   */
  const generateUpsert = (
    db: WriteDatabase,
    tableName: string,
    table: Table,
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

    const pkNames = primaryKeyPropNames(table);
    const hooks = policies?.onWrite?.(tableName, 'upsert');

    return {
      name: fieldName,
      resolver: async (
        _source,
        args: { values: Record<string, any> | Record<string, any>[]; onConflict?: OnConflictArg },
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
              const supplied = single ? [args.values as Record<string, any>] : (args.values as Record<string, any>[]);
              if (!supplied.length) {
                throw new GraphQLError('No values were provided!');
              }
              await runWriteHook(hooks, 'before', {
                table: tableName,
                operation: 'upsert',
                single,
                args,
                context,
                info,
                tx: executor,
              });

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
                defaultOrderBy: policies?.defaultOrderBy,
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
                  buildWhere: (where) =>
                    extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)),
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

              await runWriteHook(hooks, 'after', {
                table: tableName,
                operation: 'upsert',
                single,
                args,
                rows: result,
                context,
                info,
                tx: executor,
              });

              if (single && !result[0]) {
                return undefined;
              }

              const enriched = hasRelations
                ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
                : result;

              return single
                ? remapToGraphQLSingleOutput(enriched[0], tableName, table, relationMap)
                : remapToGraphQLArrayOutput(enriched, tableName, table, relationMap);
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

  const generateUpdate = (
    db: WriteDatabase,
    tableName: string,
    table: Table,
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
    const pkNames = primaryKeyPropNames(table);
    const hooks = policies?.onWrite?.(tableName, 'update');

    return {
      name: fieldName,
      resolver: async (_source, args: { where?: Filters<Table>; set: Record<string, any> }, context, info) => {
        try {
          return await runMutation(
            db,
            context,
            info,
            txCtx,
            async (executor) => {
              const { where, set } = args;
              const scope = policies?.scope?.(context);
              await runWriteHook(hooks, 'before', {
                table: tableName,
                operation: 'update',
                single,
                args,
                context,
                info,
                tx: executor,
              });

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

              const entry = nested?.enabled(tableName) ? nested.split(tableName, set) : undefined;
              const nestedOps = entry && nested!.hasOps(entry.ops) ? entry.ops : undefined;
              // A context-derived column is the server's to set, so an update never reassigns
              // one — that is what stops a row being handed to another owner.
              const input = stripContextValues(
                remapUpdateInput(entry ? entry.columns : set, table, tableName),
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

              const returning = nestedOps
                ? nested!.withJoinColumns(tableName, nestedOps, { ...columns }, table)
                : columns;

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

              await runWriteHook(hooks, 'after', {
                table: tableName,
                operation: 'update',
                single,
                args,
                rows: result,
                context,
                info,
                tx: executor,
              });

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

  /**
   * `delete<Table>` and, for a table that declares a soft-delete column, `restore<Table>`.
   *
   * A soft-deleting table never issues a `DELETE`: both mutations are an `UPDATE` of the marker
   * column, and the rows they return are the rows as they now stand. `restore` is the same
   * resolver reading the other way — it matches only marked rows (`deleted: ONLY`) and writes
   * the restored value.
   */
  const generateDelete = (
    db: WriteDatabase,
    tableName: string,
    table: Table,
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
    const operation: WriteOperation = restore ? 'restore' : 'delete';
    const hooks = policies?.onWrite?.(tableName, operation);
    const queryArgs = {
      where: {
        type: single || requireWhere ? new GraphQLNonNull(filterArgs) : filterArgs,
      },
    } as const satisfies GraphQLFieldConfigArgumentMap;

    return {
      name: fieldName,
      resolver: async (_source, args: { where?: Filters<Table> }, context, info) => {
        try {
          return await runMutation(
            db,
            context,
            info,
            txCtx,
            async (executor) => {
              const { where } = args;
              const scope = policies?.scope?.(context);
              await runWriteHook(hooks, 'before', {
                table: tableName,
                operation,
                single,
                args,
                context,
                info,
                tx: executor,
              });

              const parsedInfo = parseResolveInfo(info, {
                deep: true,
              }) as ResolveTree;

              const columns = extractSelectedColumnsFromTreeSQLFormat(
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

              await runWriteHook(hooks, 'after', {
                table: tableName,
                operation,
                single,
                args,
                rows: result,
                context,
                info,
                tx: executor,
              });

              if (single && result.length > 1) {
                // A row started matching between the pre-check and the write.
                throw new GraphQLError(`${fieldName}: 'where' matched more than one row!`);
              }

              if (single) {
                return result[0] ? remapToGraphQLSingleOutput(result[0], tableName, table) : undefined;
              }

              return remapToGraphQLArrayOutput(result, tableName, table);
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
  return { generateInsertArray, generateInsertSingle, generateUpsert, generateUpdate, generateDelete };
};
