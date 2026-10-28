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
// Type-only: nested-writes imports this module at runtime through common.ts, so its input
// types arrive as a `generateTableTypes` parameter from `prepareBuild` instead.
import type { NestedWriteTypes } from '../nested-writes/input-types.ts';
import type { GeneratedTableTypes, GeneratedTableTypesOutputs, SelectData, TableNamedRelations } from '../types.ts';
import { deletedArg } from './args.ts';
import { generateDistinctEnum } from './column-enums.ts';
import { inputFieldDocs } from './docs.ts';
import { visibleColumns } from './exclusions.ts';
import { aggregateFieldComplexity, listFieldComplexity } from './limits.ts';
import { relationExtensionFor } from './relation-resolvers.ts';
import type { RelationAggregateFactory, RelationResolverFactory } from './relations.ts';
import {
  generateTableFilterTypeCached,
  generateTableOrderTypeCached,
  generateTableSelectTypeFieldsCached,
} from './table-inputs.ts';
import type { TypeCacheCtx } from './type-cache.ts';
import type { TypeNameMapper } from './type-names.ts';
import { resolveTypeName } from './type-names.ts';
import { isWritableColumn } from './writable-columns.ts';

/**
 * The single `GraphQLObjectType` for a table, created on first request as a shell whose fields
 * thunk reads the table's relation-field container. Whichever comes first — the table's own
 * {@link generateSelectFields} call or another table's relation field pointing at it —
 * registers it, and everything after reuses that instance, so the schema never holds two types
 * with one name and a cyclic relation graph needs no recursion to wire up.
 */
const objectTypeShell = (
  tables: Record<string, Table>,
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
): GraphQLObjectType => {
  const cached = cacheCtx.objectTypeCache.get(tableName);
  if (cached) {
    return cached;
  }
  const table = tables[tableName]!;
  const tableFields = generateTableSelectTypeFieldsCached(table, tableName, cacheCtx);
  let container = cacheCtx.relationFieldContainers.get(tableName);
  if (!container) {
    container = { fields: {} };
    cacheCtx.relationFieldContainers.set(tableName, container);
  }
  const capturedContainer = container;
  // The thunk runs when the schema is assembled, by which point the table's own
  // generateSelectFields call has filled the container in.
  const shell = new GraphQLObjectType({
    name: cacheCtx.resolveName({
      kind: 'object',
      defaultName: resolveTypeName(tableName, typeNameMapper),
      table: tableName,
    }),
    description: cacheCtx.docs.describeTable?.(tableName, table),
    fields: () => ({ ...tableFields, ...capturedContainer.fields }),
    extensions: { drizzle: tableTypeExtension(tableName, cacheCtx.primaryKeyOf?.(tableName) ?? []) },
  });
  cacheCtx.objectTypeCache.set(tableName, shell);
  return shell;
};

/**
 * Build the select fields for a table: its columns, its filter and order inputs, and one field
 * per relation (plus `${relation}Aggregate` for a to-many one).
 *
 * A relation field's type is the target table's own object type (see {@link objectTypeShell})
 * and its `where` / `orderBy` arguments are the target's cached filter and order inputs. None of
 * that depends on the target's own relation fields, so this does not recurse: every table's
 * relation fields are built exactly once, by its own call. It used to recurse into each relation
 * target and throw the result away, which walked every simple path through the relation graph —
 * build time exponential in the number of relation cycles.
 */
