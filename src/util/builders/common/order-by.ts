// Compiling an `orderBy` argument into ORDER BY expressions — including ordering by a to-one
// relation's columns, which compiles to a correlated scalar subquery.

import type { Column, Relation, Table } from 'drizzle-orm';
import {
  aliasedTable,
  and,
  asc,
  desc,
  getColumns,
  getTableAsAliasSQL,
  is,
  One,
  relationsFilterToSQL,
  type SQL,
  sql,
} from 'drizzle-orm';
import { remapFromGraphQLCore } from '../../data-mappers/index.ts';
import type { OrderByArgs, TableNamedRelations } from '../types.ts';
import { drizzleError } from './errors.ts';
import type { RelationFilterContext } from './relation-filters.ts';
import { buildRelationJoinCondition } from './relation-filters.ts';
import { isFilterableRelation } from './relations.ts';

/** How NULLs are placed relative to non-NULL values in an ordered column. */
export type OrderNullsOption = 'first' | 'last';

/**
 * Column name / direction / nulls triples from an `orderBy` argument, highest priority
 * first. Split out of `extractOrderBy` so the same ordering can be rebuilt against a
 * subquery's fields, where there is no `Table` to read columns from. Because there is no
 * table, ordering through a relation cannot be compiled here — a relation-shaped entry
 * (an object without a `direction`) is rejected with a clear error instead of being
 * silently dropped.
 */
export const orderByEntries = (
  orderArgs: Record<string, any>,
): [string, 'asc' | 'desc', OrderNullsOption | undefined][] =>
  Object.entries(orderArgs)
    // Filtered before the sort: an unset key contributes no entry, so sorting it is work
    // thrown away — and `sort` is stable, so dropping first leaves the same relative order
    // among equal priorities.
    .filter(([, config]) => config)
    .sort((a, b) => (b[1]?.priority ?? 0) - (a[1]?.priority ?? 0))
    .map(([column, config]) => {
      if (typeof config === 'object' && config.direction === undefined) {
        throw drizzleError(`ORDER BY ${column}: ordering through a relation is not supported in this query`, {
          code: 'DRIZZLE_INVALID_ORDER_BY',
        });
      }
      // Same reason as above: the sort key is not a value of the row, so it cannot be
      // rebuilt against a subquery's fields or encoded into a cursor.
      if (config.matchFilterOrder) {
        throw drizzleError(`ORDER BY ${column}: 'matchFilterOrder' is not supported in this query`, {
          code: 'DRIZZLE_INVALID_ORDER_BY',
        });
      }
      return [column, config.direction, config.nulls ?? undefined];
    });

/**
 * The ORDER BY expression(s) for one ordered value. Without a `nulls` option this is the
 * plain `asc`/`desc` of the expression. With one:
 * - PostgreSQL and SQLite (3.30+) support `NULLS FIRST` / `NULLS LAST` natively, so the
 *   clause is emitted as-is.
 * - MySQL has no such clause, so it is emulated with an extra `<expr> IS NULL` sort key
 *   ahead of the expression itself (`IS NULL DESC` puts nulls first, `ASC` puts them
 *   last). The same GraphQL surface is kept on all three dialects.
 *
 * `dialectColumn` is the real table column the expression derives from — used only to
 * detect the dialect (its `columnType` is prefixed `Pg` / `MySql` / `SQLite`), so `expr`
 * may be the column itself, a subquery field, or a correlated subquery.
 */
export const orderExpressions = (
  expr: Column | SQL | SQL.Aliased | any,
  direction: 'asc' | 'desc',
  nulls: OrderNullsOption | undefined,
  dialectColumn: Column,
): SQL[] => {
  const directed = direction === 'asc' ? asc(expr) : desc(expr);

  if (!nulls) {
    return [directed];
  }

  const isMySql = (((dialectColumn as any).columnType as string) ?? '').startsWith('MySql');
  if (isMySql) {
    const nullsKey = nulls === 'first' ? desc(sql`(${expr} is null)`) : asc(sql`(${expr} is null)`);
    return [nullsKey, directed];
  }

  return [nulls === 'first' ? sql`${directed} nulls first` : sql`${directed} nulls last`];
};

