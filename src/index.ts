import { getColumns, is, Table } from 'drizzle-orm';
import { MySqlDatabase } from 'drizzle-orm/mysql-core';
import { PgAsyncDatabase } from 'drizzle-orm/pg-core';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import {
  type GraphQLFieldConfig,
  type GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLSchema,
  type GraphQLSchemaConfig,
} from 'graphql';
import type { AnyDrizzleDB, BuildSchemaConfig, GeneratedData, TableLimitPolicy } from './types.ts';
import {
  applyErrorMapper,
  defaultErrorMapper,
  type LimitPolicyFor,
  type ResolvedLimitPolicy,
  resolveLimitPolicy,
} from './util/builders/common.ts';
import { generateMySQL, generatePG, generateSQLite } from './util/builders/index.ts';
import type { SchemaGeneratorOptions } from './util/builders/types.ts';
import { singularizeMapper } from './util/case-ops/index.ts';
import { resolveTableFeatures } from './util/features.ts';

export type {
  AggregateResolver,
  AnyDrizzleDB,
  BuildSchemaConfig,
  ComplexityConfig,
  DeleteResolver,
  DeleteSingleResolver,
  ExtractRelations,
  ExtractTableByName,
  ExtractTableRelations,
  ExtractTables,
  FeatureSwitch,
  GeneratedData,
  GeneratedEntities,
  GeneratedInputs,
  GeneratedOutputs,
  InsertArrResolver,
  InsertResolver,
  LimitsConfig,
  MutationReturnlessResult,
  MutationsCore,
  QueriesCore,
  SchemaExclusions,
  SchemaFeatures,
  SelectResolver,
  SelectSingleResolver,
  TableLimitPolicy,
  UpdateManyArgs,
  UpdateManyEntry,
  UpdateManyResolver,
  UpdateResolver,
  UpdateSingleResolver,
  UpsertArgs,
  UpsertArrResolver,
  UpsertConflictArgs,
  UpsertResolver,
} from './types.ts';
export type { RelationResolverFactory } from './util/builders/common.ts';
export {
  createRelationResolverFactory,
  defaultErrorMapper,
  drizzleExecutorKey,
  extractFilters,
  extractOrderBy,
  extractRelationJoinColumns,
} from './util/builders/common.ts';
export type { TableNamedRelations } from './util/builders/types.ts';
export { singularizeMapper } from './util/case-ops/index.ts';
export type {
  DrizzleExtension,
  DrizzleFieldExtension,
  DrizzleFieldKind,
  DrizzleFieldOperation,
  DrizzleTargetArg,
  DrizzleTypeExtension,
  IdentifiedRows,
} from './util/extensions.ts';
export { drizzleExtension, identifyRows, isDrizzleFieldExtension } from './util/extensions.ts';
export {
  GraphQLBigIntString,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLDecimalString,
  GraphQLJSON,
  GraphQLUUID,
} from './util/scalars/index.ts';
export type { ResolveSelectionOptions, SelectionOptions } from './util/selection.ts';
export { resolveSelection, selectionToWith } from './util/selection.ts';
export type {
  ColumnDeprecator,
  ColumnDescriber,
  ColumnDocInfo,
  ColumnTypeMapper,
  ColumnTypeMapperInfo,
  EnumNameInfo,
  EnumNameMapper,
  RelationDescriber,
  ScalarOverride,
  ScalarOverridesConfig,
  SchemaDocs,
  TableDescriber,
} from './util/type-converter/types.ts';

type ObjMap<T> = Record<string, T>;

