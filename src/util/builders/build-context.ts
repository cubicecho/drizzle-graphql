// =============================================================================
// The part of a schema build that has nothing to do with the dialect.
//
// Every builder starts the same way: find the tables, resolve the feature flags,
// flatten the relation graph, register the per-build scalar/enum/exclusion state,
// assemble the filter context and the type cache, and generate each table's types.
// Every builder ends the same way too, and the read half in between — the two
// select fields, the aggregate field and the group-by field — is identical down to
// the argument lists.
//
// This module holds all three stretches once. What a dialect still owns is its
// mutation half: PostgreSQL and SQLite return the rows they wrote, MySQL cannot,
// so its mutation fields, return types and resolvers differ throughout.
//
// Keeping this shared is not just deduplication. A feature added to the prelude
// used to reach two of the three dialects — `uniqueKeyFilters` (#90) shipped as a
// flag MySQL accepted and never acted on, because MySQL carried its own copy.
// =============================================================================

import { is, One, type Table } from 'drizzle-orm';
import type { GraphQLFieldConfig, GraphQLInputObjectType, GraphQLObjectType } from 'graphql';
import { GraphQLList, GraphQLNonNull } from 'graphql';
import {
  aggregateFieldComplexity,
  attachTargetPrimaryKeys,
  bindPolicies,
  buildNamedRelations,
  buildUniqueKeyMap,
  createMutationTxCtx,
  createRelationResolverFactory,
  extractRelationJoinColumns,
  generateTableTypes,
  getUniqueColumnSets,
  type LimitPolicyFor,
  listFieldComplexity,
  type MutationTxCtx,
  type NullOrdering,
  pruneNonEagerRelations,
  type RelationAggregateFactory,
  type RelationFilterBase,
  type RelationResolverFactory,
  type ResolverFieldNames,
  type ResolverPolicies,
  registerColumnExclusions,
  type TablesRelationalConfig,
  type TypeCacheCtx,
  type TypeNameMapper,
  type UniqueKeyMap,
  visibleColumns,
} from '../builders/common.ts';
import type { TableFieldExtensionFactory } from '../extensions.ts';
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
import {
  buildNestedWritePlans,
  createNestedWriteRuntime,
  createNestedWriteTypes,
  type NestedWriteRuntime,
  type NestedWriteTypes,
} from './nested-writes.ts';
import { createSelectGenerators } from './select.ts';
import type { GeneratedTableTypes, SchemaGeneratorOptions, TableFeatures, TableNamedRelations } from './types.ts';

/** What {@link createSchemaBuilder} cannot work out for itself. */
export type SchemaBuildAdapter<WithReturning extends boolean = boolean> = {
  /** The dialect's table class, used with `is()` to pick tables out of the schema module. */
  tableClass: any;
  /**
   * The dialect's `getTableConfig`. The three dialects expose the same
   * `{ primaryKeys, uniqueConstraints, indexes }` shape from different modules.
   */
  getTableConfig: (table: any) => any;
  /** Primary-key property names, composite-aware — built on the dialect's `getTableConfig`. */
  primaryKeyPropNames: (table: any) => string[];
  /** How the dialect's `ORDER BY` sorts NULLs, which relation pagination has to match. */
  nullOrdering: NullOrdering;
  /**
   * Whether a write can return the rows it wrote. `false` on MySQL, which has no `RETURNING`
   * clause — its table types carry no `${Table}Item` outputs because no mutation returns one.
   */
  returnsRows: WithReturning;
  /**
   * Dialect-specific validation of the database handle against the requested options, run
   * once the tables are known but before anything is generated. SQLite uses it to reject
   * features a synchronous driver cannot support; MySQL to reject nested writes.
   */
  preflight?: (db: any, options: SchemaGeneratorOptions) => void;
};

/**
 * Everything a build accumulates before its root fields exist, handed to the dialect so it
 * can generate its mutation half against the same tables, caches and policies the shared
 * half used.
 */
