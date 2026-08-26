// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import { is, One, type Table, type View } from 'drizzle-orm';
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
  assertSingleMatch,
  attachTargetPrimaryKeys,
  buildNamedRelations,
  computeResolverFieldNames,
  createRelationResolverFactory,
  eagerLoadMutationRelations,
  excludedColumnRef,
  extractFilters,
  extractOrderBy,
  extractRequiredFilters,
  extractSelectedColumnsFromTreeSQLFormat,
  generateDistinctEnum,
  generateOnConflictInput,
  generateTableTypes,
  getPrimaryKeyPropNamesFromConfig,
  getUniqueColumnSets,
  listFieldComplexity,
  type OnConflictArg,
  prepareMutationRelationColumns,
  primaryKeyOrderExprs,
  primaryKeyRestriction,
  pruneNonEagerRelations,
  type RelationAggregateFactory,
  type RelationFilterBase,
  type RelationResolverFactory,
  relationFilterCtx,
  resolveConflictPlan,
  resolveExecutor,
  resolveQueryExecutor,
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
): CreatedResolver => {
  const queryBase = db.query[tableName as keyof typeof db.query] as unknown as
    | RelationalQueryBuilder<any, any, any>
    | undefined;
  // Tables without relations won't have db.query support — fall back to basic select.

  const table = tables[tableName]!;
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
            single: false,
            filterCtx,
            pkNames,
            db: executor,
          });
        }

        // Fallback for tables without relational query builder support.
        // Use SQL column objects (not Record<string,true>) so db.select() receives valid expressions.
        const { offset, limit, orderBy, where, distinct } = args;
        const selectedColumnsSql = extractSelectedColumnsFromTreeSQLFormat<PgColumn>(
          parsedInfo.fieldsByTypeName[typeName]!,
          table,
          { tableName, relationMap, tables },
        );
        const whereSql = where
          ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName))
          : undefined;

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
        if (orderBy) {
          q = q.orderBy(
            ...extractOrderBy(table, orderBy),
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
        return remapToGraphQLArrayOutput(await q, tableName, table, relationMap);
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
          q = q.orderBy(...extractOrderBy(table, orderBy)) as any;
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

        const executor = resolveExecutor(db, context);
        let query = executor.insert(table).values(input).returning(columns);
        if (conflictDoNothing) {
          query = query.onConflictDoNothing() as any;
        }
        const result = await query;

        const enriched = hasRelations
          ? await eagerLoadMutationRelations(executor, tableName, result, pkNames, withParams)
          : result;

        return remapToGraphQLArrayOutput(enriched, tableName, table, relationMap);
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

        const executor = resolveExecutor(db, context);
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

        const executor = resolveExecutor(db, context);
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

        const executor = resolveExecutor(db, context);
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

        const executor = resolveExecutor(db, context);
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
  } = options;
  const schemaEntries = Object.entries(schema);
  const tableEntries = schemaEntries.filter(([_key, value]) => is(value, PgTable)) as [string, PgTable][];
  const tables = Object.fromEntries(tableEntries) as Record<string, PgTable>;

  if (!tableEntries.length) {
    throw new Error(
      "Drizzle-GraphQL Error: No tables detected in Drizzle-ORM's database instance. Did you forget to pass schema to drizzle constructor?",
    );
  }

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
          schema[tableName] as PgTable,
          tables,
          eagerRelations,
          insertInput,
          createArrayFieldName,
          typeName,
          typeNameMapper,
          conflictDoNothing,
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
        )
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