export const buildSchema = <TDbClient extends AnyDrizzleDB<any>>(
  db: TDbClient,
  config?: BuildSchemaConfig,
): GeneratedData<TDbClient> => {
  const relations = db._.relations;
  // drizzle-orm v1 rc.2 removed fullSchema from PgAsyncDatabase._
  // For PG, reconstruct a schema-like map from db._.relations (each entry has { table }).
  // MySQL and SQLite still expose fullSchema directly.
  const schema =
    (db._ as any).fullSchema ??
    Object.fromEntries(
      Object.entries(relations as Record<string, any>)
        .filter(([, config]) => config?.table != null)
        .map(([key, config]) => [key, config.table]),
    );

  if (!schema || !Object.keys(schema).length) {
    throw new Error(
      'Drizzle-GraphQL Error: Schema not found in drizzle instance. Pass relations (from buildRelations/defineRelations) to the drizzle constructor so drizzle-graphql can detect your tables.',
    );
  }

  const prefixes = {
    insert: config?.prefixes?.insert ?? 'create',
    delete: config?.prefixes?.delete ?? 'delete',
    update: config?.prefixes?.update ?? 'update',
    upsert: config?.prefixes?.upsert ?? 'upsert',
  };

  const suffixes = {
    list: config?.suffixes?.list ?? '',
    single: config?.suffixes?.single ?? 'Single',
  };

  // `'singularize'` is the one shipped preset; anything else is the caller's own function.
  const typeNameMapper = config?.typeNameMapper === 'singularize' ? singularizeMapper : config?.typeNameMapper;

  // Table keys this build generates for — what a per-table feature predicate is asked about.
  // Excluded tables are dropped up front so no predicate is ever consulted for a table that
  // generates nothing.
  const tableKeys = Object.entries(schema as Record<string, unknown>)
    .filter(([, value]) => is(value, Table))
    .map(([key]) => key);
  const excludedTableNames = new Set(config?.exclude?.tables ?? []);
  const featureTables = tableKeys.filter((key) => !excludedTableNames.has(key));

  // Resolved the same way the generators resolve it, so the implication warnings below
  // describe exactly what gets generated.
  const forTable = resolveTableFeatures(config?.features);

  // Cost hints are inert without a complexity rule installed, so they are generated unless the
  // caller opts out.
  const complexityConfig = config?.complexity ?? true;
  const complexity =
    complexityConfig === false
      ? undefined
      : {
          defaultListSize: (complexityConfig === true ? undefined : complexityConfig.defaultListSize) ?? 10,
          aggregateCost: (complexityConfig === true ? undefined : complexityConfig.aggregateCost) ?? 10,
        };

  // Off unless asked for: opening transactions the caller did not wire up themselves is a
  // behavior change (and some drivers, e.g. neon-http, cannot open one at all).
  const transactionsOpt = config?.transactions;
  const transactions =
    transactionsOpt === undefined || transactionsOpt === 'none'
      ? undefined
      : { timeoutMs: (transactionsOpt === 'auto' ? undefined : transactionsOpt.timeoutMs) ?? 30_000 };

  // A limit policy is only built when the caller configured one; otherwise `limits` stays
  // undefined and every list keeps its unbounded behavior. Policies are resolved once per
  // table and memoized, since the lookup runs on every relation field build and every list
  // resolve.
  const limitsConfig = config?.limits;
  if (limitsConfig) {
    const check = (policy: TableLimitPolicy, where: string) => {
      for (const key of ['defaultLimit', 'maxLimit'] as const) {
        const value = policy[key];
        if (value === undefined) {
          continue;
        }
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Drizzle-GraphQL Error: config.limits${where}.${key} must be a positive integer.`);
        }
      }
    };
    check(limitsConfig, '');
    for (const [tableName, policy] of Object.entries(limitsConfig.tables ?? {})) {
      check(policy, `.tables.${tableName}`);
    }
  }
  const limitPolicyCache = new Map<string, ResolvedLimitPolicy | undefined>();
  const limits: LimitPolicyFor | undefined = limitsConfig
    ? (tableName: string) => {
        if (limitPolicyCache.has(tableName)) {
          return limitPolicyCache.get(tableName);
        }
        const resolved = resolveLimitPolicy(limitsConfig, limitsConfig.tables?.[tableName]);
        limitPolicyCache.set(tableName, resolved);
        return resolved;
      }
    : undefined;

  // Exclusions are resolved against the real schema so a renamed table or column fails the
  // build instead of quietly un-hiding itself — the failure mode that matters when this config
  // is what keeps a secret out of the API.
  const exclude = config?.exclude;
  if (exclude) {
    const tableNames = new Set(tableKeys);
    const excludedTables = excludedTableNames;
    for (const tableName of excludedTables) {
      if (!tableNames.has(tableName)) {
        throw new Error(
          `Drizzle-GraphQL Error: config.exclude.tables names '${tableName}', which is not a table in the Drizzle schema.`,
        );
      }
    }
    if (excludedTables.size >= tableNames.size) {
      throw new Error(
        'Drizzle-GraphQL Error: config.exclude.tables excludes every table in the schema, leaving nothing to generate.',
      );
    }
    for (const [tableName, columnNames] of Object.entries(exclude.columns ?? {})) {
      if (!tableNames.has(tableName)) {
        throw new Error(
          `Drizzle-GraphQL Error: config.exclude.columns names table '${tableName}', which is not a table in the Drizzle schema.`,
        );
      }
      // An excluded table has no columns left to hide; listing them too is redundant, not wrong.
      if (excludedTables.has(tableName)) {
        continue;
      }
      const columns = getColumns(schema[tableName] as Table);
      for (const columnName of columnNames) {
        const column = columns[columnName];
        if (!column) {
          throw new Error(
            `Drizzle-GraphQL Error: config.exclude.columns names '${tableName}.${columnName}', which is not a column of that table.`,
          );
        }
        // Hiding a column every insert must supply leaves the table readable but unwritable.
        // That is a reasonable thing to configure deliberately, so it warns rather than throws.
        if (column.notNull && !column.hasDefault && !column.defaultFn) {
          console.warn(
            `Drizzle-GraphQL Warning: excluded column '${tableName}.${columnName}' is NOT NULL with no default, so generated inserts for '${tableName}' can never succeed.`,
          );
        }
      }
    }
  }

  // Some operations are built out of others: an upsert writes through the insert and update
  // paths, a batch update reuses the update input, a grouped result reuses the aggregate
  // output types. The generator knows those implications; a table whose flags contradict them
  // is told at build time rather than leaving the consumer to notice a second write path (or a
  // missing operation) later. These warn rather than throw — the resulting schema is coherent,
  // it just isn't what the config appears to ask for.
  const featureConflicts = new Map<string, string[]>();
  const noteConflict = (message: string, tableName: string) => {
    const tables = featureConflicts.get(message);
    if (tables) {
      tables.push(tableName);
    } else {
      featureConflicts.set(message, [tableName]);
    }
  };
  for (const tableName of featureTables) {
    const tableFeatures = forTable(tableName);
    if (tableFeatures.upsert) {
      const missing = [!tableFeatures.insert ? 'insert' : undefined, !tableFeatures.update ? 'update' : undefined]
        .filter(Boolean)
        .join(' and ');
      if (missing) {
        noteConflict(
          `upsert is on while ${missing} is off, so the upsert mutations are a second write path past the operation you turned off`,
          tableName,
        );
      }
    }
    // Nested writes are build-wide, so a relation pointing at this table can still write it
    // from another table's mutation even with its own write operations turned off.
    if (config?.features?.nestedWrites && (!tableFeatures.insert || !tableFeatures.update)) {
      noteConflict(
        "nestedWrites is on while this table's own insert or update is off, so a nested `create` or `connect` under another table's mutation can still write it",
        tableName,
      );
    }
    // Only flagged when the caller actually asked for the dependent feature: both default to
    // on, so turning off the operation they build on is the normal way to remove them.
    if (config?.features?.updateMany !== undefined && tableFeatures.updateMany && !tableFeatures.update) {
      noteConflict('updateMany is on while update is off, so no batch update is generated', tableName);
    }
    if (config?.features?.groupBy !== undefined && tableFeatures.groupBy && !tableFeatures.aggregates) {
      noteConflict('groupBy is on while aggregates is off, so no grouped query is generated', tableName);
    }
    // The count mutations mirror the plural write they count, so they need at least one of the
    // two to be generated at all.
    if (tableFeatures.countMutations && !tableFeatures.update && !tableFeatures.delete) {
      noteConflict(
        'countMutations is on while update and delete are both off, so no count mutation is generated',
        tableName,
      );
    }
  }
  for (const [message, tables] of featureConflicts) {
    const listed =
      tables.length > 5 ? `${tables.slice(0, 5).join(', ')} and ${tables.length - 5} more` : tables.join(', ');
    console.warn(`Drizzle-GraphQL Warning: config.features — ${message} (${listed}).`);
  }

  // Normalize eagerLoadRelations (boolean | predicate | undefined) into a predicate.
  const eagerOpt = config?.eagerLoadRelations;
  const shouldEagerLoad: (tableName: string, relationName: string) => boolean =
    eagerOpt === undefined || eagerOpt === true ? () => true : eagerOpt === false ? () => false : eagerOpt;

  // When a typeNameMapper is provided, the mapper's singular/plural forms disambiguate the
  // list and single fields even if the suffixes are identical (e.g. both '').
  // Only enforce the suffix-collision check when no mapper is active.
  if (!typeNameMapper && suffixes.list === suffixes.single) {
    throw new Error(
      'Drizzle-GraphQL Error: List and single query suffixes cannot be the same. This would create conflicting GraphQL field names.',
    );
  }

  if (typeof config?.relationsDepthLimit === 'number') {
    if (config.relationsDepthLimit < 0) {
      throw new Error(
        'Drizzle-GraphQL Error: config.relationsDepthLimit is supposed to be nonnegative integer or undefined!',
      );
    }
    if (config.relationsDepthLimit !== ~~config.relationsDepthLimit) {
      throw new Error(
        'Drizzle-GraphQL Error: config.relationsDepthLimit is supposed to be nonnegative integer or undefined!',
      );
    }
  }

  const generatorOptions: SchemaGeneratorOptions = {
    relationsDepthLimit: config?.relationsDepthLimit,
    prefixes,
    suffixes,
    conflictDoNothing: config?.conflictDoNothing ?? false,
    typeNameMapper,
    shouldEagerLoad,
    features: config?.features ?? {},
    complexity,
    scalars: config?.scalars,
    mapColumnType: config?.mapColumnType,
    enumNameMapper: config?.enumNameMapper,
    transactions,
    limits,
    exclude,
    docs: {
      describeColumn: config?.describeColumn,
      describeTable: config?.describeTable,
      describeRelation: config?.describeRelation,
      deprecateColumn: config?.deprecateColumn,
    },
  };

  let generatorOutput;
  if (is(db, MySqlDatabase)) {
    generatorOutput = generateMySQL(db, schema, relations, generatorOptions);
  } else if (is(db, PgAsyncDatabase)) {
    generatorOutput = generatePG(db, schema, relations, generatorOptions);
  } else if (is(db, BaseSQLiteDatabase)) {
    generatorOutput = generateSQLite(db, schema, relations, generatorOptions);
  } else {
    throw new Error('Drizzle-GraphQL Error: Unknown database instance type');
  }

  // Wrap resolvers before the schema is assembled, so the generated schema and the returned
  // entities share the same handling.
  const onError = config?.onError;
  applyErrorMapper(
    generatorOutput as any,
    onError ? (error) => onError(error) ?? defaultErrorMapper(error) : defaultErrorMapper,
  );

  const { queries, mutations, inputs, types } = generatorOutput;

  const graphQLSchemaConfig: GraphQLSchemaConfig = {
    types: [...Object.values(inputs), ...Object.values(types)] as (GraphQLInputObjectType | GraphQLObjectType)[],
    query: new GraphQLObjectType({
      name: 'Query',
      fields: queries as ObjMap<GraphQLFieldConfig<any, any, any>>,
    }),
  };

  // An empty Mutation type is invalid GraphQL, so turning off every mutation feature
  // omits the type the same way `mutations: false` does.
  if (config?.mutations !== false && Object.keys(mutations).length) {
    const mutation = new GraphQLObjectType({
      name: 'Mutation',
      fields: mutations as ObjMap<GraphQLFieldConfig<any, any, any>>,
    });

    graphQLSchemaConfig.mutation = mutation;
  }

  const outputSchema = new GraphQLSchema(graphQLSchemaConfig);

  return { schema: outputSchema, entities: generatorOutput };
};
