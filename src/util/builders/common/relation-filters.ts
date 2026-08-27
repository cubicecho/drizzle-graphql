// Relation keys inside a `where`: the correlated EXISTS subquery each `some` / `none` / `every`
// compiles to, and `extractFilters`, which dispatches a whole filter object across columns,
// boolean groups and relations.

import type { Column, Relation, Table } from 'drizzle-orm';
import {
  aliasedTable,
  and,
  eq,
  getColumns,
  getTableAsAliasSQL,
  is,
  not,
  One,
  or,
  relationsFilterToSQL,
  type SQL,
  sql,
} from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { FilterColumnOperatorsCore, Filters, TableNamedRelations } from '../types.ts';
import { extractFiltersColumn } from './filters.ts';

/**
 * Everything `extractFilters` needs to turn a relation key in a `where` argument into a
 * correlated subquery. Omitted by callers that don't generate relation filters, in which case
 * relation keys can't appear in the input to begin with.
 */
export interface RelationFilterContext {
  /** Every table in the schema, keyed by its schema key. */
  tables: Record<string, Table>;
  /** Relations keyed by table schema key, then relation name. */
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  /**
   * Schema key of the table being filtered. Not always the same as the `tableName` label
   * used in error messages (relation `where` callbacks pass the relation name there).
   */
  tableKey: string;
  /** Shared counter making every subquery alias unique within one extraction. */
  aliases?: { n: number };
}

/**
 * The build-scoped half of {@link RelationFilterContext}. Created once per generated schema and
 * handed to every resolver, which adds the table it is filtering.
 */
export type RelationFilterBase = Pick<RelationFilterContext, 'tables' | 'relationMap'>;

/** Narrows the build-scoped relation filter context to the table a resolver is filtering. */
export const relationFilterCtx = (
  base: RelationFilterBase | undefined,
  tableKey: string,
): RelationFilterContext | undefined => (base ? { ...base, tableKey } : undefined);

/** The three ways a to-many relation can be required to match, plus the to-one shorthand. */
type RelationMatchMode = 'some' | 'none' | 'every';

/**
 * Correlates the parent row with the aliased target table using the relation's own join
 * columns. Columns are matched by SQL name rather than object identity so this also works when
 * the parent is an aliased proxy (as it is inside a relational `with:` where callback).
 */
export const buildRelationJoinCondition = (
  parentTable: Table,
  relation: Relation<string>,
  aliasedTarget: Table,
  relationName: string,
): SQL | undefined => {
  const sourceColumns = (relation as any).sourceColumns as Column[] | undefined;
  const targetColumns = (relation as any).targetColumns as Column[] | undefined;

  if (!sourceColumns?.length || sourceColumns.length !== targetColumns?.length) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  const parentColumns = Object.values(getColumns(parentTable));
  const targetColumnsByName = Object.values(getColumns(aliasedTarget));

  const conditions: SQL[] = [];
  for (let i = 0; i < sourceColumns.length; i++) {
    const localColumn = parentColumns.find((c) => c.name === sourceColumns[i]!.name);
    const foreignColumn = targetColumnsByName.find((c) => c.name === targetColumns[i]!.name);

    if (!localColumn || !foreignColumn) {
      throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
    }

    conditions.push(eq(localColumn, foreignColumn));
  }

  return conditions.length > 1 ? and(...conditions) : conditions[0];
};

/**
 * Resolves one side of a `.through()` junction pair to the corresponding column on the
 * aliased junction table. Drizzle stores the junction column as a RelationsBuilderColumn
 * (`_.column` is the Column, `_.key` its property name), so look up by property name first
 * and fall back to matching by SQL name.
 */
const resolveJunctionColumn = (aliasedThrough: Table, junctionRef: any, relationName: string): Column => {
  const throughColumns = getColumns(aliasedThrough);

  const key: string | undefined = junctionRef?._?.key;
  const byKey = key ? throughColumns[key] : undefined;
  if (byKey) {
    return byKey;
  }

  const columnName: string | undefined = junctionRef?._?.column?.name;
  const byName = columnName ? Object.values(throughColumns).find((c) => c.name === columnName) : undefined;
  if (!byName) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  return byName;
};

/**
 * Join conditions for a `.through()` (many-to-many) relation, split into the two legs of the
 * junction: `correlation` ties the parent row to the aliased junction table on the relation's
 * source keys, `junctionJoin` ties the aliased junction table to the aliased target on the
 * target keys. Column matching mirrors {@link buildRelationJoinCondition} — by SQL name on the
 * parent/target so aliased proxies work — while junction columns come from the relation's own
 * `through` metadata.
 */
