import type { Table } from 'drizzle-orm';
import { getTableConfig, type MySqlDatabase, MySqlTable } from 'drizzle-orm/mysql-core';
import type { GraphQLFieldConfigArgumentMap } from 'graphql';
import {
  GraphQLBoolean,
  type GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from 'graphql';
import type { GeneratedEntities } from '../../types.ts';
import {
  applyContextValues,
  applyContextValuesAll,
  assertSingleMatch,
  computeResolverFieldNames,
  type DrizzleErrorContext,
  drizzleError,
  extractFilters,
  extractRequiredFilters,
  generateOnConflictInput,
  generateUpdateManyInput,
  generateWriteCount,
  getPrimaryKeyPropNamesFromConfig,
  hardDeleteArg,
  type MutationTxCtx,
  mysqlValuesColumnRef,
  type OnConflictArg,
  type RelationFilterBase,
  type ResolverPolicies,
  relationFilterCtx,
  resolveConflictPlan,
  runMutation,
  runWriteHook,
  stripContextValues,
  type TablesRelationalConfig,
  toGraphQLError,
  type WriteOperation,
  withErrorContext,
  withScope,
} from '../builders/common.ts';
import { remapFromGraphQLArrayInput, remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
import { type DrizzleMutationMeta, tableFieldExtensions } from '../extensions.ts';
import { createSchemaBuilder } from './build-context.ts';
import { remapUpdateInput } from './field-updates.ts';
import type { CreatedResolver, Filters, SchemaGeneratorOptions } from './types.ts';

const generateInsertArray = (
  db: MySqlDatabase<any, any, any, any>,
  tableName: string,
  table: MySqlTable,
  baseType: GraphQLInputObjectType,
  fieldName: string,
  txCtx?: MutationTxCtx,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(baseType))),
    },
  };

  const hooks = policies?.onWrite?.(tableName, 'insert');
  const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'insert', field: fieldName };

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
            const input = applyContextValuesAll(
              remapFromGraphQLArrayInput(args.values, table),
              policies?.contextValues?.(tableName),
              context,
            );
            if (!input.length) {
              throw drizzleError('No values were provided!', { code: 'DRIZZLE_NO_VALUES' });
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

            await executor.insert(table).values(input);

            await runWriteHook(hooks, 'after', {
              table: tableName,
              operation: 'insert',
              single: false,
              args,
              rows: [],
              context,
              info,
              tx: executor,
            });

            return { isSuccess: true };
          },
          !!hooks,
        );
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};

const generateInsertSingle = (
  db: MySqlDatabase<any, any, any, any>,
  tableName: string,
  table: MySqlTable,
  baseType: GraphQLInputObjectType,
  fieldName: string,
  txCtx?: MutationTxCtx,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: new GraphQLNonNull(baseType),
    },
  };

  const hooks = policies?.onWrite?.(tableName, 'insert');
  const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'insert', field: fieldName };

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
            const input = applyContextValues(
              remapFromGraphQLSingleInput(args.values, table),
              policies?.contextValues?.(tableName),
              context,
            );

            await executor.insert(table).values(input);

            await runWriteHook(hooks, 'after', {
              table: tableName,
              operation: 'insert',
              single: true,
              args,
              rows: [],
              context,
              info,
              tx: executor,
            });

            return { isSuccess: true };
          },
          !!hooks,
        );
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};

