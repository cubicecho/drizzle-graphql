// =============================================================================
// `generateSchemaData` for the two dialects whose writes return the rows they
// wrote — PostgreSQL and SQLite. They build a schema identically, so this module
// holds it once and a dialect supplies only what it genuinely owns, through
// {@link DialectSchemaAdapter}.
//
// The parts that are not even dialect-specific — everything up to each table's
// types, the read fields, and the relation resolvers at the end — live in
// `build-context.ts`, which MySQL shares. What remains here is the mutation half:
// MySQL has no RETURNING clause, so its mutation fields, return types and
// resolvers differ throughout.
// =============================================================================

import type { Table } from 'drizzle-orm';
import type { GraphQLInputObjectType } from 'graphql';
import { GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import {
  computeResolverFieldNames,
  defineRootField,
  generateOnConflictInput,
  generateUpdateManyInput,
  generateWriteCount,
  getUniqueColumnSets,
  type LimitPolicyFor,
  type MutationTxCtx,
  type RelationFilterBase,
  type ResolverPolicies,
  type TablesRelationalConfig,
  type TypeNameMapper,
  type TypeNameResolver,
} from '../builders/common.ts';
import { tableFieldExtensions } from '../extensions.ts';
import { createSchemaBuilder, type SchemaBuildAdapter } from './build-context.ts';
import type { NestedWriteRuntime } from './nested-writes.ts';
import type { CreatedResolver, SchemaGeneratorOptions, TableNamedRelations } from './types.ts';
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
  /** The build's type-naming rule — the resolve tree is keyed by the names it produced. */
  resolveName?: TypeNameResolver,
) => CreatedResolver;

/**
 * Everything {@link createSchemaDataGenerator} cannot decide for itself: the shared build's
 * adapter, plus the one generator whose statement loop is dialect-specific. Both dialects on
 * this path return the rows they write, so it is fixed to `true`.
 */
