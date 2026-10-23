// The named-relation map the builders work from, derived from drizzle-orm v1's relational
// config, plus the factory signatures the dialect builders implement.

import type { Relation, SQL, Table } from 'drizzle-orm';
import { Column, getColumns, is, relationsFilterToSQL, sql } from 'drizzle-orm';
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
 * The table column behind one entry of a relation's `sourceColumns`, `targetColumns` or
 * `through` lists.
 *
 * drizzle-orm rc.4 stores the table's own Column objects in `sourceColumns` / `targetColumns`
 * and a `RelationsBuilderColumn` descriptor (`{ _: { column, key, tableName } }`) in `through`.
 * The rc.5 snapshots store the descriptor in all of them. Both shapes are accepted here, told
 * apart structurally rather than by importing a class one of those versions does not export.
 * Anything else yields `undefined`, which callers treat as "join columns not readable".
 */
export const unwrapRelationColumn = (entry: unknown): Column | undefined => {
  if (is(entry, Column)) {
    return entry;
  }
  const inner = (entry as any)?._?.column;
  return is(inner, Column) ? inner : undefined;
};

/**
 * A relation's `sourceColumns` or `targetColumns` as table columns, via
 * {@link unwrapRelationColumn}. `undefined` when the list is missing, empty, or has an entry
 * that is not a column in either known shape.
 */
export const relationColumns = (relation: unknown, side: 'source' | 'target'): Column[] | undefined => {
  const entries: unknown[] | undefined = (relation as any)?.[side === 'source' ? 'sourceColumns' : 'targetColumns'];
  if (!entries?.length) {
    return undefined;
  }
  const columns: Column[] = [];
  for (const entry of entries) {
    const column = unwrapRelationColumn(entry);
    if (!column) {
      return undefined;
    }
    columns.push(column);
  }
  return columns;
};

/**
 * drizzle-orm's "no filter" sentinel. rc.5 snapshots export it as `EmptyFilter` and use it as
 * the default `relation.where`; rc.4 has no such export and leaves `where` undefined. It is a
 * registered symbol, so it can be compared against without importing anything.
 */
const EMPTY_FILTER = Symbol.for('drizzle:EmptyFilter');

/**
 * The relation's own declared `where` filter, or `undefined` when it has none. rc.4 leaves
 * `where` undefined in that case; rc.5 snapshots set it to the `EmptyFilter` sentinel, which is
 * truthy and must not be read as a filter.
 */
export const relationOwnWhere = (relation: unknown): Record<string, unknown> | undefined => {
  const where = (relation as any)?.where;
  return where == null || where === EMPTY_FILTER ? undefined : where;
};

/**
 * Whether the relation's `where` was inherited from its reverse relation, and so is written
 * against the parent table rather than the target. rc.4 calls this flag `isReversed`; rc.5
 * snapshots renamed it to `isFilterReversed`. Both are set in the same place with the same
 * meaning (true only for a relation declared without `from`/`to` and without its own `where`).
 */
export const isRelationFilterReversed = (relation: unknown): boolean =>
  !!((relation as any)?.isFilterReversed ?? (relation as any)?.isReversed);

/**
 * Warns, at build time, that a field was left out because the relation's join columns could
 * not be matched to its tables. Omitting it silently is how a drizzle-orm change in the shape
 * of relation columns (issue #179) went unnoticed. A relation that declares no join columns
 * is not reported: there is nothing that failed to match.
 */
export const warnUnresolvedJoin = (
  relEntry: TableNamedRelations,
  tableName: string,
  relationName: string,
  omitted: string,
): void => {
  const rel = (relEntry as any).relation ?? relEntry;
  if (!rel?.sourceColumns?.length || !rel?.targetColumns?.length) {
    return;
  }
  console.warn(
    `Drizzle-GraphQL Warning: relation '${tableName}.${relationName}' declares join columns that could not be matched to columns of '${tableName}' and '${relEntry.targetTableName}', so ${omitted} is not generated. The installed drizzle-orm probably stores relation columns in a shape this version of drizzle-graphql does not recognize.`,
  );
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
  const sourceCol = relationColumns(rel, 'source')?.[0];
  const targetCol = relationColumns(rel, 'target')?.[0];

  if (!sourceCol || !targetCol) {
    return undefined;
  }

  const parentCols = getColumns(parentTable);
  const localColPropName = Object.entries(parentCols).find(([, c]) => c === sourceCol)?.[0];

  const targetCols = getColumns(targetTable);
  const foreignColPropName = Object.entries(targetCols).find(([, c]) => c === targetCol)?.[0];

  if (!localColPropName || !foreignColPropName) {
    return undefined;
  }

  return { localColPropName, foreignCol: targetCol, foreignColPropName };
};

/**
 * The junction table and its two columns for a `.through()` (many-to-many) relation:
 * `sourceCol` holds the parent's key, `targetCol` the target's. `undefined` for a relation
 * with no junction; `null` for one whose junction cannot be used here — more than one column
 * on either side, or columns that are not on the junction table.
 */
export const extractJunctionColumns = (
  relEntry: TableNamedRelations,
): { table: Table; sourceCol: Column; targetCol: Column } | null | undefined => {
  const rel = (relEntry as any).relation ?? relEntry;
  const junction = rel?.throughTable as Table | undefined;
  if (!junction) {
    return undefined;
  }
  const sourceEntries: unknown[] | undefined = rel.through?.source;
  const targetEntries: unknown[] | undefined = rel.through?.target;
  if (sourceEntries?.length !== 1 || targetEntries?.length !== 1) {
    return null;
  }
  const junctionCols = Object.values(getColumns(junction));
  const sourceCol = unwrapRelationColumn(sourceEntries[0]);
  const targetCol = unwrapRelationColumn(targetEntries[0]);
  if (!sourceCol || !targetCol || !junctionCols.includes(sourceCol) || !junctionCols.includes(targetCol)) {
    return null;
  }
  return { table: junction, sourceCol, targetCol };
};

/**
 * The relation's own declared `where` as a condition on a query that reads the target table,
 * or `undefined` when it has none. The eager path gets this from drizzle's `with:`; the batched
 * field resolver and `<relation>Aggregate` read the target table directly, so they have to add
 * it themselves or they return rows the relation hides.
 *
 * A reversed filter (inherited from the relation on the other side) is written against the
 * parent table, so it is applied as "the row's parent key belongs to a parent that passes it".
 * `parentKeyCol` is the parent's join column and `groupCol` the column in the query that holds
 * the parent key for each row — the target's foreign key, or the junction's source column.
 */
export const relationOwnCondition = (
  relEntry: TableNamedRelations,
  parentTable: Table,
  targetTable: Table,
  parentKeyCol: Column,
  groupCol: Column,
): SQL | undefined => {
  const rel = (relEntry as any).relation ?? relEntry;
  const ownWhere = relationOwnWhere(rel);
  if (!ownWhere) {
    return undefined;
  }
  if (!isRelationFilterReversed(rel)) {
    return relationsFilterToSQL(targetTable, ownWhere as any);
  }
  const parentFilter = relationsFilterToSQL(parentTable, ownWhere as any);
  return sql`${groupCol} in (select ${parentKeyCol} from ${parentTable} where ${parentFilter})`;
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