const generateSelectFields = (
  tables: Record<string, Table>,
  tableName: string,
  namedRelations: Record<string, Record<string, TableNamedRelations>>,
  relationsDepthLimit: number | undefined,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  resolverFactory?: RelationResolverFactory,
  relationAggregateFactory?: RelationAggregateFactory,
): SelectData<true> => {
  const table = tables[tableName]!;
  const order = generateTableOrderTypeCached(table, tableName, typeNameMapper, cacheCtx, namedRelations, tables);
  const filters = generateTableFilterTypeCached(table, tableName, cacheCtx, typeNameMapper, namedRelations, tables);
  const tableFields = generateTableSelectTypeFieldsCached(table, tableName, cacheCtx);

  // relationsDepthLimit: 0 → no relation fields on any type (a flat, columns-only schema).
  // Any positive limit generates every table's direct relations, which is the whole relation
  // surface: a deeper level is the same shared types again, so there is nothing more to bound.
  if (relationsDepthLimit !== undefined && relationsDepthLimit <= 0) {
    return { order, filters, tableFields, relationFields: {} };
  }

  // A table's relation fields are built once; a repeat call has nothing to add.
  if (cacheCtx.fullyBuiltTables.has(tableName)) {
    return { order, filters, tableFields, relationFields: {} };
  }

  // Registered before the relation loop, so a self-relation resolves to this same instance.
  objectTypeShell(tables, tableName, cacheCtx, typeNameMapper);
  const container = cacheCtx.relationFieldContainers.get(tableName)!;

  const relationsForTable = namedRelations[tableName];
  const relationEntries: [string, TableNamedRelations][] = relationsForTable ? Object.entries(relationsForTable) : [];
  const rawRelationFields: [string, ConvertedRelationColumnWithArgs][] = [];

  for (const [relationName, relEntry] of relationEntries) {
    const { targetTableName } = relEntry;
    const relation = (relEntry as any).relation ?? relEntry;
    const isOne = is(relation, One);
    const targetTable = tables[targetTableName]!;

    // The target's own filter and order inputs — the same instances its root list query takes.
    const targetFilters = generateTableFilterTypeCached(
      targetTable,
      targetTableName,
      cacheCtx,
      typeNameMapper,
      namedRelations,
      tables,
    );
    const targetOrder = isOne
      ? undefined
      : generateTableOrderTypeCached(targetTable, targetTableName, typeNameMapper, cacheCtx, namedRelations, tables);

    // The target table's own type, shared by every relation field that points at it.
    const relType = objectTypeShell(tables, targetTableName, cacheCtx, typeNameMapper);

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
            where: { type: targetFilters },
            ...deletedArg(cacheCtx.softDeleteOf, targetTableName, cacheCtx.resolveName),
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
    // implements both — see extractRelationsParams.
    const targetDistinctEnum = cacheCtx.featureOf(targetTableName).distinct
      ? generateDistinctEnum(
          tables[targetTableName]!,
          resolveTypeName(targetTableName, typeNameMapper),
          cacheCtx.resolveName,
          targetTableName,
        )
      : undefined;

    rawRelationFields.push([
      relationName,
      {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relType))),
        args: {
          where: { type: targetFilters },
          ...(targetOrder ? { orderBy: { type: targetOrder } } : {}),
          offset: { type: GraphQLInt },
          limit: { type: GraphQLInt },
          ...deletedArg(cacheCtx.softDeleteOf, targetTableName, cacheCtx.resolveName),
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
            ? {
                complexity: listFieldComplexity(
                  cacheCtx.complexity,
                  cacheCtx.limits?.(targetTableName, { parent: tableName, name: relationName }),
                ),
              }
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
              where: { type: targetFilters },
              ...deletedArg(cacheCtx.softDeleteOf, targetTableName, cacheCtx.resolveName),
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

  // Populate the container, which the type's fields thunk reads — whether the shell was created
  // above or pre-registered by another table's relation field.
  const relationFields = Object.fromEntries(rawRelationFields);
  container.fields = relationFields;
  cacheCtx.fullyBuiltTables.add(tableName);

  return { order, filters, tableFields, relationFields };
};

export const generateTableTypes = <WithReturning extends boolean>(
  tableName: string,
  tables: Record<string, Table>,
  namedRelations: Record<string, Record<string, TableNamedRelations>>,
  withReturning: WithReturning,
  relationsDepthLimit: number | undefined,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined = undefined,
  insertPrefix: string = 'create',
  updatePrefix: string = 'update',
  upsertPrefix: string = 'upsert',
  resolverFactory?: RelationResolverFactory,
  relationAggregateFactory?: RelationAggregateFactory,
  nestedWrites?: NestedWriteTypes,
): GeneratedTableTypes<WithReturning> => {
  const { tableFields, relationFields, filters, order } = generateSelectFields(
    tables,
    tableName,
    namedRelations,
    relationsDepthLimit,
    cacheCtx,
    typeNameMapper,
    resolverFactory,
    relationAggregateFactory,
  );

  const table = tables[tableName]!;
  const columns = visibleColumns(table);
  const columnEntries = Object.entries(columns);

  // A client writes only the columns it may set; the rest stay in the output type, filters and
  // ordering.
  const writableEntries = columnEntries.filter(([columnName, column]) =>
    isWritableColumn(cacheCtx, tableName, columnName, column),
  );

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
        ? fieldUpdateInputType(column, columnName, tableName, cacheCtx.resolveName)
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
    name: cacheCtx.resolveName({
      kind: 'createInput',
      defaultName: `${capitalize(insertPrefix)}${typeName}Input`,
      table: tableName,
    }),
    fields: nestedWrites
      ? () => ({ ...insertFields, ...nestedWrites.createFields(tableName, typeName) })
      : insertFields,
  });

  const updateInput = new GraphQLInputObjectType({
    name: cacheCtx.resolveName({
      kind: 'updateInput',
      defaultName: `${capitalize(updatePrefix)}${typeName}Input`,
      table: tableName,
    }),
    fields: nestedWrites
      ? () => ({ ...updateFields, ...nestedWrites.updateFields(tableName, typeName) })
      : updateFields,
  });

  // Upsert input: the create input's columns with relation fields that can also detach and
  // replace, since the row may already exist. Only a table with writable relations needs one;
  // every other table's upsert takes the create input, which would be identical.
  const upsertInput = nestedWrites?.hasRelations(tableName)
    ? new GraphQLInputObjectType({
        name: cacheCtx.resolveName({
          kind: 'upsertInput',
          defaultName: `${capitalize(upsertPrefix)}${typeName}Input`,
          table: tableName,
        }),
        fields: () => ({ ...insertFields, ...nestedWrites.upsertFields(tableName, typeName) }),
      })
    : undefined;

  // Select type: ${resolveTypeName(tableName)} (with relation fields)
  // Reuse the cached shell created in generateSelectFields.
  const selectSingleOutput =
    cacheCtx.objectTypeCache.get(tableName) ??
    new GraphQLObjectType({
      name: cacheCtx.resolveName({
        kind: 'object',
        defaultName: resolveTypeName(tableName, typeNameMapper),
        table: tableName,
      }),
      description: cacheCtx.docs.describeTable?.(tableName, tables[tableName]!),
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
    upsertInput,
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