/**
 * One ordering term, flattened out of a (possibly relation-nested) `orderBy` argument.
 * `expression` is what the ORDER BY sorts on — the column itself, or a correlated
 * subquery reaching it through one or more to-one relations. `column` is the leaf table
 * column, kept for dialect detection.
 */
interface FlatOrderEntry {
  expression: Column | SQL;
  column: Column;
  direction: 'asc' | 'desc';
  nulls: OrderNullsOption | undefined;
  priority: number;
}

/**
 * The chain of aliased to-one hops a relation-ordered column is reached through. Rendered
 * as a single correlated scalar subquery: every hop's target sits in the FROM list and
 * its join condition (plus the relation's own `where`, when it declares one) in the WHERE.
 */
interface RelationOrderChain {
  fromParts: SQL[];
  conditions: SQL[];
  /** The aliased target of the last hop — the table the next hop or leaf column resolves from. */
  table: Table;
}

/** Extends the chain (or starts one from `parentTable`) with one to-one hop. */
const extendRelationOrderChain = (
  parentTable: Table,
  relationName: string,
  relEntry: TableNamedRelations,
  ctx: RelationFilterContext,
  chain: RelationOrderChain | undefined,
): RelationOrderChain => {
  const targetTable = ctx.tables[relEntry.targetTableName];
  const relation = ((relEntry as any).relation ?? relEntry) as Relation<string>;

  if (!targetTable || !is(relation, One) || !isFilterableRelation(relation)) {
    throw drizzleError(`ORDER BY ${relationName}: Relation cannot be used for ordering`, {
      code: 'DRIZZLE_INVALID_ORDER_BY',
    });
  }

  ctx.aliases ??= { n: 0 };
  const aliasedTarget = aliasedTable(targetTable, `dgql_ord_${ctx.aliases.n++}`);

  const joinCondition = buildRelationJoinCondition(parentTable, relation, aliasedTarget, relationName);
  // A relation declared with its own `where` only ever exposes the rows it selects, so the
  // ordering subquery has to honour it too — mirroring the relation-filter subqueries.
  const relationWhere = (relation as any).where
    ? relationsFilterToSQL((relation as any).isReversed ? parentTable : aliasedTarget, (relation as any).where)
    : undefined;

  return {
    fromParts: [...(chain?.fromParts ?? []), getTableAsAliasSQL(aliasedTarget)],
    conditions: [
      ...(chain?.conditions ?? []),
      ...(joinCondition ? [joinCondition] : []),
      ...(relationWhere ? [relationWhere] : []),
    ],
    table: aliasedTarget,
  };
};

/**
 * The sort key behind `matchFilterOrder`: the column's position in the `inArray` list that
 * the same request's `where` gives it, as a `CASE` ladder over that list.
 *
 * A ladder rather than a dialect array function (`array_position` on Postgres, `FIELD()` on
 * MySQL, neither on SQLite) because it is the one form all three share, and because every
 * list value stays a bound parameter. The branch indices are library-generated integers, so
 * they are written into the SQL text — a bound parameter there would leave Postgres unable
 * to infer the CASE result type. Values outside the list sort after every listed one.
 */
const filterOrderExpression = (column: Column, columnName: string, whereArgs: Record<string, any> | undefined): SQL => {
  const values = whereArgs?.[columnName]?.inArray as unknown;
  if (!Array.isArray(values)) {
    throw drizzleError(
      `ORDER BY ${columnName}: 'matchFilterOrder' needs an 'inArray' filter on the same column in this query's 'where'`,
      { code: 'DRIZZLE_INVALID_ORDER_BY' },
    );
  }
  if (!values.length) {
    // An empty `inArray` matches no rows at all, so every row would sort the same anyway;
    // a constant keeps the expression valid without a ladder that has no branches.
    return sql`0`;
  }

  const branches = values.map(
    (value, index) =>
      sql`when ${column} = ${remapFromGraphQLCore(value, column, columnName)} then ${sql.raw(String(index))}`,
  );
  return sql`case ${sql.join(branches, sql` `)} else ${sql.raw(String(values.length))} end`;
};

