// Keyset pagination. The `cursor` field, the ordering entries a cursor encodes, the encode and
// decode pair, and the predicate that resumes a query from one.

import type { Column, Table } from 'drizzle-orm';
import {
  and,
  bindIfParam,
  eq,
  extractExtendedColumnType,
  getColumns,
  gt,
  is,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  MySqlBigInt53,
  MySqlColumn,
  MySqlDate,
  MySqlDateTime,
  MySqlEnumColumn,
  MySqlEnumObjectColumn,
  MySqlSerial,
  MySqlTimestamp,
} from 'drizzle-orm/mysql-core';
import { PgBigInt53, PgBigSerial53, PgColumn, PgDate, PgTimestamp } from 'drizzle-orm/pg-core';
import { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { ResolveTree } from '../../parse-resolve-info.ts';
import { dateToCalendarDate } from '../../scalars/index.ts';
import { isDateOnlyColumn } from '../../type-converter/index.ts';
import { cursorValueFormatFits, isInt64Text, readsNumbersForStrings } from './cursor-value-formats.ts';
import { drizzleError } from './errors.ts';
import { comparableOperand } from './filters.ts';
import type { OrderNullsOption } from './order-by.ts';
import { isRelationOrderEntry, orderByEntries, orderExpressions } from './order-by.ts';

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

/** Each dialect's {@link NullOrdering}, declared once for its schema builder and the selection helpers. */
export const DIALECT_NULL_ORDERING = {
  pg: 'nulls-largest',
  mysql: 'nulls-smallest',
  sqlite: 'nulls-smallest',
} as const satisfies Record<string, NullOrdering>;

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
  !!orderBy && Object.values(orderBy).some(isRelationOrderEntry);

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
 * Property a row carries an ordering column's database text under, when the JS form the column
 * reads into cannot stand for every value it holds. Namespaced like {@link ROW_CURSOR_PROP}, and
 * removed from the row once its cursor is encoded.
 */
const preciseTextProp = (column: string): string => `__drizzle_graphql_cursor_text_${column}`;

/** The database text a {@link cursorTextForm} column's cursor value takes. */
type CursorTextForm = 'timestamp' | 'date' | 'integer';

/** 64-bit integer columns drizzle reads as JS numbers (`mode: 'number'`). */
const NUMBER_MODE_INT64_COLUMNS = [PgBigInt53, PgBigSerial53, MySqlBigInt53, MySqlSerial] as const;

/**
 * How a column whose values its JS form cannot always stand for keeps its cursor position: as
 * the database's own text of a timestamp, of a date-only value, or of a 64-bit integer.
 *
 * Every `mode: 'date'` PostgreSQL `timestamp` / `timestamptz` / `date` and MySQL `datetime` /
 * `timestamp` / `date` takes a timestamp or date text:
 * - a fraction finer than milliseconds (PostgreSQL's default precision 6, MySQL `fsp` above 3)
 *   would be truncated, and two rows a microsecond apart would share one position;
 * - a value outside a JS Date's range (a BC date, a year past 275760, PostgreSQL's infinities,
 *   MySQL's zero date) reads as an invalid Date, which has no position to encode at all — and
 *   drizzle reads `timestamp` (without time zone) infinity as an ordinary instant in 2000.
 *
 * Every `mode: 'number'` 64-bit integer — PostgreSQL `bigint` / `bigserial`, MySQL `bigint` /
 * `serial` — takes an integer text. Past ±2^53 it reads as the nearest double, so neighbouring
 * values share one position, and -2^63 reads as a number below every row (MySQL) or one
 * PostgreSQL refuses as out of range.
 *
 * String-mode columns already arrive as the database's own text, `time` is always a string, and
 * SQLite's integer timestamps hold no text form to compare by, so none of those need it.
 */
const cursorTextForm = (column: Column): CursorTextForm | undefined => {
  if (is(column, PgTimestamp) || is(column, MySqlDateTime) || is(column, MySqlTimestamp)) {
    return 'timestamp';
  }
  if (is(column, PgDate) || is(column, MySqlDate)) {
    return 'date';
  }
  return NUMBER_MODE_INT64_COLUMNS.some((type) => is(column, type)) ? 'integer' : undefined;
};

/**
 * Extra SQL expressions a cursor-computing query selects alongside the row: for each ordering
 * column with a {@link cursorTextForm}, the value as the database's own text. The cursor then
 * encodes that text rather than the Date or number, and `after` compares the column against it —
 * so two rows a microsecond (or one) apart stay distinct positions, and a row whose value a JS
 * Date cannot hold still has one. `table` may be the aliased RQB proxy. Empty when no ordering
 * column needs it.
 */
export const cursorPreciseExtras = (table: Table, entries: CursorOrderEntry[]): Record<string, SQL> => {
  const cols = getColumns(table);
  const extras: Record<string, SQL> = {};
  for (const [name] of entries) {
    const column = cols[name];
    if (column && cursorTextForm(column)) {
      extras[preciseTextProp(name)] = is(column, PgColumn) ? sql`${column}::text` : sql`cast(${column} as char)`;
    }
  }
  return extras;
};

/**
 * {@link cursorPreciseExtras} aliased under their property names, for a `select({...})` that
 * may be wrapped in a subquery (where a bare SQL expression would have no name).
 */
export const cursorPreciseSelection = (table: Table, entries: CursorOrderEntry[]): Record<string, SQL.Aliased> =>
  Object.fromEntries(
    Object.entries(cursorPreciseExtras(table, entries)).map(([prop, expression]) => [prop, expression.as(prop)]),
  );

/**
 * What a cursor value is in the JS form the driver read it in — the form decoding restores.
 * Encoding tags a value by its kind and a decoded value is checked against its column by its
 * kind, so the two sides classify values by this one rule.
 */
type CursorValueKind = 'null' | 'boolean' | 'number' | 'string' | 'bigint' | 'date';

/** `typeof` results, and drizzle column data types, that name a cursor value kind directly. */
const SCALAR_CURSOR_KINDS: Readonly<Partial<Record<string, CursorValueKind>>> = {
  boolean: 'boolean',
  number: 'number',
  string: 'string',
  bigint: 'bigint',
};

/** A value's {@link CursorValueKind}, or `undefined` for anything else (an object, an array). */
const cursorValueKind = (value: unknown): CursorValueKind | undefined => {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value instanceof Date) {
    return 'date';
  }
  return SCALAR_CURSOR_KINDS[typeof value];
};