const generateUpsert = (
  db: MySqlDatabase<any, any, any, any>,
  tableName: string,
  table: MySqlTable,
  baseType: GraphQLInputObjectType,
  onConflictType: GraphQLInputObjectType,
  fieldName: string,
  single: boolean,
  txCtx?: MutationTxCtx,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: single ? new GraphQLNonNull(baseType) : new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(baseType))),
    },
    onConflict: {
      type: onConflictType,
      description: 'How a conflicting row is resolved. Defaults to overwriting it.',
    },
  };

  const pkNames = mysqlPrimaryKeyPropNames(table);

  const hooks = policies?.onWrite?.(tableName, 'upsert');
  const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'upsert', field: fieldName };

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
            const input = applyContextValuesAll(
              single
                ? [remapFromGraphQLSingleInput(args.values as Record<string, any>, table)]
                : remapFromGraphQLArrayInput(args.values as Record<string, any>[], table),
              policies?.contextValues?.(tableName),
              context,
            );
            if (!input.length) {
              throw drizzleError('No values were provided!', { code: 'DRIZZLE_NO_VALUES' });
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

            // MySQL's ON DUPLICATE KEY UPDATE fires on whichever unique key was violated, so
            // there is no target to resolve and no predicate to attach.
            const plan = resolveConflictPlan({
              table,
              values: input,
              onConflict: args.onConflict,
              pkNames,
              uniqueSets: [],
              excludedRef: mysqlValuesColumnRef,
              withTarget: false,
            });

            if (plan.action === 'NOTHING') {
              // INSERT IGNORE is the closest MySQL gets to DO NOTHING.
              await executor.insert(table).ignore().values(input);
            } else {
              await executor.insert(table).values(input).onDuplicateKeyUpdate({ set: plan.set });
            }

            await runWriteHook(hooks, 'after', {
              table: tableName,
              operation: 'upsert',
              single,
              args,
              rows: [],
              context,
              info,
              tx: executor,
            });

            return { isSuccess: true };
          },
          !!hooks,
        );
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};

const generateUpdate = (
  db: MySqlDatabase<any, any, any>,
  tableName: string,
  table: MySqlTable,
  setArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  single: boolean,
  requireWhere: boolean,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
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

  const hooks = policies?.onWrite?.(tableName, 'update');
  const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'update', field: fieldName };

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

            // A context-derived column is the server's to set, so an update never reassigns
            // one — that is what stops a row being handed to another owner.
            const input = stripContextValues(
              remapUpdateInput(set, table, tableName),
              policies?.contextValues?.(tableName),
            );
            if (!Object.keys(input).length) {
              throw drizzleError('Unable to update with no values specified!', { code: 'DRIZZLE_NO_VALUES' });
            }
            await runWriteHook(hooks, 'before', {
              table: tableName,
              operation: 'update',
              single,
              args,
              context,
              info,
              tx: executor,
            });

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

            let query = executor.update(table).set(input);
            if (filters) {
              query = query.where(filters) as any;
            }

            await query;

            await runWriteHook(hooks, 'after', {
              table: tableName,
              operation: 'update',
              single,
              args,
              rows: [],
              context,
              info,
              tx: executor,
            });

            return { isSuccess: true };
          },
          !!hooks,
        );
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
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
 * in order. MySQL has no RETURNING, so — like every other MySQL mutation — the result is
 * `{ isSuccess: true }` rather than the updated rows.
 */
const generateUpdateMany = (
  db: MySqlDatabase<any, any, any>,
  tableName: string,
  table: MySqlTable,
  updateManyInput: GraphQLInputObjectType,
  fieldName: string,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
  policies?: ResolverPolicies,
): CreatedResolver => {
  const queryArgs = {
    updates: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(updateManyInput))),
    },
  } as const satisfies GraphQLFieldConfigArgumentMap;

  const hooks = policies?.onWrite?.(tableName, 'updateMany');
  const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'updateMany', field: fieldName };

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
              throw drizzleError('No updates were provided!', { code: 'DRIZZLE_NO_VALUES' });
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

            // Remap and validate every entry before the transaction opens, so a malformed
            // entry rejects the request instead of rolling back mid-batch.
            const entries = updates.map(({ where, set }) => {
              const input = stripContextValues(remapUpdateInput(set, table, tableName), contextColumns);
              if (!Object.keys(input).length) {
                throw drizzleError('Unable to update with no values specified!', { code: 'DRIZZLE_NO_VALUES' });
              }
              return {
                set: input,
                filters: withScope(
                  scope,
                  tableName,
                  table,
                  where ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)) : undefined,
                ),
              };
            });

            // On a caller-supplied transaction — or the shared multi-mutation transaction
            // opened by `runMutation` — this opens a savepoint, so the batch stays atomic
            // without breaking the outer transaction.
            await executor.transaction(async (tx: any) => {
              for (const entry of entries) {
                let query = tx.update(table).set(entry.set);
                if (entry.filters) {
                  query = query.where(entry.filters) as any;
                }
                await query;
              }
            });

            await runWriteHook(hooks, 'after', {
              table: tableName,
              operation: 'updateMany',
              single: false,
              args,
              rows: [],
              context,
              info,
              tx: executor,
            });

            return { isSuccess: true };
          },
          !!hooks,
        );
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};

