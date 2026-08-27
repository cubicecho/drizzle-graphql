// The named-relation map the builders work from, derived from drizzle-orm v1's relational
// config, plus the factory signatures the dialect builders implement.

import type { Column, Relation, Table } from 'drizzle-orm';
import { getColumns } from 'drizzle-orm';
import type { GraphQLFieldResolver, GraphQLObjectType } from 'graphql';
import type { TableNamedRelations } from '../types.ts';

/**
 * Shape of the relational config from drizzle-orm v1 db._.relations.
 * Each entry has { table, name, relations }.
 */
interface TableRelationalConfig {
  table: Table;
  name: string;
  relations: Record<string, Relation<string>>;
}
export type TablesRelationalConfig = Record<string, TableRelationalConfig>;

/**
 * Flatten drizzle-orm v1 TablesRelationalConfig into the canonical
 * Record<tableName, Record<relName, TableNamedRelations>> shape used
 * throughout common.ts.  Both pg.ts and sqlite.ts call this before
 * passing the relation map to any shared function.
 */
export const buildNamedRelations = (
  relations: TablesRelationalConfig,
  tableEntries: [string, Table][],
): Record<string, Record<string, TableNamedRelations>> => {
  const namedRelations: Record<string, Record<string, TableNamedRelations>> = {};

  for (const [relTableName, relConfig] of Object.entries(relations)) {
    if (!relConfig?.relations) {
      continue;
    }

    const namedConfig: Record<string, TableNamedRelations> = {};

    for (const [innerRelName, innerRelValue] of Object.entries(relConfig.relations)) {
      // drizzle-orm v1 uses `targetTable` (not `referencedTable`)
      // and provides `targetTableName` directly.
      const targetTable = (innerRelValue as any).targetTable ?? (innerRelValue as any).referencedTable;
      const directTargetName = (innerRelValue as any).targetTableName as string | undefined;

      let targetTableName: string | undefined;

      if (directTargetName) {
        // v1: use the direct name to find the schema key
        const targetEntry = tableEntries.find(([key]) => key === directTargetName);
        targetTableName = targetEntry?.[0];
      } else if (targetTable) {
        // fallback: match by object reference
        const targetEntry = tableEntries.find(([, tableValue]) => tableValue === targetTable);
        targetTableName = targetEntry?.[0];
      }

      if (!targetTableName) {
        continue;
      }

      namedConfig[innerRelName] = {
        relation: innerRelValue,
        targetTableName,
      };
    }

    if (Object.keys(namedConfig).length > 0) {
      namedRelations[relTableName] = namedConfig;
    }
  }

  return namedRelations;
};

/**
 * Records each relation's target-table primary-key property names on the relation entry,
 * so the pagination paths (the window-function batch loader and the eager `with:` orderBy
 * default) can fall back to a deterministic PK order without re-deriving it per request.
 *
 * Composite primary keys are only visible through the dialect's getTableConfig, so the
 * dialect builder passes a `resolvePkNames` that threads the composite column names in.
 * Mutates the relation entries in place (they are shared with the pruned eager map and
 * the resolver factory, so attaching once covers every consumer).
 */
export const attachTargetPrimaryKeys = (
  namedRelations: Record<string, Record<string, TableNamedRelations>>,
  tables: Record<string, Table>,
  resolvePkNames: (table: Table) => string[],
): void => {
  const cache = new Map<string, readonly string[]>();
  for (const rels of Object.values(namedRelations)) {
    for (const relEntry of Object.values(rels)) {
      const { targetTableName } = relEntry;
      let pk = cache.get(targetTableName);
      if (!pk) {
        const targetTable = tables[targetTableName];
        pk = targetTable ? resolvePkNames(targetTable) : [];
        cache.set(targetTableName, pk);
      }
      relEntry.targetPkNames = pk;
    }
  }
};

/**
 * Extracts the join column info from a drizzle-orm v1 Relation object.
 * Returns the JS property name of the local column on the parent table and the
 * Column object for the foreign column on the target table, or undefined if the
 * relation internals are not accessible.
 */
export const extractRelationJoinColumns = (
  relEntry: TableNamedRelations,
  parentTable: Table,
  targetTable: Table,
): { localColPropName: string; foreignCol: Column; foreignColPropName: string } | undefined => {
  const rel = (relEntry as any).relation ?? relEntry;
  const sourceColumns: any[] | undefined = rel.sourceColumns;
  const targetColumns: any[] | undefined = rel.targetColumns;

  if (!sourceColumns?.length || !targetColumns?.length) {
    return undefined;
  }

  const sourceCol = sourceColumns[0];
  const targetCol = targetColumns[0];

  const parentCols = getColumns(parentTable);
  const localColPropName = Object.entries(parentCols).find(([, c]) => c === sourceCol)?.[0];

  const targetCols = getColumns(targetTable);
  const foreignColPropName = Object.entries(targetCols).find(([, c]) => c === targetCol)?.[0];

  if (!localColPropName || !foreignColPropName) {
    return undefined;
  }

  return { localColPropName, foreignCol: targetCol, foreignColPropName };
};

export type RelationResolverFactory = (params: {
  tableName: string;
  relationName: string;
  relEntry: TableNamedRelations;
  isOne: boolean;
}) => GraphQLFieldResolver<any, any> | undefined;

/**
 * Builds the `${relationName}Aggregate` field for a to-many relation. Implemented in
 * `aggregates.ts` and injected here so the aggregate code can depend on this module
 * without the two importing each other.
 */
export type RelationAggregateFactory = (params: {
  tableName: string;
  relationName: string;
  relEntry: TableNamedRelations;
}) => { type: GraphQLObjectType; resolve: GraphQLFieldResolver<any, any> } | undefined;

/**
 * Whether a to-one relation can back a relation orderBy hop. `.through()` (junction)
 * relations are excluded — the ordering subquery only joins the direct target, never the
 * junction table. (Relation *filters* do support `.through()` — this guard is orderBy-only.)
 */
export const isFilterableRelation = (relation: Relation<string>): boolean => !(relation as any).through;