/**
 * How each kind JSON.stringify cannot carry losslessly is tagged: bigint throws, a Date turns
 * into an untagged string, and `NaN` / `±Infinity` into `null`. Decimals already arrive from the
 * driver as strings, which are lossless as-is.
 */
const CURSOR_VALUE_ENCODERS: Readonly<Partial<Record<CursorValueKind, (value: any) => unknown>>> = {
  date: (value: Date) => ({ $type: 'date', value: value.toISOString() }),
  bigint: (value: bigint) => ({ $type: 'bigint', value: value.toString() }),
  // `String` spells them `NaN` / `Infinity` / `-Infinity`, which `Number` reads back.
  number: (value: number) => (Number.isFinite(value) ? value : { $type: 'float', value: String(value) }),
};

/** Serializes one ordering-tuple value into a JSON-safe shape (see {@link CURSOR_VALUE_ENCODERS}). */
const encodeCursorValue = (value: any): any => {
  const kind = cursorValueKind(value);
  const encode = kind && CURSOR_VALUE_ENCODERS[kind];
  return encode ? encode(value) : value;
};

/** The text forms a `bigint`-tagged cursor value may take. */
const BIGINT_TEXT = /^-?\d+$/;
/** The text forms a `float`-tagged cursor value may take: what `String` makes of a non-finite number. */
const NON_FINITE_TEXTS: ReadonlySet<string> = new Set(['NaN', 'Infinity', '-Infinity']);

const invalidCursorValue = () =>
  drizzleError('Invalid cursor: it holds a value no page issues. Pass a cursor returned by a previous page.', {
    code: 'DRIZZLE_INVALID_CURSOR',
  });

