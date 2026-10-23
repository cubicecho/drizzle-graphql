// The `limits`, `defaults` and `complexity` configs resolved per table, plus the estimator
// functions the generated fields publish on `extensions.complexity`.

import { getColumns, type Table } from 'drizzle-orm';
import { columnDialect } from './column-filters.ts';
import { type DrizzleErrorContext, drizzleError } from './errors.ts';

/**
 * The `offset` a read actually sends. `offset: 0` skips nothing, so it is dropped here rather
 * than carried into the SQL: an `OFFSET` with no `LIMIT` is invalid on SQLite and MySQL, and
 * {@link offsetOnlyLimit} only supplies the stand-in limit for an offset that skips rows. Read
 * after {@link assertPagingNotNegative}, so a negative offset is still rejected rather than
 * dropped.
 */
export const effectiveOffset = (offset: number | null | undefined): number | undefined => offset || undefined;

/**
 * The `limit` to send with an `offset` the request gave without one. SQLite and MySQL accept
 * `OFFSET` only after a `LIMIT`, so `offset` alone has to carry a limit that means "all of
 * them": SQLite reads `LIMIT -1` that way, and on MySQL it is the largest integer every driver
 * binds exactly (MySQL's own documented 2^64-1 does not fit a JS number). PostgreSQL takes
 * `OFFSET` alone, so the limit is left as it was.
 */
export const offsetOnlyLimit = (table: Table, limit: number | undefined, offset: number | undefined) => {
  if (limit != null || !offset) {
    return limit;
  }
  const firstColumn = Object.values(getColumns(table))[0];
  switch (firstColumn ? columnDialect(firstColumn) : undefined) {
    case 'sqlite':
      return -1;
    case 'mysql':
      return Number.MAX_SAFE_INTEGER;
    default:
      return limit;
  }
};

/** The shape `graphql-query-complexity`'s `fieldExtensionsEstimator` hands to a field's hint. */
type ComplexityEstimatorArgs = { args: Record<string, any>; childComplexity: number };

/** A field's cost hint, published as `extensions.complexity` on the generated field config. */
export type ComplexityEstimator = (options: ComplexityEstimatorArgs) => number;

/** {@link BuildSchemaConfig.complexity} with its defaults filled in. */
export type ResolvedComplexityOptions = {
  /** Rows a list field is assumed to return when the query passes no `limit`. */
  defaultListSize: number;
  /** Flat cost charged for an aggregate field, on top of the fields selected inside it. */
  aggregateCost: number;
};

/** {@link BuildSchemaConfig.limits} resolved for one table. `undefined` means no policy. */
export type ResolvedLimitPolicy = {
  defaultLimit: number | undefined;
  maxLimit: number | undefined;
  clampToMax: boolean;
};

/**
 * Looks up the limit policy for a table by its Drizzle schema key. Built once per schema by
 * `buildSchema`; `undefined` for a table the caller left unbounded.
 */
export type LimitPolicyFor = (tableName: string) => ResolvedLimitPolicy | undefined;

/**
 * {@link BuildSchemaConfig.defaults} resolved for one table: the `orderBy` a read falls back
 * to when the request passes none, already in the shape the generated argument has.
 * `undefined` means the table declares no default and keeps whatever order the database
 * returns.
 */
export type DefaultOrderByFor = (tableName: string) => Record<string, any> | undefined;

/**
 * Substitutes a table's default ordering for an absent `orderBy`.
 *
 * Applied where the arguments are first read, so everything downstream — the cursor tuple, a
 * `distinct` pass, the plain-select fallback — sees one effective ordering and cannot
 * disagree about it. Only a missing argument is replaced: `orderBy: {}` is a request for no
 * ordering, and stays one.
 */
export const withDefaultOrderBy = <T extends { orderBy?: any }>(
  args: T,
  tableName: string,
  defaults: DefaultOrderByFor | undefined,
): T => {
  if (!defaults || args?.orderBy != null) {
    return args;
  }
  const fallback = defaults(tableName);
  return fallback ? { ...args, orderBy: fallback } : args;
};

/**
 * Rejects a negative `limit` or `offset`. Neither is a page size or a position, and the
 * dialects disagree on what one means: SQLite reads `LIMIT -1` as "no limit" — which would walk
 * straight past `maxLimit` — while PostgreSQL and MySQL fail with a raw database error. Applied
 * whether or not the table has a limit policy.
 */
