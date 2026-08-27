// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import { is, One, type Table } from 'drizzle-orm';
import { getTableConfig, type MySqlDatabase, MySqlTable } from 'drizzle-orm/mysql-core';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import type { GraphQLFieldConfig, GraphQLFieldConfigArgumentMap, ThunkObjMap } from 'graphql';
import {
  GraphQLBoolean,
  GraphQLError,
  type GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
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
  extractFilters,
  extractRequiredFilters,
  generateDistinctEnum,
  generateOnConflictInput,
  generateTableTypes,
  generateUpdateManyInput,
  getPrimaryKeyPropNamesFromConfig,
  type LimitPolicyFor,
  listFieldComplexity,
  type MutationTxCtx,
  mysqlValuesColumnRef,
  type OnConflictArg,
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
  runWriteHook,
  selectArrayArgs,
  selectSingleArgs,
  stripContextValues,
  type TablesRelationalConfig,
  type TypeCacheCtx,
  type TypeNameMapper,
  toGraphQLError,
  type WriteOperation,
  withDefaultOrderBy,
  withScope,
} from '../builders/common.ts';
import { remapFromGraphQLArrayInput, remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
import { type DrizzleMutationMeta, tableFieldExtensions } from '../extensions.ts';
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
import type {
  CreatedResolver,
  Filters,
  SchemaGeneratorOptions,
  TableFeatures,
  TableNamedRelations,
  TableSelectArgs,
} from './types.ts';

const generateSelectArray = (
  db: MySqlDatabase<any, any, any>,
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
  const pkNames = mysqlPrimaryKeyPropNames(table as MySqlTable);
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
          defaultOrderBy: policies?.defaultOrderBy,
          scope: policies?.scope?.(context),
          pkNames,
          db: executor,
          // MySQL sorts NULLs as the smallest values (first in ASC).
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
  db: MySqlDatabase<any, any, any>,
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

  const queryArgs = selectSingleArgs(orderArgs, filterArgs, policies?.softDelete, tableName);

  const table = tables[tableName]!;
  const pkNames = mysqlPrimaryKeyPropNames(table as MySqlTable);

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
          scope: policies?.scope?.(context),
          pkNames,
          db: executor,
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

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
        throw toGraphQLError(e);
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
        throw toGraphQLError(e);
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
        throw toGraphQLError(e);
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
              remapFromGraphQLSingleInput(set, table),
              policies?.contextValues?.(tableName),
            );
            if (!Object.keys(input).length) {
              throw new GraphQLError('Unable to update with no values specified!');
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
                ? extractRequiredFilters(table, tableName, where, fieldName, relationCtx)
                : where
                  ? extractFilters(table, tableName, where, relationCtx)
                  : undefined,
            );

            if (single) {
              await assertSingleMatch(executor, table, filters!, fieldName);
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

            // Remap and validate every entry before the transaction opens, so a malformed
            // entry rejects the request instead of rolling back mid-batch.
            const entries = updates.map(({ where, set }) => {
              const input = stripContextValues(remapFromGraphQLSingleInput(set, table), contextColumns);
              if (!Object.keys(input).length) {
                throw new GraphQLError('Unable to update with no values specified!');
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
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

/**
 * `delete<Table>` and, for a table that declares a soft-delete column, `restore<Table>`.
 * MySQL's writes return no rows either way, so both answer `{ isSuccess: true }` — the
 * difference from the other dialects is only what the payload can say, not what runs.
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
  const queryArgs = {
    where: {
      type: single || requireWhere ? new GraphQLNonNull(filterArgs) : filterArgs,
    },
  } as const satisfies GraphQLFieldConfigArgumentMap;

  const hooks = policies?.onWrite?.(tableName, operation);

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
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

/** Primary-key property names for a MySQL table, including table-level composite keys. */
const mysqlPrimaryKeyPropNames = (table: MySqlTable): string[] =>
  getPrimaryKeyPropNamesFromConfig(table, getTableConfig);

export const generateSchemaData = <
  TDrizzleInstance extends MySqlDatabase<any, any, any, any>,
  TSchema extends Record<string, Table | unknown>,
>(
  db: TDrizzleInstance,
  schema: TSchema,
  relations: TablesRelationalConfig,
  options: SchemaGeneratorOptions,
): GeneratedEntities<TDrizzleInstance, TSchema> => {
  const { relationsDepthLimit, prefixes, suffixes, typeNameMapper, shouldEagerLoad, features, complexity, limits } =
    options;
  const rawSchema = schema;
  const schemaEntries = Object.entries(rawSchema);

  // Excluded tables are dropped here, before anything reads `tableEntries` — which also makes
  // `buildNamedRelations` skip every relation pointing at one, since it resolves targets
  // through this list.
  const excludedTables = new Set(options.exclude?.tables ?? []);
  const tableEntries = schemaEntries.filter(([key, value]) => is(value, MySqlTable) && !excludedTables.has(key)) as [
    string,
    MySqlTable,
  ][];
  const tables = Object.fromEntries(tableEntries);

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

  // A nested write reads the key of the row it just wrote back out of the statement that
  // wrote it, which MySQL has no RETURNING clause for.
  if (features.nestedWrites) {
    throw new Error(
      'Drizzle-GraphQL Error: features.nestedWrites is not supported on MySQL — a nested write needs the parent row it just inserted returned to it, and MySQL has no RETURNING clause.',
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
  attachTargetPrimaryKeys(namedRelations, tables, mysqlPrimaryKeyPropNames);
  // Pruned map for query resolvers' `with:`; type generation keeps the full map.
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
    primaryKeyOf: (name) => (tables[name] ? mysqlPrimaryKeyPropNames(tables[name] as MySqlTable) : []),
    contextValuesOf,
    softDeleteOf,
  };

  // Built when at least one table wants relation aggregates; a table that has them off is
  // handed `undefined` below, so `generateTableTypes` emits no `${relation}Aggregate` fields
  // on its object type.
  const relationAggregateFactory: RelationAggregateFactory | undefined = anyTable('relationAggregates')
    ? createRelationAggregateFactory(db, tables, cacheCtx, typeNameMapper, filterCtx, tablePolicies)
    : undefined;

  const queries: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};
  const mutations: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};
  // One per schema build: every mutation resolver shares it so a multi-mutation request can
  // ride a single transaction. Undefined unless transactions were requested.
  const mutationTxCtx = createMutationTxCtx(options.transactions);
  const gqlSchemaTypes = Object.fromEntries(
    Object.entries(tables).map(([tableName, _table]) => [
      tableName,
      generateTableTypes(
        tableName,
        tables,
        namedRelations,
        false,
        relationsDepthLimit,
        cacheCtx,
        typeNameMapper,
        prefixes.insert,
        prefixes.update,
        resolverFactory,
        featureOf(tableName).relationAggregates ? relationAggregateFactory : undefined,
      ),
    ]),
  );

  const mutationReturnType = new GraphQLObjectType({
    name: 'MutationReturn',
    fields: {
      isSuccess: {
        type: new GraphQLNonNull(GraphQLBoolean),
      },
    },
  });

  const inputs: Record<string, GraphQLInputObjectType> = {};
  const outputs: Record<string, GraphQLObjectType> = {};
  // Every MySQL mutation returns it, so it only belongs in the type map when at least one
  // mutation is generated.
  if ((['insert', 'upsert', 'update', 'delete'] as const).some((feature) => anyTable(feature))) {
    outputs.MutationReturn = mutationReturnType;
  }

  for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
    // Everything this table generates, with any per-table predicate already run.
    const tableFeatures = featureOf(tableName);
    // What every field this table generates publishes about itself under `extensions.drizzle`,
    // so a wrapper can read a field's identity instead of parsing its configurable name.
    const drizzleMeta = tableFieldExtensions(tableName, mysqlPrimaryKeyPropNames(schema[tableName] as MySqlTable));
    const { insertInput, updateInput, tableFilters, tableOrder } = tableTypes.inputs;
    const { selectSingleOutput, selectArrOutput } = tableTypes.outputs;

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
          typeName,
          uniqueSets: [],
          tableFilters,
          withTarget: false,
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
        ? generateUpdateManyInput({ typeName, updatePrefix: prefixes.update, updateInput, tableFilters })
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
    const aggregateType = tableFeatures.aggregates
      ? generateAggregateTypes(schema[tableName] as MySqlTable, tableName, typeName, cacheCtx)
      : undefined;
    const aggregateGenerated = tableFeatures.aggregates
      ? generateAggregate(
          db,
          tableName,
          schema[tableName] as MySqlTable,
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
        ? generateGroupByType(schema[tableName] as MySqlTable, tableName, typeName, cacheCtx)
        : undefined;
    const groupByEnum = groupByType
      ? generateGroupByEnum(schema[tableName] as MySqlTable, tableName, typeName)
      : undefined;
    const havingInput = groupByEnum
      ? generateHavingInput(schema[tableName] as MySqlTable, tableName, typeName)
      : undefined;
    const groupByGenerated =
      groupByType && groupByEnum && havingInput
        ? generateGroupBy(
            db,
            tableName,
            schema[tableName] as MySqlTable,
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
    // Each mutation is paired with the identity it publishes on `extensions.drizzle`, so a
    // consumer can tell an insert from an upsert without unpicking the configured prefixes.
    const generatedMutations: [typeof insertArrGenerated, DrizzleMutationMeta][] = [
      [insertArrGenerated, { operation: 'insert', single: false, targetArg: 'values' }],
      [insertSingleGenerated, { operation: 'insert', single: true, targetArg: 'values' }],
      [upsertArrGenerated, { operation: 'upsert', single: false, targetArg: 'values' }],
      [upsertSingleGenerated, { operation: 'upsert', single: true, targetArg: 'values' }],
      [updateGenerated, { operation: 'update', single: false, targetArg: 'where' }],
      [updateManyGenerated, { operation: 'updateMany', single: false, targetArg: 'updates' }],
      [updateSingleGenerated, { operation: 'update', single: true, targetArg: 'where' }],
      [deleteGenerated, { operation: 'delete', single: false, targetArg: 'where' }],
      [deleteSingleGenerated, { operation: 'delete', single: true, targetArg: 'where' }],
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

  // The first mutation resolver of a request counts the operation's root mutation fields to
  // know how many completions to wait for — but only fields this library generated can report
  // completion, so the shared-transaction path needs the full roster of generated names.
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
