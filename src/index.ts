import {
  type GraphQLFieldConfig,
  type GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLSchema,
  type GraphQLSchemaConfig,
} from 'graphql';
import type { AnyDrizzleDB, BuildSchemaConfig, GeneratedData, NamingOf } from './types.ts';
import { resolveBuildConfig } from './util/build-config.ts';
import { applyErrorMapper, defaultErrorMapper, tablesOfRelations } from './util/builders/common.ts';
import { dialectOf } from './util/builders/dialects.ts';

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
  DerivedTypeNameMapper,
  ExtractRelations,
  ExtractTableByName,
  ExtractTableRelations,
  ExtractTables,
  FeatureSwitch,
  GeneratedData,
  GeneratedEntities,
  GeneratedInputs,
  GeneratedOutputs,
  GeneratedTypeInfo,
  GeneratedTypeKind,
  InsertArrResolver,
  InsertResolver,
  LimitsConfig,
  MutationReturnlessResult,
  MutationsCore,
  NamingOf,
  NestedWriteOp,
  NestedWriteOrigin,
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
  TypeNameMapper,
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
export type { FieldsByTypeName, ParseResolveInfoOptions, ResolveTree } from './util/parse-resolve-info.ts';
export { parseResolveInfo } from './util/parse-resolve-info.ts';
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
  EnumValueNameInfo,
  EnumValueNameMapper,
  RelationDescriber,
  ScalarOverride,
  ScalarOverridesConfig,
  SchemaDocs,
  TableDescriber,
} from './util/type-converter/types.ts';
export type { Pluralize, Singularize, TypeNaming } from './util/type-naming.ts';

type ObjMap<T> = Record<string, T>;

export const buildSchema = <TDbClient extends AnyDrizzleDB<any>, TConfig extends BuildSchemaConfig = BuildSchemaConfig>(
  db: TDbClient,
  config?: TConfig,
): GeneratedData<TDbClient, NamingOf<TConfig>> => {
  const relations = db._.relations;
  // `_.fullSchema` is gone from all three dialects and the constructor's separate `schema`
  // argument no longer reaches the handle, so the table map comes from the relations config.
  const schema = tablesOfRelations(relations);

  if (!Object.keys(schema).length) {
    throw new Error(
      'Drizzle-GraphQL Error: Schema not found in drizzle instance. Pass relations (from buildRelations/defineRelations) to the drizzle constructor so drizzle-graphql can detect your tables.',
    );
  }

  const generatorOptions = resolveBuildConfig(config, schema);

  const dialect = dialectOf(db);
  if (!dialect) {
    throw new Error('Drizzle-GraphQL Error: Unknown database instance type');
  }
  const generatorOutput = dialect.generateSchemaData(db, schema, relations, generatorOptions);

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

  // Each dialect generator is typed on its own database, so none matches
  // `GeneratedEntities<TDbClient>` for a still-generic TDbClient; `dialectOf` picked this one.
  return {
    schema: outputSchema,
    entities: generatorOutput as unknown as GeneratedData<TDbClient, NamingOf<TConfig>>['entities'],
  };
};