export const assertPagingNotNegative = (
  paging: { limit?: number | null; offset?: number | null },
  errorCtx?: DrizzleErrorContext,
): void => {
  for (const name of ['limit', 'offset'] as const) {
    const value = paging[name];
    if (value != null && value < 0) {
      throw drizzleError(`'${name}' must not be negative, got ${value}.`, {
        code: 'DRIZZLE_INVALID_INPUT_VALUE',
        ...errorCtx,
      });
    }
  }
};

/**
 * The `limit` a query actually runs with, given the policy for the table it reads.
 *
 * A request that passes no `limit` falls back to `defaultLimit`, or to `maxLimit` when only
 * that is configured — an absent limit means every row, which is above any maximum. A limit
 * the client did ask for is rejected when it exceeds `maxLimit`, since silently truncating a
 * page tells a paginating client it has reached the end when it has not; `clampToMax` opts
 * into the truncation instead. A limit the *policy* supplied is capped rather than rejected —
 * a misconfigured `defaultLimit` above `maxLimit` is the operator's problem, not something to
 * fail a client's query over.
 */
export const applyLimitPolicy = (
  limit: number | null | undefined,
  policy: ResolvedLimitPolicy | undefined,
  /**
   * Only a relation field passes this: its limit is applied while the *parent's* resolver is
   * building the eager query, so there is no relation-shaped catch to attach the context at.
   */
  errorCtx?: DrizzleErrorContext,
): number | undefined => {
  assertPagingNotNegative({ limit }, errorCtx);
  if (!policy) {
    return limit ?? undefined;
  }
  const { defaultLimit, maxLimit, clampToMax } = policy;

  if (limit == null) {
    const fallback = defaultLimit ?? maxLimit;
    if (fallback === undefined) {
      return undefined;
    }
    return maxLimit === undefined ? fallback : Math.min(fallback, maxLimit);
  }

  if (maxLimit !== undefined && limit > maxLimit) {
    if (clampToMax) {
      return maxLimit;
    }
    throw drizzleError(`'limit' of ${limit} exceeds the maximum of ${maxLimit}.`, {
      code: 'DRIZZLE_LIMIT_EXCEEDED',
      ...errorCtx,
    });
  }
  return limit;
};

/** Merges a per-table override over the global policy, or `undefined` when neither bounds anything. */
export const resolveLimitPolicy = (
  global: { defaultLimit?: number; maxLimit?: number; clampToMax?: boolean } | undefined,
  table: { defaultLimit?: number; maxLimit?: number; clampToMax?: boolean } | undefined,
): ResolvedLimitPolicy | undefined => {
  const defaultLimit = table?.defaultLimit ?? global?.defaultLimit;
  const maxLimit = table?.maxLimit ?? global?.maxLimit;
  if (defaultLimit === undefined && maxLimit === undefined) {
    return undefined;
  }
  return { defaultLimit, maxLimit, clampToMax: table?.clampToMax ?? global?.clampToMax ?? false };
};

/**
 * A paginated field costs its page size times whatever one row of it costs, so `users(limit: 100)
 * { posts(limit: 10) { id } }` is charged for the thousand rows it can return rather than the two
 * fields it mentions. `childComplexity` floors at 1 so a row is never free.
 *
 * The page size is the *effective* one: a request without `limit` is priced at the policy's
 * `defaultLimit` (or its `maxLimit` when that is all it sets) rather than the estimator's guess, and no request is priced above `maxLimit`,
 * so the cost a query is charged matches the rows it can actually pull.
 */
export const listFieldComplexity =
  (options: ResolvedComplexityOptions, policy?: ResolvedLimitPolicy): ComplexityEstimator =>
  ({ args, childComplexity }) => {
    const limit = args['limit'];
    const requested = typeof limit === 'number' && limit > 0 ? limit : undefined;
    // Same fallback as `applyLimitPolicy`: an omitted limit runs at `defaultLimit`, or at
    // `maxLimit` when only that is configured.
    let rows = requested ?? policy?.defaultLimit ?? policy?.maxLimit ?? options.defaultListSize;
    if (policy?.maxLimit !== undefined) {
      rows = Math.min(rows, policy.maxLimit);
    }
    return rows * Math.max(childComplexity, 1);
  };

/**
 * An aggregate returns a single row but reads however many match, so its cost tracks the scan
 * rather than the response.
 */
export const aggregateFieldComplexity =
  (options: ResolvedComplexityOptions): ComplexityEstimator =>
  ({ childComplexity }) =>
    options.aggregateCost + childComplexity;
