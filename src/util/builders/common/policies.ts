// Row-level policy: `scope`, `softDelete` and `contextValues`, each resolved per table and
// bound into the shape the resolvers apply at request time.

import type { Column, Table } from 'drizzle-orm';
import { and, eq, extractExtendedColumnType, getColumns, is, isNotNull, isNull, ne, or, SQL } from 'drizzle-orm';
import { GraphQLEnumType } from 'graphql';
import { drizzleError } from './errors.ts';
import type { DefaultOrderByFor } from './limits.ts';
import type { RelationFilterBase } from './relation-filters.ts';
import { extractFilters, relationFilterCtx } from './relation-filters.ts';
import { sharedType, type TypeNameResolver } from './type-names.ts';
import type { WriteHookFor } from './write-hooks.ts';

/**
 * A table's row-level scope: the predicate every generated read, update and delete on that
 * table is narrowed by. See `BuildSchemaConfig.scope`.
 *
 * `table` is the table the predicate must be built against. On the relational-query path
 * drizzle hands its callbacks an *aliased* proxy (`d0`, `d1`, …), so a predicate built from
 * the imported schema table would reference a name that isn't in the query — always build
 * from the argument. Returning a filter object instead (the same shape as the field's
 * `where`) sidesteps aliasing entirely, and is the only form that can reach through a
 * relation — which is what ownership through a join table needs.
 */
type ScopeHook<TContext = any> = (context: TContext, table: any) => SQL | Record<string, any> | undefined | null;

/** Build-time lookup: the scope configured for a table, if any. */
export type ScopeFor = (tableName: string) => ScopeHook | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Soft delete
// ─────────────────────────────────────────────────────────────────────────────

/** What a read over a soft-deleting table does with rows that are marked deleted. */
export type DeletedMode = 'EXCLUDE' | 'INCLUDE' | 'ONLY';

/**
 * One table's soft-delete convention, resolved against the real column at build time.
 *
 * `marker` picks the shape of the predicate. When the config names a constant that means
 * deleted, the predicate compares against it (`isDeleted = true`); otherwise the column marks
 * a row deleted by holding a value at all (`deletedAt IS NOT NULL`), the common timestamp
 * form. A NOT NULL column has no "absent" state, so it must have a marker; a nullable one
 * takes the NULL-means-alive reading only when no marker was configured.
 */
export type SoftDeleteInfo = {
  /** Property name of the column on the drizzle table — also the key on an aliased proxy. */
  columnName: string;
  column: Column;
  nullable: boolean;
  /** Evaluated per delete, so a timestamp form stamps the moment of the delete. */
  writeDeleted: () => any;
  /** Written by the restore mutation. */
  writeRestored: any;
  /**
   * The constant that means "this row is deleted", when the config named one. Required on a
   * NOT NULL column; optional on a nullable one, which otherwise reads NULL as alive.
   */
  marker?: any;
  /**
   * Which reads hide marked rows by default — `'all'` (the table's own fields and every
   * relation pointing at it) or `'root'` (its own fields only). See
   * {@link relationDeletedDefault}.
   */
  scope: 'root' | 'all';
  /**
   * Whether the delete mutations take a `hard` argument that issues a real `DELETE`. Off
   * unless the table opts in, so the generated schema says which tables can be purged.
   */
  hardDelete: boolean;
};

/** Build-time lookup: the soft-delete convention of a table, if it declares one. */
export type SoftDeleteFor = (tableName: string) => SoftDeleteInfo | undefined;

/**
 * The enum behind the `deleted` argument on every read over a soft-deleting table. Built once
 * per name it resolves to — it carries no per-build state beyond that name, so every build
 * that names it the same way shares one instance.
 */
export const deletedFilterEnumType = (typeName: TypeNameResolver): GraphQLEnumType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'DeletedFilter' },
    (name) =>
      new GraphQLEnumType({
        name,
        description: 'Which rows a read over a soft-deleting table returns.',
        values: {
          EXCLUDE: { value: 'EXCLUDE', description: 'Only rows that are not marked deleted. The default.' },
          INCLUDE: { value: 'INCLUDE', description: 'Marked and unmarked rows alike.' },
          ONLY: { value: 'ONLY', description: 'Only rows that are marked deleted — a trash view.' },
        },
      }),
  );

/**
 * Resolves one table's `softDelete` declaration against the real column, at build time, so a
 * renamed column fails the build instead of quietly making every row visible again.
 */
