// The per-table object types and the fields on them, including relation fields and the type a
// mutation returns.

import type { Table } from 'drizzle-orm';
import { is, One } from 'drizzle-orm';
import {
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { capitalize } from '../../case-ops/index.ts';
import { tableTypeExtension } from '../../extensions.ts';
import { drizzleColumnToGraphQLType } from '../../type-converter/index.ts';
import type { ConvertedRelationColumnWithArgs } from '../../type-converter/types.ts';
import { fieldUpdateInputType } from '../field-updates.ts';
// Type-only: the nested-write module imports this one at runtime, so the dependency has to
// stay one-directional. The implementation is injected by the dialect builder.
import type { NestedWriteTypes } from '../nested-writes.ts';
import type { GeneratedTableTypes, GeneratedTableTypesOutputs, SelectData, TableNamedRelations } from '../types.ts';
import { deletedArg } from './args.ts';
import { generateDistinctEnum } from './column-enums.ts';
import { inputFieldDocs } from './docs.ts';
import { visibleColumns } from './exclusions.ts';
import { aggregateFieldComplexity, listFieldComplexity } from './limits.ts';
import type { TypeNameMapper } from './naming.ts';
import { resolveTypeName } from './naming.ts';
import { relationExtensionFor } from './relation-resolvers.ts';
import type { RelationAggregateFactory, RelationResolverFactory } from './relations.ts';
import {
  generateTableFilterTypeCached,
  generateTableOrderTypeCached,
  generateTableSelectTypeFieldsCached,
} from './table-inputs.ts';
import type { TypeCacheCtx } from './type-cache.ts';

/**
 * Build the select fields for a table.
 * Creates:
 * - Main select type: ${capitalize(tableName)} (e.g. Users)
 * - Relation fields reference the target table's own type directly (e.g. posts: [Posts!]!)
 *   rather than creating intermediate relation types.
 *
 * The function is called recursively for relation targets.
 * Cycle detection: usedTables tracks tables currently being processed in the call stack.
 * When we see a table already in usedTables, we stop recursing (no relation fields for that type).
 */
const generateSelectFields = <TWithOrder extends boolean>(
  tables: Record<string, Table>,
  tableName: string,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  fromTableName: string,
  fromRelationName: string,
  withOrder: TWithOrder,
  relationsDepthLimit: number | undefined,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  usedTables: Set<string> = new Set(),
  resolverFactory?: RelationResolverFactory,
  currentDepth: number = 0,
  relationAggregateFactory?: RelationAggregateFactory,
): SelectData<TWithOrder> => {
  const table = tables[tableName]!;
  const order = withOrder
    ? generateTableOrderTypeCached(table, tableName, typeNameMapper, cacheCtx, relationMap, tables)
    : undefined;
  const filters = generateTableFilterTypeCached(table, tableName, cacheCtx, typeNameMapper, relationMap, tables);
  const tableFields = generateTableSelectTypeFieldsCached(table, tableName, cacheCtx);

  const relationsForTable = relationMap[tableName];
  const relationEntries: [string, TableNamedRelations][] = relationsForTable ? Object.entries(relationsForTable) : [];

  // Depth limit: stop generating relation fields once we reach the configured maximum.
  // relationsDepthLimit: 0 → no relation fields on any type.
  // relationsDepthLimit: N → each table's own root call (depth 0) generates its relations,
  // but traversals beyond depth N stop, which prevents unbounded recursive generation.
  if (relationsDepthLimit !== undefined && currentDepth >= relationsDepthLimit) {
    return {
      order,
      filters,
      tableFields,
      relationFields: {},
    } as SelectData<TWithOrder>;
  }

  // If this table is already being processed (cycle), stop recursing.
  // Return just the base fields with no relation fields.
  if (usedTables.has(tableName)) {
    return {
      order,
      filters,
      tableFields,
      relationFields: {},
    } as SelectData<TWithOrder>;
  }

  // For the root call (fromTableName === '' && fromRelationName === ''), this builds the
  // main ${capitalize(tableName)}SelectItem type.
  // For recursive calls, this builds the relation type.
  const isRootCall = fromTableName === '' && fromRelationName === '';

  // If the root type has already been fully built (not just pre-registered as a shell), return early.
  if (isRootCall && cacheCtx.fullyBuiltTables.has(tableName)) {
    return {
      order,
      filters,
      tableFields,
      relationFields: {},
    } as SelectData<TWithOrder>;
  }

  // Obtain or create the mutable relation-fields container for this table.
  // The container is a plain object whose `fields` property the GraphQLObjectType thunk reads.
  // Pre-registering it here (before recursion) allows sibling relation traversals to reference
  // the same single GraphQLObjectType instance even when it hasn't been fully built yet.
  let container = cacheCtx.relationFieldContainers.get(tableName);
  if (!container) {
    container = { fields: {} };
    cacheCtx.relationFieldContainers.set(tableName, container);
  }

  if (isRootCall && !cacheCtx.objectTypeCache.has(tableName)) {
    const typeName = resolveTypeName(tableName, typeNameMapper);
    // Pre-register shell with thunk BEFORE recursing to break circular refs.
    // The thunk reads container.fields, which will be populated after recursion completes.
    const shell = new GraphQLObjectType({
      name: typeName,
      description: cacheCtx.docs.describeTable?.(tableName),
      fields: () => ({ ...tableFields, ...container!.fields }),
      extensions: { drizzle: tableTypeExtension(tableName, cacheCtx.primaryKeyOf?.(tableName) ?? []) },
    });
    cacheCtx.objectTypeCache.set(tableName, shell);
  }

  // Build relation fields — recurse into each related table.
  // Mark this table as in-progress before recursing to detect cycles.
  if (relationEntries.length > 0) {
    const rawRelationFields: [string, ConvertedRelationColumnWithArgs][] = [];

    // Mark this table as currently being processed.
    const nextUsedTables = new Set(usedTables);
    nextUsedTables.add(tableName);

    for (const [relationName, relEntry] of relationEntries) {
      const { targetTableName } = relEntry;
      const relation = (relEntry as any).relation ?? relEntry;
      const isOne = is(relation, One);

      // Always recurse to get the target table's filters/order (needed for args).
      // The usedTables check inside the recursive call prevents actual infinite recursion.
      const relSelectData = generateSelectFields(
        tables,
        targetTableName,
        relationMap,
        tableName, // fromTableName for the relation type
        relationName, // fromRelationName for the relation type
        !isOne,
        relationsDepthLimit,
        cacheCtx,
        typeNameMapper,
        nextUsedTables,
        resolverFactory,
        currentDepth + 1,
        relationAggregateFactory,
      );

      // Use the target table's own GraphQL type directly instead of creating an intermediate relation type.
      // Ensure exactly one GraphQLObjectType instance exists for the target table.
      // If the root call for the target table has already run (or pre-registered a shell),
      // reuse that instance so the schema never contains duplicate type names.
      let relType = cacheCtx.objectTypeCache.get(targetTableName);
      if (!relType) {
        // The target table hasn't been processed yet. Pre-register a shell so that:
        //   (a) this relation field has a concrete type reference, and
        //   (b) when the target table's root call eventually runs, it reuses this same object.
        const targetTable = tables[targetTableName]!;
        const targetTableFields = generateTableSelectTypeFieldsCached(targetTable, targetTableName, cacheCtx);
        // Get or create a container for the target table's relation fields.
        let targetContainer = cacheCtx.relationFieldContainers.get(targetTableName);
        if (!targetContainer) {
          targetContainer = { fields: {} };
          cacheCtx.relationFieldContainers.set(targetTableName, targetContainer);
        }
        const capturedTargetContainer = targetContainer;
        // The thunk reads capturedTargetContainer.fields so that when the target table's root
        // call populates the container, the shell automatically includes those relation fields.
        relType = new GraphQLObjectType({
          name: resolveTypeName(targetTableName, typeNameMapper),
          description: cacheCtx.docs.describeTable?.(targetTableName),
          fields: () => ({ ...targetTableFields, ...capturedTargetContainer.fields }),
          extensions: {
            drizzle: tableTypeExtension(targetTableName, cacheCtx.primaryKeyOf?.(targetTableName) ?? []),
          },
        });
        cacheCtx.objectTypeCache.set(targetTableName, relType);
      }

      const resolve = resolverFactory?.({ tableName, relationName, relEntry: relEntry as TableNamedRelations, isOne });
      const relationDescription = cacheCtx.docs.describeRelation?.(tableName, relationName);
      const relationDocs = relationDescription !== undefined ? { description: relationDescription } : {};

      if (isOne) {
        // Honor the relation's declared optionality: `r.one.Target({ ..., optional: false })`
        // asserts the related row always exists (a NOT NULL foreign key), so the field is
        // emitted as `Target!`. The default (`optional: true` / omitted) stays nullable.
        // Column nullability alone is NOT used to infer this — a notNull `from` column does
        // not guarantee a related row exists when the FK constraint lives on the other side
        // (e.g. `Users.customer` joins the notNull `Users.id` to `Customers.userId`).
        const isRequired = (relation as One<any, any>).optional === false;
        rawRelationFields.push([
          relationName,
          {
            type: isRequired ? new GraphQLNonNull(relType) : relType,
            args: {
              where: { type: relSelectData.filters },
              ...deletedArg(cacheCtx.softDeleteOf, targetTableName),
            },
            resolve,
            ...relationDocs,
            extensions: { drizzle: relationExtensionFor(relEntry, tableName, relationName, true) },
          },
        ]);
        continue;
      }

      // A to-many relation field is a list of the target table, so it takes the same
      // pagination surface a root list of that table does. `after` and `distinct` are the
      // two drizzle's `with:` clause cannot express, so a request that passes either drops
      // the relation out of the eager fetch and resolves it through the batch loader, which
      // implements both — see extractRelationsParamsInner.
      const targetDistinctEnum = cacheCtx.featureOf(targetTableName).distinct
        ? generateDistinctEnum(tables[targetTableName]!, resolveTypeName(targetTableName, typeNameMapper))
        : undefined;

      rawRelationFields.push([
        relationName,
        {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relType))),
          args: {
            where: { type: relSelectData.filters },
            orderBy: { type: relSelectData.order! },
            offset: { type: GraphQLInt },
            limit: { type: GraphQLInt },
            ...deletedArg(cacheCtx.softDeleteOf, targetTableName),
            after: {
              type: GraphQLString,
              description:
                "Keyset pagination: only return related rows strictly after this cursor (a row's `cursor` field from a previous page of this relation, under the same orderBy).",
            },
            ...(targetDistinctEnum
              ? { distinct: { type: new GraphQLList(new GraphQLNonNull(targetDistinctEnum)) } }
              : {}),
          },
          resolve,
          ...relationDocs,
          extensions: {
            drizzle: relationExtensionFor(relEntry, tableName, relationName, false),
            ...(cacheCtx.complexity
              ? { complexity: listFieldComplexity(cacheCtx.complexity, cacheCtx.limits?.(targetTableName)) }
              : {}),
          },
        },
      ]);

      // Aggregate over the related rows without fetching them: `user { postsAggregate { count } }`.
      // Skipped when the name would shadow a column or another relation.
      const aggregateFieldName = `${relationName}Aggregate`;
      if (!tableFields[aggregateFieldName] && !relationsForTable?.[aggregateFieldName]) {
        const relationAggregate = relationAggregateFactory?.({
          tableName,
          relationName,
          relEntry: relEntry as TableNamedRelations,
        });

        if (relationAggregate) {
          rawRelationFields.push([
            aggregateFieldName,
            {
              type: new GraphQLNonNull(relationAggregate.type),
              args: {
                where: { type: relSelectData.filters },
                ...deletedArg(cacheCtx.softDeleteOf, targetTableName),
              },
              resolve: relationAggregate.resolve,
              extensions: {
                drizzle: relationExtensionFor(relEntry, tableName, relationName, isOne, true),
                ...(cacheCtx.complexity ? { complexity: aggregateFieldComplexity(cacheCtx.complexity) } : {}),
              },
            } as unknown as ConvertedRelationColumnWithArgs,
          ]);
        }
      }
    }

    const builtRelationFields = Object.fromEntries(rawRelationFields);

    // Only the root call should populate the container — non-root calls are temporary traversals
    // to collect filters/order for args and should not overwrite the canonical relation fields.
    if (isRootCall) {
      // Populate the container so that the thunk on the GraphQLObjectType shell (whether it was
      // created here or pre-registered by another table's relation traversal) picks up the fields.
      container.fields = builtRelationFields;
      cacheCtx.fullyBuiltTables.add(tableName);
    }

    return {
      order,
      filters,
      tableFields,
      relationFields: builtRelationFields,
    } as SelectData<TWithOrder>;
  }

  // No relation entries — mark as fully built if root call.
  if (isRootCall) {
    cacheCtx.fullyBuiltTables.add(tableName);
  }

  return {
    order,
    filters,
    tableFields,
    relationFields: {},
  } as SelectData<TWithOrder>;
};

