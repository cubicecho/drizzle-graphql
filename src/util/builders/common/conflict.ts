// The `onConflict` argument: the input type it is generated from, and the plan a resolver
// compiles one into before handing it to the dialect's upsert.

import type { Column, Table } from 'drizzle-orm';
import { getColumns, is, type SQL, sql } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { GraphQLEnumType, GraphQLInputObjectType, GraphQLList, GraphQLNonNull } from 'graphql';
import { generateColumnEnum } from './column-enums.ts';
import { drizzleError } from './errors.ts';
import type { UniqueTarget } from './keys.ts';
import type { TypeCacheCtx } from './type-cache.ts';
import { sharedType, type TypeNameResolver } from './type-names.ts';

/** Shared by every table's `${typeName}OnConflict` input, so it is created once per name. */
export const conflictActionEnumType = (typeName: TypeNameResolver): GraphQLEnumType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'ConflictAction' },
    (name) =>
      new GraphQLEnumType({
        name,
        description: 'What an upsert does when a row with the same unique key already exists',
        values: {
          UPDATE: { value: 'UPDATE', description: 'Overwrite the conflicting row with the supplied values' },
          NOTHING: { value: 'NOTHING', description: 'Keep the existing row and insert nothing' },
        },
      }),
  );

/**
 * The `${typeName}OnConflict` input that types an upsert's `onConflict` argument.
 *
 * `target` and `where` only exist when the dialect can express them: MySQL's
 * `ON DUPLICATE KEY UPDATE` fires on any unique key and takes no predicate, so offering
 * either there would mean silently ignoring it.
 *
 * `update` never offers a `contextValues` column: the server owns it, and the conflict
 * branch is an update, which must not hand the row to another owner.
 *
 * Returns `undefined` when the table has nothing to conflict on (`withTarget` dialects
 * only) — the caller then generates no upsert mutations for that table at all, rather than
 * an operation whose every call is a database error.
 */
export const generateOnConflictInput = (params: {
  table: Table;
  tableName: string;
  typeName: string;
  uniqueSets: UniqueTarget[];
  tableFilters: GraphQLInputObjectType;
  withTarget: boolean;
  cacheCtx: TypeCacheCtx;
}): GraphQLInputObjectType | undefined => {
  const { table, tableName, typeName, uniqueSets, tableFilters, withTarget, cacheCtx } = params;
  const resolveName = cacheCtx.typeName;
  const serverOwned = Object.keys(cacheCtx.contextValuesOf?.(tableName) ?? {}).sort();

  const updateEnum = generateColumnEnum(
    table,
    resolveName({
      kind: 'columnEnum',
      defaultName: `${typeName}UpdateColumn`,
      table: tableName,
      operation: 'conflictUpdate',
    }),
    `Columns of ${typeName} that an upsert can overwrite`,
    (_column, columnName) => !serverOwned.includes(columnName),
    serverOwned.join(','),
  );
  if (!updateEnum) {
    return undefined;
  }

  const fields: Record<string, any> = {
    action: {
      type: conflictActionEnumType(resolveName),
      defaultValue: 'UPDATE',
      description: 'Whether a conflicting row is overwritten or left alone. Defaults to UPDATE.',
    },
    update: {
      type: new GraphQLList(new GraphQLNonNull(updateEnum)),
      description: `Columns to overwrite on conflict. Defaults to every column the request supplied, minus the ${
        withTarget ? 'conflict target' : 'primary key'
      }. Columns the request did not supply cannot be listed here — there would be no value to write.`,
    },
  };

  if (withTarget) {
    const uniqueColumns = new Set(uniqueSets.flatMap((set) => set.columns));
    const targetEnum = generateColumnEnum(
      table,
      resolveName({
        kind: 'columnEnum',
        defaultName: `${typeName}ConflictTarget`,
        table: tableName,
        operation: 'conflictTarget',
      }),
      `Columns of ${typeName} that carry a unique constraint, and so can be conflicted on`,
      (_column, columnName) => uniqueColumns.has(columnName),
    );
    if (!targetEnum) {
      return undefined;
    }

    fields['target'] = {
      type: new GraphQLList(new GraphQLNonNull(targetEnum)),
      description:
        'The unique column set a conflict is detected on. Must match one of the table’s unique constraints exactly. Defaults to the primary key.',
    };
    fields['where'] = {
      type: tableFilters,
      description: 'Only overwrite conflicting rows that match this filter. Others are left alone.',
    };
  }

  return new GraphQLInputObjectType({
    name: resolveName({ kind: 'onConflict', defaultName: `${typeName}OnConflict`, table: tableName }),
    description: `Conflict handling for an upsert of ${typeName}`,
    fields,
  });
};