export const resolveSoftDeleteInfo = (
  table: Table,
  tableName: string,
  declaration:
    | string
    | {
        column: string;
        deletedValue?: any;
        restoredValue?: any;
        scope?: 'root' | 'all';
        hardDelete?: boolean;
      },
): SoftDeleteInfo => {
  const config = typeof declaration === 'string' ? { column: declaration } : declaration;
  const columnName = config?.column;
  if (typeof columnName !== 'string' || !columnName) {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete.${tableName} must be a column name or an object with a 'column' property.`,
    );
  }
  const column = getColumns(table)[columnName];
  if (!column) {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete names '${tableName}.${columnName}', which is not a column of that table.`,
    );
  }
  const nullable = !column.notNull;
  // drizzle-orm v1 reports compound dataType strings ("object date", "number int32"), so the
  // shape of the column has to come from the extended type rather than a string compare.
  const { type: baseType, constraint } = extractExtendedColumnType(column);
  const hasDeleted = 'deletedValue' in (config as object) && config.deletedValue !== undefined;
  // The default depends on what the column can hold: a timestamp records when, a flag records
  // whether. Both are the shapes the convention actually takes in the wild.
  const writeDeleted: () => any = hasDeleted
    ? typeof config.deletedValue === 'function'
      ? (config.deletedValue as () => any)
      : () => config.deletedValue
    : constraint === 'date' && baseType === 'object'
      ? () => new Date()
      : baseType === 'string'
        ? () => new Date().toISOString()
        : baseType === 'number'
          ? () => Date.now()
          : baseType === 'bigint'
            ? () => BigInt(Date.now())
            : () => true;

  let marker: any;
  if (hasDeleted && typeof config.deletedValue !== 'function') {
    // A configured constant is what reads compare against, whether or not the column is
    // nullable: a nullable boolean defaulting to `false` (the shape a marker column added to
    // an existing table without a backfill takes) means deleted by holding `true`, not by
    // holding anything at all.
    marker = config.deletedValue;
  } else if (!nullable) {
    // A non-nullable column has no "absent" state, so the predicate has to compare against a
    // constant — which a function cannot supply, and which the boolean form supplies for free.
    if (!hasDeleted && baseType === 'boolean') {
      marker = true;
    } else {
      throw new Error(
        `Drizzle-GraphQL Error: config.softDelete.${tableName} marks a NOT NULL column ('${columnName}'), so 'deletedValue' must be a constant that means deleted — not a function, and not omitted for a non-boolean column.`,
      );
    }
  }

  const hasRestored = 'restoredValue' in (config as object);
  const writeRestored = hasRestored
    ? config.restoredValue
    : nullable
      ? null
      : baseType === 'boolean'
        ? false
        : undefined;
  if (!nullable && writeRestored === undefined) {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete.${tableName} marks a NOT NULL column ('${columnName}'), so 'restoredValue' must say what restoring writes back.`,
    );
  }

  const scope = config.scope ?? 'all';
  if (scope !== 'root' && scope !== 'all') {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete.${tableName}.scope must be 'root' or 'all', not ${JSON.stringify(scope)}.`,
    );
  }

  const hardDelete = config.hardDelete ?? false;
  if (typeof hardDelete !== 'boolean') {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete.${tableName}.hardDelete must be a boolean, not ${JSON.stringify(hardDelete)}.`,
    );
  }

  return { columnName, column, nullable, writeDeleted, writeRestored, marker, scope, hardDelete };
};

/**
 * The `deleted` mode a *relation* field reads its target with when the request does not pass
 * one. Root fields always default to `EXCLUDE`; a relation field is the case a soft delete
 * cannot answer for on its own, because the row it hides belongs to a different query than
 * the one that marked it.
 *
 * - `scope: 'root'` reads relations with `INCLUDE`: the row is retired, not erased, so the
 *   historical rows that reference it keep rendering it.
 * - `scope: 'all'` keeps hiding it — except through a *required* to-one relation, where a
 *   hidden row can only surface as "Cannot return null for non-nullable field" and take the
 *   whole parent down with it. There is no usable result to protect there, so the row is
 *   included rather than the parent lost.
 *
 * Returns `undefined` when the target declares no soft delete, so an unconfigured build
 * passes exactly the mode it did before.
 */
export const relationDeletedDefault = (
  softDelete: SoftDeleteFor | undefined,
  targetTableName: string,
  requiredToOne: boolean,
): DeletedMode | undefined => {
  const info = softDelete?.(targetTableName);
  if (!info) {
    return undefined;
  }
  return info.scope === 'root' || requiredToOne ? 'INCLUDE' : 'EXCLUDE';
};

/**
 * The predicate that selects the rows a `deleted` mode asks for: nothing for `INCLUDE`, the
 * marked rows for `ONLY`, the unmarked ones for `EXCLUDE`. Built against the table it is
 * handed, which on the relational path is drizzle's aliased proxy rather than the schema
 * table — the same rule a scope hook follows.
 */
export const softDeletePredicate = (info: SoftDeleteInfo, table: Table, mode: DeletedMode): SQL | undefined => {
  if (mode === 'INCLUDE') {
    return undefined;
  }
  const column = ((table as any)?.[info.columnName] ?? info.column) as Column;
  if (info.marker === undefined) {
    return mode === 'ONLY' ? isNotNull(column) : isNull(column);
  }
  if (!info.nullable) {
    return mode === 'ONLY' ? eq(column, info.marker) : ne(column, info.marker);
  }
  // A nullable column with a marker: NULL is neither the marker nor a match for `<>`, so the
  // exclude side has to name it explicitly or every un-backfilled row would drop out.
  return mode === 'ONLY' ? eq(column, info.marker) : or(ne(column, info.marker), isNull(column))!;
};

/**
 * The row policies of one request, bound to its context: the table's scope and its
 * soft-delete convention, which both narrow the same `where`. `has` answers "does this table
 * restrict anything at all", cheaply and without evaluating a hook; `on` compiles the
 * predicate against a given table.
 */
export type ScopeResolver = {
  has: (tableName: string, mode?: DeletedMode) => boolean;
  on: (tableName: string, table: Table, mode?: DeletedMode) => SQL | undefined;
  /**
   * The mode a relation field reading `tableName` defaults to — see
   * {@link relationDeletedDefault}. Carried here because the eager (`with:`) path has the
   * resolver but not the build-time soft-delete lookup.
   */
  relationDefault: (tableName: string, requiredToOne: boolean) => DeletedMode | undefined;
};

/**
 * Binds the configured row policies to one request's GraphQL context. Returns `undefined`
 * when neither a scope nor a soft-delete column is configured, so every call site skips the
 * machinery with a single check and an unconfigured build generates exactly the SQL it did
 * before.
 */
export const resolveScope = (
  policies: TablePolicies | undefined,
  context: any,
  filterCtx?: RelationFilterBase,
): ScopeResolver | undefined => {
  const scopes = policies?.scope;
  const softDelete = policies?.softDelete;
  if (!scopes && !softDelete) {
    return undefined;
  }
  return {
    has: (tableName, mode) => !!scopes?.(tableName) || (!!softDelete?.(tableName) && (mode ?? 'EXCLUDE') !== 'INCLUDE'),
    relationDefault: (tableName, requiredToOne) => relationDeletedDefault(softDelete, tableName, requiredToOne),
    on: (tableName, table, mode) => {
      // Order is fixed: the soft-delete predicate first, the scope after it, both ANDed. They
      // commute, but a fixed order keeps the generated SQL stable between requests.
      const marked = softDelete?.(tableName);
      const deleted = marked ? softDeletePredicate(marked, table, mode ?? 'EXCLUDE') : undefined;
      const hook = scopes?.(tableName);
      if (!hook) {
        return deleted;
      }
      const predicate = hook(context, table);
      if (predicate === undefined || predicate === null) {
        return deleted;
      }
      if (is(predicate, SQL)) {
        return and(deleted, predicate as SQL);
      }
      if (typeof predicate !== 'object') {
        throw drizzleError(
          `Drizzle-GraphQL Error: the scope for '${tableName}' returned a ${typeof predicate}. A scope returns a filter object, a Drizzle SQL expression, or undefined.`,
          { code: 'DRIZZLE_INVALID_SCOPE' },
        );
      }
      // A filter object is compiled the same way the field's own `where` is, against the
      // table it was handed — which is what keeps it correct under RQB aliasing.
      return and(deleted, extractFilters(table, tableName, predicate as any, relationFilterCtx(filterCtx, tableName)));
    },
  };
};

/**
 * `condition AND <the row policies of tableName>` — the single way a scope or a soft-delete
 * predicate is ever combined with a caller-supplied filter, so a `where` can only ever narrow
 * them, never widen them. `mode` is the read's `deleted` argument, and defaults to hiding
 * marked rows; a write passes nothing and so never touches one.
 */
export const withScope = (
  scope: ScopeResolver | undefined,
  tableName: string,
  table: Table,
  condition: SQL | undefined,
  mode?: DeletedMode,
): SQL | undefined => {
  const predicate = scope?.on(tableName, table, mode);
  return predicate ? and(condition, predicate) : condition;
};

// ─────────────────────────────────────────────────────────────────────────────
// Context-derived column values
// ─────────────────────────────────────────────────────────────────────────────

/** Produces one column's value from the GraphQL context. See `BuildSchemaConfig.contextValues`. */
export type ContextValueHook<TContext = any> = (context: TContext) => any;

/** Build-time lookup: the context-derived columns of a table, keyed by column property name. */
export type ContextValuesFor = (tableName: string) => Record<string, ContextValueHook> | undefined;

/**
 * The two request-time policies a generated resolver applies, passed to the dialect
 * generators as one value so a table's read scope and its server-owned columns travel
 * together. Both stay `undefined` when nothing is configured, and every call site checks
 * before doing any work — an unconfigured build generates exactly the SQL it did before.
 */
export type TablePolicies = {
  /** See `BuildSchemaConfig.scope`. */
  scope?: ScopeFor;
  /** See `BuildSchemaConfig.contextValues`. */
  contextValues?: ContextValuesFor;
  /** See `BuildSchemaConfig.softDelete`. */
  softDelete?: SoftDeleteFor;
  /** See `BuildSchemaConfig.onWrite`. */
  onWrite?: WriteHookFor;
  /** See `BuildSchemaConfig.defaults`. */
  defaultOrderBy?: DefaultOrderByFor;
};

/**
 * {@link TablePolicies} with the scope already bound to the build's relation context, which
 * is what a dialect generator is handed: `scope(context)` is all a resolver needs to compile
 * a predicate, and it stays `undefined` when nothing is scoped.
 */
export type ResolverPolicies = {
  scope?: (context: any) => ScopeResolver | undefined;
  contextValues?: ContextValuesFor;
  softDelete?: SoftDeleteFor;
  onWrite?: WriteHookFor;
  defaultOrderBy?: DefaultOrderByFor;
};

/** Binds a build's {@link TablePolicies} to its relation context, once, at schema-build time. */
export const bindPolicies = (
  policies: TablePolicies | undefined,
  filterCtx: RelationFilterBase | undefined,
): ResolverPolicies | undefined =>
  policies?.scope || policies?.contextValues || policies?.softDelete || policies?.onWrite || policies?.defaultOrderBy
    ? {
        scope:
          policies.scope || policies.softDelete
            ? (context: any) => resolveScope(policies, context, filterCtx)
            : undefined,
        contextValues: policies.contextValues,
        softDelete: policies.softDelete,
        onWrite: policies.onWrite,
        defaultOrderBy: policies.defaultOrderBy,
      }
    : undefined;

/**
 * Merges a table's context-derived values into one row's insert values. The hooks run per
 * row — a value may depend on the row's own contents through the closure the caller built —
 * and they overwrite whatever was there: the columns are not in the create input, so nothing
 * legitimate can be lost, but a stitched-in input could still carry the key and the server's
 * value has to win.
 */
export const applyContextValues = (
  values: Record<string, any>,
  hooks: Record<string, ContextValueHook> | undefined,
  context: any,
): Record<string, any> => {
  if (!hooks) {
    return values;
  }
  for (const [columnName, hook] of Object.entries(hooks)) {
    values[columnName] = hook(context);
  }
  return values;
};

/** {@link applyContextValues} over a batch — every row in an insert gets its own evaluation. */
export const applyContextValuesAll = (
  rows: Record<string, any>[],
  hooks: Record<string, ContextValueHook> | undefined,
  context: any,
): Record<string, any>[] => {
  if (!hooks) {
    return rows;
  }
  for (const row of rows) {
    applyContextValues(row, hooks, context);
  }
  return rows;
};

/**
 * Drops context-derived columns from an update's `set`. They are not in the update input
 * either, so this only matters when the key arrives some other way — and reassigning one is
 * exactly the ownership transfer the feature exists to prevent.
 */
export const stripContextValues = (
  values: Record<string, any>,
  hooks: Record<string, ContextValueHook> | undefined,
): Record<string, any> => {
  if (!hooks) {
    return values;
  }
  for (const columnName of Object.keys(hooks)) {
    delete values[columnName];
  }
  return values;
};