/**
 * Reverses {@link encodeCursorValue}, refusing anything it never produces: a cursor is client
 * input, and a forged value would otherwise bind as an invalid date (a silently empty page) or
 * fail in the driver (an internal error).
 */
const decodeCursorValue = (value: unknown): unknown => {
  const isPlainScalar =
    value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
  if (isPlainScalar) {
    return value;
  }
  const { $type: type, value: text } = (value ?? {}) as { $type?: unknown; value?: unknown };
  const isTagged = typeof value === 'object' && !Array.isArray(value) && typeof text === 'string';
  if (!isTagged) {
    throw invalidCursorValue();
  }
  if (type === 'date') {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      throw invalidCursorValue();
    }
    return date;
  }
  if (type === 'bigint' && BIGINT_TEXT.test(text)) {
    return BigInt(text);
  }
  if (type === 'float' && NON_FINITE_TEXTS.has(text)) {
    return Number(text);
  }
  throw invalidCursorValue();
};

/**
 * Encodes a row's position in the given total order as an opaque cursor: base64url of a JSON
 * payload holding the ordering spec (`o`) and the row's values for it (`v`). The spec rides
 * along so a later request can verify the cursor was issued for the same ordering it is using.
 */
export const encodeCursor = (entries: CursorOrderEntry[], row: Record<string, any>): string =>
  cursorEncoder(entries)(row);

/**
 * `encodeCursor` bound to one ordering, for encoding a whole page.
 *
 * The ordering spec is the same for every row of a page, so it is serialized once here and
 * spliced into each row's payload rather than re-serialized per row. The bytes are identical
 * to what building the payload object and stringifying it produces — same keys, same order —
 * so cursors stay interchangeable with ones issued before this was split out.
 */
const cursorEncoder = (entries: CursorOrderEntry[]): ((row: Record<string, any>) => string) => {
  const spec = JSON.stringify(entries);
  const columns = entries.map(([column]) => column);

  return (row) => {
    const values = JSON.stringify(
      columns.map((column) => {
        const value = row[column] ?? null;
        // The database's own text of a value a Date or number would round (see
        // cursorPreciseExtras). It goes out as a plain string: both dialects' date-mode and
        // number-mode bigint columns bind a string as-is, and the database parses it back
        // exactly, at the column's own type.
        const precise = row[preciseTextProp(column)];
        return value !== null && typeof precise === 'string' ? precise : encodeCursorValue(value);
      }),
    );
    return Buffer.from(`{"o":${spec},"v":${values}}`, 'utf8').toString('base64url');
  };
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
 * `col > value` (asc) or `col < value` (desc), compared by the rule the ORDER BY sorts by.
 * MySQL sorts an ENUM by its declaration index but compares it with a string as a string, so
 * there the comparison is between `col + 0` (the 1-based index) and the value's own index.
 */
const strictComparison = (col: Column, direction: 'asc' | 'desc', value: unknown): SQL => {
  if (is(col, MySqlEnumColumn) || is(col, MySqlEnumObjectColumn)) {
    const index = ((col as any).enumValues as readonly string[] | undefined)?.indexOf(value as string) ?? -1;
    if (index >= 0) {
      const position = sql`(${col} + 0)`;
      return direction === 'asc' ? sql`${position} > ${index + 1}` : sql`${position} < ${index + 1}`;
    }
  }
  const operand = comparableOperand(col, value);
  return direction === 'asc' ? gt(col, operand) : lt(col, operand);
};

/** A real literal too large for a double, which SQLite reads as `Infinity`. */
const SQLITE_INFINITY_LITERAL = '9e999';

/**
 * A decoded cursor value in the form it is bound against its column. A date-only column's
 * value decodes to a JS `Date` at UTC midnight, and mysql2 renders a bound `Date` in the
 * process's local timezone — west of UTC `2025-12-31T00:00Z` goes out as `2025-12-30`, the
 * cursor row still sorts after itself, and every page repeats it. The calendar day the cursor
 * encodes is bound instead, as the data mappers bind a `Date` filter on the same column: a
 * `YYYY-MM-DD` string no timezone can shift, which every dialect's date column reads as is.
 * `±Infinity` on SQLite is spliced as a literal, since its drivers will not bind it.
 */
const boundCursorValue = (col: Column, value: unknown): unknown => {
  if (value instanceof Date && isDateOnlyColumn(col)) {
    return dateToCalendarDate(value) ?? value;
  }
  const isInfinity = value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY;
  if (isInfinity && is(col, SQLiteColumn)) {
    // SQLite drivers refuse to bind a non-finite number; an overflowing literal parses to it.
    return sql.raw(value > 0 ? SQLITE_INFINITY_LITERAL : `-${SQLITE_INFINITY_LITERAL}`);
  }
  return value;
};

/** Number constraints whose columns hold whole numbers only. */
const INTEGER_CONSTRAINTS: ReadonlySet<string> = new Set([
  'int8',
  'int16',
  'int24',
  'int32',
  'int53',
  'uint8',
  'uint16',
  'uint24',
  'uint32',
  'uint53',
  'year',
]);

/**
 * Every timestamp text {@link cursorPreciseExtras} can select: PostgreSQL's `::text` of a
 * `timestamp` / `timestamptz` (ISO DateStyle — years of four or more digits, any fraction, an
 * offset of `±HH`, `±HH:MM` or local mean time's `±HH:MM:SS`, and a trailing ` BC`) and MySQL's
 * `cast(… as char)` of a `datetime` / `timestamp`, which is the same shape without the offset.
 */
const TIMESTAMP_TEXT =
  /^(?<year>\d{4,6})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:[+-]\d{2}(?::\d{2}){0,2})?(?<bc> BC)?$/;
