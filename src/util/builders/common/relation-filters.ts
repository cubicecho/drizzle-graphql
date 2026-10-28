// Relation keys inside a `where`: the correlated EXISTS subquery each `some` / `none` / `every`
// compiles to, and `extractFilters`, which dispatches a whole filter object across columns,
// boolean groups and relations.

import type { Column, Relation, Table } from 'drizzle-orm';
import { aliasedTable, and, eq, getColumns, is, One, type SQL, sql } from 'drizzle-orm';
import type { BuildRegistries } from '../../build-registries.ts';
import type { FilterColumnOperatorsCore, Filters, TableNamedRelations } from '../types.ts';
import { drizzleError } from './errors.ts';
import { allOf, type CompiledFilter, compileBooleanBranches, extractFiltersColumn, isNotTrue } from './filters.ts';
import type { RowVisibility } from './policies.ts';
import {
  isRelationFilterReversed,
  relationColumns,
  relationOwnWhere,
  relationsFilterSQL,
  unwrapRelationColumn,
} from './relations.ts';
import type { UniqueKeyMap } from './unique-keys.ts';
import { extractUniqueKeyFilter } from './unique-keys.ts';

/**
 * Everything `extractFilters` needs to turn a relation key in a `where` argument into a
 * correlated subquery. Omitted by callers that don't generate relation filters, in which case
 * relation keys can't appear in the input to begin with.
 */
export interface RelationFilterContext {
  /** Every table in the schema, keyed by its schema key. */
  tables: Record<string, Table>;
  /** Relations keyed by table schema key, then relation name. */
  namedRelations: Record<string, Record<string, TableNamedRelations>>;
  /**
   * Schema key of the table being filtered. Not always the same as the `tableName` label
   * used in error messages (relation `where` callbacks pass the relation name there).
   */
  tableKey: string;
  /** Shared counter making every subquery alias unique within one extraction. */
  aliases?: { n: number };
  /**
   * The compound-unique-key `where` fields of each table, keyed by table schema key. Only
   * populated when `features.uniqueKeyFilters` generated them — a key field the build did not
   * generate is an unknown filter key like any other.
   */
  uniqueKeys?: Record<string, UniqueKeyMap>;
  /**
   * The row policies of the request being compiled. A relation filter (and an ordering through
   * a relation) reads the target table in a subquery, so it applies the target's `scope` and
   * `softDelete` here — with the mode the relation field itself would default to — or a filter
   * could match, and a sort could rank by, a row the relation hides. Absent for a scope's own
   * filter object, which is the server's predicate and is compiled unscoped.
   */
  visibility?: RowVisibility;
  /**
   * The build's registries. Request-time value conversion reads its scalar overrides — a filter
   * operand on a column an override scalar owns is passed through as that scalar produced it —
   * so a context without them converts every operand by the built-in rules.
   */
  registries?: BuildRegistries;
}

/**
 * The build-scoped half of {@link RelationFilterContext}. Created once per generated schema and
 * handed to every resolver, which adds the table it is filtering.
 */
export type RelationFilterBase = Pick<RelationFilterContext, 'tables' | 'namedRelations' | 'uniqueKeys' | 'registries'>;

/**
 * The narrowed contexts already handed out, keyed by the build-scoped base and then by
 * table. The base is created once per `buildSchema` and the result depends on nothing else,
 * so every call for one table produces the same value — a `WeakMap` on the base keeps them
 * for exactly as long as that build is reachable.
 */
const narrowedCtxCache = new WeakMap<RelationFilterBase, Map<string, RelationFilterContext>>();

/**
 * One alias counter per build, shared by every table's narrowed context. A statement can
 * combine subqueries compiled from different contexts — a relation filter on one table whose
 * target's scope is a filter object reaching through another relation, say — and nested
 * subqueries that drew the same alias from two separate counters would shadow each other.
 */
const aliasCounters = new WeakMap<RelationFilterBase, { n: number }>();

/**
 * Narrows the build-scoped relation filter context to the table a resolver is filtering.
 *
 * Cached rather than rebuilt: the base carries the build's whole `tables` and `namedRelations`,
 * and the spread copied both on every call — three per parent row in the lazy relation
 * resolver, one per parent row in the relation aggregate, and up to four per select, several
 * of them inside callbacks drizzle invokes lazily.
 *
 * The one field written after the fact is `aliases`, the counter that keeps subquery aliases
 * apart ({@link extractRelationFilter}). Sharing it is what makes the caching safe rather
 * than a hazard: the counter now spans the process instead of restarting per extraction, and
 * aliases only ever have to be unique *within* one statement, which a number that never
 * repeats gives more surely than one that restarts.
 */
