import { is } from 'drizzle-orm';
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
import type { AnyDrizzleDB, BuildSchemaConfig, GeneratedData, GeneratedEntities } from './types.ts';
import { resolveBuildConfig } from './util/build-config.ts';
import { applyErrorMapper, defaultErrorMapper } from './util/builders/common.ts';
import { generateMySQL, generatePG, generateSQLite } from './util/builders/index.ts';

export type {
  AggregateResolver,
  AnyDrizzleDB,
  BuildSchemaConfig,
  ComplexityConfig,
  ContextValuesConfig,
  DefaultOrderByEntry,
  DefaultsConfig,
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
  OnWriteConfig,
  QueriesCore,
  RowScope,
  RowScopeFilter,
  SchemaExclusions,
  SchemaFeatures,
  ScopeConfig,
  SelectResolver,
  SelectSingleResolver,
  SoftDeleteColumn,
  SoftDeleteConfig,
  TableDefaults,
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
  WriteHook,
  WriteHookPayload,
  WriteHookPositions,
  WriteHooks,
  WriteOperation,
} from './types.ts';
export type { DrizzleErrorCode, DrizzleErrorContext, RelationResolverFactory } from './util/builders/common.ts';
export {
  createRelationResolverFactory,
  defaultErrorMapper,
  drizzleError,
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

  const generatorOptions = resolveBuildConfig(config, schema as Record<string, unknown>);

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

  // The three dialect generators are typed on their own dialect's database, so their union
  // does not structurally match `GeneratedEntities<TDbClient>` for a still-generic TDbClient.
  // The runtime branch above is what guarantees the right one was built.
  return { schema: outputSchema, entities: generatorOutput as unknown as GeneratedEntities<TDbClient> };
};