/** The same for a `date`: PostgreSQL's ISO `YYYY-MM-DD`, with a trailing ` BC`, and MySQL's, without. */
const DATE_TEXT = /^(?<year>\d{4,7})-(?<month>\d{2})-(?<day>\d{2})(?<bc> BC)?$/;
/** Texts that name no day or instant but that the database stores: PostgreSQL's infinities, MySQL's zero date. */
const NON_INSTANT_TEXT = {
  timestamp: /^(-?infinity|0000-00-00 00:00:00(\.0+)?)$/,
  date: /^(-?infinity|0000-00-00)$/,
} as const;
/** PostgreSQL's range, which contains MySQL's: 4713 BC to 294276 AD for a timestamp, 5874897 AD for a date. */
const MAX_AD_YEAR = { timestamp: 294276, date: 5874897 } as const;
const MAX_BC_YEAR = 4714;
/** The values each field of {@link TIMESTAMP_TEXT} can print, inclusive; PostgreSQL prints `24:00:00` and leap second 60. */
const TIMESTAMP_FIELD_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  month: [1, 12],
  day: [1, 31],
  hour: [0, 24],
  minute: [0, 59],
  second: [0, 60],
};

/**
 * Whether a string is text in `form` as {@link cursorPreciseExtras} selects it — any form the
 * databases print, with each field in range. Day-of-month overflow (Feb 31) is left to the
 * database, which refuses it; it never prints one. An integer text is a whole number the column's
 * 64 bits hold.
 */
const isCursorText = (col: Column, form: CursorTextForm, text: string): boolean => {
  if (form === 'integer') {
    return isInt64Text(col, text);
  }
  if (NON_INSTANT_TEXT[form].test(text)) {
    return true;
  }
  const fields = (form === 'timestamp' ? TIMESTAMP_TEXT : DATE_TEXT).exec(text)?.groups;
  if (!fields) {
    return false;
  }
  const year = Number(fields['year']);
  const maxYear = fields['bc'] ? MAX_BC_YEAR : MAX_AD_YEAR[form];
  const fieldsInRange = Object.entries(TIMESTAMP_FIELD_RANGES).every(([field, [min, max]]) => {
    const value = fields[field];
    return value === undefined || (Number(value) >= min && Number(value) <= max);
  });
  return fieldsInRange && year >= 1 && year <= maxYear;
};