export const relationFilterCtx = (
  base: RelationFilterBase | undefined,
  tableKey: string,
  visibility?: RowVisibility,
): RelationFilterContext | undefined => {
  if (!base) {
    return undefined;
  }

  let byTable = narrowedCtxCache.get(base);
  if (!byTable) {
    byTable = new Map();
    narrowedCtxCache.set(base, byTable);
  }

  let ctx = byTable.get(tableKey);
  if (!ctx) {
    let aliases = aliasCounters.get(base);
    if (!aliases) {
      aliases = { n: 0 };
      aliasCounters.set(base, aliases);
    }
    ctx = { ...base, tableKey, aliases };
    byTable.set(tableKey, ctx);
  }

  // The request's policies are per request, so they ride on a copy rather than the cached
  // context. The copy shares the cached alias counter.
  return visibility ? { ...ctx, visibility } : ctx;
};

/**
 * The row-policy predicate a subquery over a relation's target applies: the target's scope
 * and soft-delete condition, in the `deleted` mode the relation field defaults to — so a
 * relation filter or a relation ordering sees exactly the rows the relation field returns.
 */
export const relationTargetPolicy = (
  ctx: RelationFilterContext,
  relation: Relation<string>,
  targetTableName: string,
  aliasedTarget: Table,
): SQL | undefined => {
  const visibility = ctx.visibility;
  if (!visibility) {
    return undefined;
  }
  const mode = visibility.relationDefault(targetTableName, is(relation, One) && (relation as any).optional === false);
  return visibility.has(targetTableName, mode) ? visibility.on(targetTableName, aliasedTarget, mode) : undefined;
};

const TABLE_ORIGINAL_NAME = Symbol.for('drizzle:OriginalName');
const TABLE_SCHEMA = Symbol.for('drizzle:Schema');

/**
 * The `<schema>.<name> as <alias>` FROM-list entry for a table made with `aliasedTable`.
 *
 * Built here rather than with drizzle's `getTableAsAliasSQL`, whose return shape is internal
 * and changed between releases: rc.4 returns an `SQL`, rc.5 an array of chunks, which an `sql`
 * template renders as a parenthesised, comma-separated list (`("app", ., "t",  as , "a")`).
 * The alias proxy answers its original name and schema with the underlying table's — the same
 * symbols drizzle itself reads. The alias is the aliased table itself, which every release
 * renders as just its alias, rather than a bare identifier: a table chunk is how a statement
 * records the tables it reads, which drizzle's query cache invalidates by and MySQL's
 * self-referencing write check (`readsTable`) looks for.
 */
