// The per-table input types — Filters, OrderBy, and the select field map — each cached so a
// schema builds one of them per table no matter how many fields reference it.

import type { Column, Table } from 'drizzle-orm';
import { is, One } from 'drizzle-orm';
import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { drizzleColumnToGraphQLType } from '../../type-converter/index.ts';
import type { ConvertedColumn, ConvertedInputColumn } from '../../type-converter/types.ts';
import type { TableNamedRelations } from '../types.ts';
import { generateColumnFilterValues, isOrderableColumn } from './column-filters.ts';
import { CURSOR_FIELD_NAME, rowCursorResolver } from './cursor.ts';
import { columnDocs } from './docs.ts';
import { hasExcludedColumns, visibleColumns } from './exclusions.ts';
import { innerOrderType } from './input-order.ts';
import type { TypeNameMapper } from './naming.ts';
import { resolveTypeName } from './naming.ts';
import { isFilterableRelation } from './relations.ts';
import type { TypeCacheCtx } from './type-cache.ts';
import { generateUniqueKeyFilterFields } from './unique-keys.ts';

// Keyed by the `InnerOrder` instance as well as the table: the type's name follows the
// build's naming rule, and the cache outlives a build, so two builds that name it differently
// must not share one field map.
const orderMap = new WeakMap<object, Map<GraphQLInputObjectType, Record<string, ConvertedInputColumn>>>();
const generateTableOrderCached = (table: Table, innerOrder: GraphQLInputObjectType) => {
  // The cache outlives a build, so a table whose columns this build hides must not read from
  // it (a previous build may have cached the full set) or write to it (a later unfiltered
  // build would inherit the holes).
  const cacheable = !hasExcludedColumns(table);
  const cached = cacheable ? orderMap.get(table)?.get(innerOrder) : undefined;
  if (cached) {
    return cached;
  }

  let remapped = {};
  try {
    const columns = visibleColumns(table);
    const columnEntries = Object.entries(columns);

    remapped = Object.fromEntries(
      columnEntries
        .filter(([, column]) => isOrderableColumn(column))
        .map(([columnName]) => [columnName, { type: innerOrder }]),
    );

    if (cacheable) {
      let byInnerOrder = orderMap.get(table);
      if (!byInnerOrder) {
        byInnerOrder = new Map();
        orderMap.set(table, byInnerOrder);
      }
      byInnerOrder.set(innerOrder, remapped);
    }
  } catch (_err) {}
  return remapped;
};

const generateTableFilterValuesCached = (table: Table, tableName: string, cacheCtx: TypeCacheCtx) => {
  if (cacheCtx.filterFieldCache.has(table)) {
    return cacheCtx.filterFieldCache.get(table)!;
  }

  const columns = visibleColumns(table);
  const columnEntries = Object.entries(columns);

  const remapped = Object.fromEntries(
    columnEntries.map(([columnName, column]) => [
      columnName,
      {
        type: generateColumnFilterValues(column, tableName, columnName, cacheCtx),
        // A filter field is the same column, so it carries the same documentation. Deprecation
        // is not propagated: filtering on a deprecated column is how a caller finds the rows
        // that still use it.
        ...(cacheCtx.docs.describeColumn
          ? { description: cacheCtx.docs.describeColumn(column, { tableName, columnName }) }
          : {}),
      },
    ]),
  );

  cacheCtx.filterFieldCache.set(table, remapped);

  return remapped;
};

export const generateTableSelectTypeFieldsCached = (
  table: Table,
  tableName: string,
  cacheCtx: TypeCacheCtx,
): Record<string, ConvertedColumn> => {
  if (cacheCtx.selectFieldCache.has(table)) {
    return cacheCtx.selectFieldCache.get(table)!;
  }

  const columns = visibleColumns(table);
  const columnEntries = Object.entries(columns);

  const remapped = Object.fromEntries(
    columnEntries.map(([columnName, column]) => [
      columnName,
      {
        ...drizzleColumnToGraphQLType(column, columnName, tableName),
        ...columnDocs(cacheCtx.docs, column, tableName, columnName),
      },
    ]),
  );

  // Opaque keyset-pagination cursor. Only populated on rows returned by a list query; a real
  // column named `cursor` keeps the field for itself instead.
  if (!remapped[CURSOR_FIELD_NAME]) {
    remapped[CURSOR_FIELD_NAME] = {
      type: GraphQLString,
      description:
        "Opaque cursor of this row's position in the query's ordering. Pass it as `after` to resume from here. Only set on rows returned by a list query.",
      resolve: rowCursorResolver,
    } as ConvertedColumn;
  }

  cacheCtx.selectFieldCache.set(table, remapped);

  return remapped;
};

