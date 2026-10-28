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
// The per-table loop is shared as well: `forEachTable` works out what every dialect
// needs per table, calls the dialect back for the mutations it generated, and then
// registers those and the inputs and outputs they reference. What a dialect still
// owns is the mutation half itself — PostgreSQL and SQLite return the rows they
// wrote, MySQL cannot, so its mutation fields, return types and resolvers differ
// throughout.
//
// Keeping this shared is not just deduplication. A feature added to the prelude
// used to reach two of the three dialects — `uniqueKeyFilters` (#90) shipped as a
// flag MySQL accepted and never acted on, because MySQL carried its own copy.
// =============================================================================

import { getColumns, is, One, type Table } from 'drizzle-orm';
import type { GraphQLFieldConfig, GraphQLInputObjectType, GraphQLObjectType, GraphQLOutputType } from 'graphql';
import { GraphQLList, GraphQLNonNull } from 'graphql';
import {
  aggregateFieldComplexity,
  bindPolicies,
  buildRelationGraph,
  computeResolverFieldNames,
  createMutationTxCtx,
  createRelationResolverFactory,
  defineRootField,
  extractRelationJoinColumns,
  generateTableTypes,
  getRowKeyCandidates,
  getUniqueColumnSets,
  insertStamps,
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
  type SoftDeleteInfo,
  type TablesRelationalConfig,
  type TypeCacheCtx,
  type TypeNameMapper,
  tableUniqueKeyMap,
  type UniqueKeyMap,
  unwrapRelationColumn,
} from '../builders/common.ts';
import { installSqliteBlobJsonDecoders } from '../data-mappers/index.ts';
import { type DrizzleMutationMeta, type TableFieldExtensionFactory, tableFieldExtensions } from '../extensions.ts';
import { resolveTableFeatures } from '../features.ts';
import { beginPerBuildInstall } from '../per-build-registry.ts';
import { registerEnumConfig, registerScalarOverrides } from '../type-converter/index.ts';
import {
  createRelationAggregateFactory,
  generateAggregate,
  generateAggregateTypes,
  generateGroupBy,
  generateGroupByEnum,
  generateGroupByType,
  generateHavingInput,
  resetAggregateColumnCache,
} from './aggregates.ts';
import { registerBuildRuntime } from './common/build-registry.ts';
import { resetFieldUpdateCaches } from './field-updates.ts';
import { dropContextValueRelations, gateNestedWritePlans } from './nested-writes/gating.ts';
import { createNestedWriteTypes, type NestedWriteTypes } from './nested-writes/input-types.ts';
import { buildNestedWritePlans, type NestedWritePlans } from './nested-writes/plans.ts';
import { createNestedWriteRuntime, type NestedWriteRuntime } from './nested-writes/runtime.ts';
import { createSelectGenerators, type ReadBuildOptions } from './select.ts';
import type {
  CreatedResolver,
  GeneratedTableTypes,
  GeneratedTableTypesOutputs,
  SchemaGeneratorOptions,
  TableFeatures,
  TableNamedRelations,
} from './types.ts';

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
 * One generated mutation, ready to be hung off the mutation root: what the field returns,
 * and what it says about itself. A dialect's per-table callback answers with a list of these
 * rather than registering fields itself, so the registration — and the collision check in
 * {@link defineRootField} — happens in one place for all three dialects.
 */
export type MutationRegistration = {
  /** Undefined when this table's features left the mutation ungenerated. */
  generated: CreatedResolver | undefined;
  type: GraphQLOutputType;
  /**
   * The identity published on `extensions.drizzle`. The count mutations carry their plural
   * sibling's operation plus `count: true`, so a wrapper gating writes on `operation` cannot
   * be bypassed by swapping in the count variant.
   */
  meta?: DrizzleMutationMeta;
  description?: string;
};

