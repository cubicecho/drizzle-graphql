// =============================================================================
// The dialect-independent half of `generateSchemaData`.
//
// PostgreSQL and SQLite build a schema the same way: the same tables are found,
// the same relation graph is flattened, the same per-table types and resolvers
// are generated, and the same fields are hung off the query and mutation roots.
// The two builders used to carry ~750 lines of that logic each, drifting
// independently. This module holds it once; a dialect supplies only the handful
// of things it genuinely owns, through {@link DialectSchemaAdapter}.
//
// MySQL is deliberately not on this path: its writes return no rows, so its
// mutation fields, their return types and their resolvers differ throughout.
// =============================================================================

import { is, One, type Table } from 'drizzle-orm';
import type { GraphQLFieldConfig, GraphQLInputObjectType, GraphQLObjectType, ThunkObjMap } from 'graphql';
import { GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import {
  aggregateFieldComplexity,
  attachTargetPrimaryKeys,
  bindPolicies,
  buildNamedRelations,
  computeResolverFieldNames,
  createMutationTxCtx,
  createRelationResolverFactory,
  extractRelationJoinColumns,
  generateOnConflictInput,
  generateTableTypes,
  generateUpdateManyInput,
  generateWriteCount,
  getUniqueColumnSets,
  type LimitPolicyFor,
  listFieldComplexity,
  type MutationTxCtx,
  type NullOrdering,
  pruneNonEagerRelations,
  type RelationAggregateFactory,
  type RelationFilterBase,
  type RelationResolverFactory,
  type ResolverPolicies,
  registerColumnExclusions,
  type TablesRelationalConfig,
  type TypeCacheCtx,
  type TypeNameMapper,
} from '../builders/common.ts';
import { tableFieldExtensions } from '../extensions.ts';
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
} from './nested-writes.ts';
import { createSelectGenerators } from './select.ts';
import type { CreatedResolver, SchemaGeneratorOptions, TableFeatures, TableNamedRelations } from './types.ts';
import { buildWriteResolvers } from './write-resolvers.ts';

/** `update<Table>Many` — batch update, whose statement loop is dialect-specific. */
export type UpdateManyGenerator = (
  db: any,
  tableName: string,
  table: any,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  updateManyInput: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  txCtx?: MutationTxCtx,
  nested?: NestedWriteRuntime,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
) => CreatedResolver;

/** Everything {@link createSchemaDataGenerator} cannot decide for itself. */
export type DialectSchemaAdapter = {
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
   * Dialect-specific validation of the database handle against the requested options,
   * run once the tables are known but before anything is generated. SQLite uses it to
   * reject features a synchronous driver cannot support.
   */
  preflight?: (db: any, options: SchemaGeneratorOptions) => void;
  generateUpdateMany: UpdateManyGenerator;
};

/**
 * Binds an adapter and returns the dialect's `generateSchemaData` implementation.
 *
 * Called once per dialect module at import time, so the write resolvers — which close
 * over the dialect's primary-key lookup — are built once rather than per `buildSchema`.
 */
