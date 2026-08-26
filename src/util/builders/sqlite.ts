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
  assertSingleMatch,
  attachTargetPrimaryKeys,
  buildNamedRelations,
  computeResolverFieldNames,
  createMutationTxCtx,
  createRelationResolverFactory,
  eagerLoadMutationRelations,
  excludedColumnRef,
  extractFilters,
  extractRequiredFilters,
  extractSelectedColumnsFromTreeSQLFormat,
  generateDistinctEnum,
  generateOnConflictInput,
  generateTableTypes,
  generateUpdateManyInput,
  getPrimaryKeyPropNamesFromConfig,
  getUniqueColumnSets,
  listFieldComplexity,
  type MutationTxCtx,
  type OnConflictArg,
  prepareMutationRelationColumns,
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
          single: false,
          filterCtx,
          pkNames,
          db: executor,
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
          const input = remapFromGraphQLArrayInput(args.values, table);
          if (!input.length) {
            throw new GraphQLError('No values were provided!');
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
          });

          let query = executor.insert(table).values(input).returning(columns);
          if (conflictDoNothing) {
            query = query.onConflictDoNothing() as any;
          }
          const result = await query;

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
          const input = remapFromGraphQLSingleInput(args.values, table);

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
          });
          let query = executor.insert(table).values(input).returning(columns);
          if (conflictDoNothing) {
            query = query.onConflictDoNothing() as any;
          }
          const result = await query;

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
          const input = single
            ? [remapFromGraphQLSingleInput(args.values as Record<string, any>, table)]
            : remapFromGraphQLArrayInput(args.values as Record<string, any>[], table);
          if (!input.length) {
            throw new GraphQLError('No values were provided!');
          }

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
          });

          const plan = resolveConflictPlan({
            table,
            values: input,
            onConflict: args.onConflict,
            pkNames,
            uniqueSets,
            excludedRef: excludedColumnRef,
            withTarget: true,
            buildWhere: (where) => extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)),
          });

          let query = executor.insert(table).values(input).returning(columns);
          query =
            plan.action === 'NOTHING'
              ? (query.onConflictDoNothing(plan.target ? { target: plan.target } : undefined) as any)
              : (query.onConflictDoUpdate({ target: plan.target!, set: plan.set, setWhere: plan.setWhere }) as any);

          const result = await query;

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
          });

          const input = remapFromGraphQLSingleInput(set, table);
          if (!Object.keys(input).length) {
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

          let query = executor.update(table).set(input);
          if (filters) {
            query = query.where(filters) as any;
          }

          query = query.returning(columns) as any;

          const result = await query;

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
          });

          // Remap and validate every entry before the transaction opens, so a malformed
          // entry rejects the request instead of rolling back mid-batch.
          const entries = updates.map(({ where, set }) => {
            const input = remapFromGraphQLSingleInput(set, table);
            if (!Object.keys(input).length) {
              throw new GraphQLError('Unable to update with no values specified!');
            }
            return {
              set: input,
              filters: where
                ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName))
                : undefined,
            };
          });

          const runEntry = (tx: any, entry: (typeof entries)[number]) => {
            let query = tx.update(table).set(entry.set);
            if (entry.filters) {
              query = query.where(entry.filters);
            }
            // `.all()` instead of awaiting the thenable: a sync driver (better-sqlite3)
            // executes it immediately, which is the only way the statement still runs
            // inside the synchronous native transaction below.
            return query.returning(columns).all();
          };

          // On a caller-supplied transaction — or the shared multi-mutation transaction
          // opened by `runMutation` — this opens a savepoint, so the batch stays atomic
          // without breaking the outer transaction. A sync driver's transaction callback
          // must not be async — it would commit before any awaited statement ran — so the
          // driver kind is probed from the first statement's result instead.
          const perEntry: Record<string, any>[][] = await executor.transaction((tx: any) => {
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

          const columns = extractSelectedColumnsFromTreeSQLFormat<SQLiteColumn>(
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
  } = options;
  const rawSchema = schema;
  const schemaEntries = Object.entries(rawSchema);

  const tableEntries = schemaEntries.filter(([_key, value]) => is(value, SQLiteTable)) as [string, SQLiteTable][];
  const tables = Object.fromEntries(tableEntries) as Record<string, SQLiteTable>;

  if (!tableEntries.length) {
    throw new Error(
      "Drizzle-GraphQL Error: No tables detected in Drizzle-ORM's database instance. Did you forget to pass schema to drizzle constructor?",
    );
  }

  // Build namedRelations from the drizzle-orm v1 relations config.
  const namedRelations = buildNamedRelations(relations ?? {}, tableEntries);
  // Record each relation target's (composite-aware) primary key for deterministic
  // paginated ordering. Must run before pruning / type generation (shared entry objects).
  attachTargetPrimaryKeys(namedRelations, tables, sqlitePrimaryKeyPropNames);
  // Pruned map for query/mutation resolvers' `with:`; type generation keeps the full map.
  const eagerRelations = pruneNonEagerRelations(namedRelations, shouldEagerLoad);

  const filterCtx: RelationFilterBase = { tables, relationMap: namedRelations };

  const resolverFactory: RelationResolverFactory = createRelationResolverFactory(db, tables, filterCtx);

  // Fresh cache per generateSchemaData call — prevents type name collisions
  // when buildSchema() is called multiple times.
  const cacheCtx: TypeCacheCtx = {
    genericFilterCache: new Map(),
    objectTypeCache: new Map(),
    relationFieldContainers: new Map(),
    fullyBuiltTables: new Set(),
    relationTypeCache: new Map(),
    orderTypeCache: new WeakMap(),
    filterTypeCache: new WeakMap(),
    listRelationFilterCache: new Map(),
    aggregateTypeCache: new Map(),
    complexity,
  };

  // Left undefined when the feature is off — generateTableTypes then emits no
  // `${relation}Aggregate` fields at all.
  const relationAggregateFactory: RelationAggregateFactory | undefined = features.relationAggregates
    ? createRelationAggregateFactory(db, tables, cacheCtx, typeNameMapper, filterCtx)
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
        relationAggregateFactory,
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
      features.distinct,
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
    );
    const insertArrGenerated = features.insert
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
        )
      : undefined;
    const insertSingleGenerated = features.insert
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
        )
      : undefined;
    // An upsert needs something to conflict on, so a table with no primary key and no
    // unique constraint gets no upsert mutations rather than ones that always fail.
    const uniqueSets = features.upsert ? getUniqueColumnSets(schema[tableName] as SQLiteTable, getTableConfig) : [];
    const onConflictInput = features.upsert
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
        )
      : undefined;
    const updateGenerated = features.update
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
          features.requireWhere,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
        )
      : undefined;
    const updateSingleGenerated = features.update
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
          features.requireWhere,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
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
          schema[tableName] as SQLiteTable,
          tables,
          eagerRelations,
          updateManyInput,
          updateManyFieldName,
          typeName,
          typeNameMapper,
          filterCtx,
          mutationTxCtx,
        )
      : undefined;
    const deleteGenerated = features.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as SQLiteTable,
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
          schema[tableName] as SQLiteTable,
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
    const aggregateType = features.aggregates
      ? generateAggregateTypes(schema[tableName] as SQLiteTable, tableName, typeName, cacheCtx)
      : undefined;
    const aggregateGenerated = features.aggregates
      ? generateAggregate(
          db,
          tableName,
          schema[tableName] as SQLiteTable,
          typeName,
          aggregateFieldName,
          tableFilters,
          filterCtx,
        )
      : undefined;

    // The grouped result reuses the aggregate output types, so it only exists alongside them.
    const groupByType =
      features.aggregates && features.groupBy
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
          )
        : undefined;

    queries[selectArrGenerated.name] = {
      type: selectArrOutput,
      args: selectArrGenerated.args,
      resolve: selectArrGenerated.resolver,
      ...(complexity ? { extensions: { complexity: listFieldComplexity(complexity) } } : {}),
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
        type: singleTableItemOutput,
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
        // Nullable items: a no-match entry yields `null` in its slot.
        type: new GraphQLNonNull(new GraphQLList(singleTableItemOutput)),
        args: updateManyGenerated.args,
        resolve: updateManyGenerated.resolver,
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
};
