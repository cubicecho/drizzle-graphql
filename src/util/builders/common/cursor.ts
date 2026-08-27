// Keyset pagination. The `cursor` field, the ordering entries a cursor encodes, the encode and
// decode pair, and the predicate that resumes a query from one.

import type { Table } from 'drizzle-orm';
import { and, eq, getColumns, gt, isNotNull, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { drizzleError } from './errors.ts';
import type { OrderNullsOption } from './order-by.ts';
import { orderByEntries, orderExpressions } from './order-by.ts';

/** Name of the field on generated select types that exposes a row's opaque pagination cursor. */
export const CURSOR_FIELD_NAME = 'cursor';

/**
 * Property the list resolvers stash each row's computed cursor under. Namespaced so it can't
 * collide with a real column; the `cursor` field's resolver reads it back off the row.
 */
const ROW_CURSOR_PROP = '__drizzle_graphql_cursor';

/**
 * Where a dialect's default sort places NULLs relative to non-NULL values:
 * - `nulls-largest` — PostgreSQL: NULLs sort as the largest values (last in ASC, first in DESC).
 * - `nulls-smallest` — MySQL and SQLite: NULLs sort as the smallest values (first in ASC, last
 *   in DESC).
 * The keyset predicate has to agree with the dialect's ORDER BY, so each builder passes its own.
 */
export type NullOrdering = 'nulls-largest' | 'nulls-smallest';

/**
 * One key of the total order a cursor is defined over: column property name + direction,
 * plus the request's `nulls: first | last` override when it carries one (absent/null means
 * the dialect's native NULL placement).
 */
export type CursorOrderEntry = [string, 'asc' | 'desc', (OrderNullsOption | null)?];

/**
 * Whether an `orderBy` argument orders through a to-one relation (a nested object entry
 * rather than a direction). A cursor encodes the row's own ordering-tuple values, and a
 * related row's value is not part of the row, so cursor pagination refuses these orderings —
 * `after` raises an error and the `cursor` field resolves to null, while the ordering itself
 * still applies.
 */
export const orderByHasRelationEntry = (orderBy: Record<string, any> | undefined): boolean =>
  !!orderBy &&
  Object.values(orderBy).some((config) => config && typeof config === 'object' && config.direction === undefined);

/**
 * Why the given `orderBy` cannot back a cursor, as the message to raise — or `undefined`
 * when it can. Both cases sort on something that is not a value of the row: a related row's
 * column, or a position in the request's own `inArray` list. `after` raises the message and
 * the `cursor` field resolves to null, while the ordering itself still applies.
 */
export const orderByCursorObstacle = (orderBy: Record<string, any> | undefined): string | undefined => {
  if (orderByHasRelationEntry(orderBy)) {
    return "'after' cannot be combined with an orderBy that orders through a relation — a related row's value cannot be encoded into a cursor.";
  }
  if (
    orderBy &&
    Object.values(orderBy).some((config) => config && typeof config === 'object' && config.matchFilterOrder)
  ) {
    return "'after' cannot be combined with 'matchFilterOrder' — a row's position in the request's own filter list is not a value of the row, so it cannot be encoded into a cursor.";
  }
  return undefined;
};

/**
 * The total order a list query's rows follow when cursor pagination is in play: the request's
 * `orderBy` entries (highest priority first), then the primary key ascending as a tiebreak —
 * skipping PK columns the `orderBy` already names, so no key appears twice.
 */
export const cursorOrderingEntries = (
  orderBy: Record<string, any> | undefined,
  pkNames: readonly string[],
): CursorOrderEntry[] => {
  const entries: CursorOrderEntry[] = orderBy ? orderByEntries(orderBy) : [];
  const seen = new Set(entries.map(([column]) => column));
  for (const pk of pkNames) {
    if (!seen.has(pk)) {
      entries.push([pk, 'asc']);
    }
  }
  return entries;
};

/**
 * ORDER BY expressions realizing a cursor's total order on `table` (which may be the aliased
 * RQB proxy) — each key's direction plus its `nulls` override, exactly the order the keyset
 * predicate in {@link buildCursorCondition} compares against.
 */
export const cursorOrderExprs = (table: Table, entries: CursorOrderEntry[]): SQL[] => {
  const cols = getColumns(table);
  return entries.flatMap(([column, direction, nulls]) =>
    orderExpressions(cols[column]!, direction, nulls ?? undefined, cols[column]!),
  );
};

/**
 * Serializes one ordering-tuple value into a JSON-safe shape. Dates and bigints don't survive
 * JSON.stringify losslessly (bigint throws, Date turns into an untagged string), so they are
 * tagged; decimals already arrive from the driver as strings, which are lossless as-is.
 */
const encodeCursorValue = (value: any): any => {
  if (value instanceof Date) {
    return { $type: 'date', value: value.toISOString() };
  }
  if (typeof value === 'bigint') {
    return { $type: 'bigint', value: value.toString() };
  }
  return value;
};

const decodeCursorValue = (value: any): any => {
  if (value && typeof value === 'object' && typeof value.$type === 'string') {
    if (value.$type === 'date') {
      return new Date(value.value);
    }
    if (value.$type === 'bigint') {
      return BigInt(value.value);
    }
  }
  return value;
};

/**
 * Encodes a row's position in the given total order as an opaque cursor: base64url of a JSON
 * payload holding the ordering spec (`o`) and the row's values for it (`v`). The spec rides
 * along so a later request can verify the cursor was issued for the same ordering it is using.
 */
export const encodeCursor = (entries: CursorOrderEntry[], row: Record<string, any>): string => {
  const payload = {
    o: entries,
    v: entries.map(([column]) => encodeCursorValue(row[column] ?? null)),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
};

/**
 * Decodes an `after` cursor and validates it against the ordering the current request pages
 * over. A cursor issued under a different `orderBy` would combine one ordering's predicate
 * with another's sort — silently wrong pages — so a mismatch is an error, as is anything that
 * doesn't decode to the expected payload shape.
 */
export const decodeCursor = (after: string, entries: CursorOrderEntry[]): any[] => {
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
  } catch (_e) {
    throw drizzleError('Invalid cursor: unable to decode it. Pass a cursor returned by a previous page.', {
      code: 'DRIZZLE_INVALID_CURSOR',
    });
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.o) ||
    !Array.isArray(payload.v) ||
    payload.o.length !== payload.v.length
  ) {
    throw drizzleError('Invalid cursor: malformed payload. Pass a cursor returned by a previous page.', {
      code: 'DRIZZLE_INVALID_CURSOR',
    });
  }

  const matchesOrdering =
    payload.o.length === entries.length &&
    payload.o.every(
      (entry: any, i: number) =>
        Array.isArray(entry) &&
        entry[0] === entries[i]![0] &&
        entry[1] === entries[i]![1] &&
        // The nulls override changes where NULLs sort, so it is part of the ordering identity.
        // JSON round-trips undefined as null — compare the normalized forms.
        (entry[2] ?? null) === (entries[i]![2] ?? null),
    );
  if (!matchesOrdering) {
    throw drizzleError(
      "Invalid cursor: it was issued for a different ordering. Pass the same orderBy the cursor's page used.",
      { code: 'DRIZZLE_INVALID_CURSOR' },
    );
  }

  return payload.v.map(decodeCursorValue);
};

