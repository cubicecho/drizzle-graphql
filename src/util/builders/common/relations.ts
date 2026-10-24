// The named-relation map the builders work from, derived from drizzle-orm v1's relational
// config, plus the factory signatures the dialect builders implement.

import type { Relation, SQL, Table } from 'drizzle-orm';
import { and, Column, eq, getColumns, getTableName, inArray, is, or, relationsFilterToSQL, sql } from 'drizzle-orm';
import type { GraphQLFieldResolver, GraphQLObjectType } from 'graphql';
import {
  mySqlDateTimeTextToIso,
  pgTimestampTextToIso,
  rawColumnValue,
  remapFromGraphQLCore,
} from '../../data-mappers/index.ts';
import { dateToCalendarDate } from '../../scalars/index.ts';
import {
  isDateOnlyColumn,
  isMySqlDateTimeStringColumn,
  isPgTimestampStringColumn,
} from '../../type-converter/index.ts';
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
 *
 * Only the relation's *first* column pair is reported. A relation joined on several columns
 * (`from: [a, b], to: [x, y]`) is not described fully by it, so anything that reads rows by
 * this pair alone mixes up parents that share the first column. Read paths use
 * {@link extractRelationJoinColumnPairs}, which returns every pair.
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

/** One column pair a relation joins on: the parent's column and the target's it equals. */
export interface RelationJoinColumnPair {
  localColPropName: string;
  localCol: Column;
  foreignColPropName: string;
  foreignCol: Column;
}

/**
 * Every column pair the relation joins on, in declaration order — one for an ordinary relation,
 * several for one declared `from: [a, b], to: [x, y]`. A row of the target belongs to a parent
 * only when *all* pairs match, so a read path has to correlate on every one of them.
 *
 * `undefined` when the relation's columns cannot be matched to the two tables, or when its two
 * sides list a different number of columns.
 */
export const extractRelationJoinColumnPairs = (
  relEntry: TableNamedRelations,
  parentTable: Table,
  targetTable: Table,
): RelationJoinColumnPair[] | undefined => {
  const rel = (relEntry as any).relation ?? relEntry;
  const sourceCols = relationColumns(rel, 'source');
  const targetCols = relationColumns(rel, 'target');
  if (!sourceCols?.length || sourceCols.length !== targetCols?.length) {
    return undefined;
  }

  const parentEntries = Object.entries(getColumns(parentTable));
  const targetEntries = Object.entries(getColumns(targetTable));
  const pairs: RelationJoinColumnPair[] = [];
  for (let i = 0; i < sourceCols.length; i++) {
    const localCol = sourceCols[i]!;
    const foreignCol = targetCols[i]!;
    const localColPropName = parentEntries.find(([, c]) => c === localCol)?.[0];
    const foreignColPropName = targetEntries.find(([, c]) => c === foreignCol)?.[0];
    if (!localColPropName || !foreignColPropName) {
      return undefined;
    }
    pairs.push({ localColPropName, localCol, foreignColPropName, foreignCol });
  }
  return pairs;
};

/** A decimal written as text, in a form `canonicalDecimal` can normalise. */
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * Decimal text without the zeros that do not change its value: `1.500` and `01.5` are both
 * `1.5`, as SQL compares them. Anything else (an exponent, `NaN`) is returned unchanged.
 */
const canonicalDecimal = (value: string): string => {
  const match = DECIMAL_TEXT.exec(value);
  if (!match || (!match[2] && !match[3])) {
    return value;
  }
  const whole = match[2]!.replace(/^0+(?=\d)/, '') || '0';
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const digits = fraction ? `${whole}.${fraction}` : whole;
  return match[1] === '-' && digits !== '0' ? `-${digits}` : digits;
};

/** An ISO instant without trailing zeros in its fraction: `…:00.100Z` and `…:00.1Z` agree. */
const trimIsoFraction = (iso: string): string => iso.replace(/(\.\d*?)0+Z$/, '$1Z').replace(/\.Z$/, 'Z');

/**
 * One join value in a form both sides of a relation produce for the same SQL value. The parent's
 * key and a related row's can arrive in different JS forms — a `Date` and the text of the same
 * instant, `1.50` and `1.500` from decimals of different scale — and `String()` would tell them
 * apart (it even drops a `Date`'s milliseconds).
 */
const joinValueKey = (value: unknown, column: Column | undefined): string => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return String(value);
    }
    if (column && isDateOnlyColumn(column)) {
      return dateToCalendarDate(value) ?? value.toISOString();
    }
    return trimIsoFraction(value.toISOString());
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  }
  if (typeof value === 'string' && column) {
    if (isMySqlDateTimeStringColumn(column)) {
      return trimIsoFraction(mySqlDateTimeTextToIso(value));
    }
    if (isPgTimestampStringColumn(column)) {
      return trimIsoFraction(pgTimestampTextToIso(value));
    }
    if (((column as any).dataType ?? '') === 'string numeric') {
      return canonicalDecimal(value);
    }
  }
  return String(value);
};

