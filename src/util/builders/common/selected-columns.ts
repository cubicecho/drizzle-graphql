// Reading the requested columns off a parsed selection tree, in both shapes the builders need —
// the relational query builder's `columns` map, and a SQL select list.

import type { Column, Table } from 'drizzle-orm';
import { getColumns } from 'drizzle-orm';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import type { SelectedColumnsRaw, SelectedSQLColumns, TableNamedRelations } from '../types.ts';
import { extractRelationJoinColumns } from './relations.ts';

const rqbCrashTypes = ['SQLiteBigInt', 'SQLiteBlobJson', 'SQLiteBlobBuffer'];

/**
 * Everything needed to work out which extra columns a selection implies. Passed to the column
 * extractors so a requested `<relation>Aggregate` field can pull in the join column it resolves
 * from, which the client has no reason to have selected itself.
 */
export interface SelectionCtx {
  tableName: string;
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  tables: Record<string, Table>;
  /**
   * Every relation on the table, including those `relationMap` omits because they are not
   * eager-loaded. A lazily-resolved relation still correlates on a join column, so the
   * column extractors need to see it even when the eager map doesn't.
   */
  allRelations?: Record<string, Record<string, TableNamedRelations>>;
}

const AGGREGATE_FIELD_SUFFIX = 'Aggregate';

/**
 * Property names of the join columns that this selection's relation fields correlate on.
 * Without them the parent row reaches the relation resolver with no key: an aggregate counts
 * 0 and a relation list comes back empty.
 *
 * Needed by every relation field that resolves through its own resolver rather than the
 * parent's `with:` clause — `<relation>Aggregate` fields, which are always lazy; relations
 * excluded by `eagerLoadRelations`; and relations dropped from `with:` because they were
 * selected more than once under different aliases. Forcing the column for *any* selected
 * relation covers all three without the extractor having to predict which path will run: the
 * cost is one extra column (usually the primary key) in the parent SELECT, and GraphQL only
 * returns the fields the query asked for, so it never reaches the response.
 */
const relationJoinColumns = (
  tree: Record<string, ResolveTree>,
  table: Table,
  selectionCtx: SelectionCtx | undefined,
): string[] => {
  if (!selectionCtx) {
    return [];
  }
  const relations =
    (selectionCtx.allRelations ?? selectionCtx.relationMap)[selectionCtx.tableName] ??
    selectionCtx.relationMap[selectionCtx.tableName];
  if (!relations) {
    return [];
  }

  const tableColumns = getColumns(table);
  const needed: string[] = [];

  for (const fieldData of Object.values(tree)) {
    // A column that happens to be named like a relation is a column.
    if (tableColumns[fieldData.name]) {
      continue;
    }

    const relEntry = fieldData.name.endsWith(AGGREGATE_FIELD_SUFFIX)
      ? relations[fieldData.name.slice(0, -AGGREGATE_FIELD_SUFFIX.length)]
      : relations[fieldData.name];
    const targetTable = relEntry ? selectionCtx.tables[relEntry.targetTableName] : undefined;
    if (!relEntry || !targetTable) {
      continue;
    }

    const joinCols = extractRelationJoinColumns(relEntry, table, targetTable);
    if (joinCols) {
      needed.push(joinCols.localColPropName);
    }
  }

  return needed;
};

export const extractSelectedColumnsFromTree = (
  tree: Record<string, ResolveTree>,
  table: Table,
  selectionCtx?: SelectionCtx,
): Record<string, true> => {
  const tableColumns = getColumns(table);

  const treeEntries = Object.entries(tree);
  const selectedColumns: SelectedColumnsRaw = [];

  for (const [_fieldName, fieldData] of treeEntries) {
    if (!tableColumns[fieldData.name]) {
      continue;
    }

    selectedColumns.push([fieldData.name, true]);
  }

  for (const columnName of relationJoinColumns(tree, table, selectionCtx)) {
    selectedColumns.push([columnName, true]);
  }

  if (!selectedColumns.length) {
    const columnKeys = Object.entries(tableColumns);
    const columnName =
      columnKeys.find((e) => rqbCrashTypes.find((haram) => e[1].columnType !== haram))?.[0] ?? columnKeys[0]![0];

    selectedColumns.push([columnName, true]);
  }

  return Object.fromEntries(selectedColumns);
};

/**
 * Can't automatically determine column type on type level
 * Since drizzle table types extend eachother
 */
export const extractSelectedColumnsFromTreeSQLFormat = <TColType extends Column = Column>(
  tree: Record<string, ResolveTree>,
  table: Table,
  selectionCtx?: SelectionCtx,
): Record<string, TColType> => {
  const tableColumns = getColumns(table);

  const treeEntries = Object.entries(tree);
  const selectedColumns: SelectedSQLColumns = [];

  for (const [_fieldName, fieldData] of treeEntries) {
    if (!tableColumns[fieldData.name]) {
      continue;
    }

    selectedColumns.push([fieldData.name, tableColumns[fieldData.name]!]);
  }

  for (const columnName of relationJoinColumns(tree, table, selectionCtx)) {
    selectedColumns.push([columnName, tableColumns[columnName]!]);
  }

  if (!selectedColumns.length) {
    const columnKeys = Object.entries(tableColumns);
    const columnName =
      columnKeys.find((e) => rqbCrashTypes.find((haram) => e[1].columnType !== haram))?.[0] ?? columnKeys[0]![0];

    selectedColumns.push([columnName, tableColumns[columnName]!]);
  }

  return Object.fromEntries(selectedColumns) as Record<string, TColType>;
};
