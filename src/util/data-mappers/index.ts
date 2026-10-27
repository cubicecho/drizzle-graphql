import { type Column, getColumns, is, One, type Table } from 'drizzle-orm';
import { isJsonColumn } from '../builders/common/column-filters.ts';
import { drizzleError } from '../builders/common/errors.ts';
import type { TableNamedRelations } from '../builders/index.ts';
import { dateToCalendarDate, isCalendarDate } from '../scalars/index.ts';
import {
  floatTupleLength,
  getColumnScalarOverride,
  isBufferColumn,
  isDateOnlyColumn,
  isDateTimeColumn,
  isFloatTupleColumn,
  isMySqlDateTimeStringColumn,
  isPgTimestampStringColumn,
  isSQLiteTimestampColumn,
  sqliteTimestampToDate,
} from '../type-converter/index.ts';

/**
 * MySQL's own text form for a `timestamp` / `datetime`: `YYYY-MM-DD HH:MM:SS`, an optional
 * fraction, and no offset. mysql2 returns it for a `'string'`-mode column, and it is what such a
 * column expects on write.
 */
const MYSQL_DATETIME_TEXT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * MySQL datetime text, read as UTC, as the ISO 8601 instant the `DateTime` scalar carries.
 * UTC because that is how drizzle's own `'date'`-mode codecs read the same text, so a column's
 * two modes agree on the instant. Anything else (a zero date, a value already carrying an
 * offset) is returned unchanged for the scalar to accept or reject.
 */
export const mySqlDateTimeTextToIso = (value: string): string => {
  const match = MYSQL_DATETIME_TEXT.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : value;
};

/**
 * A JS `Date` as offset-less `YYYY-MM-DD HH:MM:SS.mmm` text in UTC: what a MySQL `'string'`-mode
 * column and a Postgres `timestamp` (without time zone) `'string'`-mode column are written with.
 */
const dateToUtcWallText = (value: Date): string => value.toISOString().slice(0, -1).replace('T', ' ');

/**
 * Postgres's text form for a `timestamp` / `timestamptz` (the `ISO` `DateStyle`, the default):
 * `YYYY-MM-DD HH:MM:SS`, an optional fraction, and — for `timestamptz` only — the session zone's
 * offset as `±HH`, `±HH:MM` or, for historical local mean time, `±HH:MM:SS`.
 */
const PG_TIMESTAMP_TEXT =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/;

/**
 * Postgres timestamp text as the RFC 3339 UTC instant (`…Z`) the `DateTime` scalar accepts.
 *
 * - With an offset (`timestamptz`), the instant is shifted to UTC. The offset can carry seconds,
 *   which RFC 3339 cannot express, so it is applied here rather than rewritten.
 * - Without one (`timestamp`), the wall time is read as UTC: that is what drizzle's `'date'`-mode
 *   codec does (`new Date(text + '+0000')`) and what the input side writes, so a column's two
 *   modes agree on the instant.
 * - The fraction is kept digit for digit. The scalar itself carries milliseconds, so microseconds
 *   are truncated on the wire, never rounded into the next second.
 *
 * Anything else (`infinity`, a `BC` date, a five-digit year) is returned unchanged for the scalar
 * to reject.
 */