/** What a dialect's per-table callback hands back for {@link forEachTable} to register. */
export type TableMutations = {
  /** In registration order, which is the order the fields appear in the schema. */
  mutations: MutationRegistration[];
  /**
   * The two inputs whose presence is decided by the mutation half rather than by a feature
   * flag, and which the shared loop needs in order to know whether to publish them.
   */
  onConflictInput?: GraphQLInputObjectType;
  updateManyInput?: GraphQLInputObjectType;
};

/** The per-table values {@link forEachTable} has already worked out, handed to the dialect. */
export type TableBuild<WithReturning extends boolean = boolean> = {
  tableName: string;
  table: Table;
  /** This table's feature flags, with any per-table predicate already run. */
  tableFeatures: TableFeatures;
  /** Builds what a field of this table publishes under `extensions.drizzle`. */
  drizzleMeta: TableFieldExtensionFactory;
  /** The generated field names, from the naming config. */
  names: ResolverFieldNames;
  types: GeneratedTableTypes<WithReturning>;
  /** Set when the table marks rows deleted instead of removing them. */
  softDeleteInfo: SoftDeleteInfo | undefined;
};

/**
 * Installs this build's module-level state, in order, replacing what the previous build left.
 * Scalar overrides, column exclusions and the SQLite blob decoders are kept per table or column
 * object, so a second build changes only the tables it shares with the first; the enum registry
 * and the aggregate and field-update caches are replaced whole. Request-time remapping reads the
 * scalar overrides and field-update kinds, so there the most recent build wins.
 */
const installBuildRegistries = (tables: Record<string, Table>, options: SchemaGeneratorOptions): void => {
  beginPerBuildInstall();
  registerScalarOverrides(tables, options);
  installSqliteBlobJsonDecoders(tables);
  registerEnumConfig(options);
  registerColumnExclusions(tables, options.exclude);
  resetAggregateColumnCache();
  resetFieldUpdateCaches();
};

/** How many tables a build-time warning names before it only counts the rest. */
const MAX_LISTED_OMISSIONS = 5;

/** `names` for a build-time warning: the first few, then how many more. */
const listForWarning = (names: string[]): string =>
  names.length > MAX_LISTED_OMISSIONS
    ? `${names.slice(0, MAX_LISTED_OMISSIONS).join(', ')} and ${names.length - MAX_LISTED_OMISSIONS} more`
    : names.join(', ');

/**
 * For each of `tableNames` that is the junction of a many-to-many relation (its `.through()`
 * table), a hint naming the key to give it: its join columns, by property name. One per table,
 * from the first relation found that runs through it.
 */
const junctionKeyHints = (
  tableNames: string[],
  tables: Record<string, Table>,
  namedRelations: Record<string, Record<string, TableNamedRelations>>,
): string[] =>
  tableNames.flatMap((junctionName) => {
    const junction = tables[junctionName];
    const propNameOf = new Map(Object.entries(getColumns(junction as Table)).map(([propName, col]) => [col, propName]));
    for (const [tableName, tableRelations] of Object.entries(namedRelations)) {
      for (const [relationName, relEntry] of Object.entries(tableRelations)) {
        const rel = relEntry.relation as any;
        if (!junction || rel.throughTable !== junction) {
          continue;
        }
        const joinColumns = [...(rel.through?.source ?? []), ...(rel.through?.target ?? [])].map((entry: unknown) =>
          propNameOf.get(unwrapRelationColumn(entry) as any),
        );
        if (!joinColumns.length || joinColumns.some((propName) => !propName)) {
          continue;
        }
        const columns = [...new Set(joinColumns)].map((propName) => `t.${propName}`).join(', ');
        return [
          `${junctionName} is the junction of ${tableName}.${relationName}; give it primaryKey({ columns: [${columns}] })`,
        ];
      }
    }
    return [];
  });

/**
 * A fresh type cache for one build, so a second `buildSchema` never reuses the first one's
 * types and two of them never collide on a name.
 */