/**
 * The keyset predicate selecting rows strictly after the cursor position in the given total
 * order — the expanded lexicographic form
 * `after(k0) OR (k0 = v0 AND after(k1)) OR (k0 = v0 AND k1 = v1 AND after(k2)) …`,
 * built with and/or/gt/lt/eq rather than SQL row-value syntax, which cannot express mixed
 * asc/desc directions and mishandles NULLs.
 *
 * NULL handling follows each key's `nulls: first | last` override when present, and otherwise
 * the dialect's default sort position (see {@link NullOrdering}): where NULLs sort last for a
 * key, "after a non-NULL value" includes the NULL rows and nothing sorts after a NULL one;
 * where NULLs sort first, "after NULL" is every non-NULL row.
 * `table` may be the aliased RQB proxy.
 */
export const buildCursorCondition = (
  table: Table,
  entries: CursorOrderEntry[],
  values: any[],
  nullOrdering: NullOrdering,
): SQL => {
  const cols = getColumns(table);
  const disjuncts: SQL[] = [];
  const equalities: SQL[] = [];

  entries.forEach(([column, direction, nulls], i) => {
    const col = cols[column];
    if (!col) {
      throw drizzleError(`Invalid cursor: unknown column '${column}'.`, { code: 'DRIZZLE_INVALID_CURSOR' });
    }

    const value = values[i];
    const nullsSortLast =
      nulls != null ? nulls === 'last' : (direction === 'asc') === (nullOrdering === 'nulls-largest');

    let strictlyAfter: SQL | undefined;
    if (value === null || value === undefined) {
      // Nothing sorts after NULL when NULLs are last; every non-NULL row does when first.
      strictlyAfter = nullsSortLast ? undefined : isNotNull(col);
    } else {
      const comparison = direction === 'asc' ? gt(col, value) : lt(col, value);
      strictlyAfter = nullsSortLast ? or(comparison, isNull(col)) : comparison;
    }

    if (strictlyAfter) {
      disjuncts.push(equalities.length ? and(...equalities, strictlyAfter)! : strictlyAfter);
    }
    equalities.push(value === null || value === undefined ? isNull(col) : eq(col, value));
  });

  if (!disjuncts.length) {
    // Every key's strict term was impossible (e.g. a NULLs-last cursor position of all NULLs) —
    // nothing sorts after this cursor.
    return sql`1 = 0`;
  }

  return disjuncts.length > 1 ? or(...disjuncts)! : disjuncts[0]!;
};