export const generateTableTypes = <WithReturning extends boolean>(
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  withReturning: WithReturning,
  relationsDepthLimit: number | undefined,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined = undefined,
  insertPrefix: string = 'create',
  updatePrefix: string = 'update',
  resolverFactory?: RelationResolverFactory,
  relationAggregateFactory?: RelationAggregateFactory,
  nestedWrites?: NestedWriteTypes,
): GeneratedTableTypes<WithReturning> => {
  const { tableFields, relationFields, filters, order } = generateSelectFields(
    tables,
    tableName,
    relationMap,
    '', // root call: no fromTableName
    '', // root call: no fromRelationName
    true,
    relationsDepthLimit,
    cacheCtx,
    typeNameMapper,
    new Set(),
    resolverFactory,
    0,
    relationAggregateFactory,
  );

  const table = tables[tableName]!;
  const columns = visibleColumns(table);
  const columnEntries = Object.entries(columns);

  // A column whose value comes from the request context is not part of any write input: the
  // client cannot supply one on create, and cannot reassign one on update. It stays an
  // ordinary column everywhere else — the output type, the filters, the ordering.
  const contextColumns = cacheCtx.contextValuesOf?.(tableName);
  // Same for the column that marks a row deleted: `delete` and `restore` own it, and a client
  // that could write it through an ordinary create or update could delete or undelete a row
  // without going through either.
  const markerColumn = cacheCtx.softDeleteOf?.(tableName)?.columnName;
  const writableEntries =
    contextColumns || markerColumn
      ? columnEntries.filter(
          ([columnName]) => !(contextColumns && columnName in contextColumns) && columnName !== markerColumn,
        )
      : columnEntries;

  // A column a nested write can supply (`author: { create: … }` fills in `authorId`) cannot
  // stay required on the create input, or the two ways of setting it would be mutually
  // exclusive at the type level.
  const relaxedColumns = nestedWrites?.relaxedColumns(tableName);

  const insertFields = Object.fromEntries(
    writableEntries.map(([columnName, column]) => {
      const converted = drizzleColumnToGraphQLType(
        column,
        columnName,
        tableName,
        !!relaxedColumns?.has(columnName),
        true,
        true,
      );
      return [
        columnName,
        { ...converted, ...inputFieldDocs(cacheCtx.docs, column, tableName, columnName, converted.type) },
      ];
    }),
  );

  const updateFields = Object.fromEntries(
    writableEntries.map(([columnName, column]) => {
      const converted = drizzleColumnToGraphQLType(column, columnName, tableName, true, false, true);
      // A numeric or array column takes an operations input instead of the bare scalar, so
      // it can be changed relative to its current value rather than only replaced.
      const operations = cacheCtx.featureOf(tableName).fieldUpdateOperations
        ? fieldUpdateInputType(column, columnName, tableName)
        : undefined;
      const field = operations ? { ...converted, type: operations } : converted;
      return [columnName, { ...field, ...inputFieldDocs(cacheCtx.docs, column, tableName, columnName, field.type) }];
    }),
  );

  const typeName = resolveTypeName(tableName, typeNameMapper);

  // Insert/update input types: ${capitalize(insertPrefix)}${resolveTypeName(tableName)}Input / ${capitalize(updatePrefix)}${resolveTypeName(tableName)}Input
  // With nested writes on, the fields are thunked: a relation field's operand is the target
  // table's filter input, which does not exist yet while this table is being generated.
  const insertInput = new GraphQLInputObjectType({
    name: `${capitalize(insertPrefix)}${typeName}Input`,
    fields: nestedWrites
      ? () => ({ ...insertFields, ...nestedWrites.createFields(tableName, typeName) })
      : insertFields,
  });

  const updateInput = new GraphQLInputObjectType({
    name: `${capitalize(updatePrefix)}${typeName}Input`,
    fields: nestedWrites
      ? () => ({ ...updateFields, ...nestedWrites.updateFields(tableName, typeName) })
      : updateFields,
  });

  // Select type: ${resolveTypeName(tableName)} (with relation fields)
  // Reuse the cached shell created in generateSelectFields.
  const selectSingleOutput =
    cacheCtx.objectTypeCache.get(tableName) ??
    new GraphQLObjectType({
      name: resolveTypeName(tableName, typeNameMapper),
      description: cacheCtx.docs.describeTable?.(tableName),
      fields: { ...tableFields, ...relationFields },
      extensions: { drizzle: tableTypeExtension(tableName, cacheCtx.primaryKeyOf?.(tableName) ?? []) },
    });

  const selectArrOutput = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(selectSingleOutput)));

  // Mutation return type: ${capitalize(tableName)}Item (table columns only, no relations)
  //   const singleTableItemOutput = withReturning
  //     ? new GraphQLObjectType({
  //         name: `${capitalize(tableName)}`,
  // //         name: `${capitalize(tableName)}Item`,
  //         fields: tableFields,
  //       })
  //     : undefined;

  const arrTableItemOutput = withReturning
    ? //     ? new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(singleTableItemOutput!)))
      new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(selectSingleOutput!)))
    : undefined;

  const inputs = {
    insertInput,
    updateInput,
    tableOrder: order,
    tableFilters: filters,
  };

  const outputs = (
    withReturning
      ? {
          selectSingleOutput,
          selectArrOutput,
          singleTableItemOutput: selectSingleOutput!,
          //           singleTableItemOutput: singleTableItemOutput!,
          arrTableItemOutput: arrTableItemOutput!,
        }
      : {
          selectSingleOutput,
          selectArrOutput,
        }
  ) as GeneratedTableTypesOutputs<WithReturning>;

  return {
    inputs,
    outputs,
  };
};