/**
 * Flattens one level of an `orderBy` argument into `out`. A column key becomes an entry
 * directly (wrapped in a correlated subquery when reached through a relation chain); a
 * to-one relation key recurses with the chain extended by that hop. Priorities live in one
 * global space, so a relation's column can interleave with the parent's own columns.
 */
const collectOrderEntries = (
  table: Table,
  tableKey: string,
  orderArgs: Record<string, any>,
  ctx: RelationFilterContext | undefined,
  chain: RelationOrderChain | undefined,
  out: FlatOrderEntry[],
  whereArgs: Record<string, any> | undefined,
): void => {
  const columns = getColumns(table);
  const relations = ctx?.relationMap[tableKey];

  for (const [key, config] of Object.entries(orderArgs)) {
    if (config === null || config === undefined) {
      continue;
    }

    const column = columns[key];
    if (column) {
      if (config.matchFilterOrder && chain) {
        throw drizzleError(`ORDER BY ${key}: 'matchFilterOrder' is not supported through a relation`, {
          code: 'DRIZZLE_INVALID_ORDER_BY',
        });
      }
      out.push({
        expression: config.matchFilterOrder
          ? filterOrderExpression(column, key, whereArgs)
          : chain
            ? sql`(select ${column} from ${sql.join(chain.fromParts, sql`, `)} where ${and(...chain.conditions)})`
            : column,
        column,
        direction: config.direction,
        nulls: config.nulls ?? undefined,
        priority: config.priority ?? 0,
      });
      continue;
    }

    const relEntry = relations?.[key];
    if (!relEntry || !ctx) {
      throw drizzleError(`ORDER BY ${key}: Unknown column or relation`, { code: 'DRIZZLE_INVALID_ORDER_BY' });
    }

    const nextChain = extendRelationOrderChain(chain?.table ?? table, key, relEntry, ctx, chain);
    collectOrderEntries(nextChain.table, relEntry.targetTableName, config, ctx, nextChain, out, undefined);
  }
};

/**
 * Compiles an `orderBy` argument into ORDER BY expressions, highest priority first.
 *
 * A key naming one of the table's columns orders by that column. A key naming a to-one
 * relation takes the target table's own OrderBy input and orders by the related row's
 * column(s), compiled as a correlated scalar subquery — reusing the aliased-join machinery
 * the relation filters are built on — so it works identically on all three dialects and
 * inside the relational query builder's aliased CTEs. Priorities share one global space
 * across relation boundaries. Each entry may also carry `nulls: first | last`
 * (see {@link orderExpressions} for how MySQL emulates it).
 *
 * An entry may instead set `matchFilterOrder`, which sorts by the column's position in the
 * `inArray` list the same request's `where` gives it — `whereArgs` is that `where`.
 *
 * `ctx` supplies the tables and relation map that relation ordering needs; callers whose
 * inputs cannot contain relation keys may omit it.
 */
export const extractOrderBy = <TTable extends Table, TArgs extends OrderByArgs<any> = OrderByArgs<TTable>>(
  table: TTable,
  orderArgs: TArgs,
  ctx?: RelationFilterContext,
  whereArgs?: Record<string, any>,
): SQL[] => {
  const entries: FlatOrderEntry[] = [];
  collectOrderEntries(table, ctx?.tableKey ?? '', orderArgs, ctx, undefined, entries, whereArgs);

  return entries
    .sort((a, b) => b.priority - a.priority)
    .flatMap((entry) => orderExpressions(entry.expression, entry.direction, entry.nulls, entry.column));
};