export const createSchemaDataGenerator = (adapter: DialectSchemaAdapter) => {
  const primaryKeyPropNames = adapter.primaryKeyPropNames;
  const uniqueColumnSets = (table: Table): string[][] => getUniqueColumnSets(table, adapter.getTableConfig);
  const { generateInsertArray, generateInsertSingle, generateUpsert, generateUpdate, generateDelete } =
    buildWriteResolvers(primaryKeyPropNames);
  // Derived rather than supplied: the two values a select generator needs are already on the
  // adapter, and all three dialects read the same way.
  const { generateSelectArray, generateSelectSingle } = createSelectGenerators(
    primaryKeyPropNames,
    adapter.nullOrdering,
  );

  return (
    db: any,
    schema: Record<string, unknown>,
    relations: TablesRelationalConfig,
    options: SchemaGeneratorOptions,
  ): any => {
    const {
      relationsDepthLimit,
      prefixes,
      suffixes,
      conflictDoNothing,
      typeNameMapper,
      shouldEagerLoad,
      features,
      complexity,
      limits,
    } = options;
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
      adapter.nullOrdering,
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
      primaryKeyOf: (name) => (tables[name] ? primaryKeyPropNames(tables[name] as Table) : []),
      contextValuesOf,
      softDeleteOf,
      featureOf,
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

    const queries: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};
    const mutations: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};

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
          featureOf(tableName).relationAggregates ? relationAggregateFactory : undefined,
          nestedTypes,
        ),
      ]),
    );

    const inputs: Record<string, GraphQLInputObjectType> = {};
    const outputs: Record<string, GraphQLObjectType> = {};

    for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
      // Everything this table generates, with any per-table predicate already run.
      const tableFeatures = featureOf(tableName);
      // What every field this table generates publishes about itself under `extensions.drizzle`,
      // so a wrapper can read a field's identity instead of parsing its configurable name.
      const drizzleMeta = tableFieldExtensions(tableName, primaryKeyPropNames(schema[tableName] as Table));
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
        updateCountFieldName,
        deleteFieldName,
        deleteSingleFieldName,
        restoreFieldName,
        restoreSingleFieldName,
        deleteCountFieldName,
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
            schema[tableName] as Table,
            tables,
            eagerRelations,
            insertInput,
            createArrayFieldName,
            typeName,
            typeNameMapper,
            conflictDoNothing,
            mutationTxCtx,
            nestedRuntime,
            limits,
            policies,
          )
        : undefined;
      const insertSingleGenerated = tableFeatures.insert
        ? generateInsertSingle(
            db,
            tableName,
            schema[tableName] as Table,
            tables,
            eagerRelations,
            insertInput,
            createSingleFieldName,
            typeName,
            typeNameMapper,
            conflictDoNothing,
            mutationTxCtx,
            nestedRuntime,
            limits,
            policies,
          )
        : undefined;
      // An upsert needs something to conflict on, so a table with no primary key and no
      // unique constraint gets no upsert mutations rather than ones that always fail.
      const uniqueSets = tableFeatures.upsert ? uniqueColumnSets(schema[tableName] as Table) : [];
      const onConflictInput = tableFeatures.upsert
        ? generateOnConflictInput({
            table: schema[tableName] as Table,
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
            schema[tableName] as Table,
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
            nestedRuntime,
            limits,
            policies,
          )
        : undefined;
      const upsertSingleGenerated = onConflictInput
        ? generateUpsert(
            db,
            tableName,
            schema[tableName] as Table,
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
            nestedRuntime,
            limits,
            policies,
          )
        : undefined;
      const updateGenerated = tableFeatures.update
        ? generateUpdate(
            db,
            tableName,
            schema[tableName] as Table,
            tables,
            eagerRelations,
            updateInput,
            tableFilters,
            updateFieldName,
            typeName,
            false,
            tableFeatures.requireWhere,
            typeNameMapper,
            filterCtx,
            mutationTxCtx,
            nestedRuntime,
            limits,
            policies,
          )
        : undefined;
      const updateSingleGenerated = tableFeatures.update
        ? generateUpdate(
            db,
            tableName,
            schema[tableName] as Table,
            tables,
            eagerRelations,
            updateInput,
            tableFilters,
            updateSingleFieldName,
            typeName,
            true,
            tableFeatures.requireWhere,
            typeNameMapper,
            filterCtx,
            mutationTxCtx,
            nestedRuntime,
            limits,
            policies,
          )
        : undefined;
      // The batch update reuses the update `set` input, so it needs `update` on too.
      const updateManyInput =
        tableFeatures.update && tableFeatures.updateMany
          ? generateUpdateManyInput({ typeName, updatePrefix: prefixes.update, updateInput, tableFilters })
          : undefined;
      const updateManyGenerated = updateManyInput
        ? adapter.generateUpdateMany(
            db,
            tableName,
            schema[tableName] as Table,
            tables,
            eagerRelations,
            updateManyInput,
            updateManyFieldName,
            typeName,
            typeNameMapper,
            filterCtx,
            mutationTxCtx,
            nestedRuntime,
            limits,
            policies,
          )
        : undefined;
      const deleteGenerated = tableFeatures.delete
        ? generateDelete(
            db,
            tableName,
            schema[tableName] as Table,
            tableFilters,
            deleteFieldName,
            typeName,
            false,
            tableFeatures.requireWhere,
            filterCtx,
            { tableName, relationMap: namedRelations, tables },
            mutationTxCtx,
            policies,
          )
        : undefined;
      const deleteSingleGenerated = tableFeatures.delete
        ? generateDelete(
            db,
            tableName,
            schema[tableName] as Table,
            tableFilters,
            deleteSingleFieldName,
            typeName,
            true,
            tableFeatures.requireWhere,
            filterCtx,
            { tableName, relationMap: namedRelations, tables },
            mutationTxCtx,
            policies,
          )
        : undefined;
      const restoreGenerated = softDeleteInfo
        ? generateDelete(
            db,
            tableName,
            schema[tableName] as Table,
            tableFilters,
            restoreFieldName,
            typeName,
            false,
            tableFeatures.requireWhere,
            filterCtx,
            { tableName, relationMap: namedRelations, tables },
            mutationTxCtx,
            policies,
            true,
          )
        : undefined;
      const restoreSingleGenerated = softDeleteInfo
        ? generateDelete(
            db,
            tableName,
            schema[tableName] as Table,
            tableFilters,
            restoreSingleFieldName,
            typeName,
            true,
            tableFeatures.requireWhere,
            filterCtx,
            { tableName, relationMap: namedRelations, tables },
            mutationTxCtx,
            policies,
            true,
          )
        : undefined;
      // The count variants are the plural write with its payload left off, so each follows the
      // same feature switch as the write it mirrors.
      const updateCountGenerated =
        tableFeatures.update && tableFeatures.countMutations
          ? generateWriteCount({
              db,
              tableName,
              table: schema[tableName] as Table,
              kind: 'update',
              setArgs: updateInput,
              filterArgs: tableFilters,
              fieldName: updateCountFieldName,
              requireWhere: tableFeatures.requireWhere,
              filterCtx,
              txCtx: mutationTxCtx,
              nested: nestedRuntime,
            })
          : undefined;
      const deleteCountGenerated =
        tableFeatures.delete && tableFeatures.countMutations
          ? generateWriteCount({
              db,
              tableName,
              table: schema[tableName] as Table,
              kind: 'delete',
              filterArgs: tableFilters,
              fieldName: deleteCountFieldName,
              requireWhere: tableFeatures.requireWhere,
              filterCtx,
              txCtx: mutationTxCtx,
            })
          : undefined;
      const aggregateType = tableFeatures.aggregates
        ? generateAggregateTypes(schema[tableName] as Table, tableName, typeName, cacheCtx)
        : undefined;
      const aggregateGenerated = tableFeatures.aggregates
        ? generateAggregate(
            db,
            tableName,
            schema[tableName] as Table,
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
          ? generateGroupByType(schema[tableName] as Table, tableName, typeName, cacheCtx)
          : undefined;
      const groupByEnum = groupByType
        ? generateGroupByEnum(schema[tableName] as Table, tableName, typeName)
        : undefined;
      const havingInput = groupByEnum
        ? generateHavingInput(schema[tableName] as Table, tableName, typeName)
        : undefined;
      const groupByGenerated =
        groupByType && groupByEnum && havingInput
          ? generateGroupBy(
              db,
              tableName,
              schema[tableName] as Table,
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
      if (insertArrGenerated) {
        mutations[insertArrGenerated.name] = {
          type: arrTableItemOutput,
          args: insertArrGenerated.args,
          resolve: insertArrGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'insert', single: false, targetArg: 'values' }),
          },
        };
      }
      if (insertSingleGenerated) {
        mutations[insertSingleGenerated.name] = {
          // An insert either returns the row it inserted or throws — the one path to `null` is
          // `conflictDoNothing` swallowing the insert, so the field is nullable only there.
          type: conflictDoNothing ? singleTableItemOutput : new GraphQLNonNull(singleTableItemOutput),
          args: insertSingleGenerated.args,
          resolve: insertSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'insert', single: true, targetArg: 'values' }),
          },
        };
      }
      if (upsertArrGenerated) {
        mutations[upsertArrGenerated.name] = {
          type: arrTableItemOutput,
          args: upsertArrGenerated.args,
          resolve: upsertArrGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'upsert', single: false, targetArg: 'values' }),
          },
        };
      }
      if (upsertSingleGenerated) {
        mutations[upsertSingleGenerated.name] = {
          type: singleTableItemOutput,
          args: upsertSingleGenerated.args,
          resolve: upsertSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'upsert', single: true, targetArg: 'values' }),
          },
        };
      }
      if (updateGenerated) {
        mutations[updateGenerated.name] = {
          type: arrTableItemOutput,
          args: updateGenerated.args,
          resolve: updateGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'update', single: false, targetArg: 'where' }),
          },
        };
      }
      if (updateManyGenerated) {
        mutations[updateManyGenerated.name] = {
          type: new GraphQLNonNull(new GraphQLList(singleTableItemOutput)),
          args: updateManyGenerated.args,
          resolve: updateManyGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'updateMany', single: false, targetArg: 'updates' }),
          },
          // The nullable element is deliberate, and the reason this mutation's return type
          // differs from every sibling's: the result is aligned with the input, one slot per
          // entry, so an entry that matched nothing has to be able to say so.
          description:
            "Each entry's updated rows, in entry order. An entry whose `where` matched no rows contributes `null` in its slot; an entry that matched several contributes each of its rows.",
        };
      }
      if (updateSingleGenerated) {
        mutations[updateSingleGenerated.name] = {
          type: singleTableItemOutput,
          args: updateSingleGenerated.args,
          resolve: updateSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'update', single: true, targetArg: 'where' }),
          },
        };
      }
      if (deleteGenerated) {
        mutations[deleteGenerated.name] = {
          type: arrTableItemOutput,
          args: deleteGenerated.args,
          resolve: deleteGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({
              kind: 'mutation',
              operation: 'delete',
              single: false,
              targetArg: 'where',
              ...(softDeleteInfo?.hardDelete ? { hardDelete: true } : {}),
            }),
          },
        };
      }
      if (deleteSingleGenerated) {
        mutations[deleteSingleGenerated.name] = {
          type: singleTableItemOutput,
          args: deleteSingleGenerated.args,
          resolve: deleteSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({
              kind: 'mutation',
              operation: 'delete',
              single: true,
              targetArg: 'where',
              ...(softDeleteInfo?.hardDelete ? { hardDelete: true } : {}),
            }),
          },
        };
      }
      if (restoreGenerated) {
        mutations[restoreGenerated.name] = {
          type: arrTableItemOutput,
          args: restoreGenerated.args,
          resolve: restoreGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'restore', single: false, targetArg: 'where' }),
          },
        };
      }
      if (restoreSingleGenerated) {
        mutations[restoreSingleGenerated.name] = {
          type: singleTableItemOutput,
          args: restoreSingleGenerated.args,
          resolve: restoreSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'restore', single: true, targetArg: 'where' }),
          },
        };
      }
      if (updateCountGenerated) {
        mutations[updateCountGenerated.name] = {
          type: new GraphQLNonNull(GraphQLInt),
          args: updateCountGenerated.args,
          resolve: updateCountGenerated.resolver,
          description:
            'How many rows the update touched. The rows themselves are not read back, which is the point of this mutation.',
        };
      }
      if (deleteCountGenerated) {
        mutations[deleteCountGenerated.name] = {
          type: new GraphQLNonNull(GraphQLInt),
          args: deleteCountGenerated.args,
          resolve: deleteCountGenerated.resolver,
          description:
            'How many rows the delete removed. The rows themselves are not read back, which is the point of this mutation.',
        };
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
};