/** The `onConflict` argument as it arrives from GraphQL. */
export type OnConflictArg = {
  action?: 'UPDATE' | 'NOTHING';
  target?: string[];
  update?: string[];
  where?: any;
};

/** What a dialect needs to turn an insert into an upsert. */
export type ConflictPlan = {
  action: 'UPDATE' | 'NOTHING';
  /** Columns to conflict on, or `undefined` on dialects that take no conflict target. */
  target: Column[] | undefined;
  /**
   * The predicate of the partial unique index `target` names. The statement has to repeat
   * it (`ON CONFLICT (…) WHERE …`) for the database to match that index.
   */
  targetWhere: SQL | undefined;
  /** `column -> value to write`, in Drizzle's `set` shape. Empty when the action is NOTHING. */
  set: Record<string, SQL>;
  setWhere: SQL | undefined;
};

/** One statement of an upsert: the rows it inserts, and how it resolves their conflicts. */
export type ConflictBatch = { values: Record<string, any>[]; plan: ConflictPlan };

/**
 * Turns the request's `onConflict` argument and the rows it is inserting into the
 * statements a dialect should run — one per run of consecutive rows that write the same
 * columns on conflict.
 *
 * The split is what keeps a partial row partial. A multi-row insert fills a key one row
 * left out with DEFAULT, and `excluded.<column>` would carry that default onto the existing
 * row, so rows that supply different columns cannot share a `SET` list. Splitting into
 * *consecutive* runs, rather than grouping, keeps the rows a caller gets back in the order
 * it sent them. A batch whose rows agree — the usual case — is still one statement.
 *
 * `excludedRef` names the row that failed to insert in the dialect's own terms
 * (`excluded.col` on PostgreSQL and SQLite, `values(col)` on MySQL), which is what makes a
 * batch upsert update each row with its own values instead of the last row's.
 *
 * Never written on conflict, even when supplied: the conflict target (it already matches);
 * the primary key on a dialect with no target (MySQL's conflict can be on another unique
 * key, and copying a generated id over the existing row's would move it); and `serverOwned`
 * — the `contextValues` columns, which an update never reassigns.
 *
 * An UPDATE with nothing left to write degrades to NOTHING: `DO UPDATE SET` with an empty
 * body is not valid SQL, and doing nothing is what the request asked for anyway.
 */