/**
 * The kind a column's values read into, from drizzle's data type — or `undefined` when no
 * cursor value kind describes them (JSON, buffers, custom types, arrays), and none is checked.
 */
const columnCursorKind = (col: Column): CursorValueKind | undefined => {
  if ((col as any).dimensions) {
    return undefined;
  }
  const { type, constraint } = extractExtendedColumnType(col);
  if (type === 'object') {
    return constraint === 'date' ? 'date' : undefined;
  }
  return SCALAR_CURSOR_KINDS[type];
};

/**
 * Whether a decoded cursor value is one its column's rows can produce: NULL only for a nullable
 * column, otherwise the column's kind — or, for a column with a {@link cursorTextForm}, its
 * database text. SQLite stores any number in an integer column, so only other dialects require a whole one.
 * A value of the right kind must also be in its column's format and range
 * ({@link cursorValueFormatFits}): a uuid, a numeric, an enum label, an integer that fits.
 */
const cursorValueFits = (col: Column, value: unknown): boolean => {
  const kind = cursorValueKind(value);
  if (kind === 'null') {
    return col.notNull !== true;
  }
  const expected = columnCursorKind(col);
  if (expected === undefined) {
    return true;
  }
  const textForm = cursorTextForm(col);
  if (kind === 'string' && textForm) {
    return isCursorText(col, textForm, value as string);
  }
  const kindFits = kind === expected || (kind === 'number' && readsNumbersForStrings(col));
  if (!kindFits) {
    return false;
  }
  const holdsWholeNumbers =
    INTEGER_CONSTRAINTS.has(extractExtendedColumnType(col).constraint ?? '') && !is(col, SQLiteColumn);
  if (kind === 'number' && holdsWholeNumbers && !Number.isInteger(value)) {
    return false;
  }
  return cursorValueFormatFits(col, value);
};

/**
 * Refuses a cursor value its column cannot hold. A forged one would otherwise fail in drizzle's
 * encoder or the database (an internal error), or compare under the wrong type.
 */
const assertCursorValueFits = (col: Column, column: string, value: unknown): void => {
  if (!cursorValueFits(col, value)) {
    throw drizzleError(
      `Invalid cursor: its value for '${column}' is not one that column holds. Pass a cursor returned by a previous page.`,
      { code: 'DRIZZLE_INVALID_CURSOR' },
    );
  }
};

/** One key of a cursor's total order, resolved against the queried table. */
interface CursorKey {
  col: Column;
  direction: 'asc' | 'desc';
  nulls: OrderNullsOption | null | undefined;
  value: unknown;
}

/**
 * Whether a key's column can never hold NULL in the rows the predicate filters. Every key is a
 * plain column of the queried table — `orderByEntries` rejects relation and `matchFilterOrder`
 * entries before a cursor ordering exists — and the batched relation query joins only its
 * junction, with an inner join, so a NOT NULL column stays non-NULL there too.
 */
const isNonNullKey = (key: CursorKey): boolean => key.col.notNull === true;

/**
 * The keyset predicate as one SQL row-value comparison — `(k0, k1, …) > (v0, v1, …)`, or `<`
 * for a descending order — when that is exactly the expanded lexicographic form, and
 * `undefined` otherwise.
 *
 * PostgreSQL seeks a composite index on the ordering only for the row-value form: against
 * `k0 > v0 OR (k0 = v0 AND k1 > v1)` it scans the index from its start and filters out every
 * row before the cursor. SQLite (3.15+) seeks for both. The two forms agree only when
 * - every key shares one direction (a row value has a single comparison operator);
 * - every key is a NOT NULL column and its cursor value non-NULL (a row-value comparison that
 *   meets a NULL is NULL, not "sorts after");
 * - the dialect is not MySQL. MySQL compares an ENUM by its label but sorts it by its index
 *   (see {@link strictComparison}), and its range optimizer does not seek an index for a
 *   row-value inequality, while it does turn the expanded form into a range scan.
 * Each element compares under the column's own collation, exactly as the scalar `>` / `=` of
 * the expanded form does, and binds through the column as `gt` / `eq` do.
 */