export type DialectSchemaAdapter = SchemaBuildAdapter<true> & {
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
  // The three stretches of a build that have nothing to do with the dialect: everything up to
  // each table's types, the read fields in the middle, and the relation resolvers at the end.
  const { prepareBuild, addReadFields, finalizeBuild } = createSchemaBuilder(adapter);

  return (
    db: any,
    schema: Record<string, unknown>,
    relations: TablesRelationalConfig,
    options: SchemaGeneratorOptions,
  ): any => {
    const { prefixes, suffixes, conflictDoNothing, typeNameMapper, limits } = options;

    // Table discovery, the relation graph, the per-build registries, the filter context, the
    // type cache and every table's types — all of it dialect-independent, so all of it lives
    // in `build-context.ts` and is shared with the MySQL builder.
    const ctx = prepareBuild(db, schema, relations, options);
    const {
      tables,
      featureOf,
      eagerRelations,
      filterCtx,
      policies,
      softDeleteOf,
      namedRelations,
      cacheCtx,
      nestedRuntime,
      mutationTxCtx,
      gqlSchemaTypes,
      mutations,
      inputs,
      outputs,
    } = ctx;

    for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
      // Everything this table generates, with any per-table predicate already run.
      const tableFeatures = featureOf(tableName);
      // What every field this table generates publishes about itself under `extensions.drizzle`,
      // so a wrapper can read a field's identity instead of parsing its configurable name.
      const drizzleMeta = tableFieldExtensions(tableName, primaryKeyPropNames(schema[tableName] as Table));
      const { insertInput, updateInput, tableFilters, tableOrder } = tableTypes.inputs;
      const { selectSingleOutput, singleTableItemOutput, arrTableItemOutput } = tableTypes.outputs;

      // Compute field names using the mapper logic
      const names = computeResolverFieldNames(tableName, typeNameMapper, prefixes, suffixes);
      const {
        typeName,
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
      } = names;
      // A table that marks rows deleted instead of removing them also gets the mutation that
      // reverses it — clearing the column through an ordinary update is not possible, since the
      // column is not in the update input and a marked row is invisible to a `where` anyway.
      const softDeleteInfo = softDeleteOf?.(tableName);

      // Both selects, the aggregate and the group-by: generated and hung off the query root
      // by the shared builder, since a read is a read on every dialect.
      const { aggregateType, groupByType, havingInput } = addReadFields(ctx, tableName, names, tableTypes, drizzleMeta);

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
            cacheCtx.typeName,
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
            cacheCtx.typeName,
          )
        : undefined;
      // An upsert needs something to conflict on, so a table with no primary key and no
      // unique constraint gets no upsert mutations rather than ones that always fail.
      const uniqueSets = tableFeatures.upsert ? uniqueColumnSets(schema[tableName] as Table) : [];
      const onConflictInput = tableFeatures.upsert
        ? generateOnConflictInput({
            table: schema[tableName] as Table,
            tableName,
            typeName,
            uniqueSets,
            tableFilters,
            withTarget: true,
            cacheCtx,
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
            cacheCtx.typeName,
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
            cacheCtx.typeName,
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
            cacheCtx.typeName,
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
            cacheCtx.typeName,
          )
        : undefined;
      // The batch update reuses the update `set` input, so it needs `update` on too.
      const updateManyInput =
        tableFeatures.update && tableFeatures.updateMany
          ? generateUpdateManyInput({
              tableName,
              typeName,
              updatePrefix: prefixes.update,
              updateInput,
              tableFilters,
              cacheCtx,
            })
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
            cacheCtx.typeName,
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
            false,
            cacheCtx.typeName,
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
            false,
            cacheCtx.typeName,
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
            cacheCtx.typeName,
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
            cacheCtx.typeName,
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
      if (insertArrGenerated) {
        defineRootField(mutations, 'mutation', insertArrGenerated.name, {
          type: arrTableItemOutput,
          args: insertArrGenerated.args,
          resolve: insertArrGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'insert', single: false, targetArg: 'values' }),
          },
        });
      }
      if (insertSingleGenerated) {
        defineRootField(mutations, 'mutation', insertSingleGenerated.name, {
          // An insert either returns the row it inserted or throws — the one path to `null` is
          // `conflictDoNothing` swallowing the insert, so the field is nullable only there.
          type: conflictDoNothing ? singleTableItemOutput : new GraphQLNonNull(singleTableItemOutput),
          args: insertSingleGenerated.args,
          resolve: insertSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'insert', single: true, targetArg: 'values' }),
          },
        });
      }
      if (upsertArrGenerated) {
        defineRootField(mutations, 'mutation', upsertArrGenerated.name, {
          type: arrTableItemOutput,
          args: upsertArrGenerated.args,
          resolve: upsertArrGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'upsert', single: false, targetArg: 'values' }),
          },
        });
      }
      if (upsertSingleGenerated) {
        defineRootField(mutations, 'mutation', upsertSingleGenerated.name, {
          type: singleTableItemOutput,
          args: upsertSingleGenerated.args,
          resolve: upsertSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'upsert', single: true, targetArg: 'values' }),
          },
        });
      }
      if (updateGenerated) {
        defineRootField(mutations, 'mutation', updateGenerated.name, {
          type: arrTableItemOutput,
          args: updateGenerated.args,
          resolve: updateGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'update', single: false, targetArg: 'where' }),
          },
        });
      }
      if (updateManyGenerated) {
        defineRootField(mutations, 'mutation', updateManyGenerated.name, {
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
        });
      }
      if (updateSingleGenerated) {
        defineRootField(mutations, 'mutation', updateSingleGenerated.name, {
          type: singleTableItemOutput,
          args: updateSingleGenerated.args,
          resolve: updateSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'update', single: true, targetArg: 'where' }),
          },
        });
      }
      if (deleteGenerated) {
        defineRootField(mutations, 'mutation', deleteGenerated.name, {
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
        });
      }
      if (deleteSingleGenerated) {
        defineRootField(mutations, 'mutation', deleteSingleGenerated.name, {
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
        });
      }
      if (restoreGenerated) {
        defineRootField(mutations, 'mutation', restoreGenerated.name, {
          type: arrTableItemOutput,
          args: restoreGenerated.args,
          resolve: restoreGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'restore', single: false, targetArg: 'where' }),
          },
        });
      }
      if (restoreSingleGenerated) {
        defineRootField(mutations, 'mutation', restoreSingleGenerated.name, {
          type: singleTableItemOutput,
          args: restoreSingleGenerated.args,
          resolve: restoreSingleGenerated.resolver,
          extensions: {
            drizzle: drizzleMeta({ kind: 'mutation', operation: 'restore', single: true, targetArg: 'where' }),
          },
        });
      }
      if (updateCountGenerated) {
        defineRootField(mutations, 'mutation', updateCountGenerated.name, {
          type: new GraphQLNonNull(GraphQLInt),
          args: updateCountGenerated.args,
          resolve: updateCountGenerated.resolver,
          description:
            'How many rows the update touched. The rows themselves are not read back, which is the point of this mutation.',
        });
      }
      if (deleteCountGenerated) {
        defineRootField(mutations, 'mutation', deleteCountGenerated.name, {
          type: new GraphQLNonNull(GraphQLInt),
          args: deleteCountGenerated.args,
          resolve: deleteCountGenerated.resolver,
          description:
            'How many rows the delete removed. The rows themselves are not read back, which is the point of this mutation.',
        });
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

    return finalizeBuild(ctx);
  };
};
