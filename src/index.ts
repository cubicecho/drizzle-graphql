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
import type { AnyDrizzleDB, BuildSchemaConfig, GeneratedData } from './types.ts';
import { applyErrorMapper, defaultErrorMapper } from './util/builders/common.ts';
import { generateMySQL, generatePG, generateSQLite } from './util/builders/index.ts';
import type { SchemaGeneratorOptions } from './util/builders/types.ts';

export type {
  AggregateResolver,
  AnyDrizzleDB,
  BuildSchemaConfig,
  ComplexityConfig,
  DeleteResolver,
  ExtractRelations,
  ExtractTableByName,
  ExtractTableRelations,
  ExtractTables,
  GeneratedData,
  GeneratedEntities,
  GeneratedInputs,
  GeneratedOutputs,
  InsertArrResolver,
  InsertResolver,
  MutationReturnlessResult,
  MutationsCore,
  QueriesCore,
  SchemaFeatures,
  SelectResolver,
  SelectSingleResolver,
  UpdateResolver,
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
export {
  GraphQLBigIntString,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLJSON,
  GraphQLUUID,
} from './util/scalars/index.ts';

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

  const typeNameMapper = config?.typeNameMapper;

  // Every feature is on unless the caller says otherwise, so a build without a `features`
  // block generates what it always did — except upsert, which is new surface and so has to
  // be asked for.
  const features = {
    aggregates: config?.features?.aggregates ?? true,
    relationAggregates: config?.features?.relationAggregates ?? true,
    distinct: config?.features?.distinct ?? true,
    insert: config?.features?.insert ?? true,
    update: config?.features?.update ?? true,
    delete: config?.features?.delete ?? true,
    upsert: config?.features?.upsert ?? false,
  };

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
    features,
    complexity,
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
