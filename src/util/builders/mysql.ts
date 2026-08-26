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
  attachTargetPrimaryKeys,
  buildNamedRelations,
  computeResolverFieldNames,
  createMutationTxCtx,
  createRelationResolverFactory,
  extractFilters,
  generateDistinctEnum,
  generateOnConflictInput,
  generateTableTypes,
  getPrimaryKeyPropNamesFromConfig,
  listFieldComplexity,
  type MutationTxCtx,
  mysqlValuesColumnRef,
  type OnConflictArg,
  pruneNonEagerRelations,
  type RelationAggregateFactory,
  type RelationFilterBase,
  type RelationResolverFactory,
  relationFilterCtx,
  resolveConflictPlan,
  resolveQueryExecutor,
  runMutation,
  runRelationalSelect,
  selectArrayArgs,
  selectSingleArgs,
  type TablesRelationalConfig,
  type TypeCacheCtx,
  type TypeNameMapper,
  toGraphQLError,
} from '../builders/common.ts';
import { remapFromGraphQLArrayInput, remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
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
  const pkNames = mysqlPrimaryKeyPropNames(table as MySqlTable);
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
  const pkNames = mysqlPrimaryKeyPropNames(table as MySqlTable);

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

const generateInsertArray = (
  db: MySqlDatabase<any, any, any, any>,
  _tableName: string,
  table: MySqlTable,
  baseType: GraphQLInputObjectType,
  fieldName: string,
  txCtx?: MutationTxCtx,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(baseType))),
    },
  };

  return {
    name: fieldName,
    resolver: async (_source, args: { values: Record<string, any>[] }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const input = remapFromGraphQLArrayInput(args.values, table);
          if (!input.length) {
            throw new GraphQLError('No values were provided!');
          }

          await executor.insert(table).values(input);

          return { isSuccess: true };
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateInsertSingle = (
  db: MySqlDatabase<any, any, any, any>,
  _tableName: string,
  table: MySqlTable,
  baseType: GraphQLInputObjectType,
  fieldName: string,
  txCtx?: MutationTxCtx,
): CreatedResolver => {
  const queryArgs: GraphQLFieldConfigArgumentMap = {
    values: {
      type: new GraphQLNonNull(baseType),
    },
  };

  return {
    name: fieldName,
    resolver: async (_source, args: { values: Record<string, any> }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const input = remapFromGraphQLSingleInput(args.values, table);

          await executor.insert(table).values(input);

          return { isSuccess: true };
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateUpsert = (
  db: MySqlDatabase<any, any, any, any>,
  table: MySqlTable,
  baseType: GraphQLInputObjectType,
  onConflictType: GraphQLInputObjectType,
  fieldName: string,
  single: boolean,
  txCtx?: MutationTxCtx,
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

          return { isSuccess: true };
        });
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
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
): CreatedResolver => {
  const queryArgs = {
    set: {
      type: new GraphQLNonNull(setArgs),
    },
    where: {
      type: filterArgs,
    },
  } as const satisfies GraphQLFieldConfigArgumentMap;

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table>; set: Record<string, any> }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const { where, set } = args;

          const input = remapFromGraphQLSingleInput(set, table);
          if (!Object.keys(input).length) {
            throw new GraphQLError('Unable to update with no values specified!');
          }

          let query = executor.update(table).set(input);
          if (where) {
            const filters = extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName));
            query = query.where(filters) as any;
          }

          await query;

          return { isSuccess: true };
        });
      } catch (e) {
        throw toGraphQLError(e);
      }
    },
    args: queryArgs,
  };
};

