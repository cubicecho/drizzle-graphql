// The five write resolvers PostgreSQL and SQLite generate identically.
//
// Both dialects insert/upsert/update/delete through the same drizzle-orm surface, so these
// bodies were duplicated verbatim between pg.ts and sqlite.ts. The only differences were the
// dialect spellings of `db` and `table` and how primary-key prop names are derived — the
// first two collapse into the union/base types below, the third is the factory's parameter.
// MySQL is NOT built from here: it has no RETURNING clause, so where these bodies read their
// rows back out of the statement, MySQL's report `{ isSuccess }` — a genuinely different
// shape, not a spelling difference. What all three dialects do share is the scaffolding
// around the statement (hooks, transaction, error context), which lives in
// `common/write-scaffold.ts` and wraps every body below.

import type { Table } from 'drizzle-orm';
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core';
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core';
import { type GraphQLFieldConfigArgumentMap, type GraphQLInputObjectType, GraphQLList, GraphQLNonNull } from 'graphql';
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
  applyObjectTypeName,
  assertSingleMatch,
  drizzleError,
  eagerLoadMutationRelations,
  excludedColumnRef,
  extractFilters,
  extractRequiredFilters,
  extractSelectedColumnsFromTreeSQLFormat,
  hardDeleteArg,
  type LimitPolicyFor,
  type MutationTxCtx,
  type OnConflictArg,
  prepareMutationRelationColumns,
  type RelationFilterBase,
  type ResolverPolicies,
  relationFilterCtx,
  resolveConflictPlan,
  type SelectionCtx,
  stripContextValues,
  type TypeNameMapper,
  type TypeNameResolver,
  type WriteOperation,
  withScope,
  writeResolver,
} from './common.ts';
import { remapUpdateInput } from './field-updates.ts';
import { mergedOps, type NestedWriteRuntime, updateWithNestedOps, writeWithNestedOps } from './nested-writes.ts';
import type { CreatedResolver, Filters, TableNamedRelations } from './types.ts';

