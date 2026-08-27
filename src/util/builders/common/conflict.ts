// The `onConflict` argument: the input type it is generated from, and the plan a resolver
// compiles one into before handing it to the dialect's upsert.

import type { Column, Table } from 'drizzle-orm';
import { getColumns, type SQL, sql } from 'drizzle-orm';
import { GraphQLEnumType, GraphQLError, GraphQLInputObjectType, GraphQLList, GraphQLNonNull } from 'graphql';
import { generateColumnEnum } from './column-enums.ts';

/** Shared by every table's `${typeName}OnConflict` input, so it is created once. */
export const conflictActionEnum = new GraphQLEnumType({
  name: 'ConflictAction',
  description: 'What an upsert does when a row with the same unique key already exists',
  values: {
    UPDATE: { value: 'UPDATE', description: 'Overwrite the conflicting row with the supplied values' },
    NOTHING: { value: 'NOTHING', description: 'Keep the existing row and insert nothing' },
  },
});

/**
 * The `${typeName}OnConflict` input that types an upsert's `onConflict` argument.
 *
 * `target` and `where` only exist when the dialect can express them: MySQL's
 * `ON DUPLICATE KEY UPDATE` fires on any unique key and takes no predicate, so offering
 * either there would mean silently ignoring it.
 *
 * Returns `undefined` when the table has nothing to conflict on (`withTarget` dialects
 * only) — the caller then generates no upsert mutations for that table at all, rather than
 * an operation whose every call is a database error.
 */
export const generateOnConflictInput = (params: {
  table: Table;
  typeName: string;
  uniqueSets: string[][];
  tableFilters: GraphQLInputObjectType;
  withTarget: boolean;
}): GraphQLInputObjectType | undefined => {
  const { table, typeName, uniqueSets, tableFilters, withTarget } = params;

  const updateEnum = generateColumnEnum(
    table,
    `${typeName}UpdateColumn`,
    `Columns of ${typeName} that an upsert can overwrite`,
  );
  if (!updateEnum) {
    return undefined;
  }

  const fields: Record<string, any> = {
    action: {
      type: conflictActionEnum,
      defaultValue: 'UPDATE',
      description: 'Whether a conflicting row is overwritten or left alone. Defaults to UPDATE.',
    },
    update: {
      type: new GraphQLList(new GraphQLNonNull(updateEnum)),
      description:
        'Columns to overwrite on conflict. Defaults to every column the request supplied, minus the conflict target. Columns the request did not supply cannot be listed here — there would be no value to write.',
    },
  };

  if (withTarget) {
    const uniqueColumns = new Set(uniqueSets.flat());
    const targetEnum = generateColumnEnum(
      table,
      `${typeName}ConflictTarget`,
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
    name: `${typeName}OnConflict`,
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
  /** `column -> value to write`, in Drizzle's `set` shape. Empty when the action is NOTHING. */
  set: Record<string, SQL>;
  setWhere: SQL | undefined;
};

/**
 * Turns the request's `onConflict` argument and the rows it is inserting into the clause a
 * dialect should attach.
 *
 * `excludedRef` names the row that failed to insert in the dialect's own terms
 * (`excluded.col` on PostgreSQL and SQLite, `values(col)` on MySQL), which is what makes a
 * batch upsert update each row with its own values instead of the last row's.
 *
 * An UPDATE with nothing left to write degrades to NOTHING: `DO UPDATE SET` with an empty
 * body is not valid SQL, and doing nothing is what the request asked for anyway.
 */
export const resolveConflictPlan = (params: {
  table: Table;
  values: Record<string, any>[];
  onConflict: OnConflictArg | undefined;
  pkNames: readonly string[];
  uniqueSets: string[][];
  excludedRef: (columnName: string) => SQL;
  withTarget: boolean;
  buildWhere?: (where: any) => SQL | undefined;
}): ConflictPlan => {
  const { table, values, onConflict, pkNames, uniqueSets, excludedRef, withTarget, buildWhere } = params;
  const columns = getColumns(table) as Record<string, Column>;

  let target: Column[] | undefined;
  if (withTarget) {
    const targetNames = onConflict?.target?.length ? onConflict.target : [...pkNames];
    if (!targetNames.length) {
      throw new GraphQLError(
        'Unable to upsert: no conflict target was given and this table has no primary key. Pass onConflict.target.',
      );
    }
    // A target that is not itself a unique constraint is a database error, and a confusing
    // one ("there is no unique or exclusion constraint matching the ON CONFLICT
    // specification"), so reject it here where we can say which sets are valid.
    const requested = [...targetNames].sort().join(',');
    if (!uniqueSets.some((set) => [...set].sort().join(',') === requested)) {
      throw new GraphQLError(
        `Unable to upsert: [${targetNames.join(', ')}] is not a unique constraint on this table. Valid conflict targets: ${uniqueSets
          .map((set) => `[${set.join(', ')}]`)
          .join(', ')}.`,
      );
    }
    target = targetNames.map((name) => columns[name]!);
  }

  if ((onConflict?.action ?? 'UPDATE') === 'NOTHING') {
    return { action: 'NOTHING', target, set: {}, setWhere: undefined };
  }

  // Only columns the request actually supplied have a value to copy over; anything else
  // would write the column's default (usually null) onto the row that already exists.
  const supplied = new Set(values.flatMap((row) => Object.keys(row)));
  const targetNames = new Set(withTarget ? (onConflict?.target?.length ? onConflict.target : pkNames) : []);

  let updateNames: string[];
  if (onConflict?.update?.length) {
    const unsupplied = onConflict.update.filter((name) => !supplied.has(name));
    if (unsupplied.length) {
      throw new GraphQLError(
        `Unable to upsert: onConflict.update lists ${unsupplied.join(', ')}, which the values do not supply.`,
      );
    }
    updateNames = onConflict.update;
  } else {
    updateNames = [...supplied].filter((name) => !targetNames.has(name));
  }

  if (!updateNames.length) {
    return { action: 'NOTHING', target, set: {}, setWhere: undefined };
  }

  const set = Object.fromEntries(updateNames.map((name) => [name, excludedRef(columns[name]!.name)]));
  const setWhere = onConflict?.where && buildWhere ? buildWhere(onConflict.where) : undefined;

  return { action: 'UPDATE', target, set, setWhere };
};

/** `excluded.<column>` — PostgreSQL and SQLite name the rejected row this way. */
export const excludedColumnRef = (columnName: string): SQL => sql`excluded.${sql.identifier(columnName)}`;

/** `values(<column>)` — MySQL's equivalent inside ON DUPLICATE KEY UPDATE. */
export const mysqlValuesColumnRef = (columnName: string): SQL => sql`values(${sql.identifier(columnName)})`;
