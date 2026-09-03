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
import type { GraphQLInputObjectType, GraphQLOutputType } from 'graphql';
import { GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import {
  computeResolverFieldNames,
  defineRootField,
  generateOnConflictInput,
  generateUpdateManyInput,
  generateWriteCount,
  getUniqueColumnSets,
  type TablesRelationalConfig,
} from '../builders/common.ts';
import { type DrizzleMutationMeta, tableFieldExtensions } from '../extensions.ts';
import { createSchemaBuilder, type SchemaBuildAdapter } from './build-context.ts';
import type { CreatedResolver, SchemaGeneratorOptions } from './types.ts';
import { buildWriteResolvers, type WriteBuildOptions } from './write-resolvers.ts';

/** The per-table half of {@link UpdateManyGenerator}'s options; the rest comes from the build. */
export interface UpdateManyOptions {
  tableName: string;
  table: any;
  updateManyInput: GraphQLInputObjectType;
  fieldName: string;
  typeName: string;
}

/** `update<Table>Many` — batch update, whose statement loop is dialect-specific. */
export type UpdateManyGenerator = (build: WriteBuildOptions, opts: UpdateManyOptions) => CreatedResolver;

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
  const { generateInsert, generateUpsert, generateUpdate, generateDelete } = buildWriteResolvers(primaryKeyPropNames);
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

    // Everything a write generator takes from the build rather than from the table. The same
    // object serves every table below, so each call names only what varies per table.
    const writeBuild: WriteBuildOptions = {
      db,
      tables,
      relationMap: eagerRelations,
      typeNameMapper,
      filterCtx,
      txCtx: mutationTxCtx,
      nested: nestedRuntime,
      limits,
      policies,
      resolveName: cacheCtx.typeName,
    };

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
        ? generateInsert(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            baseType: insertInput,
            fieldName: createArrayFieldName,
            typeName,
            single: false,
            conflictDoNothing,
          })
        : undefined;
      const insertSingleGenerated = tableFeatures.insert
        ? generateInsert(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            baseType: insertInput,
            fieldName: createSingleFieldName,
            typeName,
            single: true,
            conflictDoNothing,
          })
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
        ? generateUpsert(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            baseType: insertInput,
            onConflictType: onConflictInput,
            uniqueSets,
            fieldName: upsertArrayFieldName,
            typeName,
            single: false,
          })
        : undefined;
      const upsertSingleGenerated = onConflictInput
        ? generateUpsert(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            baseType: insertInput,
            onConflictType: onConflictInput,
            uniqueSets,
            fieldName: upsertSingleFieldName,
            typeName,
            single: true,
          })
        : undefined;
      const updateGenerated = tableFeatures.update
        ? generateUpdate(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            setArgs: updateInput,
            filterArgs: tableFilters,
            fieldName: updateFieldName,
            typeName,
            single: false,
            requireWhere: tableFeatures.requireWhere,
          })
        : undefined;
      const updateSingleGenerated = tableFeatures.update
        ? generateUpdate(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            setArgs: updateInput,
            filterArgs: tableFilters,
            fieldName: updateSingleFieldName,
            typeName,
            single: true,
            requireWhere: tableFeatures.requireWhere,
          })
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
        ? adapter.generateUpdateMany(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            updateManyInput,
            fieldName: updateManyFieldName,
            typeName,
          })
        : undefined;
      const deleteGenerated = tableFeatures.delete
        ? generateDelete(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            filterArgs: tableFilters,
            fieldName: deleteFieldName,
            typeName,
            single: false,
            requireWhere: tableFeatures.requireWhere,
            restore: false,
            selectionCtx: { tableName, relationMap: namedRelations, tables },
          })
        : undefined;
      const deleteSingleGenerated = tableFeatures.delete
        ? generateDelete(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            filterArgs: tableFilters,
            fieldName: deleteSingleFieldName,
            typeName,
            single: true,
            requireWhere: tableFeatures.requireWhere,
            restore: false,
            selectionCtx: { tableName, relationMap: namedRelations, tables },
          })
        : undefined;
      const restoreGenerated = softDeleteInfo
        ? generateDelete(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            filterArgs: tableFilters,
            fieldName: restoreFieldName,
            typeName,
            single: false,
            requireWhere: tableFeatures.requireWhere,
            restore: true,
            selectionCtx: { tableName, relationMap: namedRelations, tables },
          })
        : undefined;
      const restoreSingleGenerated = softDeleteInfo
        ? generateDelete(writeBuild, {
            tableName,
            table: schema[tableName] as Table,
            filterArgs: tableFilters,
            fieldName: restoreSingleFieldName,
            typeName,
            single: true,
            requireWhere: tableFeatures.requireWhere,
            restore: true,
            selectionCtx: { tableName, relationMap: namedRelations, tables },
          })
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
      // Each mutation is paired with the type it returns and the identity it publishes on
      // `extensions.drizzle`, so a consumer can tell an insert from an upsert without unpicking
      // the configured prefixes — and, for a delete, whether the field can purge rather than
      // mark. The count pair is the one entry with a description and no meta: it answers with a
      // number rather than rows, so there is no row operation for a consumer to dispatch on.
      const hardDeleteMeta = softDeleteInfo?.hardDelete ? ({ hardDelete: true } as const) : {};
      const generatedMutations: {
        generated: CreatedResolver | undefined;
        type: GraphQLOutputType;
        meta?: DrizzleMutationMeta;
        description?: string;
      }[] = [
        {
          generated: insertArrGenerated,
          type: arrTableItemOutput,
          meta: { operation: 'insert', single: false, targetArg: 'values' },
        },
        {
          generated: insertSingleGenerated,
          // An insert either returns the row it inserted or throws — the one path to `null` is
          // `conflictDoNothing` swallowing the insert, so the field is nullable only there.
          type: conflictDoNothing ? singleTableItemOutput : new GraphQLNonNull(singleTableItemOutput),
          meta: { operation: 'insert', single: true, targetArg: 'values' },
        },
        {
          generated: upsertArrGenerated,
          type: arrTableItemOutput,
          meta: { operation: 'upsert', single: false, targetArg: 'values' },
        },
        {
          generated: upsertSingleGenerated,
          type: singleTableItemOutput,
          meta: { operation: 'upsert', single: true, targetArg: 'values' },
        },
        {
          generated: updateGenerated,
          type: arrTableItemOutput,
          meta: { operation: 'update', single: false, targetArg: 'where' },
        },
        {
          generated: updateManyGenerated,
          type: new GraphQLNonNull(new GraphQLList(singleTableItemOutput)),
          meta: { operation: 'updateMany', single: false, targetArg: 'updates' },
          // The nullable element is deliberate, and the reason this mutation's return type
          // differs from every sibling's: the result is aligned with the input, one slot per
          // entry, so an entry that matched nothing has to be able to say so.
          description:
            "Each entry's updated rows, in entry order. An entry whose `where` matched no rows contributes `null` in its slot; an entry that matched several contributes each of its rows.",
        },
        {
          generated: updateSingleGenerated,
          type: singleTableItemOutput,
          meta: { operation: 'update', single: true, targetArg: 'where' },
        },
        {
          generated: deleteGenerated,
          type: arrTableItemOutput,
          meta: { operation: 'delete', single: false, targetArg: 'where', ...hardDeleteMeta },
        },
        {
          generated: deleteSingleGenerated,
          type: singleTableItemOutput,
          meta: { operation: 'delete', single: true, targetArg: 'where', ...hardDeleteMeta },
        },
        {
          generated: restoreGenerated,
          type: arrTableItemOutput,
          meta: { operation: 'restore', single: false, targetArg: 'where' },
        },
        {
          generated: restoreSingleGenerated,
          type: singleTableItemOutput,
          meta: { operation: 'restore', single: true, targetArg: 'where' },
        },
        {
          generated: updateCountGenerated,
          type: new GraphQLNonNull(GraphQLInt),
          description:
            'How many rows the update touched. The rows themselves are not read back, which is the point of this mutation.',
        },
        {
          generated: deleteCountGenerated,
          type: new GraphQLNonNull(GraphQLInt),
          description:
            'How many rows the delete removed. The rows themselves are not read back, which is the point of this mutation.',
        },
      ];
      for (const { generated, type, meta, description } of generatedMutations) {
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