const buildThroughJoinConditions = (
  parentTable: Table,
  relation: Relation<string>,
  aliasedThrough: Table,
  aliasedTarget: Table,
  relationName: string,
): { correlation: SQL | undefined; junctionJoin: SQL | undefined } => {
  const sourceColumns = (relation as any).sourceColumns as Column[] | undefined;
  const targetColumns = (relation as any).targetColumns as Column[] | undefined;
  const through = (relation as any).through as { source: any[]; target: any[] } | undefined;

  if (
    !sourceColumns?.length ||
    !targetColumns?.length ||
    through?.source.length !== sourceColumns.length ||
    through.target.length !== targetColumns.length
  ) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  const parentColumns = Object.values(getColumns(parentTable));
  const targetTableColumns = Object.values(getColumns(aliasedTarget));

  const correlationConditions: SQL[] = [];
  for (let i = 0; i < sourceColumns.length; i++) {
    const localColumn = parentColumns.find((c) => c.name === sourceColumns[i]!.name);
    if (!localColumn) {
      throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
    }
    correlationConditions.push(eq(localColumn, resolveJunctionColumn(aliasedThrough, through.source[i], relationName)));
  }

  const junctionJoinConditions: SQL[] = [];
  for (let i = 0; i < targetColumns.length; i++) {
    const foreignColumn = targetTableColumns.find((c) => c.name === targetColumns[i]!.name);
    if (!foreignColumn) {
      throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
    }
    junctionJoinConditions.push(
      eq(resolveJunctionColumn(aliasedThrough, through.target[i], relationName), foreignColumn),
    );
  }

  return {
    correlation: correlationConditions.length > 1 ? and(...correlationConditions) : correlationConditions[0],
    junctionJoin: junctionJoinConditions.length > 1 ? and(...junctionJoinConditions) : junctionJoinConditions[0],
  };
};

/**
 * Builds one `[NOT] EXISTS (SELECT 1 FROM target alias WHERE …)` for a relation filter.
 * A `.through()` (many-to-many) relation adds an `INNER JOIN` on the aliased junction table
 * inside the subquery, correlated to the parent on the relation's source keys.
 *
 * `some` / the to-one shorthand match when a related row satisfies the inner filters, `none`
 * when none does, and `every` is expressed as "no related row fails the inner filters".
 * Because `every` negates the inner condition, a related row whose compared column is NULL
 * counts as matching (SQL three-valued logic) — the same caveat Prisma carries.
 */
const buildRelationExists = (
  parentTable: Table,
  relationName: string,
  relEntry: TableNamedRelations,
  innerFilters: Filters<Table> | undefined,
  mode: RelationMatchMode,
  ctx: RelationFilterContext,
): SQL | undefined => {
  const { targetTableName } = relEntry;
  const targetTable = ctx.tables[targetTableName];
  const relation = ((relEntry as any).relation ?? relEntry) as Relation<string>;

  if (!targetTable) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  ctx.aliases ??= { n: 0 };
  const aliases = ctx.aliases;
  const aliasedTarget = aliasedTable(targetTable, `dgql_rel_${aliases.n++}`);

  // A `.through()` relation reaches the target via a junction table: the subquery joins the
  // aliased junction to the aliased target and correlates the junction to the parent, so
  // `some` / `none` / `every` compile exactly like the direct case with a longer FROM clause.
  const throughTable = (relation as any).throughTable as Table | undefined;
  let fromClause: SQL;
  let joinCondition: SQL | undefined;
  if (throughTable) {
    const aliasedThrough = aliasedTable(throughTable, `dgql_rel_${aliases.n++}`);
    const { correlation, junctionJoin } = buildThroughJoinConditions(
      parentTable,
      relation,
      aliasedThrough,
      aliasedTarget,
      relationName,
    );
    fromClause = sql`${getTableAsAliasSQL(aliasedTarget)} inner join ${getTableAsAliasSQL(aliasedThrough)} on ${junctionJoin}`;
    joinCondition = correlation;
  } else {
    fromClause = getTableAsAliasSQL(aliasedTarget);
    joinCondition = buildRelationJoinCondition(parentTable, relation, aliasedTarget, relationName);
  }

  // A relation declared with its own `where` only ever exposes the rows it selects, so the
  // subquery has to honour it too — otherwise a filter could match a row the relation hides.
  const relationWhere = (relation as any).where
    ? relationsFilterToSQL((relation as any).isReversed ? parentTable : aliasedTarget, (relation as any).where)
    : undefined;

  const inner = innerFilters
    ? extractFilters(aliasedTarget, targetTableName, innerFilters, { ...ctx, tableKey: targetTableName, aliases })
    : undefined;

  if (mode === 'every') {
    // "every related row matches" with no inner condition is vacuously true.
    if (!inner) {
      return undefined;
    }

    return sql`not exists (select 1 from ${fromClause} where ${and(joinCondition, relationWhere, not(inner))})`;
  }

  const condition = and(joinCondition, relationWhere, inner);

  return mode === 'none'
    ? sql`not exists (select 1 from ${fromClause} where ${condition})`
    : sql`exists (select 1 from ${fromClause} where ${condition})`;
};