/** Every database handle these resolvers can run on. `runMutation` takes `any`, so this is purely a call-site guard. */
export type WriteDatabase = PgAsyncDatabase<any, any> | SQLiteAsyncDatabase<any, any, any>;

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
    /** The build's type-naming rule — the resolve tree is keyed by the names it produced. */
    resolveName?: TypeNameResolver,
  ): CreatedResolver => {
    const queryArgs: GraphQLFieldConfigArgumentMap = {
      values: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(baseType))),
      },
    };

    // Primary-key prop names are constant per table — derive them once at build time
    // rather than re-running getTableConfig on every mutation request.
    const pkNames = primaryKeyPropNames(table);

    return writeResolver<{ values: Record<string, any>[] }>({
      db,
      tableName,
      operation: 'insert',
      single: false,
      fieldName,
      txCtx,
      policies,
      args: queryArgs,
      run: async ({ executor, args, context, info, before, after }) => {
        if (!args.values.length) {
          throw drizzleError('No values were provided!', { code: 'DRIZZLE_NO_VALUES' });
        }
        await before();

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
          resolveName,
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

        await after(result);

        const enriched = hasRelations
          ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
          : result;

        return remapToGraphQLArrayOutput(enriched, tableName, table, relationMap);
      },
    });
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
    /** The build's type-naming rule — the resolve tree is keyed by the names it produced. */
    resolveName?: TypeNameResolver,
  ): CreatedResolver => {
    const queryArgs: GraphQLFieldConfigArgumentMap = {
      values: {
        type: new GraphQLNonNull(baseType),
      },
    };

    // Derived once at build time — PK prop names don't change per request.
    const pkNames = primaryKeyPropNames(table);

    return writeResolver<{ values: Record<string, any> }>({
      db,
      tableName,
      operation: 'insert',
      single: true,
      fieldName,
      txCtx,
      policies,
      args: queryArgs,
      run: async ({ executor, args, context, info, before, after }) => {
        await before();
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
          resolveName,
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

        await after(result);

        if (!result[0]) {
          // Only reachable under `conflictDoNothing`, which is why the field is nullable
          // there and non-null everywhere else.
          if (!conflictDoNothing) {
            throw drizzleError('The insert returned no row.', { code: 'DRIZZLE_NO_ROW_RETURNED' });
          }
          return undefined;
        }

        const enriched = hasRelations
          ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
          : result;

        return remapToGraphQLSingleOutput(enriched[0], tableName, table, relationMap);
      },
    });
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
    /** The build's type-naming rule — the resolve tree is keyed by the names it produced. */
    resolveName?: TypeNameResolver,
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

    return writeResolver<{ values: Record<string, any> | Record<string, any>[]; onConflict?: OnConflictArg }>({
      db,
      tableName,
      operation: 'upsert',
      single,
      fieldName,
      txCtx,
      policies,
      args: queryArgs,
      run: async ({ executor, args, context, info, before, after }) => {
        const supplied = single ? [args.values as Record<string, any>] : (args.values as Record<string, any>[]);
        if (!supplied.length) {
          throw drizzleError('No values were provided!', { code: 'DRIZZLE_NO_VALUES' });
        }
        await before();

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
          resolveName,
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

        await after(result);

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
    });
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
    /** The build's type-naming rule — the resolve tree is keyed by the names it produced. */
    resolveName?: TypeNameResolver,
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

    return writeResolver<{ where?: Filters<Table>; set: Record<string, any> }>({
      db,
      tableName,
      operation: 'update',
      single,
      fieldName,
      txCtx,
      policies,
      args: queryArgs,
      run: async ({ executor, args, context, info, before, after }) => {
        const { where, set } = args;
        const scope = policies?.scope?.(context);
        await before();

        const parsedInfo = parseResolveInfo(info, {
          deep: true,
        }) as ResolveTree;

        const { columns, hasRelations, withParams } = prepareMutationRelationColumns({
          relationMap,
          tables,
          tableName,
          typeName,
          typeNameMapper,
          resolveName,
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
          throw drizzleError('Unable to update with no values specified!', { code: 'DRIZZLE_NO_VALUES' });
        }

        const relationCtx = relationFilterCtx(filterCtx, tableName);
        // The scope is ANDed on last, so a caller-supplied `where` can only narrow it.
        const filters = withScope(
          scope,
          tableName,
          table,
          single || requireWhere
            ? extractRequiredFilters(table, tableName, where, relationCtx)
            : where
              ? extractFilters(table, tableName, where, relationCtx)
              : undefined,
        );

        if (single) {
          await assertSingleMatch(executor, table, filters!);
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

        await after(result);

        if (single && result.length > 1) {
          // A row started matching between the pre-check and the write.
          throw drizzleError("'where' matched more than one row!", { code: 'DRIZZLE_MULTI_ROW_MATCH' });
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
    });
  };

  /**
   * `delete<Table>` and, for a table that declares a soft-delete column, `restore<Table>`.
   *
   * A soft-deleting table normally issues no `DELETE`: both mutations are an `UPDATE` of the
   * marker column, and the rows they return are the rows as they now stand. `restore` is the
   * same resolver reading the other way — it matches only marked rows (`deleted: ONLY`) and
   * writes the restored value.
   *
   * A table that opted into `hardDelete` also takes `hard: true`, which issues the real
   * `DELETE` — emptying the trash, reclaiming a unique key. It reads at `INCLUDE`, since the
   * rows it mostly exists to remove are the ones already marked; a `scope` still confines it.
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
    /** The build's type-naming rule — the resolve tree is keyed by the names it produced. */
    resolveName?: TypeNameResolver,
  ): CreatedResolver => {
    const softDelete = policies?.softDelete?.(tableName);
    const operation: WriteOperation = restore ? 'restore' : 'delete';
    // Only a soft-deleting table that opted in gets the argument, so the schema itself says
    // which tables can be purged — and `restore` never takes one, having nothing to remove.
    const canHardDelete = !restore && softDelete?.hardDelete === true;
    const queryArgs = {
      where: {
        type: single || requireWhere ? new GraphQLNonNull(filterArgs) : filterArgs,
      },
      ...(canHardDelete ? { hard: hardDeleteArg } : {}),
    } as GraphQLFieldConfigArgumentMap;

    return writeResolver<{ where?: Filters<Table>; hard?: boolean }>({
      db,
      tableName,
      operation,
      single,
      fieldName,
      txCtx,
      policies,
      args: queryArgs,
      run: async ({ executor, args, context, info, before, after }) => {
        const { where } = args;
        // `canHardDelete` decides whether the argument exists; this decides what it does,
        // so a stitched-in `hard: true` on a table that never opted in stays a soft delete.
        const hard = canHardDelete && args.hard === true;
        const scope = policies?.scope?.(context);
        await before();

        const parsedInfo = parseResolveInfo(info, {
          deep: true,
        }) as ResolveTree;

        const columns = extractSelectedColumnsFromTreeSQLFormat(
          parsedInfo.fieldsByTypeName[applyObjectTypeName(typeName, tableName, resolveName)]!,
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
            ? extractRequiredFilters(table, tableName, where, relationCtx)
            : where
              ? extractFilters(table, tableName, where, relationCtx)
              : undefined,
          // A hard delete reads at INCLUDE: the rows it mostly exists to remove are the
          // ones already marked, which the default EXCLUDE could not reach at all.
          restore ? 'ONLY' : hard ? 'INCLUDE' : undefined,
        );

        if (single) {
          await assertSingleMatch(executor, table, filters!);
        }

        let query =
          softDelete && !hard
            ? executor.update(table).set({
                [softDelete.columnName]: restore ? softDelete.writeRestored : softDelete.writeDeleted(),
              })
            : executor.delete(table);
        if (filters) {
          query = query.where(filters) as any;
        }

        query = query.returning(columns) as any;

        const result = await query;

        await after(result);

        if (single && result.length > 1) {
          // A row started matching between the pre-check and the write.
          throw drizzleError("'where' matched more than one row!", { code: 'DRIZZLE_MULTI_ROW_MATCH' });
        }

        if (single) {
          return result[0] ? remapToGraphQLSingleOutput(result[0], tableName, table) : undefined;
        }

        return remapToGraphQLArrayOutput(result, tableName, table);
      },
    });
  };
  return { generateInsertArray, generateInsertSingle, generateUpsert, generateUpdate, generateDelete };
};