export type SchemaBuildContext<WithReturning extends boolean = boolean> = {
  db: any;
  /** The schema module as given, including whatever is not a table. */
  schema: Record<string, unknown>;
  options: SchemaGeneratorOptions;
  /** The tables this build covers — excluded ones already dropped. */
  tables: Record<string, Table>;
  tableEntries: [string, Table][];
  /** This table's feature flags, with any per-table predicate already run. */
  featureOf: (tableName: string) => TableFeatures;
  /** Whether any table in the build wants a feature — i.e. whether to build shared machinery. */
  anyTable: (feature: keyof TableFeatures) => boolean;
  /** The full relation graph, used by type generation. */
  namedRelations: Record<string, Record<string, TableNamedRelations>>;
  /** The relations to eager-load via `with:`, used by the resolvers. */
  eagerRelations: Record<string, Record<string, TableNamedRelations>>;
  filterCtx: RelationFilterBase;
  /** The build's policies as configured, before binding. */
  tablePolicies: SchemaGeneratorOptions['policies'];
  policies: ResolverPolicies | undefined;
  softDeleteOf: NonNullable<SchemaGeneratorOptions['policies']>['softDelete'];
  resolverFactory: RelationResolverFactory;
  cacheCtx: TypeCacheCtx;
  nestedRuntime: NestedWriteRuntime | undefined;
  nestedTypes: NestedWriteTypes | undefined;
  /** Undefined unless `transactions: 'auto'`; its field-name set is filled by `finalizeBuild`. */
  mutationTxCtx: MutationTxCtx | undefined;
  gqlSchemaTypes: Record<string, GeneratedTableTypes<WithReturning>>;
  // A plain map rather than graphql's `ThunkObjMap`, which is a union with a thunk and so
  // cannot be indexed through a property. Still assignable wherever a thunk map is wanted.
  queries: Record<string, GraphQLFieldConfig<any, any>>;
  mutations: Record<string, GraphQLFieldConfig<any, any>>;
  inputs: Record<string, GraphQLInputObjectType>;
  outputs: Record<string, GraphQLObjectType>;
  limits: LimitPolicyFor | undefined;
  typeNameMapper: TypeNameMapper | undefined;
};

/**
 * Binds a dialect and returns the shared halves of its build.
 *
 * Called once per dialect module at import time, so the select generators — which close over
 * the dialect's primary-key lookup and NULL ordering — are built once rather than per
 * `buildSchema`.
 */