/**
 * A string identifying one combination of join-column values, for grouping a batch's rows by
 * parent. `columns` are the columns the values were read from, in the same order: the parent's
 * join columns for a parent key, the target's (or the junction's) for a related row. Values the
 * database compares equal give the same key — see {@link joinValueKey}.
 */
export const joinKeyOf = (values: readonly unknown[], columns?: readonly Column[]): string =>
  values.length === 1
    ? joinValueKey(values[0], columns?.[0])
    : JSON.stringify(values.map((value, i) => joinValueKey(value, columns?.[i])));

/** MySQL column types whose comparisons follow a collation. */
const MYSQL_TEXT_COLUMN_TYPES: ReadonlySet<string> = new Set(['MySqlVarChar', 'MySqlChar', 'MySqlText']);

/**
 * Text as MySQL compares it under `collation`, as near as JS can tell: equal under the
 * collation gives an equal fold.
 * - `*_ci` folds case; `*_ai_*` — and the pre-0900 `*_ci` collations, which are
 *   accent-insensitive too — fold accents
 * - `*_cs`, `*_bin` and `binary` keep both
 * - every collation outside the `*_0900_*` family and `binary` is PAD SPACE, so trailing
 *   spaces do not count
 */
const collationFold = (collation: string): ((text: string) => string) => {
  const name = collation.toLowerCase();
  const padSpace = name !== 'binary' && !name.includes('_0900_');
  const caseInsensitive = name.endsWith('_ci');
  const accentInsensitive = name.includes('_ai_') || (caseInsensitive && !name.includes('_as_'));
  return (text) => {
    let folded = padSpace ? text.replace(/ +$/, '') : text;
    if (accentInsensitive) {
      folded = folded.normalize('NFD').replace(/\p{M}/gu, '');
    }
    return caseInsensitive ? folded.toLowerCase() : folded;
  };
};

/**
 * The collation each MySQL text column compares under, per column object. A column that
 * declares one (`.collate()`) answers from the schema; otherwise the database is asked once —
 * the table or database default it inherited is not something the drizzle schema records.
 */
const columnCollations = new WeakMap<Column, Promise<string | undefined>>();

const columnCollation = (executor: any, column: Column): Promise<string | undefined> => {
  const declared = (column as any).collation as string | undefined;
  if (declared) {
    return Promise.resolve(declared);
  }
  let collation = columnCollations.get(column);
  if (!collation) {
    const table = (column as any).table;
    const tableName: string = table[Symbol.for('drizzle:OriginalName')] ?? getTableName(table);
    const schema: string | undefined = table[Symbol.for('drizzle:Schema')];
    collation = Promise.resolve(
      executor.execute(
        sql`select collation_name as collation from information_schema.columns where table_schema = ${schema ?? sql`database()`} and table_name = ${tableName} and column_name = ${column.name}`,
      ),
    ).then((result: any) => {
      // mysql2 resolves `[rows, fields]`; read whichever shape the driver handed back.
      const rows: any[] = Array.isArray(result?.[0]) ? result[0] : Array.isArray(result) ? result : [];
      return (rows[0]?.collation ?? rows[0]?.COLLATION_NAME ?? undefined) as string | undefined;
    });
    // A failed lookup is not cached, so the next request asks again.
    collation.catch(() => columnCollations.delete(column));
    columnCollations.set(column, collation);
  }
  return collation;
};

/**
 * Matches a batch's related rows to the parents they belong to, by the rule the database used
 * to fetch them. Resolves to a function from one related row's join values to the
 * {@link joinKeyOf} keys of the parents (in `parentKeys`) it belongs to.
 *
 * For every key but MySQL text that is the exact key — one parent, no lookup. MySQL compares
 * text under a collation, and its default (`utf8mb4_0900_ai_ci`) is case- and
 * accent-insensitive, so the batch query fetches a child whose `ABC` key names the parent
 * `abc`; read back by its exact text, that child would match no parent and be dropped — and in
 * an aggregate's GROUP BY the whole group would, labelled with whichever spelling MySQL saw
 * first. So a MySQL text key is matched folded under the collation the batch query compared
 * by: the related column's (`targetCols`, which the query's `IN` list is compared against),
 * read from the schema or, failing that, from the database ({@link columnCollation}). A child
 * then belongs to every parent its key equals under that collation, as in SQL.
 */