export const pgTimestampTextToIso = (value: string): string => {
  const match = PG_TIMESTAMP_TEXT.exec(value);
  if (!match) {
    return value;
  }
  const [, date, time, fraction = '', sign, hours, minutes = '0', seconds = '0'] = match;
  if (!sign) {
    return `${date}T${time}${fraction}Z`;
  }

  const wallMs = Date.parse(`${date}T${time}Z`);
  if (Number.isNaN(wallMs)) {
    return value;
  }
  const offsetSeconds = (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
  const utc = new Date(wallMs - offsetSeconds * 1000).toISOString();
  // `toISOString` only stays `YYYY-MM-DDTHH:MM:SS.mmmZ` inside years 0000–9999.
  return utc.length === 24 ? `${utc.slice(0, 19)}${fraction}Z` : value;
};

/** Marks a decoder installed by {@link installSqliteBlobJsonDecoders}, so a rebuild never wraps it twice. */
const BLOB_JSON_DECODER = Symbol.for('drizzle-graphql.sqliteBlobJsonDecoder');

/**
 * Gives SQLite's blob columns a decoder for the relational query builder's JSON path, so a NULL
 * there reads back as null.
 *
 * Inside a nested relation drizzle selects a blob as `hex(column)` (JSON cannot hold a blob), and
 * `hex(NULL)` is `''`. drizzle then decodes that `''` with the column's ordinary decoder: a
 * `blob({ mode: 'bigint' })` reads it as `0n` — indistinguishable from a stored 0 — and a
 * `blob({ mode: 'json' })` throws on it. drizzle consults a column's `mapFromJsonValue`, when it
 * has one, instead of `mapFromDriverValue` for exactly this path, so one is installed here that
 * reads `''` as NULL and hands everything else to the column's own decoder.
 *
 * `''` is never a stored bigint or JSON blob, so for those it can only be NULL. For a buffer
 * blob it is also how an empty blob arrives, so it is read as NULL only when the column is
 * nullable — a `notNull` column cannot hold the NULL, so there it is the empty blob.
 */
export const installSqliteBlobJsonDecoders = (tables: Record<string, Table>): void => {
  for (const table of Object.values(tables)) {
    for (const column of Object.values(getColumns(table))) {
      const columnType: string = (column as any).columnType ?? '';
      const isBuffer = columnType === 'SQLiteBlobBuffer';
      if (columnType !== 'SQLiteBigInt' && columnType !== 'SQLiteBlobJson' && !isBuffer) {
        continue;
      }
      const existing = (column as any).mapFromJsonValue;
      if (existing && !existing[BLOB_JSON_DECODER]) {
        continue;
      }
      const emptyIsNull = !isBuffer || !column.notNull;
      const decoder = (value: unknown) =>
        value === '' && emptyIsNull ? null : (column as any).mapFromDriverValue(value);
      (decoder as any)[BLOB_JSON_DECODER] = true;
      (column as any).mapFromJsonValue = decoder;
    }
  }
};

export const remapToGraphQLCore = (
  key: string,
  value: any,
  tableName: string,
  // Relation keys have no column; the guard below is what handles them.
  column: Column | undefined,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
): any => {
  // Check for relation fields BEFORE the column check.
  // Relation fields don't have corresponding table columns.
  if (Array.isArray(value)) {
    const relations = relationMap?.[tableName];
    if (relations?.[key]) {
      const rel = relations[key]!;
      return remapToGraphQLArrayOutput(
        value,
        rel.targetTableName,
        (rel.relation as any)?.targetTable ?? (rel.relation as any)?.referencedTable,
        relationMap,
      );
    }
  }

  if (typeof value === 'object' && value !== null) {
    const relations = relationMap?.[tableName];
    if (relations?.[key]) {
      const rel = relations[key]!;
      const remapped = remapToGraphQLSingleOutput(
        value,
        rel.targetTableName,
        (rel.relation as any)?.targetTable ?? (rel.relation as any)?.referencedTable,
        relationMap,
      );
      return remapped;
    }
  }

  // For non-relation fields, require a column definition.
  if (!column) {
    return value;
  }

  // Columns whose output type is a scalar override hand the driver's raw value straight to
  // that scalar — serialization is wholly the scalar's job, and converting here first would
  // double-convert.
  if (getColumnScalarOverride(column, false)) {
    return value;
  }

  // JSON columns are carried by the `JSON` scalar, which transports the parsed value as-is.
  // This has to come before the array/object branches below, which would otherwise walk into
  // the value and remap its contents as if they were column values.
  if (isJsonColumn(column)) {
    return value;
  }

  // A `date` column read in drizzle's `'date'` mode arrives as a JS `Date` at UTC midnight;
  // the `Date` scalar transports the day it names, not the instant. An unrepresentable value
  // is left for the scalar to reject rather than silently reformatted.
  if (value instanceof Date && isDateOnlyColumn(column)) {
    return dateToCalendarDate(value) ?? value;
  }

  // A SQLite integer timestamp arrives as a `Date`: drizzle decodes it on every path the library
  // reads through, aggregates included (`min`/`max` are `mapWith(column)`). A row that skipped the
  // column's decoder (a hand-built one, say) holds the stored integer instead, in the column's own
  // unit — read it as that unit here, because the `DateTime` scalar reads any number as
  // milliseconds.
  if (typeof value === 'number' && isSQLiteTimestampColumn(column)) {
    const instant = sqliteTimestampToDate(column, value);
    return Number.isNaN(instant.getTime()) ? value : instant.toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  // A MySQL `timestamp` / `datetime` read in `'string'` mode arrives as MySQL's offset-less text,
  // which the `DateTime` scalar does not accept; it names a UTC instant (see
  // `mySqlDateTimeTextToIso`).
  if (typeof value === 'string' && isMySqlDateTimeStringColumn(column)) {
    return mySqlDateTimeTextToIso(value);
  }

  // A Postgres `timestamp` read in `'string'` mode arrives as Postgres's own text, which the
  // `DateTime` scalar does not accept either (see `pgTimestampTextToIso`).
  if (typeof value === 'string' && isPgTimestampStringColumn(column)) {
    return pgTimestampTextToIso(value);
  }

  // A `bytea` / SQLite `blob({ mode: 'buffer' })` value: a Node `Buffer` from most drivers, a
  // plain `Uint8Array` from some (PGlite). Either is the `[Int!]` list of its bytes.
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    // A float tuple or vector (`point` / `line` in tuple mode, `geometry`, `vector`,
    // `halfvec`) is one value that happens to be a list of numbers.
    if (isFloatTupleColumn(column)) {
      return value;
    }

    return value.map((arrVal) => remapToGraphQLCore(key, arrVal, tableName, column, relationMap));
  }

  if (typeof value === 'object' && value !== null) {
    // An object-valued column (`point` in `'xy'` mode, `line` in `'abc'` mode, a geometry
    // object) is carried as the object itself, by `PgGeometryObject` or the `JSON` scalar.
    if (((column as any).dataType ?? '').startsWith('object')) {
      return value;
    }

    return JSON.stringify(value);
  }

  return value;
};

/**
 * Where a remapped row keeps the values its columns held before remapping, by property name —
 * only for the columns remapping changed. The output form is not always reversible: a
 * microsecond timestamp read in `'string'` mode leaves as an ISO string the `DateTime` input
 * side would cut to milliseconds. A relation field correlating on the row's join columns reads
 * them from here (see `parentJoinValues`). Non-enumerable, so the row's own keys, JSON form and
 * equality are unchanged.
 */
const RAW_COLUMN_VALUES = Symbol('drizzle-graphql.rawColumnValues');

/**
 * The value column `key` held in `row` before remapping: `{ found: true, value }` when remapping
 * changed it, `{ found: false }` when it did not (or the row was never remapped), in which case
 * `row[key]` is still the column's own value.
 */
export const rawColumnValue = (row: Record<string, any>, key: string): { found: boolean; value?: unknown } => {
  const raw: Record<string, unknown> | undefined = row[RAW_COLUMN_VALUES as any];
  return raw && key in raw ? { found: true, value: raw[key] } : { found: false };
};

const keepRawColumnValue = (row: Record<string, any>, key: string, value: unknown) => {
  let raw: Record<string, unknown> | undefined = row[RAW_COLUMN_VALUES as any];
  if (!raw) {
    // No prototype, so `in` sees only the columns kept here.
    raw = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(row, RAW_COLUMN_VALUES, { value: raw, enumerable: false, configurable: true });
  }
  // A row remapped a second time already holds its output form; the first value is the raw one.
  if (!(key in raw)) {
    raw[key] = value;
  }
};

export const remapToGraphQLSingleOutput = (
  queryOutput: Record<string, any>,
  tableName: string,
  table: Table,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
) => {
  const columns = getColumns(table);

  for (const [key, value] of Object.entries(queryOutput)) {
    if (value === undefined || value === null) {
      // Preserve an explicitly-null TO-ONE relation field (eager-loaded with no related
      // row) as null, so the relation's field resolver returns null directly instead of
      // re-querying it through the batch loader. Only to-one relations are nullable; a
      // to-many relation is a non-null list, so a null there must fall through to deletion
      // (the field resolver then resolves it to []) rather than be emitted as null.
      const relEntry = value === null ? relationMap?.[tableName]?.[key] : undefined;
      if (relEntry && is(relEntry.relation, One)) {
        queryOutput[key] = null;
        continue;
      }
      delete queryOutput[key];
      continue;
    }

    const column = columns[key];

    const remapped = remapToGraphQLCore(key, value, tableName, column, relationMap);
    if (column && remapped !== value) {
      keepRawColumnValue(queryOutput, key, value);
    }
    queryOutput[key] = remapped;
  }

  return queryOutput;
};

export const remapToGraphQLArrayOutput = (
  queryOutput: Record<string, any>[],
  tableName: string,
  table: Table,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
) => {
  for (const entry of queryOutput) {
    remapToGraphQLSingleOutput(entry, tableName, table, relationMap);
  }

  return queryOutput;
};

export const remapFromGraphQLCore = (value: any, column: Column, columnName: string): any => {
  // `null` is SQL NULL whatever the column's type, so there is nothing to coerce — and the
  // coercing branches below would get it wrong rather than fail: `new Date(null)` is the
  // epoch, not an invalid date, and `BigInt(null)` throws. Whether the column may hold a
  // null is the caller's question (see `remapFromGraphQLSingleInput`), not this function's.
  if (value === null) {
    return null;
  }

  // Columns whose input type is a scalar override receive exactly what that scalar's
  // parseValue/parseLiteral produced — coercion is the scalar's job, so the value goes to
  // the driver untouched. Only the null-prototype normalization still applies (it undoes a
  // graphql-js artifact, not a coercion — see the default case below).
  if (getColumnScalarOverride(column, true)) {
    if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null) {
      return Object.assign({}, value);
    }
    return value;
  }

  // drizzle-orm v1 uses compound dataType strings (e.g. "object date", "bigint int64").
  // We must check inclusion rather than equality to handle these cases.
  const dataType: string = (column as any).dataType ?? '';

  // Timestamp/datetime columns: Postgres and MySQL `timestamp`, MySQL `datetime` (either mode),
  // and SQLite's integer timestamps. Pure DATE columns are handled below.
  //
  // A SQLite integer timestamp takes the `Date`, which drizzle's `mapToDriverValue` turns into
  // the stored integer: milliseconds for `'timestamp_ms'`, and for `'timestamp'` whole seconds,
  // floored — `…T10:00:00.999Z` is stored, and read back, as `…T10:00:00Z`. Filter operands go
  // through here and the same encoder, so `eq` matches the row that input would have written;
  // `filters.ts` (`secondsBoundOperand`) rounds `lt` / `gte` operands up instead.
  const columnType: string = (column as any).columnType ?? '';
  if (isDateTimeColumn(column)) {
    // `timestamp().array()` keeps the timestamp column type with a `dimensions` count, so an
    // array here is a list of instants, converted element by element.
    if (Array.isArray(value)) {
      return value.map((element) => remapFromGraphQLCore(element, column, columnName));
    }
    const isMySql = columnType.startsWith('MySql');
    const isPgString = isPgTimestampStringColumn(column);
    // MySQL / Postgres text with no offset is read as UTC, as on output — `new Date()` would read
    // it in the server's local zone. The `DateTime` scalar never produces it; an `entities` caller
    // might.
    const toIso = isMySql ? mySqlDateTimeTextToIso : isPgString ? pgTimestampTextToIso : undefined;
    const formatted = new Date(toIso && typeof value === 'string' ? toIso(value) : value);
    if (Number.isNaN(formatted.getTime())) {
      throw drizzleError(`Field '${columnName}' is not a valid date!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
    }

    // A `'string'`-mode MySQL column takes MySQL's own text, written in UTC. A `'date'`-mode
    // column takes the `Date`; drizzle's `mapToDriverValue` formats it with `toISOString`, so it
    // is written in UTC too rather than in mysql2's local-time formatting.
    //
    // A `'string'`-mode Postgres column takes a string, in the form its type reads without
    // ambiguity: `timestamptz` the ISO instant (`…Z`); `timestamp` the UTC wall time with no
    // offset, because Postgres silently drops an offset written to a `timestamp` column.
    if (isPgString) {
      return (column as any).withTimezone ? formatted.toISOString() : dateToUtcWallText(formatted);
    }
    return isMySqlDateTimeStringColumn(column) ? dateToUtcWallText(formatted) : formatted;
  }

  // Date-only columns, either drizzle mode. The `Date` scalar has already checked the value is
  // a `YYYY-MM-DD` calendar day, and that string is what goes to the driver for both modes:
  // drizzle passes a string through to a `'date'`-mode column untouched, and a string is the
  // one form that cannot be shifted by a timezone (mysql2 formats a JS `Date` in local time).
  // The check is repeated here because not every caller is the scalar — `entities` resolvers
  // can be called with hand-built args — and a JS `Date` from such a caller is read as the UTC
  // day it encodes, the same way the output side reads one.
  if (isDateOnlyColumn(column)) {
    // `date().array()` keeps the date column type with a `dimensions` count, so an array here
    // is a list of days, checked element by element.
    if (Array.isArray(value)) {
      return value.map((element) => remapFromGraphQLCore(element, column, columnName));
    }
    const day = value instanceof Date ? dateToCalendarDate(value) : value;
    if (typeof day !== 'string' || !isCalendarDate(day)) {
      throw drizzleError(`Field '${columnName}' is not a valid date! Expected a calendar date as YYYY-MM-DD.`, {
        code: 'DRIZZLE_INVALID_INPUT_VALUE',
      });
    }

    return day;
  }

  // BigInt columns (SQLite: "bigint int64", others: "bigint"). `bigint().array()` is a list of
  // them, converted element by element.
  if (dataType.includes('bigint')) {
    if (Array.isArray(value)) {
      return value.map((element) => remapFromGraphQLCore(element, column, columnName));
    }
    try {
      return BigInt(value);
    } catch {
      throw drizzleError(`Field '${columnName}' is not a BigInt!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
    }
  }

  // JSON columns (SQLite: "object json", PG: "object json"). The `JSON` scalar has already
  // parsed the literal, so the value goes to the driver untouched — parsing it again here would
  // wrongly reject a JSON value that happens to be a string, like `"hello"`.
  if (isJsonColumn(column)) {
    return value;
  }

  // Byte columns — Postgres `bytea`, SQLite `blob({ mode: 'buffer' })`, both `"object buffer"`
  // — take their bytes as an `[Int!]` list. `bytea().array()` is a list of those lists.
  if (isBufferColumn(column)) {
    if (!Array.isArray(value)) {
      throw drizzleError(`Field '${columnName}' is not an array!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
    }
    if ((column as any).dimensions > 0 && value.every((element) => element === null || Array.isArray(element))) {
      return value.map((element) => remapFromGraphQLCore(element, column, columnName));
    }
    if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw drizzleError(`Field '${columnName}' is not a list of bytes! Expected integers from 0 to 255.`, {
        code: 'DRIZZLE_INVALID_INPUT_VALUE',
      });
    }

    return Buffer.from(value);
  }

  // Float tuples and vectors ("array point", "array line", "array geometry", "array vector",
  // "array halfvector"): one value written as a list of numbers. The tuples have a fixed length.
  if (isFloatTupleColumn(column)) {
    if (!Array.isArray(value)) {
      throw drizzleError(`Field '${columnName}' is not an array!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
    }

    const length = floatTupleLength(column);
    if (length !== undefined && value.length !== length) {
      throw drizzleError(
        `Invalid float tuple in field '${columnName}': expected array with length of ${length}, received ${value.length}`,
        { code: 'DRIZZLE_INVALID_INPUT_VALUE' },
      );
    }

    return value;
  }

  // graphql-js coerces input object types using Object.create(null), producing
  // null-prototype objects. Drizzle's internal is() check accesses
  // Object.getPrototypeOf(value).constructor and throws for null-prototype objects.
  // Convert to a plain object so drizzle can process it safely.
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null) {
    return Object.assign({}, value);
  }
  return value;
};

/**
 * Which write an input is being remapped for. It decides one thing only: what an explicit
 * `null` means for a `notNull` column — see {@link remapFromGraphQLSingleInput}.
 */
export type RemapInputOperation = 'insert' | 'update';

export const remapFromGraphQLSingleInput = (
  queryInput: Record<string, any>,
  table: Table,
  operation: RemapInputOperation = 'insert',
) => {
  const columns = getColumns(table);

  for (const [key, value] of Object.entries(queryInput)) {
    if (value === undefined) {
      delete queryInput[key];
    } else {
      const column = columns[key];
      if (!column) {
        throw drizzleError(`Unknown column: ${key}`, { code: 'DRIZZLE_UNKNOWN_COLUMN' });
      }

      // An explicit `null` for a column that cannot hold one reads differently on each side
      // of a write, because the generated input types mean different things by nullability.
      //
      // On INSERT a `notNull` column's field is only nullable when the database or drizzle
      // can fill it in — `defaultIsNullable` is passed for the create input, so the field is
      // non-null unless the column has a default, or a nested `create` supplies it. So the
      // only nulls that reach here are ones the schema itself offered as "I am not supplying
      // this", and dropping the key is what lets the default apply. That contract is pinned
      // by `upsert-null-key.test.ts` and `not-null-writes.test.ts`.
      //
      // On UPDATE every field is nullable — the update input forces it, whatever the column
      // — so nullability says nothing, and there is no default to fall back to. `null` can
      // only mean "write null", which this column cannot hold. Dropping it used to report
      // either a wrong success (the rest of the `set` landed, this column silently kept its
      // old value) or a misleading `DRIZZLE_NO_VALUES` when it was the only field.
      if (value === null && column.notNull) {
        if (operation === 'update') {
          throw drizzleError(`Column '${key}' cannot be set to null.`, { code: 'DRIZZLE_NOT_NULL' });
        }
        delete queryInput[key];
        continue;
      }

      queryInput[key] = remapFromGraphQLCore(value, column, key);
    }
  }

  return queryInput;
};

export const remapFromGraphQLArrayInput = (
  queryInput: Record<string, any>[],
  table: Table,
  operation: RemapInputOperation = 'insert',
) => {
  for (const entry of queryInput) {
    remapFromGraphQLSingleInput(entry, table, operation);
  }

  return queryInput;
};