/**
 * Whether the selection asks for the `cursor` meta field. A real column named `cursor` keeps
 * the field for itself, so the meta field only exists (and is only computed) when the table
 * has no such column.
 */
export const isCursorFieldSelected = (tree: Record<string, ResolveTree> | undefined, table: Table): boolean => {
  if (!tree) {
    return false;
  }
  if (getColumns(table)[CURSOR_FIELD_NAME]) {
    return false;
  }
  return Object.values(tree).some((field) => field.name === CURSOR_FIELD_NAME);
};

/**
 * Whether a field's own selection set asks for the `cursor` meta field, read straight off the
 * AST. The relation resolvers need this per parent row on the batch path, where parsing a
 * full resolve tree each time would cost far more than the one-level walk the question needs;
 * fragment spreads are followed, and a real column named `cursor` keeps the field for itself
 * exactly as in {@link isCursorFieldSelected}.
 */
export const selectsCursorField = (info: any, table: Table): boolean => {
  if (getColumns(table)[CURSOR_FIELD_NAME]) {
    return false;
  }

  const visited = new Set<string>();
  const walk = (selections: any[]): boolean =>
    selections.some((selection) => {
      if (selection.kind === 'Field') {
        return selection.name.value === CURSOR_FIELD_NAME;
      }
      if (selection.kind === 'InlineFragment') {
        return walk(selection.selectionSet.selections);
      }
      const name = selection.name?.value;
      if (!name || visited.has(name)) {
        return false;
      }
      visited.add(name);
      const fragment = info.fragments?.[name];
      return fragment ? walk(fragment.selectionSet.selections) : false;
    });

  return (info.fieldNodes ?? []).some((node: any) => !!node.selectionSet && walk(node.selectionSet.selections));
};

/**
 * Computes and attaches each row's opaque cursor (under a namespaced property the `cursor`
 * field's resolver reads). Must run on the raw driver rows, before output remapping rewrites
 * dates and bigints into their transport forms.
 */
export const attachRowCursors = (rows: Record<string, any>[], entries: CursorOrderEntry[]): void => {
  for (const row of rows) {
    row[ROW_CURSOR_PROP] = encodeCursor(entries, row);
  }
};

/** Resolver for the `cursor` meta field: reads the value a list resolver attached, if any. */
export const rowCursorResolver = (source: any): string | null => source?.[ROW_CURSOR_PROP] ?? null;