/**
 * Handles one relation key in a `where` argument. To-one relations take the target's filters
 * inline; to-many relations take any combination of `some` / `none` / `every`, ANDed together.
 */
const extractRelationFilter = (
  parentTable: Table,
  relationName: string,
  relEntry: TableNamedRelations,
  value: Record<string, any>,
  ctx: RelationFilterContext,
): SQL | undefined => {
  const relation = ((relEntry as any).relation ?? relEntry) as Relation<string>;

  if (is(relation, One)) {
    return buildRelationExists(parentTable, relationName, relEntry, value, 'some', ctx);
  }

  const relationMatchModes: readonly RelationMatchMode[] = ['some', 'none', 'every'];

  const variants: SQL[] = [];
  for (const [mode, inner] of Object.entries(value)) {
    if (inner === undefined || inner === null) {
      continue;
    }

    // Unknown keys inside the some/none/every wrapper must throw rather than be dropped —
    // a stitched schema can contribute foreign keys here too, and dropping them all would
    // silently turn the relation filter into no filter at all.
    if (!relationMatchModes.includes(mode as RelationMatchMode)) {
      throw new GraphQLError(`WHERE ${relationName}: Unknown relation filter key: ${mode}`);
    }

    const extracted = buildRelationExists(parentTable, relationName, relEntry, inner, mode as RelationMatchMode, ctx);
    if (extracted) {
      variants.push(extracted);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};

export const extractFilters = <TTable extends Table>(
  table: TTable,
  tableName: string,
  filters: Filters<TTable>,
  relationCtx?: RelationFilterContext,
): SQL | undefined => {
  // Boolean branches compose with sibling fields: siblings and the AND list are ANDed
  // together, NOT negates its whole branch, and the OR group is ANDed with the rest —
  // `{ a: …, OR: [{ b: … }, { c: … }] }` reads as `a AND (b OR c)`. Every branch is the
  // filter type itself, so the tree nests arbitrarily.
  const { OR, AND, NOT, ...fieldFilters } = filters;

  // `Omit`-ing the boolean keys off a generic `Filters<TTable>` leaves a type the checker
  // can no longer relate to `FiltersCore<TTable>`. Each key is dispatched on its own below
  // — as a column or as a relation — so the entries are typed for that dispatch instead.
  const entries = Object.entries(fieldFilters) as [string, FilterColumnOperatorsCore<any> | undefined][];

  const columns = getColumns(table);
  const relations = relationCtx?.relationMap[relationCtx.tableKey];

  const variants = [] as SQL[];
  for (const [fieldName, operators] of entries) {
    if (operators === null || operators === undefined) {
      continue;
    }

    const column = columns[fieldName];

    // A key that is neither a column nor a filterable relation must throw rather than be
    // dropped: when the generated schema is stitched/merged with another schema, same-named
    // inputs can contribute foreign keys that pass input validation, and a where that loses
    // all of its keys silently becomes an unbounded select/update/delete.
    if (!column && !(relations?.[fieldName] && relationCtx)) {
      throw new GraphQLError(`WHERE ${tableName}: Unknown filter key: ${fieldName}`);
    }

    const extracted = column
      ? extractFiltersColumn(column, fieldName, operators)
      : extractRelationFilter(table, fieldName, relations![fieldName]!, operators as any, relationCtx!);

    if (extracted) {
      variants.push(extracted);
    }
  }

  if (AND?.length) {
    for (const variant of AND) {
      const extracted = extractFilters(table, tableName, variant, relationCtx);
      if (extracted) {
        variants.push(extracted);
      }
    }
  }

  if (NOT) {
    const extracted = extractFilters(table, tableName, NOT, relationCtx);
    if (extracted) {
      variants.push(not(extracted));
    }
  }

  if (OR?.length) {
    const orVariants = [] as SQL[];
    for (const variant of OR) {
      const extracted = extractFilters(table, tableName, variant, relationCtx);
      if (extracted) {
        orVariants.push(extracted);
      }
    }

    if (orVariants.length) {
      variants.push(orVariants.length > 1 ? or(...orVariants)! : orVariants[0]!);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// Row-level scoping
// ─────────────────────────────────────────────────────────────────────────────
