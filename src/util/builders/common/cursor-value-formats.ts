// What a cursor value of the right kind must also look like for its column to hold it. A forged
// cursor can carry text no uuid, numeric or inet parses, a label outside an enum, or an integer
// past its column's range. PostgreSQL refuses those with a cast error (an internal error) and
// MySQL compares them as something else (a page from the wrong position), so the cursor is
// refused first. Each grammar admits at least every text the database prints for the type.

import { type Column, extractExtendedColumnType, is } from 'drizzle-orm';
import {
  MySqlBigInt64,
  MySqlBigIntString,
  MySqlDecimal,
  MySqlEnumColumn,
  MySqlEnumObjectColumn,
} from 'drizzle-orm/mysql-core';
import {
  PgBigInt64,
  PgBigIntString,
  PgBigSerial64,
  PgCidr,
  PgColumn,
  PgEnumColumn,
  PgEnumObjectColumn,
  PgInet,
  PgMacaddr,
  PgMacaddr8,
  PgNumeric,
  PgReal,
  PgUUID,
} from 'drizzle-orm/pg-core';
import { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/** PostgreSQL's input forms: 32 hex digits in either case, a hyphen allowed after any group of four, optionally braced. */
const UUID_TEXT = /^(?:\{[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(?:-?[0-9a-f]{4}){7})$/i;

/** A decimal as both databases print it; PostgreSQL also prints its NaN and infinities. */
const DECIMAL_TEXT = /^-?(?<whole>\d+)(?:\.(?<fraction>\d+))?$/;
const PG_NUMERIC_SPECIALS: ReadonlySet<string> = new Set(['NaN', 'Infinity', '-Infinity']);
/** PostgreSQL's numeric limits: 131072 digits before the point, 16383 after. */
const PG_NUMERIC_MAX_WHOLE_DIGITS = 131072;
const PG_NUMERIC_MAX_FRACTION_DIGITS = 16383;

const isPgNumericText = (text: string): boolean => {
  if (PG_NUMERIC_SPECIALS.has(text)) {
    return true;
  }
  const digits = DECIMAL_TEXT.exec(text)?.groups;
  return (
    !!digits &&
    digits['whole']!.length <= PG_NUMERIC_MAX_WHOLE_DIGITS &&
    (digits['fraction']?.length ?? 0) <= PG_NUMERIC_MAX_FRACTION_DIGITS
  );
};

const INTEGER_TEXT = /^-?\d+$/;

/** The values each integer constraint holds, inclusive. `int53` / `uint53` are 64-bit columns read as JS numbers, which round their extremes up to 2^63 / 2^64. */
const INTEGER_RANGES: Readonly<Record<string, readonly [bigint, bigint]>> = {
  int8: [-(2n ** 7n), 2n ** 7n - 1n],
  int16: [-(2n ** 15n), 2n ** 15n - 1n],
  int24: [-(2n ** 23n), 2n ** 23n - 1n],
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  int53: [-(2n ** 63n), 2n ** 63n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint8: [0n, 2n ** 8n - 1n],
  uint16: [0n, 2n ** 16n - 1n],
  uint24: [0n, 2n ** 24n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  uint53: [0n, 2n ** 64n],
  uint64: [0n, 2n ** 64n - 1n],
};

/** Whether a whole number lies in its column's integer range; a column with no listed range takes any. */
const inIntegerRange = (col: Column, value: bigint): boolean => {
  const range = INTEGER_RANGES[extractExtendedColumnType(col).constraint ?? ''];
  return !range || (value >= range[0] && value <= range[1]);
};

/** A PostgreSQL `real` refuses a finite value float32 overflows to infinity or underflows to zero. */
const fitsPgReal = (value: number): boolean => {
  const single = Math.fround(value);
  return !Number.isFinite(value) || (Number.isFinite(single) && (single !== 0 || value === 0));
};

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_TEXT = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;
const NETWORK_PREFIX = /^(?:0|[1-9]\d{0,2})$/;

/** An IPv6 address: eight hex groups, or fewer around one `::`, the last two optionally written as IPv4. */
const isIpv6Text = (text: string): boolean => {
  const halves = text.split('::');
  if (halves.length > 2) {
    return false;
  }
  const groups = halves.flatMap((half) => (half === '' ? [] : half.split(':')));
  const lastHalf = halves[halves.length - 1]!;
  const embedsIpv4 = lastHalf !== '' && groups[groups.length - 1]!.includes('.');
  if (embedsIpv4 && !IPV4_TEXT.test(groups.pop()!)) {
    return false;
  }
  const width = groups.length + (embedsIpv4 ? 2 : 0);
  return groups.every((group) => IPV6_GROUP.test(group)) && (halves.length === 2 ? width <= 7 : width === 8);
};

/**
 * An `inet` / `cidr` as PostgreSQL prints it: an IPv4 or IPv6 address with an optional
 * `/prefix` in its family's range. A cidr's bits right of its mask are not checked: PostgreSQL
 * compares such a value as an inet without complaint.
 */
const isInetText = (text: string): boolean => {
  const [address = '', prefix, ...rest] = text.split('/');
  if (rest.length) {
    return false;
  }
  const isIpv4 = IPV4_TEXT.test(address);
  if (!isIpv4 && !isIpv6Text(address)) {
    return false;
  }
  return prefix === undefined || (NETWORK_PREFIX.test(prefix) && Number(prefix) <= (isIpv4 ? 32 : 128));
};

/** A MAC address as PostgreSQL prints it: hex pairs in either case, joined by `:` (or, consistently, `-`). */
const MACADDR_TEXT = /^[0-9a-f]{2}(?<sep>[:-])[0-9a-f]{2}(?:\k<sep>[0-9a-f]{2}){4}$/i;
/** `macaddr8` prints eight pairs and reads a six-pair address too. */
const MACADDR8_TEXT = /^[0-9a-f]{2}(?<sep>[:-])[0-9a-f]{2}(?:\k<sep>[0-9a-f]{2}){4}(?:(?:\k<sep>[0-9a-f]{2}){2})?$/i;

const enumHolds = (col: Column, text: string): boolean =>
  ((col as any).enumValues as readonly string[] | undefined)?.includes(text) ?? true;

/** Column classes, each with what a string cursor value for it must be. */
const STRING_FORMATS: ReadonlyArray<
  readonly [abstract new (...args: any[]) => Column, (col: Column, text: string) => boolean]
> = [
  [PgUUID, (_col, text) => UUID_TEXT.test(text)],
  [PgNumeric, (_col, text) => isPgNumericText(text)],
  [MySqlDecimal, (_col, text) => DECIMAL_TEXT.test(text)],
  [PgBigIntString, (col, text) => INTEGER_TEXT.test(text) && inIntegerRange(col, BigInt(text))],
  [MySqlBigIntString, (col, text) => INTEGER_TEXT.test(text) && inIntegerRange(col, BigInt(text))],
  [PgEnumColumn, enumHolds],
  [PgEnumObjectColumn, enumHolds],
  // Outside strict mode MySQL stores a value no label matches as the empty string, index 0.
  [MySqlEnumColumn, (col, text) => text === '' || enumHolds(col, text)],
  [MySqlEnumObjectColumn, (col, text) => text === '' || enumHolds(col, text)],
  [PgInet, (_col, text) => isInetText(text)],
  [PgCidr, (_col, text) => isInetText(text)],
  [PgMacaddr, (_col, text) => MACADDR_TEXT.test(text)],
  [PgMacaddr8, (_col, text) => MACADDR8_TEXT.test(text)],
];

/** 64-bit integer columns read as JS bigints; numeric / decimal in bigint mode hold any whole number. */
const INT64_COLUMNS = [PgBigInt64, PgBigSerial64, MySqlBigInt64] as const;

/**
 * Whether a string-mode column also reads some of its values as JS numbers. mysql2 (run with
 * `supportBigNumbers` by drizzle) returns a BIGINT that fits a double as a number and only a
 * larger one as a string, and drizzle's relational queries pass either on, so a cursor issued
 * from a `bigint({ mode: 'string' })` column carries whichever the row held.
 */
export const readsNumbersForStrings = (col: Column): boolean => is(col, MySqlBigIntString);

/**
 * Whether a cursor value already of its column's kind is also one the column can hold:
 * - a string matches its column's grammar above, and holds no NUL on PostgreSQL, whose text
 *   cannot;
 * - a number or bigint lies in its integer column's range (SQLite stores any number in any
 *   column), and a number fits a PostgreSQL `real`; a number for a string-mode column
 *   ({@link readsNumbersForStrings}) is a whole one in the column's range.
 * A column type not listed takes any value of its kind.
 */
export const cursorValueFormatFits = (col: Column, value: unknown): boolean => {
  if (typeof value === 'string') {
    if (is(col, PgColumn) && value.includes('\u0000')) {
      return false;
    }
    const format = STRING_FORMATS.find(([type]) => is(col, type as any))?.[1];
    return !format || format(col, value);
  }
  if (typeof value === 'bigint') {
    return !INT64_COLUMNS.some((type) => is(col, type)) || inIntegerRange(col, value);
  }
  if (typeof value === 'number') {
    if (is(col, PgReal)) {
      return fitsPgReal(value);
    }
    if (readsNumbersForStrings(col)) {
      return Number.isInteger(value) && inIntegerRange(col, BigInt(value));
    }
    return is(col, SQLiteColumn) || !Number.isInteger(value) || inIntegerRange(col, BigInt(value));
  }
  return true;
};