export const relatedRowParents = async (
  executor: any,
  parentKeys: readonly (readonly unknown[])[],
  localCols: readonly Column[],
  targetCols: readonly Column[],
): Promise<(values: readonly unknown[]) => readonly string[]> => {
  const folds = await Promise.all(
    targetCols.map(async (column) =>
      MYSQL_TEXT_COLUMN_TYPES.has((column as any).columnType)
        ? collationFold((await columnCollation(executor, column)) ?? 'binary')
        : undefined,
    ),
  );
  if (folds.every((fold) => !fold)) {
    return (values) => [joinKeyOf(values, targetCols)];
  }

  const foldedKey = (values: readonly unknown[], columns: readonly Column[]): string =>
    JSON.stringify(
      values.map((value, i) => {
        const fold = folds[i];
        return fold && typeof value === 'string' ? fold(value) : joinValueKey(value, columns[i]);
      }),
    );
  const seen = new Set<string>();
  const byFolded = new Map<string, string[]>();
  for (const key of parentKeys) {
    const parentKey = joinKeyOf(key, localCols);
    if (seen.has(parentKey)) {
      continue;
    }
    seen.add(parentKey);
    const folded = foldedKey(key, localCols);
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), parentKey]);
  }

  return (values) => byFolded.get(foldedKey(values, targetCols)) ?? [];
};

/**
 * The parent row's values for the relation's join columns, as the database holds them. The row
 * a relation field resolves under has been remapped to its GraphQL form — a `Date` is an ISO
 * string by then, a `bigint` a decimal string — which can neither be bound back through every
 * column's encoder (SQLite's integer timestamp calls `getTime()` on it) nor be compared with the
 * related rows' decoded values. The values from before remapping are used when the row kept
 * them; otherwise the output form is mapped back the way an input value would be.
 */
export const parentJoinValues = (parent: Record<string, any>, pairs: readonly RelationJoinColumnPair[]): unknown[] =>
  pairs.map(({ localColPropName, localCol }) => {
    const raw = rawColumnValue(parent, localColPropName);
    if (raw.found) {
      return raw.value;
    }
    const value = parent[localColPropName];
    if (value == null) {
      return value;
    }
    try {
      return remapFromGraphQLCore(value, localCol, localColPropName);
    } catch {
      return value;
    }
  });

/**
 * At most this many bound parameters for the parent keys of one batched relation query. SQLite
 * accepts 32,766 per statement, Postgres and MySQL 65,535; the rest is left to the request's own
 * filters. A batch with more parents runs as several queries.
 */
const MAX_PARENT_KEY_PARAMS = 10_000;

/**
 * The parent keys of one batch split into the groups each query reads, so that no query binds
 * more than {@link MAX_PARENT_KEY_PARAMS} key values. Every parent lands in exactly one group, so
 * a per-parent result — its rows, its window, its count — is the same whichever query made it.
 */
export const parentKeyChunks = <K>(keys: readonly K[], width: number): K[][] => {
  const size = Math.max(1, Math.floor(MAX_PARENT_KEY_PARAMS / Math.max(1, width)));
  const chunks: K[][] = [];
  for (let i = 0; i < keys.length; i += size) {
    chunks.push(keys.slice(i, i + size));
  }
  return chunks;
};

/**
 * `or` over `conditions` as a balanced tree. A flat `a OR b OR c …` is parsed left-deep, and
 * SQLite refuses an expression more than 1,000 levels deep; balanced, a batch of thousands of
 * parents stays a few levels deep.
 */
export const balancedOr = (conditions: readonly (SQL | undefined)[]): SQL | undefined => {
  if (conditions.length <= 2) {
    return or(...conditions);
  }
  const middle = Math.ceil(conditions.length / 2);
  return or(balancedOr(conditions.slice(0, middle)), balancedOr(conditions.slice(middle)));
};

/**
 * The rows whose `cols` hold one of `keys`: `col IN (…)` for a single join column, and an `OR`
 * of per-parent equalities for several — `(a = 1 AND b = 1) OR (a = 1 AND b = 2)` — which
 * every dialect accepts, unlike a row-value `IN` list. The `OR` is nested as a balanced tree.
 * Callers split a large batch with {@link parentKeyChunks} first, which keeps either form within
 * the dialects' parameter limits.
 */
export const parentKeyCondition = (cols: readonly Column[], keys: readonly (readonly unknown[])[]): SQL | undefined =>
  cols.length === 1
    ? inArray(
        cols[0]!,
        keys.map((key) => key[0]),
      )
    : balancedOr(keys.map((key) => and(...cols.map((col, i) => eq(col, key[i])))));

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
 * `parentKeyCols` are the parent's join columns and `groupCols` the columns in the query that
 * hold the parent key for each row — the target's foreign key, or the junction's source
 * column — in the same order. A key of several columns is compared as a row value.
 */
export const relationOwnCondition = (
  relEntry: TableNamedRelations,
  parentTable: Table,
  targetTable: Table,
  parentKeyCols: readonly Column[],
  groupCols: readonly Column[],
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
  if (groupCols.length === 1) {
    return sql`${groupCols[0]} in (select ${parentKeyCols[0]} from ${parentTable} where ${parentFilter})`;
  }
  return sql`(${sql.join([...groupCols], sql`, `)}) in (select ${sql.join([...parentKeyCols], sql`, `)} from ${parentTable} where ${parentFilter})`;
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