const generateDelete = (
  db: MySqlDatabase<any, any, any>,
  tableName: string,
  table: MySqlTable,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
): CreatedResolver => {
  const queryArgs = {
    where: {
      type: filterArgs,
    },
  } as const satisfies GraphQLFieldConfigArgumentMap;

  return {
    name: fieldName,
    resolver: async (_source, args: { where?: Filters<Table> }, context, info) => {
      try {
        return await runMutation(db, context, info, txCtx, async (executor) => {
          const { where } = args;

          let query = executor.delete(table);
          if (where) {
            const filters = extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName));
            query = query.where(filters) as any;
          }

          await query;

          return { isSuccess: true };
        });
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
  const { relationsDepthLimit, prefixes, suffixes, typeNameMapper, shouldEagerLoad, features, complexity } = options;
  const rawSchema = schema;
  const schemaEntries = Object.entries(rawSchema);

  const tableEntries = schemaEntries.filter(([_key, value]) => is(value, MySqlTable)) as [string, MySqlTable][];
  const tables = Object.fromEntries(tableEntries);

  if (!tableEntries.length) {
    throw new Error(
      "Drizzle-GraphQL Error: No tables detected in Drizzle-ORM's database instance. Did you forget to pass schema to drizzle constructor?",
    );
  }

  // Build namedRelations from the drizzle-orm v1 relations config.
  const namedRelations = buildNamedRelations(relations ?? {}, tableEntries);
  // Record each relation target's (composite-aware) primary key for deterministic
  // paginated ordering. Must run before pruning / type generation (shared entry objects).
  attachTargetPrimaryKeys(namedRelations, tables, mysqlPrimaryKeyPropNames);
  // Pruned map for query resolvers' `with:`; type generation keeps the full map.
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
        relationAggregateFactory,
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
  if (features.insert || features.upsert || features.update || features.delete) {
    outputs.MutationReturn = mutationReturnType;
  }

  for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
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
      deleteFieldName,
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
          schema[tableName] as MySqlTable,
          insertInput,
          createArrayFieldName,
          mutationTxCtx,
        )
      : undefined;
    const insertSingleGenerated = features.insert
      ? generateInsertSingle(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          insertInput,
          createSingleFieldName,
          mutationTxCtx,
        )
      : undefined;
    // MySQL detects a conflict on any unique key, so unlike PostgreSQL and SQLite every
    // table can be upserted — there is no target to validate.
    const onConflictInput = features.upsert
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
          schema[tableName] as MySqlTable,
          insertInput,
          onConflictInput,
          upsertArrayFieldName,
          false,
          mutationTxCtx,
        )
      : undefined;
    const upsertSingleGenerated = onConflictInput
      ? generateUpsert(
          db,
          schema[tableName] as MySqlTable,
          insertInput,
          onConflictInput,
          upsertSingleFieldName,
          true,
          mutationTxCtx,
        )
      : undefined;
    const updateGenerated = features.update
      ? generateUpdate(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          updateInput,
          tableFilters,
          updateFieldName,
          filterCtx,
          mutationTxCtx,
        )
      : undefined;
    const deleteGenerated = features.delete
      ? generateDelete(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          tableFilters,
          deleteFieldName,
          filterCtx,
          mutationTxCtx,
        )
      : undefined;
    const aggregateType = features.aggregates
      ? generateAggregateTypes(schema[tableName] as MySqlTable, tableName, typeName, cacheCtx)
      : undefined;
    const aggregateGenerated = features.aggregates
      ? generateAggregate(
          db,
          tableName,
          schema[tableName] as MySqlTable,
          typeName,
          aggregateFieldName,
          tableFilters,
          filterCtx,
        )
      : undefined;

    // The grouped result reuses the aggregate output types, so it only exists alongside them.
    const groupByType =
      features.aggregates && features.groupBy
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
    for (const generated of [
      insertArrGenerated,
      insertSingleGenerated,
      upsertArrGenerated,
      upsertSingleGenerated,
      updateGenerated,
      deleteGenerated,
    ]) {
      if (generated) {
        mutations[generated.name] = {
          type: mutationReturnType,
          args: generated.args,
          resolve: generated.resolver,
        };
      }
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