export const resolveConflictPlan = (params: {
  table: Table;
  values: Record<string, any>[];
  onConflict: OnConflictArg | undefined;
  pkNames: readonly string[];
  uniqueSets: UniqueTarget[];
  excludedRef: (columnName: string) => SQL;
  withTarget: boolean;
  /** The table's `contextValues` columns. */
  serverOwned?: readonly string[];
  buildWhere?: (where: any) => SQL | undefined;
}): ConflictBatch[] => {
  const { table, values, onConflict, pkNames, uniqueSets, excludedRef, withTarget, buildWhere } = params;
  const columns = getColumns(table) as Record<string, Column>;
  const serverOwned = new Set(params.serverOwned ?? []);

  let target: Column[] | undefined;
  let targetWhere: SQL | undefined;
  if (withTarget) {
    const targetNames = onConflict?.target?.length ? onConflict.target : [...pkNames];
    if (!targetNames.length) {
      throw drizzleError(
        'Unable to upsert: no conflict target was given and this table has no primary key. Pass onConflict.target.',
        { code: 'DRIZZLE_INVALID_ON_CONFLICT' },
      );
    }
    // A target that is not itself a unique constraint is a database error, and a confusing
    // one ("there is no unique or exclusion constraint matching the ON CONFLICT
    // specification"), so reject it here where we can say which sets are valid.
    const requested = [...targetNames].sort().join(',');
    const matched = uniqueSets.find((set) => [...set.columns].sort().join(',') === requested);
    if (!matched) {
      throw drizzleError(
        `Unable to upsert: [${targetNames.join(', ')}] is not a unique constraint on this table. Valid conflict targets: ${uniqueSets
          .map((set) => `[${set.columns.join(', ')}]`)
          .join(', ')}.`,
        { code: 'DRIZZLE_INVALID_ON_CONFLICT' },
      );
    }
    target = targetNames.map((name) => columns[name]!);
    targetWhere = matched.where;
  }

  const nothing: ConflictPlan = { action: 'NOTHING', target, targetWhere, set: {}, setWhere: undefined };
  if ((onConflict?.action ?? 'UPDATE') === 'NOTHING') {
    return [{ values, plan: nothing }];
  }

  // Only columns the request actually supplied have a value to copy over; anything else
  // would write the column's default (usually null) onto the row that already exists.
  const supplied = new Set(values.flatMap((row) => Object.keys(row)));
  const neverWritten = new Set(withTarget && onConflict?.target?.length ? onConflict.target : pkNames);

  let candidates: string[];
  if (onConflict?.update?.length) {
    const owned = onConflict.update.filter((name) => serverOwned.has(name));
    if (owned.length) {
      throw drizzleError(
        `Unable to upsert: onConflict.update lists ${owned.join(', ')}, which the server sets and an update never overwrites.`,
        { code: 'DRIZZLE_INVALID_ON_CONFLICT' },
      );
    }
    const unsupplied = onConflict.update.filter((name) => !supplied.has(name));
    if (unsupplied.length) {
      throw drizzleError(
        `Unable to upsert: onConflict.update lists ${unsupplied.join(', ')}, which the values do not supply.`,
        { code: 'DRIZZLE_INVALID_ON_CONFLICT' },
      );
    }
    candidates = onConflict.update;
  } else {
    candidates = [...supplied].filter((name) => !neverWritten.has(name) && !serverOwned.has(name));
  }

  const setWhere = onConflict?.where && buildWhere ? buildWhere(onConflict.where) : undefined;
  const planFor = (updateNames: string[]): ConflictPlan =>
    updateNames.length
      ? {
          action: 'UPDATE',
          target,
          targetWhere,
          set: Object.fromEntries(updateNames.map((name) => [name, excludedRef(columns[name]!.name)])),
          setWhere,
        }
      : nothing;

  const batches: (ConflictBatch & { key: string })[] = [];
  for (const row of values) {
    const updateNames = candidates.filter((name) => name in row);
    const key = updateNames.join(',');
    const last = batches[batches.length - 1];
    if (last?.key === key) {
      last.values.push(row);
    } else {
      batches.push({ key, values: [row], plan: planFor(updateNames) });
    }
  }
  return batches.map(({ values: rows, plan }) => ({ values: rows, plan }));
};

/**
 * Adds a {@link ConflictPlan}'s clause to a PostgreSQL or SQLite insert.
 *
 * SQLite needs two things drizzle's builder does not give it when the target is a partial
 * unique index:
 *
 * - The index predicate written literally. SQLite matches a conflict target to an index by
 *   comparing the predicates as written, and a bound `?` never equals `'active'`, so a
 *   predicate that compares to a value would never find its index. Its params are inlined.
 * - A `DO NOTHING` it can parse. Drizzle writes the predicate after `do nothing`, which is a
 *   syntax error, so the action is spelled as an update that matches no row instead:
 *   `ON CONFLICT (…) WHERE … DO UPDATE SET col = col WHERE 0 = 1`. A row that is not updated is
 *   not returned, which is what `DO NOTHING` does too.
 */
export const applyConflictPlan = (query: any, table: Table, plan: ConflictPlan, setWhere: SQL | undefined): any => {
  const sqlite = is(table, SQLiteTable);
  const targetWhere = sqlite && plan.targetWhere ? sql`${plan.targetWhere}`.inlineParams() : plan.targetWhere;
  if (plan.action === 'UPDATE') {
    return query.onConflictDoUpdate({ target: plan.target!, targetWhere, set: plan.set, setWhere });
  }
  if (!plan.target) {
    return query.onConflictDoNothing();
  }
  if (sqlite && targetWhere) {
    const [key] = Object.entries(getColumns(table)).find(([, column]) => column === plan.target![0])!;
    return query.onConflictDoUpdate({
      target: plan.target,
      targetWhere,
      set: { [key]: sql`${plan.target[0]}` },
      setWhere: sql`0 = 1`,
    });
  }
  return query.onConflictDoNothing({ target: plan.target, where: targetWhere });
};

/** `excluded.<column>` — PostgreSQL and SQLite name the rejected row this way. */
export const excludedColumnRef = (columnName: string): SQL => sql`excluded.${sql.identifier(columnName)}`;

/** `values(<column>)` — MySQL's equivalent inside ON DUPLICATE KEY UPDATE. */
export const mysqlValuesColumnRef = (columnName: string): SQL => sql`values(${sql.identifier(columnName)})`;