const rowValueCondition = (keys: CursorKey[]): SQL | undefined => {
  const direction = keys[0]?.direction;
  if (
    keys.length < 2 ||
    keys.some(
      (key) =>
        key.direction !== direction ||
        !isNonNullKey(key) ||
        key.value === null ||
        key.value === undefined ||
        is(key.col, MySqlColumn),
    )
  ) {
    return undefined;
  }
  const columns = sql.join(
    keys.map((key) => key.col),
    sql`, `,
  );
  const values = sql.join(
    keys.map((key) => bindIfParam(key.value, key.col)),
    sql`, `,
  );
  return direction === 'asc' ? sql`(${columns}) > (${values})` : sql`(${columns}) < (${values})`;
};

/**
 * The keyset predicate selecting rows strictly after the cursor position in the given total
 * order. When every key is a NOT NULL column sorted one way it is a single row-value
 * comparison (see {@link rowValueCondition}); otherwise the expanded lexicographic form
 * `after(k0) OR (k0 = v0 AND after(k1)) OR (k0 = v0 AND k1 = v1 AND after(k2)) …`,
 * built with and/or/gt/lt/eq, since a row value cannot express mixed asc/desc directions or
 * NULLs.
 *
 * NULL handling follows each key's `nulls: first | last` override when present, and otherwise
 * the dialect's default sort position (see {@link NullOrdering}): where NULLs sort last for a
 * key, "after a non-NULL value" includes the NULL rows and nothing sorts after a NULL one;
 * where NULLs sort first, "after NULL" is every non-NULL row. A NOT NULL column has no NULL
 * rows to include, so its `OR col IS NULL` branch — which keeps the database from seeking an
 * index on the column — is left out.
 * `table` may be the aliased RQB proxy.
 */
export const buildCursorCondition = (
  table: Table,
  entries: CursorOrderEntry[],
  values: any[],
  nullOrdering: NullOrdering,
): SQL => {
  const cols = getColumns(table);
  const keys: CursorKey[] = entries.map(([column, direction, nulls], i) => {
    const col = cols[column];
    if (!col) {
      throw drizzleError(`Invalid cursor: unknown column '${column}'.`, { code: 'DRIZZLE_INVALID_CURSOR' });
    }
    assertCursorValueFits(col, column, values[i]);
    return { col, direction, nulls, value: boundCursorValue(col, values[i]) };
  });

  const rowValue = rowValueCondition(keys);
  if (rowValue) {
    return rowValue;
  }

  const disjuncts: SQL[] = [];
  const equalities: SQL[] = [];

  for (const key of keys) {
    const { col, direction, nulls, value } = key;
    const nullsSortLast =
      nulls != null ? nulls === 'last' : (direction === 'asc') === (nullOrdering === 'nulls-largest');

    let strictlyAfter: SQL | undefined;
    if (value === null || value === undefined) {
      // Nothing sorts after NULL when NULLs are last; every non-NULL row does when first.
      strictlyAfter = nullsSortLast ? undefined : isNotNull(col);
    } else {
      const comparison = strictComparison(col, direction, value);
      strictlyAfter = nullsSortLast && !isNonNullKey(key) ? or(comparison, isNull(col)) : comparison;
    }

    if (strictlyAfter) {
      disjuncts.push(equalities.length ? and(...equalities, strictlyAfter)! : strictlyAfter);
    }
    equalities.push(value === null || value === undefined ? isNull(col) : eq(col, comparableOperand(col, value)));
  }

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
  const encode = cursorEncoder(entries);
  const preciseProps = entries.map(([column]) => preciseTextProp(column));
  for (const row of rows) {
    row[ROW_CURSOR_PROP] = encode(row);
    for (const prop of preciseProps) {
      delete row[prop];
    }
  }
};

/** Resolver for the `cursor` meta field: reads the value a list resolver attached, if any. */
export const rowCursorResolver = (source: any): string | null => source?.[ROW_CURSOR_PROP] ?? null;