/**
 * `delete<Table>` and, for a table that declares a soft-delete column, `restore<Table>`.
 * MySQL's writes return no rows either way, so both answer `{ isSuccess: true }` — the
 * difference from the other dialects is only what the payload can say, not what runs.
 *
 * A table that opted into `hardDelete` also takes `hard: true`, which issues the real
 * `DELETE` instead of writing the marker, reading at `INCLUDE` so it reaches marked rows.
 */
const generateDelete = (
  db: MySqlDatabase<any, any, any>,
  tableName: string,
  table: MySqlTable,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  single: boolean,
  requireWhere: boolean,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
  policies?: ResolverPolicies,
  restore: boolean = false,
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

  const hooks = policies?.onWrite?.(tableName, operation);
  const errorCtx: DrizzleErrorContext = { table: tableName, operation, field: fieldName };

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table>; hard?: boolean }, context, info) => {
      try {
        return await runMutation(
          db,
          context,
          info,
          txCtx,
          async (executor) => {
            await runWriteHook(hooks, 'before', {
              table: tableName,
              operation,
              single,
              args,
              context,
              info,
              tx: executor,
            });
            const { where } = args;
            // `canHardDelete` decides whether the argument exists; this decides what it does,
            // so a stitched-in `hard: true` on a table that never opted in stays a soft delete.
            const hard = canHardDelete && args.hard === true;
            const scope = policies?.scope?.(context);

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
                ? executor
                    .update(table)
                    .set({ [softDelete.columnName]: restore ? softDelete.writeRestored : softDelete.writeDeleted() })
                : executor.delete(table);
            if (filters) {
              query = query.where(filters) as any;
            }

            await query;

            await runWriteHook(hooks, 'after', {
              table: tableName,
              operation,
              single,
              args,
              rows: [],
              context,
              info,
              tx: executor,
            });

            return { isSuccess: true };
          },
          !!hooks,
        );
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};

/** Primary-key property names for a MySQL table, including table-level composite keys. */
const mysqlPrimaryKeyPropNames = (table: MySqlTable): string[] =>
  getPrimaryKeyPropNamesFromConfig(table, getTableConfig);

// MySQL sorts NULLs as the smallest values (first in ASC), and its writes return no rows.
const { prepareBuild, addReadFields, finalizeBuild } = createSchemaBuilder({
  tableClass: MySqlTable,
  getTableConfig,
  primaryKeyPropNames: mysqlPrimaryKeyPropNames,
  nullOrdering: 'nulls-smallest',
  returnsRows: false,
  // A nested write reads the key of the row it just wrote back out of the statement that
  // wrote it, which MySQL has no RETURNING clause for.
  preflight: (_db, options) => {
    if (options.features.nestedWrites) {
      throw new Error(
        'Drizzle-GraphQL Error: features.nestedWrites is not supported on MySQL — a nested write needs the parent row it just inserted returned to it, and MySQL has no RETURNING clause.',
      );
    }
  },
});

export const generateSchemaData = <
  TDrizzleInstance extends MySqlDatabase<any, any, any, any>,
  TSchema extends Record<string, Table | unknown>,
>(
  db: TDrizzleInstance,
  schema: TSchema,
  relations: TablesRelationalConfig,
  options: SchemaGeneratorOptions,
): GeneratedEntities<TDrizzleInstance, TSchema> => {
  const { prefixes, suffixes, typeNameMapper } = options;

  // Table discovery, the relation graph, the per-build registries, the filter context, the
  // type cache and every table's types — all of it dialect-independent, so all of it lives
  // in `build-context.ts` and is shared with the PostgreSQL/SQLite builder.
  const ctx = prepareBuild(db, schema as Record<string, unknown>, relations, options);
  const {
    featureOf,
    anyTable,
    filterCtx,
    policies,
    softDeleteOf,
    cacheCtx,
    mutationTxCtx,
    gqlSchemaTypes,
    mutations,
    inputs,
    outputs,
  } = ctx;

  // MySQL cannot return the rows a write touched, so every mutation reports only whether it
  // succeeded — one shared type for the whole build.
  const mutationReturnType = new GraphQLObjectType({
    name: cacheCtx.typeName({ kind: 'shared', defaultName: 'MutationReturn' }),
    fields: {
      isSuccess: {
        type: new GraphQLNonNull(GraphQLBoolean),
      },
    },
  });
  // Every MySQL mutation returns it, so it only belongs in the type map when at least one
  // mutation is generated.
  if ((['insert', 'upsert', 'update', 'delete'] as const).some((feature) => anyTable(feature))) {
    outputs['MutationReturn'] = mutationReturnType;
  }

  for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
    // Everything this table generates, with any per-table predicate already run.
    const tableFeatures = featureOf(tableName);
    // What every field this table generates publishes about itself under `extensions.drizzle`,
    // so a wrapper can read a field's identity instead of parsing its configurable name.
    const drizzleMeta = tableFieldExtensions(tableName, mysqlPrimaryKeyPropNames(schema[tableName] as MySqlTable));
    const { insertInput, updateInput, tableFilters, tableOrder } = tableTypes.inputs;
    const { selectSingleOutput } = tableTypes.outputs;

    // Compute field names using the mapper logic
    const names = computeResolverFieldNames(tableName, typeNameMapper, prefixes, suffixes);
    const {
      typeName,
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
      restoreFieldName,
      restoreSingleFieldName,
      deleteCountFieldName,
    } = names;
    // A table that marks rows deleted instead of removing them also gets the mutation that
    // reverses it — clearing the column through an ordinary update is not possible, since the
    // column is not in the update input and a marked row is invisible to a `where` anyway.
    const softDeleteInfo = softDeleteOf?.(tableName);

    // Both selects, the aggregate and the group-by: generated and hung off the query root
    // by the shared builder, since a read is a read on every dialect.
    const { aggregateType, groupByType, havingInput } = addReadFields(ctx, tableName, names, tableTypes, drizzleMeta);

    const insertArrGenerated = tableFeatures.insert
      ? generateInsertArray(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          insertInput,
          createArrayFieldName,
          mutationTxCtx,
          policies,
        )
      : undefined;
    const insertSingleGenerated = tableFeatures.insert
      ? generateInsertSingle(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          insertInput,
          createSingleFieldName,
          mutationTxCtx,
          policies,
        )
      : undefined;
    // MySQL detects a conflict on any unique key, so unlike PostgreSQL and SQLite every
    // table can be upserted — there is no target to validate.
    const onConflictInput = tableFeatures.upsert
      ? generateOnConflictInput({
          table: schema[tableName] as MySqlTable,
          tableName,
          typeName,
          uniqueSets: [],
          tableFilters,
          withTarget: false,
          cacheCtx,
        })
      : undefined;
    const upsertArrGenerated = onConflictInput
      ? generateUpsert(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          insertInput,
          onConflictInput,
          upsertArrayFieldName,
          false,
          mutationTxCtx,
          policies,
        )
      : undefined;
    const upsertSingleGenerated = onConflictInput
      ? generateUpsert(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          insertInput,
          onConflictInput,
          upsertSingleFieldName,
          true,
          mutationTxCtx,
          policies,
        )
      : undefined;
    const updateGenerated = tableFeatures.update
      ? generateUpdate(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          updateInput,
          tableFilters,
          updateFieldName,
          false,
          tableFeatures.requireWhere,
          filterCtx,
          mutationTxCtx,
          policies,
        )
      : undefined;
    const updateSingleGenerated = tableFeatures.update
      ? generateUpdate(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          updateInput,
          tableFilters,
          updateSingleFieldName,
          true,
          tableFeatures.requireWhere,
          filterCtx,
          mutationTxCtx,
          policies,
        )
      : undefined;
    // The batch update reuses the update `set` input, so it needs `update` on too.
    const updateManyInput =
      tableFeatures.update && tableFeatures.updateMany
        ? generateUpdateManyInput({
            tableName,
            typeName,
            updatePrefix: prefixes.update,
            updateInput,
            tableFilters,
            cacheCtx,
          })
        : undefined;
    const updateManyGenerated = updateManyInput
      ? generateUpdateMany(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          updateManyInput,
          updateManyFieldName,
          filterCtx,
          mutationTxCtx,
          policies,
        )
      : undefined;
    const deleteGenerated = tableFeatures.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          tableFilters,
          deleteFieldName,
          false,
          tableFeatures.requireWhere,
          filterCtx,
          mutationTxCtx,
          policies,
        )
      : undefined;
    const deleteSingleGenerated = tableFeatures.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          tableFilters,
          deleteSingleFieldName,
          true,
          tableFeatures.requireWhere,
          filterCtx,
          mutationTxCtx,
          policies,
        )
      : undefined;
    const restoreGenerated = softDeleteInfo
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          tableFilters,
          restoreFieldName,
          false,
          tableFeatures.requireWhere,
          filterCtx,
          mutationTxCtx,
          policies,
          true,
        )
      : undefined;
    const restoreSingleGenerated = softDeleteInfo
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          tableFilters,
          restoreSingleFieldName,
          true,
          tableFeatures.requireWhere,
          filterCtx,
          mutationTxCtx,
          policies,
          true,
        )
      : undefined;
    // The count variants are the plural write with its payload left off, so each follows the
    // same feature switch as the write it mirrors.
    const updateCountGenerated =
      tableFeatures.update && tableFeatures.countMutations
        ? generateWriteCount({
            db,
            tableName,
            table: schema[tableName] as MySqlTable,
            kind: 'update',
            setArgs: updateInput,
            filterArgs: tableFilters,
            fieldName: updateCountFieldName,
            requireWhere: tableFeatures.requireWhere,
            filterCtx,
            txCtx: mutationTxCtx,
          })
        : undefined;
    const deleteCountGenerated =
      tableFeatures.delete && tableFeatures.countMutations
        ? generateWriteCount({
            db,
            tableName,
            table: schema[tableName] as MySqlTable,
            kind: 'delete',
            filterArgs: tableFilters,
            fieldName: deleteCountFieldName,
            requireWhere: tableFeatures.requireWhere,
            filterCtx,
            txCtx: mutationTxCtx,
          })
        : undefined;
    // Each mutation is paired with the identity it publishes on `extensions.drizzle`, so a
    // consumer can tell an insert from an upsert without unpicking the configured prefixes —
    // and, for a delete, whether the field can purge rather than mark.
    const hardDeleteMeta = softDeleteInfo?.hardDelete ? ({ hardDelete: true } as const) : {};
    const generatedMutations: [typeof insertArrGenerated, DrizzleMutationMeta][] = [
      [insertArrGenerated, { operation: 'insert', single: false, targetArg: 'values' }],
      [insertSingleGenerated, { operation: 'insert', single: true, targetArg: 'values' }],
      [upsertArrGenerated, { operation: 'upsert', single: false, targetArg: 'values' }],
      [upsertSingleGenerated, { operation: 'upsert', single: true, targetArg: 'values' }],
      [updateGenerated, { operation: 'update', single: false, targetArg: 'where' }],
      [updateManyGenerated, { operation: 'updateMany', single: false, targetArg: 'updates' }],
      [updateSingleGenerated, { operation: 'update', single: true, targetArg: 'where' }],
      [deleteGenerated, { operation: 'delete', single: false, targetArg: 'where', ...hardDeleteMeta }],
      [deleteSingleGenerated, { operation: 'delete', single: true, targetArg: 'where', ...hardDeleteMeta }],
      [restoreGenerated, { operation: 'restore', single: false, targetArg: 'where' }],
      [restoreSingleGenerated, { operation: 'restore', single: true, targetArg: 'where' }],
    ];
    for (const [generated, meta] of generatedMutations) {
      if (generated) {
        mutations[generated.name] = {
          type: mutationReturnType,
          args: generated.args,
          resolve: generated.resolver,
          extensions: { drizzle: drizzleMeta({ kind: 'mutation', ...meta }) },
        };
      }
    }
    // Apart from the loop above: the count mutations are the one pair whose return value is
    // not MySQL's shared `isSuccess` shape.
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
    if (aggregateType) {
      outputs[aggregateType.name] = aggregateType;
    }
    if (groupByType && havingInput) {
      outputs[groupByType.name] = groupByType;
      inputs[havingInput.name] = havingInput;
    }
  }

  return finalizeBuild(ctx);
};