export const createSchemaBuilder = <WithReturning extends boolean>(adapter: SchemaBuildAdapter<WithReturning>) => {
  const primaryKeyPropNames = adapter.primaryKeyPropNames;
  const uniqueColumnSets = (table: Table): string[][] => getUniqueColumnSets(table, adapter.getTableConfig);
  const { generateSelectArray, generateSelectSingle } = createSelectGenerators(
    primaryKeyPropNames,
    adapter.nullOrdering,
  );

  /** Everything up to and including each table's generated types. */
  const prepareBuild = (
    db: any,
    schema: Record<string, unknown>,
    relations: TablesRelationalConfig,
    options: SchemaGeneratorOptions,
  ): SchemaBuildContext<WithReturning> => {
    const { relationsDepthLimit, prefixes, typeNameMapper, shouldEagerLoad, features, complexity, limits } = options;
    const schemaEntries = Object.entries(schema);
    // Excluded tables are dropped here, before anything reads `tableEntries` — which also makes
    // `buildNamedRelations` skip every relation pointing at one, since it resolves targets
    // through this list.
    const excludedTables = new Set(options.exclude?.tables ?? []);
    const tableEntries = schemaEntries.filter(
      ([key, value]) => is(value, adapter.tableClass) && !excludedTables.has(key),
    ) as [string, Table][];
    const tables = Object.fromEntries(tableEntries) as Record<string, Table>;

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

    // Resolve scalar overrides into the type-converter's registry before any type generation —
    // every subsequent column→GraphQL type decision and runtime value remap consults it.
    registerScalarOverrides(tables, options);
    // Same lifecycle: the enum registry is per-build, so a second build never reuses the first
    // build's enum types (and with them its naming decisions).
    registerEnumConfig(options);
    // And the same for column exclusions: a per-build registry read by every site that decides
    // what the schema contains, reset here so a rebuild never inherits the previous build's.
    registerColumnExclusions(tables, options.exclude);

    // Flatten drizzle-orm v1 TablesRelationalConfig into the canonical shape
    // used throughout common.ts: Record<tableName, Record<relName, TableNamedRelations>>
    const namedRelations = buildNamedRelations(relations ?? {}, tableEntries);
    // Relations *into* an excluded table are already gone (their target no longer resolves);
    // relations *out of* one have no type left to hang a field on.
    for (const excluded of excludedTables) {
      delete namedRelations[excluded];
    }
    // Record each relation target's primary key (composite-aware) so paginated relations
    // default to a deterministic PK order. Must run before pruning / type generation, which
    // share these entry objects.
    attachTargetPrimaryKeys(namedRelations, tables, (table) => primaryKeyPropNames(table));
    // Relations to eager-load via `with:`. Query/mutation resolvers use this pruned map so
    // opted-out relations never overfetch; type generation keeps the full map so their
    // fields still exist and resolve lazily.
    const eagerRelations = pruneNonEagerRelations(namedRelations, shouldEagerLoad);

    // A `where` field per compound unique constraint, for the tables that asked for one. Built
    // once and shared by the input types and the resolvers: the fields a request may spell and
    // the fields a resolver understands are the same map, so neither can drift from the other.
    const uniqueKeys: Record<string, UniqueKeyMap> = {};
    for (const [tableName, table] of tableEntries) {
      if (!featureOf(tableName).uniqueKeyFilters) {
        continue;
      }
      // Whatever the filter input already offers under a name keeps it — columns are added
      // first, then relations, and a key field last.
      const taken = new Set([...Object.keys(visibleColumns(table)), ...Object.keys(namedRelations[tableName] ?? {})]);
      const map = buildUniqueKeyMap(uniqueColumnSets(table), taken);
      if (Object.keys(map).length) {
        uniqueKeys[tableName] = map;
      }
    }

    const filterCtx: RelationFilterBase = { tables, relationMap: namedRelations, uniqueKeys };

    // The row scope compiled against this build's relation graph, plus the columns whose value
    // the server supplies. Both stay undefined unless configured.
    const tablePolicies = options.policies;
    const contextValuesOf = tablePolicies?.contextValues;
    const softDeleteOf = tablePolicies?.softDelete;
    const policies = bindPolicies(tablePolicies, filterCtx);

    const resolverFactory: RelationResolverFactory = createRelationResolverFactory(
      db,
      tables,
      adapter.nullOrdering,
      filterCtx,
      limits,
      tablePolicies,
    );

    // Fresh cache per build — prevents type name collisions when buildSchema() is called
    // multiple times.
    const cacheCtx: TypeCacheCtx = {
      typeName: options.typeName ?? ((info) => info.defaultName),
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
      primaryKeyOf: (name) => (tables[name] ? primaryKeyPropNames(tables[name] as Table) : []),
      contextValuesOf,
      softDeleteOf,
      featureOf,
      uniqueKeysOf: (tableName) => uniqueKeys[tableName],
    };

    adapter.preflight?.(db, options);

    // Nested writes: the plans decide which relations are writable at all, the types add their
    // fields to the create/update inputs, and the runtime executes them. All three are left
    // undefined when the feature is off, so the inputs and the resolvers stay as they were.
    const nestedPlans = features.nestedWrites
      ? buildNestedWritePlans(
          tables,
          namedRelations,
          (target) => uniqueColumnSets(target as Table),
          (target) => primaryKeyPropNames(target as Table),
          extractRelationJoinColumns,
        )
      : undefined;
    const nestedTypes = nestedPlans
      ? createNestedWriteTypes({ plans: nestedPlans, cacheCtx, typeNameMapper })
      : undefined;
    const nestedRuntime = nestedPlans
      ? createNestedWriteRuntime({
          plans: nestedPlans,
          filterCtx,
          policies: tablePolicies,
          contextValues: contextValuesOf,
        })
      : undefined;

    // Built when at least one table wants relation aggregates; a table that has them off is
    // handed `undefined` below, so `generateTableTypes` emits no `${relation}Aggregate` fields
    // on its object type.
    const relationAggregateFactory: RelationAggregateFactory | undefined = anyTable('relationAggregates')
      ? createRelationAggregateFactory(db, tables, cacheCtx, typeNameMapper, filterCtx, tablePolicies)
      : undefined;

    const gqlSchemaTypes = Object.fromEntries(
      Object.entries(tables).map(([tableName, _table]) => [
        tableName,
        generateTableTypes(
          tableName,
          tables,
          namedRelations,
          adapter.returnsRows,
          relationsDepthLimit,
          cacheCtx,
          typeNameMapper,
          prefixes.insert,
          prefixes.update,
          resolverFactory,
          featureOf(tableName).relationAggregates ? relationAggregateFactory : undefined,
          nestedTypes,
        ),
      ]),
    ) as Record<string, GeneratedTableTypes<WithReturning>>;

    return {
      db,
      schema,
      options,
      tables,
      tableEntries,
      featureOf,
      anyTable,
      namedRelations,
      eagerRelations,
      filterCtx,
      tablePolicies,
      policies,
      softDeleteOf,
      resolverFactory,
      cacheCtx,
      nestedRuntime,
      nestedTypes,
      // Shared per-request transaction machinery for multi-mutation documents; undefined
      // unless `transactions: 'auto'`. Its field-name set is filled once all mutations exist.
      mutationTxCtx: createMutationTxCtx(options.transactions),
      gqlSchemaTypes,
      queries: {},
      mutations: {},
      inputs: {},
      outputs: {},
      limits,
      typeNameMapper,
    };
  };

  /**
   * The table's read fields — both selects, the aggregate and the group-by — generated and
   * hung off the query root. Identical for every dialect: a read returns rows everywhere.
   *
   * The types it built are returned rather than registered, because where they land in the
   * schema's type map is the caller's business — MySQL has no `${Table}Item` output to
   * interleave them with, and the printed order of the two schemas should not drift.
   */
  const addReadFields = (
    ctx: SchemaBuildContext<WithReturning>,
    tableName: string,
    names: ResolverFieldNames,
    tableTypes: GeneratedTableTypes<WithReturning>,
    drizzleMeta: TableFieldExtensionFactory,
  ) => {
    const { db, tables, cacheCtx, filterCtx, eagerRelations, policies, tablePolicies, limits, typeNameMapper } = ctx;
    const { complexity } = ctx.options;
    const table = tables[tableName] as Table;
    const tableFeatures = ctx.featureOf(tableName);
    const { tableFilters, tableOrder } = tableTypes.inputs;
    const { selectSingleOutput, selectArrOutput } = tableTypes.outputs;
    const { typeName, listFieldName, singleFieldName, aggregateFieldName, groupByFieldName } = names;

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
      cacheCtx.typeName,
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
      cacheCtx.typeName,
    );

    const aggregateType = tableFeatures.aggregates
      ? generateAggregateTypes(table, tableName, typeName, cacheCtx)
      : undefined;
    const aggregateGenerated = tableFeatures.aggregates
      ? generateAggregate(
          db,
          tableName,
          table,
          typeName,
          aggregateFieldName,
          tableFilters,
          filterCtx,
          tablePolicies,
          cacheCtx.typeName,
        )
      : undefined;

    // The grouped result reuses the aggregate output types, so it only exists alongside them.
    const groupByType =
      tableFeatures.aggregates && tableFeatures.groupBy
        ? generateGroupByType(table, tableName, typeName, cacheCtx)
        : undefined;
    const groupByEnum = groupByType ? generateGroupByEnum(table, tableName, typeName, cacheCtx) : undefined;
    const havingInput = groupByEnum ? generateHavingInput(table, tableName, typeName, cacheCtx) : undefined;
    const groupByGenerated =
      groupByType && groupByEnum && havingInput
        ? generateGroupBy(
            db,
            tableName,
            table,
            typeName,
            groupByFieldName,
            tableFilters,
            groupByEnum,
            havingInput,
            filterCtx,
            tablePolicies,
            cacheCtx.typeName,
          )
        : undefined;

    ctx.queries[selectArrGenerated.name] = {
      type: selectArrOutput,
      args: selectArrGenerated.args,
      resolve: selectArrGenerated.resolver,
      extensions: {
        drizzle: drizzleMeta({ kind: 'query', operation: 'select', single: false, targetArg: 'where' }),
        ...(complexity ? { complexity: listFieldComplexity(complexity, limits?.(tableName)) } : {}),
      },
    };
    ctx.queries[selectSingleGenerated.name] = {
      type: selectSingleOutput,
      args: selectSingleGenerated.args,
      resolve: selectSingleGenerated.resolver,
      extensions: {
        drizzle: drizzleMeta({ kind: 'query', operation: 'select', single: true, targetArg: 'where' }),
      },
    };
    if (aggregateGenerated && aggregateType) {
      ctx.queries[aggregateGenerated.name] = {
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
      ctx.queries[groupByGenerated.name] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(groupByType))),
        args: groupByGenerated.args,
        resolve: groupByGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'aggregate', operation: 'groupBy', single: false, targetArg: 'where' }),
          ...(complexity ? { complexity: aggregateFieldComplexity(complexity) } : {}),
        },
      };
    }

    return { aggregateType, groupByType, havingInput };
  };

  /** The relation field resolvers and the transaction roster, once every root field exists. */
  const finalizeBuild = (ctx: SchemaBuildContext<WithReturning>): any => {
    // Every generated mutation name is now known — the first mutation resolver of a request
    // uses this set to count the document's root mutation fields (and to leave documents
    // containing consumer-added mutations alone).
    if (ctx.mutationTxCtx) {
      for (const name of Object.keys(ctx.mutations)) {
        ctx.mutationTxCtx.fieldNames.add(name);
      }
    }

    const fieldResolvers: Record<string, Record<string, any>> = {};
    for (const [tableName, tableRelations] of Object.entries(ctx.namedRelations)) {
      const relResolvers: Record<string, any> = {};
      for (const [relName, relEntry] of Object.entries(tableRelations)) {
        const isOne = is((relEntry as any).relation ?? relEntry, One);
        const resolver = ctx.resolverFactory({ tableName, relationName: relName, relEntry, isOne });
        if (resolver) {
          relResolvers[relName] = resolver;
        }
      }
      if (Object.keys(relResolvers).length > 0) {
        fieldResolvers[tableName] = relResolvers;
      }
    }

    return {
      queries: ctx.queries,
      mutations: ctx.mutations,
      inputs: ctx.inputs,
      types: ctx.outputs,
      fieldResolvers,
    };
  };

  return { primaryKeyPropNames, uniqueColumnSets, prepareBuild, addReadFields, finalizeBuild };
};