/**
 * The to-one relations a table's OrderBy can order through, as `[relationName, targetTableName]`.
 * To-many relations are left out: "order a parent by its many children" has no single defined
 * value to sort on. A relation whose name collides with a column is skipped — the column keeps
 * the name, even one with no ordering of its own, so `extractOrderBy` never reads it as a relation.
 */
const orderRelations = (
  tableName: string,
  namedRelations?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): [string, string][] => {
  const relations = namedRelations?.[tableName];
  const table = tables?.[tableName];
  if (!relations || !tables || !table) {
    return [];
  }
  const columns = visibleColumns(table);
  return Object.entries(relations)
    .filter(([relationName, relEntry]) => {
      const relation = (relEntry as any).relation ?? relEntry;
      return (
        !(relationName in columns) &&
        !!tables[relEntry.targetTableName] &&
        is(relation, One) &&
        isFilterableRelation(relation)
      );
    })
    .map(([relationName, relEntry]) => [relationName, relEntry.targetTableName]);
};

/**
 * Whether a table's OrderBy would have any field: an orderable column of its own, or a to-one
 * relation to a table that has one. A table of nothing but JSON columns has none, and an input
 * object with no fields is an invalid schema, so such a table gets no OrderBy and no `orderBy`
 * argument at all.
 */
const hasOrderFields = (
  tableName: string,
  namedRelations: Record<string, Record<string, TableNamedRelations>> | undefined,
  tables: Record<string, Table>,
  visiting: Set<string> = new Set(),
): boolean => {
  const table = tables[tableName];
  if (table && Object.values(visibleColumns(table)).some((column) => isOrderableColumn(column as Column))) {
    return true;
  }
  if (visiting.has(tableName)) {
    return false;
  }
  visiting.add(tableName);
  return orderRelations(tableName, namedRelations, tables).some(([, target]) =>
    hasOrderFields(target, namedRelations, tables, visiting),
  );
};

/**
 * Order fields for a table's to-one relations: each takes the target table's own OrderBy
 * input, so a list can be sorted by a related row's column (compiled as a correlated
 * subquery in the ORDER BY — see `extractOrderBy`). A target with no OrderBy of its own is
 * left out.
 */
const generateRelationOrderFields = (
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  namedRelations?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): Record<string, { type: GraphQLInputObjectType; description?: string }> => {
  const fields: Record<string, { type: GraphQLInputObjectType; description?: string }> = {};

  for (const [relationName, targetTableName] of orderRelations(tableName, namedRelations, tables)) {
    const type = generateTableOrderTypeCached(
      tables![targetTableName]!,
      targetTableName,
      typeNameMapper,
      cacheCtx,
      namedRelations,
      tables,
    );
    if (type) {
      fields[relationName] = { type, description: `Order by columns of the related ${relationName} row` };
    }
  }

  return fields;
};

/**
 * The table's `<Type>OrderBy` input, or `undefined` when it would have no fields (see
 * {@link hasOrderFields}); the caller then leaves the `orderBy` argument out.
 */
export const generateTableOrderTypeCached = (
  table: Table,
  tableName: string,
  typeNameMapper: TypeNameMapper | undefined,
  cacheCtx: TypeCacheCtx,
  namedRelations?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): GraphQLInputObjectType | undefined => {
  if (cacheCtx.orderTypeCache.has(table)) {
    return cacheCtx.orderTypeCache.get(table)!;
  }
  if (!hasOrderFields(tableName, namedRelations, { ...tables, [tableName]: table })) {
    return undefined;
  }

  // Fields are thunked so that relation order fields, which reference other tables' order
  // inputs (and eventually this one again), are only resolved after this type is cached.
  const order = new GraphQLInputObjectType({
    name: cacheCtx.typeName({
      kind: 'orderBy',
      defaultName: `${resolveTypeName(tableName, typeNameMapper)}OrderBy`,
      table: tableName,
    }),
    fields: () => ({
      ...generateTableOrderCached(table, innerOrderType(cacheCtx.typeName)),
      ...generateRelationOrderFields(tableName, cacheCtx, typeNameMapper, namedRelations, tables),
    }),
  });

  cacheCtx.orderTypeCache.set(table, order);

  return order;
};

/**
 * `${Target}ListRelationFilter` — the Prisma-style some/every/none wrapper for a to-many
 * relation. Shared by every table that points at the same target, and built through a thunk
 * so mutually-referencing tables (Users.posts ⇄ Posts.author) don't recurse forever.
 */
