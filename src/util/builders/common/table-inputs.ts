// The per-table input types — Filters, OrderBy, and the select field map — each cached so a
// schema builds one of them per table no matter how many fields reference it.

import type { Table } from 'drizzle-orm';
import { is, One } from 'drizzle-orm';
import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { drizzleColumnToGraphQLType } from '../../type-converter/index.ts';
import type { ConvertedColumn, ConvertedInputColumn } from '../../type-converter/types.ts';
import type { TableNamedRelations } from '../types.ts';
import { generateColumnFilterValues } from './column-filters.ts';
import { CURSOR_FIELD_NAME, rowCursorResolver } from './cursor.ts';
import { columnDocs } from './docs.ts';
import { hasExcludedColumns, visibleColumns } from './exclusions.ts';
import { innerOrder } from './input-order.ts';
import type { TypeNameMapper } from './naming.ts';
import { resolveTypeName } from './naming.ts';
import { isFilterableRelation } from './relations.ts';
import type { TypeCacheCtx } from './type-cache.ts';

const orderMap = new WeakMap<object, Record<string, ConvertedInputColumn>>();
const generateTableOrderCached = (table: Table) => {
  // The cache outlives a build, so a table whose columns this build hides must not read from
  // it (a previous build may have cached the full set) or write to it (a later unfiltered
  // build would inherit the holes).
  const cacheable = !hasExcludedColumns(table);
  if (cacheable && orderMap.has(table)) {
    return orderMap.get(table)!;
  }

  let remapped = {};
  try {
    const columns = visibleColumns(table);
    const columnEntries = Object.entries(columns);

    remapped = Object.fromEntries(
      columnEntries.map(([columnName, _columnDescription]) => [columnName, { type: innerOrder }]),
    );

    if (cacheable) {
      orderMap.set(table, remapped);
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
 * Order fields for a table's to-one relations: each takes the target table's own OrderBy
 * input, so a list can be sorted by a related row's column (compiled as a correlated
 * subquery in the ORDER BY — see `extractOrderBy`). To-many relations are left out: "order
 * a parent by its many children" has no single defined value to sort on. A relation whose
 * name collides with a column is skipped — the column keeps the field.
 */
const generateRelationOrderFields = (
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  columnFields: Record<string, ConvertedInputColumn>,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): Record<string, { type: GraphQLInputObjectType; description?: string }> => {
  const relations = relationMap?.[tableName];
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
    if (!targetTable || !is(relation, One) || !isFilterableRelation(relation)) {
      continue;
    }

    fields[relationName] = {
      type: generateTableOrderTypeCached(
        targetTable,
        relEntry.targetTableName,
        typeNameMapper,
        cacheCtx,
        relationMap,
        tables,
      ),
      description: `Order by columns of the related ${relationName} row`,
    };
  }

  return fields;
};

export const generateTableOrderTypeCached = (
  table: Table,
  tableName: string,
  typeNameMapper: TypeNameMapper | undefined,
  cacheCtx: TypeCacheCtx,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
) => {
  if (cacheCtx.orderTypeCache.has(table)) {
    return cacheCtx.orderTypeCache.get(table)!;
  }

  // Fields are thunked so that relation order fields, which reference other tables' order
  // inputs (and eventually this one again), are only resolved after this type is cached.
  const order = new GraphQLInputObjectType({
    name: `${resolveTypeName(tableName, typeNameMapper)}OrderBy`,
    fields: () => {
      const orderColumns = generateTableOrderCached(table);
      return {
        ...orderColumns,
        ...generateRelationOrderFields(tableName, cacheCtx, typeNameMapper, orderColumns, relationMap, tables),
      };
    },
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
  relationMap: Record<string, Record<string, TableNamedRelations>> | undefined,
  tables: Record<string, Table> | undefined,
): GraphQLInputObjectType => {
  const cached = cacheCtx.listRelationFilterCache.get(targetTableName);
  if (cached) {
    return cached;
  }

  const listFilter = new GraphQLInputObjectType({
    name: `${resolveTypeName(targetTableName, typeNameMapper)}ListRelationFilter`,
    fields: () => {
      const targetFilters = generateTableFilterTypeCached(
        targetTable,
        targetTableName,
        cacheCtx,
        typeNameMapper,
        relationMap,
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
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): Record<string, { type: GraphQLInputObjectType; description?: string }> => {
  const relations = relationMap?.[tableName];
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
            relationMap,
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
            relationMap,
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
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
) => {
  if (cacheCtx.filterTypeCache.has(table)) {
    return cacheCtx.filterTypeCache.get(table)!;
  }

  // Fields are thunked so that relation filters, which reference other tables' filter inputs
  // (and eventually this one again), are only resolved after this type is in the cache.
  const buildFields = () => {
    const filterColumns = generateTableFilterValuesCached(table, tableName, cacheCtx);
    return {
      ...filterColumns,
      ...generateRelationFilterFields(tableName, cacheCtx, typeNameMapper, filterColumns, relationMap, tables),
    };
  };

  // The boolean branches (OR / AND / NOT) are recursive — each branch is this filter type
  // itself — so the thunk references the type being constructed. Siblings and branches
  // compose: sibling fields are implicitly ANDed with the OR / AND / NOT groups.
  const filters: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: `${resolveTypeName(tableName, typeNameMapper)}Filters`,
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