const createTypeCache = (build: {
  options: SchemaGeneratorOptions;
  tables: Record<string, Table>;
  primaryKeyPropNames: (table: any) => string[];
  featureOf: (tableName: string) => TableFeatures;
  uniqueKeys: Record<string, UniqueKeyMap>;
}): TypeCacheCtx => {
  const { options, tables, primaryKeyPropNames, featureOf, uniqueKeys } = build;
  return {
    resolveName: options.resolveName ?? ((info) => info.defaultName),
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
    complexity: options.complexity,
    limits: options.limits,
    docs: options.docs ?? {},
    primaryKeyOf: (name) => (tables[name] ? primaryKeyPropNames(tables[name] as Table) : []),
    contextValuesOf: options.policies?.contextValues,
    softDeleteOf: options.policies?.softDelete,
    featureOf,
    uniqueKeysOf: (tableName) => uniqueKeys[tableName],
  };
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

  /**
   * A `where` field per compound unique constraint, for the tables that asked for one. Shared
   * by the input types and the resolvers, so the fields a request may spell and the fields a
   * resolver understands cannot drift apart.
   */
  const buildUniqueKeys = (
    tableEntries: [string, Table][],
    featureOf: (tableName: string) => TableFeatures,
    namedRelations: Record<string, Record<string, TableNamedRelations>>,
  ): Record<string, UniqueKeyMap> => {
    const uniqueKeys: Record<string, UniqueKeyMap> = {};
    for (const [tableName, table] of tableEntries) {
      if (!featureOf(tableName).uniqueKeyFilters) {
        continue;
      }
      // Whatever the filter input already offers under a name keeps it — columns are added
      // first, then relations, and a key field last.
      const map = tableUniqueKeyMap(table, Object.keys(namedRelations[tableName] ?? {}), uniqueColumnSets(table));
      if (Object.keys(map).length) {
        uniqueKeys[tableName] = map;
      }
    }
    return uniqueKeys;
  };

  /**
   * The nested-write plans, less what the build cannot offer: an input whose write is turned
   * off on its target (or junction) table, and a relation keyed on a column the server stamps
   * from `contextValues`. Each omission is reported once as a warning.
   */
  const buildGatedNestedPlans = (build: {
    schemaEntries: [string, unknown][];
    tables: Record<string, Table>;
    namedRelations: Record<string, Record<string, TableNamedRelations>>;
    excludedTables: ReadonlySet<string>;
    featureOf: (tableName: string) => TableFeatures;
    tablePolicies: SchemaGeneratorOptions['policies'];
  }): NestedWritePlans => {
    const { schemaEntries, tables, namedRelations, excludedTables, featureOf, tablePolicies } = build;
    const contextValuesOf = tablePolicies?.contextValues;
    const softDeleteOf = tablePolicies?.softDelete;
    const plans = buildNestedWritePlans(
      tables,
      namedRelations,
      // A partial unique index still says which side of a one-to-one holds the key.
      (target) => getUniqueColumnSets(target as Table, adapter.getTableConfig, { partial: true }),
      (target) => primaryKeyPropNames(target as Table),
      extractRelationJoinColumns,
      // A junction is written without being a relation target, so it is named from the
      // whole schema — excluded tables included, which the gate below then refuses.
      (junction) => schemaEntries.find(([, value]) => value === junction)?.[0],
      (tableName) => insertStamps({ contextValues: contextValuesOf, softDelete: softDeleteOf }, tableName),
    );

    const turnedOff = gateNestedWritePlans(
      plans,
      featureOf,
      (tableName) => excludedTables.has(tableName),
      (tableName) => !!softDeleteOf?.(tableName),
    );
    if (turnedOff.length) {
      console.warn(
        `Drizzle-GraphQL Warning: config.features — nestedWrites leaves out the nested inputs whose table has that write turned off: ${listForWarning(turnedOff)}.`,
      );
    }

    const stamped = dropContextValueRelations(plans, contextValuesOf);
    if (stamped.length) {
      console.warn(
        `Drizzle-GraphQL Warning: config.contextValues — nestedWrites leaves out the relations whose foreign key the server stamps from context: ${stamped.join(', ')}.`,
      );
    }
    return plans;
  };

  /** Everything up to and including each table's generated types. */
  const prepareBuild = (
    db: any,
    schema: Record<string, unknown>,
    relations: TablesRelationalConfig,
    options: SchemaGeneratorOptions,
  ): SchemaBuildContext<WithReturning> => {
    const { relationsDepthLimit, prefixes, typeNameMapper, shouldEagerLoad, features, limits } = options;
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

    // Before any type generation: every column→GraphQL type decision reads these.
    installBuildRegistries(tables, options);

    // Each relation entry carries its target's primary key before pruning and type generation,
    // which share the entry objects, so paginated relations default to a deterministic order.
    const namedRelations = buildRelationGraph(relations ?? {}, tableEntries, primaryKeyPropNames, excludedTables);
    // Relations to eager-load via `with:`. Query/mutation resolvers use this pruned map so
    // opted-out relations never overfetch; type generation keeps the full map so their
    // fields still exist and resolve lazily.
    const eagerRelations = pruneNonEagerRelations(namedRelations, shouldEagerLoad);

    const uniqueKeys = buildUniqueKeys(tableEntries, featureOf, namedRelations);
    const filterCtx: RelationFilterBase = { tables, namedRelations, uniqueKeys };

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

    const cacheCtx = createTypeCache({ options, tables, primaryKeyPropNames, featureOf, uniqueKeys });

    adapter.preflight?.(db, options);

    // Nested writes: the plans decide which relations are writable at all, the types add their
    // fields to the create/update inputs, and the runtime executes them. All three are left
    // undefined when the feature is off, so the inputs and the resolvers stay as they were.
    const nestedPlans = features.nestedWrites
      ? buildGatedNestedPlans({ schemaEntries, tables, namedRelations, excludedTables, featureOf, tablePolicies })
      : undefined;
    const nestedTypes = nestedPlans
      ? createNestedWriteTypes({ plans: nestedPlans, cacheCtx, typeNameMapper })
      : undefined;
    const nestedRuntime = nestedPlans
      ? createNestedWriteRuntime({
          plans: nestedPlans,
          filterCtx,
          policies,
          contextValues: contextValuesOf,
        })
      : undefined;

    // Built when at least one table wants relation aggregates; a table that has them off is
    // handed `undefined` below, so `generateTableTypes` emits no `${relation}Aggregate` fields
    // on its object type.
    const relationAggregateFactory: RelationAggregateFactory | undefined = anyTable('relationAggregates')
      ? createRelationAggregateFactory(db, tables, cacheCtx, typeNameMapper, filterCtx, policies)
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
          prefixes.upsert,
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
    const { db, tables, cacheCtx, filterCtx, eagerRelations, policies, limits, typeNameMapper } = ctx;
    const { complexity } = ctx.options;
    const table = tables[tableName] as Table;
    const tableFeatures = ctx.featureOf(tableName);
    const { tableFilters, tableOrder } = tableTypes.inputs;
    const { selectSingleOutput, selectArrOutput } = tableTypes.outputs;
    const { typeName, listFieldName, singleFieldName, aggregateFieldName, groupByFieldName } = names;

    const readBuild: ReadBuildOptions = {
      db,
      tables,
      eagerRelations,
      typeNameMapper,
      filterCtx,
      limits,
      policies,
      resolveName: cacheCtx.resolveName,
    };
    const selectArrGenerated = generateSelectArray(readBuild, {
      tableName,
      orderArgs: tableOrder,
      filterArgs: tableFilters,
      fieldName: listFieldName,
      typeName,
      distinct: tableFeatures.distinct,
    });
    const selectSingleGenerated = generateSelectSingle(readBuild, {
      tableName,
      orderArgs: tableOrder,
      filterArgs: tableFilters,
      fieldName: singleFieldName,
    });

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
          policies,
          cacheCtx.resolveName,
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
            policies,
            cacheCtx.resolveName,
          )
        : undefined;

    defineRootField(ctx.queries, 'query', selectArrGenerated.name, {
      type: selectArrOutput,
      args: selectArrGenerated.args,
      resolve: selectArrGenerated.resolver,
      extensions: {
        drizzle: drizzleMeta({ kind: 'query', operation: 'select', single: false, targetArg: 'where' }),
        ...(complexity ? { complexity: listFieldComplexity(complexity, limits?.(tableName)) } : {}),
      },
    });
    defineRootField(ctx.queries, 'query', selectSingleGenerated.name, {
      type: selectSingleOutput,
      args: selectSingleGenerated.args,
      resolve: selectSingleGenerated.resolver,
      extensions: {
        drizzle: drizzleMeta({ kind: 'query', operation: 'select', single: true, targetArg: 'where' }),
      },
    });
    if (aggregateGenerated && aggregateType) {
      defineRootField(ctx.queries, 'query', aggregateGenerated.name, {
        type: new GraphQLNonNull(aggregateType),
        args: aggregateGenerated.args,
        resolve: aggregateGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'aggregate', operation: 'aggregate', single: true, targetArg: 'where' }),
          ...(complexity ? { complexity: aggregateFieldComplexity(complexity) } : {}),
        },
      });
    }
    if (groupByGenerated && groupByType) {
      defineRootField(ctx.queries, 'query', groupByGenerated.name, {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(groupByType))),
        args: groupByGenerated.args,
        resolve: groupByGenerated.resolver,
        extensions: {
          drizzle: drizzleMeta({ kind: 'aggregate', operation: 'groupBy', single: false, targetArg: 'where' }),
          ...(complexity ? { complexity: aggregateFieldComplexity(complexity) } : {}),
        },
      });
    }

    return { aggregateType, groupByType, havingInput };
  };

  /**
   * The per-table loop, run once for every table the build covers.
   *
   * The dialect's callback receives the values the loop has already worked out — the feature
   * flags, the extension factory, the field names, the table's generated types and its
   * soft-delete config — and answers with the mutations it generated. Registering them, and
   * registering the inputs and outputs those mutations reference, happens here: both sides
   * did it identically, down to the `description` strings on the count mutations, so a gate
   * changed on one side and forgotten on the other used to be a silent dialect divergence.
   *
   * What stays in the dialect is what genuinely differs — which generators run, what each
   * mutation returns, and (on MySQL) that a write cannot report the rows it touched.
   */
  const forEachTable = (
    ctx: SchemaBuildContext<WithReturning>,
    perTable: (build: TableBuild<WithReturning>) => TableMutations,
  ): void => {
    const { schema, featureOf, softDeleteOf, typeNameMapper, gqlSchemaTypes, mutations, inputs, outputs } = ctx;
    const { prefixes, suffixes } = ctx.options;
    // Tables whose `…Single` update or delete has no key to pin its write to (`narrowToSingleMatch`).
    const unkeyed: string[] = [];

    for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
      // Everything this table generates, with any per-table predicate already run.
      const tableFeatures = featureOf(tableName);
      if (
        (tableFeatures.update || tableFeatures.delete) &&
        !getRowKeyCandidates(schema[tableName] as Table, adapter.getTableConfig).length
      ) {
        unkeyed.push(tableName);
      }
      // What every field this table generates publishes about itself under `extensions.drizzle`,
      // so a wrapper can read a field's identity instead of parsing its configurable name.
      const drizzleMeta = tableFieldExtensions(tableName, primaryKeyPropNames(schema[tableName] as Table));
      // Compute field names using the mapper logic
      const names = computeResolverFieldNames(tableName, typeNameMapper, prefixes, suffixes);
      // A table that marks rows deleted instead of removing them also gets the mutation that
      // reverses it — clearing the column through an ordinary update is not possible, since the
      // column is not in the update input and a marked row is invisible to a `where` anyway.
      const softDeleteInfo = softDeleteOf?.(tableName);

      // Both selects, the aggregate and the group-by: generated and hung off the query root
      // by the shared builder, since a read is a read on every dialect.
      const readTypes = addReadFields(ctx, tableName, names, tableTypes, drizzleMeta);

      const built = perTable({
        tableName,
        table: schema[tableName] as Table,
        tableFeatures,
        drizzleMeta,
        names,
        types: tableTypes,
        softDeleteInfo,
      });

      for (const { generated, type, meta, description } of built.mutations) {
        if (generated) {
          defineRootField(mutations, 'mutation', generated.name, {
            type,
            args: generated.args,
            resolve: generated.resolver,
            ...(meta ? { extensions: { drizzle: drizzleMeta({ kind: 'mutation', ...meta }) } } : {}),
            ...(description ? { description } : {}),
          });
        }
      }

      const { insertInput, updateInput, upsertInput, tableFilters, tableOrder } = tableTypes.inputs;
      // The insert/update inputs are still built (they type the mutations that survive) but
      // only reach the schema's type map when a mutation actually references them.
      const activeInputs = [
        // The insert input types the upsert mutations too, unless the table has an upsert
        // input of its own.
        ...(tableFeatures.insert || (built.onConflictInput && !upsertInput) ? [insertInput] : []),
        ...(built.onConflictInput ? [built.onConflictInput, ...(upsertInput ? [upsertInput] : [])] : []),
        ...(tableFeatures.update ? [updateInput] : []),
        ...(built.updateManyInput ? [built.updateManyInput] : []),
        tableFilters,
        ...(tableOrder ? [tableOrder] : []),
      ];
      activeInputs.forEach((e) => {
        inputs[e.name] = e;
      });
      const { selectSingleOutput } = tableTypes.outputs;
      outputs[selectSingleOutput.name] = selectSingleOutput;
      if (adapter.returnsRows) {
        // Only a dialect with RETURNING has a `${Table}Item` type — its mutations answer with
        // one, where MySQL's answer with the build's shared `MutationReturn`.
        const { singleTableItemOutput } = tableTypes.outputs as GeneratedTableTypesOutputs<true>;
        outputs[singleTableItemOutput.name] = singleTableItemOutput;
      }
      const { aggregateType, groupByType, havingInput } = readTypes;
      if (aggregateType) {
        outputs[aggregateType.name] = aggregateType;
      }
      if (groupByType && havingInput) {
        outputs[groupByType.name] = groupByType;
        inputs[havingInput.name] = havingInput;
      }
    }

    if (unkeyed.length) {
      const hints = junctionKeyHints(unkeyed.slice(0, MAX_LISTED_OMISSIONS), ctx.tables, ctx.namedRelations);
      console.warn(
        `Drizzle-GraphQL Warning: these tables have no primary key or unique key, so their Single update and delete cannot be pinned to the row they checked — a row that starts matching mid-write is written too: ${listForWarning(unkeyed)}.${hints.map((hint) => ` ${hint}.`).join('')}`,
      );
    }
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

    // `resolveSelection` / `selectionToWith` find this build's policies through its types.
    registerBuildRuntime(
      {
        db: ctx.db,
        filterCtx: ctx.filterCtx,
        policies: ctx.policies,
        hasRowScope: !!ctx.tablePolicies?.scope,
        limits: ctx.limits,
        nullOrdering: adapter.nullOrdering,
      },
      Object.values(ctx.outputs),
    );

    return {
      queries: ctx.queries,
      mutations: ctx.mutations,
      inputs: ctx.inputs,
      types: ctx.outputs,
      fieldResolvers,
    };
  };

  return { primaryKeyPropNames, uniqueColumnSets, prepareBuild, forEachTable, finalizeBuild };
};