const generateListRelationFilterCached = (
  targetTable: Table,
  targetTableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  namedRelations: Record<string, Record<string, TableNamedRelations>> | undefined,
  tables: Record<string, Table> | undefined,
): GraphQLInputObjectType => {
  const cached = cacheCtx.listRelationFilterCache.get(targetTableName);
  if (cached) {
    return cached;
  }

  const listFilter = new GraphQLInputObjectType({
    name: cacheCtx.typeName({
      kind: 'listRelationFilter',
      defaultName: `${resolveTypeName(targetTableName, typeNameMapper)}ListRelationFilter`,
      table: targetTableName,
    }),
    fields: () => {
      const targetFilters = generateTableFilterTypeCached(
        targetTable,
        targetTableName,
        cacheCtx,
        typeNameMapper,
        namedRelations,
        tables,
      );

      return {
        some: { type: targetFilters, description: 'At least one related row matches' },
        none: { type: targetFilters, description: 'No related row matches' },
        every: { type: targetFilters, description: 'Every related row matches' },
      };
    },
  });

  cacheCtx.listRelationFilterCache.set(targetTableName, listFilter);

  return listFilter;
};

/**
 * Filter fields for a table's relations: a to-one relation takes the target's own filter input
 * directly, a to-many relation takes the some/every/none wrapper. A relation whose name collides
 * with a column name is skipped — the column keeps the field.
 */
const generateRelationFilterFields = (
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  columnFields: Record<string, ConvertedInputColumn>,
  namedRelations?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): Record<string, { type: GraphQLInputObjectType; description?: string }> => {
  const relations = namedRelations?.[tableName];
  if (!relations || !tables) {
    return {};
  }

  const fields: Record<string, { type: GraphQLInputObjectType; description?: string }> = {};

  for (const [relationName, relEntry] of Object.entries(relations)) {
    if (relationName in columnFields) {
      continue;
    }

    const targetTable = tables[relEntry.targetTableName];
    const relation = (relEntry as any).relation ?? relEntry;
    if (!targetTable) {
      continue;
    }

    fields[relationName] = is(relation, One)
      ? {
          type: generateTableFilterTypeCached(
            targetTable,
            relEntry.targetTableName,
            cacheCtx,
            typeNameMapper,
            namedRelations,
            tables,
          ),
          description: `Matches rows whose ${relationName} matches these filters`,
        }
      : {
          type: generateListRelationFilterCached(
            targetTable,
            relEntry.targetTableName,
            cacheCtx,
            typeNameMapper,
            namedRelations,
            tables,
          ),
        };
  }

  return fields;
};

export const generateTableFilterTypeCached = (
  table: Table,
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper?: TypeNameMapper,
  namedRelations?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
) => {
  if (cacheCtx.filterTypeCache.has(table)) {
    return cacheCtx.filterTypeCache.get(table)!;
  }

  // Fields are thunked so that relation filters, which reference other tables' filter inputs
  // (and eventually this one again), are only resolved after this type is in the cache.
  const buildFields = () => {
    const filterColumns = generateTableFilterValuesCached(table, tableName, cacheCtx);
    const uniqueKeys = cacheCtx.uniqueKeysOf?.(tableName);
    return {
      ...filterColumns,
      ...generateRelationFilterFields(tableName, cacheCtx, typeNameMapper, filterColumns, namedRelations, tables),
      // Last, and already filtered against both — a key field only exists under a name no
      // column and no relation claimed.
      ...(uniqueKeys ? generateUniqueKeyFilterFields(table, tableName, uniqueKeys, typeNameMapper, cacheCtx) : {}),
    };
  };

  // The boolean branches (OR / AND / NOT) are recursive — each branch is this filter type
  // itself — so the thunk references the type being constructed. Siblings and branches
  // compose: sibling fields are implicitly ANDed with the OR / AND / NOT groups.
  const filters: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: cacheCtx.typeName({
      kind: 'filter',
      defaultName: `${resolveTypeName(tableName, typeNameMapper)}Filters`,
      table: tableName,
    }),
    fields: () => ({
      ...buildFields(),
      OR: {
        type: new GraphQLList(new GraphQLNonNull(filters)),
        description: 'At least one branch matches; ANDed with any sibling fields',
      },
      AND: {
        type: new GraphQLList(new GraphQLNonNull(filters)),
        description: 'Every branch matches',
      },
      NOT: {
        type: filters,
        description: 'Negates the nested filters',
      },
    }),
  });

  cacheCtx.filterTypeCache.set(table, filters);

  return filters;
};