export const tableAsAliasSQL = (aliased: Table): SQL => {
  const schema: string | undefined = (aliased as any)[TABLE_SCHEMA];
  const name = sql.identifier((aliased as any)[TABLE_ORIGINAL_NAME]);
  return schema ? sql`${sql.identifier(schema)}.${name} as ${aliased}` : sql`${name} as ${aliased}`;
};

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
  const sourceColumns = relationColumns(relation, 'source');
  const targetColumns = relationColumns(relation, 'target');

  if (!sourceColumns?.length || sourceColumns.length !== targetColumns?.length) {
    throw drizzleError(`WHERE ${relationName}: Relation cannot be used as a filter`, {
      code: 'DRIZZLE_INVALID_FILTER',
    });
  }

  const parentColumns = Object.values(getColumns(parentTable));
  const targetColumnsByName = Object.values(getColumns(aliasedTarget));

  const conditions: SQL[] = [];
  for (let i = 0; i < sourceColumns.length; i++) {
    const localColumn = parentColumns.find((c) => c.name === sourceColumns[i]!.name);
    const foreignColumn = targetColumnsByName.find((c) => c.name === targetColumns[i]!.name);

    if (!localColumn || !foreignColumn) {
      throw drizzleError(`WHERE ${relationName}: Relation cannot be used as a filter`, {
        code: 'DRIZZLE_INVALID_FILTER',
      });
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

  const columnName: string | undefined = unwrapRelationColumn(junctionRef)?.name;
  const byName = columnName ? Object.values(throughColumns).find((c) => c.name === columnName) : undefined;
  if (!byName) {
    throw drizzleError(`WHERE ${relationName}: Relation cannot be used as a filter`, {
      code: 'DRIZZLE_INVALID_FILTER',
    });
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
  const sourceColumns = relationColumns(relation, 'source');
  const targetColumns = relationColumns(relation, 'target');
  const through = (relation as any).through as { source: any[]; target: any[] } | undefined;

  if (
    !sourceColumns?.length ||
    !targetColumns?.length ||
    through?.source.length !== sourceColumns.length ||
    through.target.length !== targetColumns.length
  ) {
    throw drizzleError(`WHERE ${relationName}: Relation cannot be used as a filter`, {
      code: 'DRIZZLE_INVALID_FILTER',
    });
  }

  const parentColumns = Object.values(getColumns(parentTable));
  const targetTableColumns = Object.values(getColumns(aliasedTarget));

  const correlationConditions: SQL[] = [];
  for (let i = 0; i < sourceColumns.length; i++) {
    const localColumn = parentColumns.find((c) => c.name === sourceColumns[i]!.name);
    if (!localColumn) {
      throw drizzleError(`WHERE ${relationName}: Relation cannot be used as a filter`, {
        code: 'DRIZZLE_INVALID_FILTER',
      });
    }
    correlationConditions.push(eq(localColumn, resolveJunctionColumn(aliasedThrough, through.source[i], relationName)));
  }

  const junctionJoinConditions: SQL[] = [];
  for (let i = 0; i < targetColumns.length; i++) {
    const foreignColumn = targetTableColumns.find((c) => c.name === targetColumns[i]!.name);
    if (!foreignColumn) {
      throw drizzleError(`WHERE ${relationName}: Relation cannot be used as a filter`, {
        code: 'DRIZZLE_INVALID_FILTER',
      });
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
 * when none does, and `every` is expressed as "no related row fails the inner filters". A row
 * fails unless the inner condition is TRUE, so one whose compared column is NULL fails too.
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
    throw drizzleError(`WHERE ${relationName}: Relation cannot be used as a filter`, {
      code: 'DRIZZLE_INVALID_FILTER',
    });
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
  let junctionPolicy: SQL | undefined;
  if (throughTable) {
    const aliasedThrough = aliasedTable(throughTable, `dgql_rel_${aliases.n++}`);
    // A junction with its own policies (a soft-deleted membership, a scoped link row) only
    // links the rows it keeps.
    const throughTableName = ctx.visibility
      ? Object.keys(ctx.tables).find((name) => ctx.tables[name] === throughTable)
      : undefined;
    if (throughTableName && ctx.visibility!.has(throughTableName)) {
      junctionPolicy = ctx.visibility!.on(throughTableName, aliasedThrough);
    }
    const { correlation, junctionJoin } = buildThroughJoinConditions(
      parentTable,
      relation,
      aliasedThrough,
      aliasedTarget,
      relationName,
    );
    fromClause = sql`${tableAsAliasSQL(aliasedTarget)} inner join ${tableAsAliasSQL(aliasedThrough)} on ${junctionJoin}`;
    joinCondition = correlation;
  } else {
    fromClause = tableAsAliasSQL(aliasedTarget);
    joinCondition = buildRelationJoinCondition(parentTable, relation, aliasedTarget, relationName);
  }

  // A relation declared with its own `where` only ever exposes the rows it selects, so the
  // subquery has to honour it too — otherwise a filter could match a row the relation hides.
  const relationWhere = relationsFilterSQL(
    isRelationFilterReversed(relation) ? parentTable : aliasedTarget,
    relationOwnWhere(relation),
  );

  // The rows the relation field would return: the target's scope and soft-delete condition,
  // and through a junction the junction's too, so a filter can neither match nor be blocked
  // by a row the caller cannot read.
  const policy = and(relationTargetPolicy(ctx, relation, targetTableName, aliasedTarget), junctionPolicy);

  const inner = innerFilters
    ? extractFilters(aliasedTarget, targetTableName, innerFilters, { ...ctx, tableKey: targetTableName, aliases })
    : undefined;

  if (mode === 'every') {
    // "every related row matches" with no inner condition is vacuously true.
    if (!inner) {
      return undefined;
    }

    return sql`not exists (select 1 from ${fromClause} where ${and(joinCondition, relationWhere, policy, isNotTrue(inner))})`;
  }

  const condition = and(joinCondition, relationWhere, policy, inner);

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
      throw drizzleError(`WHERE ${relationName}: Unknown relation filter key: ${mode}`, {
        code: 'DRIZZLE_INVALID_FILTER',
      });
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
): CompiledFilter => {
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
  const relations = relationCtx?.namedRelations[relationCtx.tableKey];

  const variants = [] as SQL[];
  for (const [fieldName, operators] of entries) {
    if (operators === null || operators === undefined) {
      continue;
    }

    const column = columns[fieldName];
    // Resolved in the order the fields were generated in: a column keeps its name, then a
    // relation, and a unique-key field only exists where neither claimed it.
    const uniqueKey = column ? undefined : relationCtx?.uniqueKeys?.[relationCtx.tableKey]?.[fieldName];

    // A key that is none of the three must throw rather than be dropped: when the generated
    // schema is stitched/merged with another schema, same-named inputs can contribute foreign
    // keys that pass input validation, and a where that loses all of its keys silently becomes
    // an unbounded select/update/delete.
    if (!column && !uniqueKey && !(relations?.[fieldName] && relationCtx)) {
      throw drizzleError(`WHERE ${tableName}: Unknown filter key: ${fieldName}`, { code: 'DRIZZLE_INVALID_FILTER' });
    }

    const extracted = column
      ? extractFiltersColumn(column, fieldName, operators, relationCtx?.registries?.scalarOverrides)
      : uniqueKey
        ? extractUniqueKeyFilter(
            table,
            tableName,
            fieldName,
            uniqueKey,
            operators as any,
            relationCtx?.registries?.scalarOverrides,
          )
        : extractRelationFilter(table, fieldName, relations![fieldName]!, operators as any, relationCtx!);

    if (extracted) {
      variants.push(extracted);
    }
  }

  compileBooleanBranches(variants, { AND, NOT, OR }, (branch) => extractFilters(table, tableName, branch, relationCtx));

  return allOf(variants);
};

// ─────────────────────────────────────────────────────────────────────────────
// Row-level scoping
// ─────────────────────────────────────────────────────────────────────────────
