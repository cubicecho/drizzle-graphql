// Compiling one column's filter operators into SQL, including the LIKE escaping and the
// JSON-path machinery the JSON operators are built on.

import type { Column } from 'drizzle-orm';
import {
  and,
  arrayContains,
  arrayOverlaps,
  bindIfParam,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  is,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notIlike,
  notInArray,
  notLike,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { MySqlFloat } from 'drizzle-orm/mysql-core';
import { SQLiteTimestamp } from 'drizzle-orm/sqlite-core';
import { remapFromGraphQLCore } from '../../data-mappers/index.ts';
import type { FilterColumnOperators, FilterColumnOperatorsCore } from '../types.ts';
import { columnDialect, isJsonColumn } from './column-filters.ts';
import { drizzleError } from './errors.ts';

/**
 * Escape character pinned via `ESCAPE` on every generated safe-LIKE predicate. Bound as a
 * query parameter (never spliced into the SQL text), so no dialect-specific string-literal
 * escaping rules apply to it.
 */
const LIKE_ESCAPE_CHAR = '\\';

/**
 * Escapes the LIKE wildcards (`%`, `_`) and the escape character itself (`\`) in a literal
 * search term, so the term only ever matches literally inside a LIKE pattern.
 */
const escapeLikeValue = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * The injection-safe string operators: the caller passes a literal search term, the library
 * builds the LIKE pattern with the term's `%` / `_` / `\` escaped and the `ESCAPE` clause pinned.
 * The `i`-prefixed variants match case-insensitively.
 */
const safeLikeOps: Record<
  string,
  { buildPattern: (value: string) => string; buildGlob: (value: string) => string; insensitive: boolean }
> = {
  startsWith: {
    buildPattern: (value) => `${escapeLikeValue(value)}%`,
    buildGlob: (value) => `${escapeGlobValue(value)}*`,
    insensitive: false,
  },
  endsWith: {
    buildPattern: (value) => `%${escapeLikeValue(value)}`,
    buildGlob: (value) => `*${escapeGlobValue(value)}`,
    insensitive: false,
  },
  contains: {
    buildPattern: (value) => `%${escapeLikeValue(value)}%`,
    buildGlob: (value) => `*${escapeGlobValue(value)}*`,
    insensitive: false,
  },
  iStartsWith: {
    buildPattern: (value) => `${escapeLikeValue(value)}%`,
    buildGlob: (value) => `${escapeGlobValue(value)}*`,
    insensitive: true,
  },
  iEndsWith: {
    buildPattern: (value) => `%${escapeLikeValue(value)}`,
    buildGlob: (value) => `*${escapeGlobValue(value)}`,
    insensitive: true,
  },
  iContains: {
    buildPattern: (value) => `%${escapeLikeValue(value)}%`,
    buildGlob: (value) => `*${escapeGlobValue(value)}*`,
    insensitive: true,
  },
};

/**
 * Escapes SQLite's `GLOB` wildcards (`*`, `?`, `[`) in a literal search term by wrapping each in
 * a one-character class, so the term only ever matches literally inside a GLOB pattern. GLOB
 * has no escape character; `]` outside a class and everything else is already literal.
 */
const escapeGlobValue = (value: string): string => value.replace(/[*?[]/g, (char) => `[${char}]`);

/**
 * A caller-written LIKE pattern as the GLOB pattern matching the same strings, for SQLite's
 * case-sensitive `like` / `notLike`: `%` → `*`, `_` → `?`, and GLOB's own wildcards escaped.
 *
 * `\` escapes the character after it, as it does in a LIKE pattern on PostgreSQL and MySQL
 * (both default LIKE's escape character to backslash): `100\%` matches the text `100%`, and
 * `\\` a single backslash. GLOB has no escape character, so an escaped character is emitted as
 * a literal — inside a one-character class when it is one of GLOB's own wildcards. A trailing
 * lone `\` has nothing to escape and matches itself.
 */
const likePatternToGlob = (pattern: string): string =>
  pattern.replace(/\\([\s\S])|[%_*?[]/g, (match, escaped: string | undefined) => {
    const char = escaped ?? match;
    if (escaped === undefined && char === '%') {
      return '*';
    }
    if (escaped === undefined && char === '_') {
      return '?';
    }
    return char === '*' || char === '?' || char === '[' ? `[${char}]` : char;
  });

/**
 * The safe string operator's predicate. Case-insensitive variants use Postgres's native
 * `ILIKE`; MySQL and SQLite have no `ILIKE`, so they compare `lower()` on both sides instead
 * (mirroring how the raw `ilike` operator is Postgres-only).
 *
 * The case-sensitive variants are `LIKE <pattern> ESCAPE '\'`, except on SQLite, whose `LIKE`
 * folds ASCII case — `contains: "App"` would match `apple`. There they are `GLOB`, which is
 * case-sensitive, as `LIKE` is on Postgres. `dialectColumn` names the column the dialect is read
 * from when `column` is an expression over it (a JSON path read).
 */
const safeLikeCondition = (
  column: Column,
  value: string,
  op: (typeof safeLikeOps)[string],
  insensitive: boolean,
  dialectColumn: Column = column,
): SQL => {
  const pattern = op.buildPattern(value);
  if (!insensitive) {
    return columnDialect(dialectColumn) === 'sqlite'
      ? sql`${column} glob ${op.buildGlob(value)}`
      : sql`${column} like ${pattern} escape ${LIKE_ESCAPE_CHAR}`;
  }

  // The pattern is lowered by the database's own `lower()`, like the column: lowering it in JS
  // instead would fold characters the database does not (SQLite's `lower()` is ASCII-only), and
  // `iContains: "École"` would then miss the row holding exactly `École`. The escapes are
  // ASCII, so lowering the escaped pattern leaves them intact.
  const isPg = (((column as any).columnType ?? '') as string).startsWith('Pg');
  return isPg
    ? sql`${column} ilike ${pattern} escape ${LIKE_ESCAPE_CHAR}`
    : sql`lower(${column}) like lower(${pattern}) escape ${LIKE_ESCAPE_CHAR}`;
};

/**
 * The case-insensitive form of the raw `like` / `notLike` operators, whose operand is a
 * caller-written pattern rather than a literal. Postgres has `ILIKE`; the other two dialects
 * compare `lower()` on both sides, exactly as {@link safeLikeCondition} does. The `ESCAPE '\'`
 * gives SQLite the backslash escape PostgreSQL's and MySQL's LIKE already default to, so
 * `100\%` matches a literal `%` on all three.
 */
const insensitiveLike = (column: Column, pattern: string, negated: boolean): SQL => {
  if (columnDialect(column) === 'pg') {
    return negated ? notIlike(column, pattern) : ilike(column, pattern);
  }
  return negated
    ? sql`lower(${column}) not like lower(${pattern}) escape ${LIKE_ESCAPE_CHAR}`
    : sql`lower(${column}) like lower(${pattern}) escape ${LIKE_ESCAPE_CHAR}`;
};

/**
 * SQL spelling of each comparison operator, for the case-insensitive forms that have to be
 * written out rather than built by drizzle's `eq`/`ne`/`lt`/… helpers.
 */
const COMPARISON_SQL: Record<string, string> = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };

/**
 * `insensitive: true` folds case out of every comparison beside it by comparing
 * `lower(column)` against `lower(operand)`. Lowercasing both sides in SQL — rather than the
 * operand in JS — keeps the comparison under one collation, and `lower(column)` is an
 * expression a matching index can serve, which `ilike '%…%'` never can. It is the same
 * `lower()` the case-insensitive LIKE operators already fall back to on the dialects without
 * a native `ILIKE`, so it adds no dialect surface.
 */
export const lowerComparison = (column: Column, operatorName: string, value: unknown): SQL =>
  sql`lower(${column}) ${sql.raw(COMPARISON_SQL[operatorName]!)} lower(${value})`;

/** `lower(column) IN (lower($1), …)` / `NOT IN` — the case-insensitive `inArray`/`notInArray`. */
const lowerMembership = (column: Column, values: unknown[], negated: boolean): SQL => {
  const lowered = sql.join(
    values.map((value) => sql`lower(${value})`),
    sql`, `,
  );
  return negated ? sql`lower(${column}) not in (${lowered})` : sql`lower(${column}) in (${lowered})`;
};

/**
 * Structural JSON containment for the `contains` operator on json/jsonb columns.
 * The value is serialized and bound as a parameter (never interpolated into the SQL text):
 * - Postgres: `col @> $1::jsonb` (a plain `json` column is cast through jsonb — `json` has
 *   no containment operator of its own)
 * - MySQL: `JSON_CONTAINS(col, ?)`
 * SQLite has no containment operator, so the filter input never exposes `contains` there;
 * reaching this with an unsupported dialect is a programming error surfaced as a GraphQLError.
 */
const jsonContains = (column: Column, columnName: string, value: any): SQL => {
  const serialized = JSON.stringify(value);

  switch (columnDialect(column)) {
    case 'pg':
      return (column as any).columnType === 'PgJson'
        ? sql`${column}::jsonb @> ${serialized}::jsonb`
        : sql`${column} @> ${serialized}::jsonb`;
    case 'mysql':
      return sql`json_contains(${column}, ${serialized})`;
    default:
      throw drizzleError(`WHERE ${columnName}: Operator 'contains' is not supported for this dialect!`, {
        code: 'DRIZZLE_INVALID_FILTER',
      });
  }
};

/**
 * The nodes of a SQLite JSON document as `(path, kind, value)` rows, for a structural
 * comparison. Integers and reals share one kind so `1` and `1.0` are the same number, as they
 * are on the other two dialects.
 */
const sqliteJsonNodes = (document: unknown): SQL =>
  sql`select fullkey, case when type in ('integer', 'real') then 'number' else type end, atom from json_tree(${document})`;

/**
 * Whole-document `eq` / `ne` on a JSON column, comparing documents rather than their text:
 * - Postgres: as `jsonb` (a plain `json` column has no `=` operator at all)
 * - MySQL: against `CAST(? AS JSON)`; a bare string parameter would be a JSON string scalar
 * - SQLite: the two documents' node sets must match both ways, so object key order and
 *   whitespace do not matter, while array order still does
 * A SQL NULL column matches neither, as with `=` / `<>` on any other column.
 */
const jsonEquality = (column: Column, columnName: string, value: unknown, negated: boolean): SQL => {
  const serialized = JSON.stringify(value);
  switch (columnDialect(column)) {
    case 'pg': {
      const left = (column as any).columnType === 'PgJson' ? sql`${column}::jsonb` : sql`${column}`;
      return negated ? sql`${left} <> ${serialized}::jsonb` : sql`${left} = ${serialized}::jsonb`;
    }
    case 'mysql':
      return negated ? sql`${column} <> cast(${serialized} as json)` : sql`${column} = cast(${serialized} as json)`;
    case 'sqlite': {
      const equal = sql`(not exists (${sqliteJsonNodes(column)} except ${sqliteJsonNodes(serialized)}) and not exists (${sqliteJsonNodes(serialized)} except ${sqliteJsonNodes(column)}))`;
      return negated ? sql`(${column} is not null and not ${equal})` : sql`(${column} is not null and ${equal})`;
    }
    default:
      throw drizzleError(`WHERE ${columnName}: JSON equality is not supported for this dialect!`, {
        code: 'DRIZZLE_INVALID_FILTER',
      });
  }
};

/** The largest `FLOAT(p)` precision MySQL still stores in single precision; above it is DOUBLE. */
const MYSQL_SINGLE_PRECISION_MAX = 24;

/** Whether a MySQL `float` column stores single-precision values (`float`, `float(p,s)`, `float(p ≤ 24)`). */
export const isMySqlSingleFloat = (column: Column): boolean =>
  is(column, MySqlFloat) &&
  (column.precision === undefined || column.scale !== undefined || column.precision <= MYSQL_SINGLE_PRECISION_MAX);

/**
 * A value bound for comparison against `column`. MySQL compares a single-precision `float` with a
 * bound double in double precision, so `0.1` never equals the stored `0.1` and a cursor never gets
 * past its own row. There the operand is cast to `float` (MySQL 8.0.17+) so both sides round alike.
 */
export const comparableOperand = (column: Column, value: unknown): unknown =>
  isMySqlSingleFloat(column) ? sql`cast(${bindIfParam(value, column)} as float)` : value;

const MS_PER_SECOND = 1000;

/**
 * Whether `value` is an instant between two whole seconds compared against a SQLite
 * `integer({ mode: 'timestamp' })` column, which stores whole seconds. Its driver encoder floors
 * the operand, which is the right bound for every operator but `lt` / `gte`.
 */
const isBetweenStoredSeconds = (column: Column, value: unknown): value is Date =>
  is(column, SQLiteTimestamp) &&
  column.mode === 'timestamp' &&
  value instanceof Date &&
  value.getTime() % MS_PER_SECOND !== 0;

/** Operators whose bound is the next whole second when the operand lies between two stored seconds. */
const CEILED_SECOND_OPERATORS: ReadonlySet<string> = new Set(['lt', 'gte']);

/**
 * The operand a comparison binds on a seconds-mode SQLite timestamp. `lt` / `gte` take the next
 * whole second, so `lt: "…10:00:00.500Z"` keeps the row stored at `…10:00:00Z` and `gte` drops
 * it. Every other operator keeps the floored operand, so `eq` finds the row that value would
 * have written.
 */
const secondsBoundOperand = (column: Column, operatorName: string, value: unknown): unknown => {
  const roundsUp = CEILED_SECOND_OPERATORS.has(operatorName) && isBetweenStoredSeconds(column, value);
  if (!roundsUp) {
    return value;
  }
  return new Date(Math.ceil(value.getTime() / MS_PER_SECOND) * MS_PER_SECOND);
};

/**
 * A compiled filter. `undefined` is the **matches every row** result ({@link MATCHES_EVERY_ROW}):
 * the filter restricts nothing, so a read adds no condition and a write that requires a `where`
 * refuses it. It is never spelled as an always-true SQL predicate, which would hide it.
 */
export type CompiledFilter = SQL | undefined;

/** The compiled filter that restricts nothing — see {@link CompiledFilter}. */
export const MATCHES_EVERY_ROW = undefined;

/** Every predicate built by {@link matchesNoRow}, so the boolean groups can fold it. */
const noRowPredicates = new WeakSet<SQL>();

/**
 * The constant "no row matches" predicate, for an operator whose operand list is empty
 * (`inArray: []`). Written as `1 = 0` rather than `FALSE` so it compiles on all three dialects,
 * and remembered so `NOT` of it can become {@link MATCHES_EVERY_ROW}. Built fresh per call
 * because a `SQL` object is spliced into whatever query consumes it.
 */
const matchesNoRow = (): SQL => {
  const predicate = sql`1 = 0`;
  noRowPredicates.add(predicate);
  return predicate;
};

const isMatchesNoRow = (filter: CompiledFilter): boolean => filter !== undefined && noRowPredicates.has(filter);

/**
 * True when `condition` is FALSE or NULL. `NOT condition` is NULL for a NULL condition, so a row
 * it should select drops out. `1 = 0` stands in for FALSE, which older SQLite cannot spell.
 */
export const isNotTrue = (condition: SQL): SQL => sql`not coalesce(${condition}, 1 = 0)`;

/**
 * ANDs the conditions of one filter object together. A "no row matches" condition decides the
 * whole conjunction (`x AND false` is false even when `x` is NULL), so it is kept recognisable
 * rather than buried in an `and(...)`.
 */
export const allOf = (variants: SQL[]): CompiledFilter => {
  if (variants.some(isMatchesNoRow)) {
    return matchesNoRow();
  }
  return variants.length > 1 ? and(...variants) : variants[0];
};

/**
 * Compiles the `AND` / `NOT` / `OR` branches of one filter object onto `variants`, the
 * conditions its sibling keys already produced (all of which are ANDed together, see
 * {@link allOf}).
 *
 * A branch that compiles to {@link MATCHES_EVERY_ROW} — `{}`, `{ c: { isNull: false } }`,
 * `{ c: { notInArray: [] } }`, a relation `every: {}` — restricts nothing, and each branch reads
 * it that way:
 *
 * - in `AND`, it drops out, as `x AND true` is `x`;
 * - under `NOT`, it matches no row, as `NOT true` is false;
 * - in `OR`, it makes the whole group match every row, as `x OR true` is true — so the group
 *   adds no condition, rather than being narrowed to its other branches.
 *
 * A branch that matches no row is the mirror image: `NOT` of it matches every row, and in `OR`
 * it drops out (an `OR` of nothing but such branches matches no row). An empty `AND` or `OR`
 * list is treated as absent.
 */
export const compileBooleanBranches = <TBranch>(
  variants: SQL[],
  branches: { AND?: TBranch[] | null; NOT?: TBranch | null; OR?: TBranch[] | null },
  compile: (branch: TBranch) => CompiledFilter,
): void => {
  const { AND, NOT, OR } = branches;

  if (AND?.length) {
    for (const branch of AND) {
      const extracted = compile(branch);
      if (extracted) {
        variants.push(extracted);
      }
    }
  }

  if (NOT) {
    const extracted = compile(NOT);
    if (extracted === MATCHES_EVERY_ROW) {
      variants.push(matchesNoRow());
    } else if (!isMatchesNoRow(extracted)) {
      // `not()` is typed `SQL | undefined` from drizzle-orm rc.5 on, `SQL` before it.
      variants.push(not(extracted) ?? matchesNoRow());
    }
  }

  if (OR?.length) {
    const orVariants = [] as SQL[];
    let matchesAll = false;
    for (const branch of OR) {
      const extracted = compile(branch);
      if (extracted === MATCHES_EVERY_ROW) {
        // Still compiled the rest: an invalid filter in a later branch is an error either way.
        matchesAll = true;
      } else if (!isMatchesNoRow(extracted)) {
        orVariants.push(extracted);
      }
    }

    if (!matchesAll) {
      variants.push(orVariants.length ? (orVariants.length > 1 ? or(...orVariants)! : orVariants[0]!) : matchesNoRow());
    }
  }
};

/**
 * A MySQL / SQLite JSON path expression for the given key walk. Bound as a query parameter,
 * never spliced into the SQL text; an all-digits key becomes an array index, and quotes and
 * backslashes inside a key are escaped so a key can never end the path segment early.
 *
 * The two dialects read a quoted key's escapes differently: MySQL takes `\"`, while SQLite
 * ends the key at the first `"` whatever precedes it and only then decodes JSON escapes — so
 * there a quote is written as `\u0022`, which both its parser and JSON decoding read back as `"`.
 */
const jsonPathString = (path: string[], dialect: 'mysql' | 'sqlite'): string =>
  `$${path
    .map((part) => {
      if (/^\d+$/.test(part)) {
        return `[${part}]`;
      }
      const escaped = part.replace(/(["\\])/g, (char) =>
        char === '"' && dialect === 'sqlite' ? '\\u0022' : `\\${char}`,
      );
      return `."${escaped}"`;
    })
    .join('')}`;

/**
 * The names each dialect's JSON type function gives a JSON number and a JSON boolean. A
 * `NUMBER` or `BOOLEAN` read only sees a value of that JSON type, so the string `"3"` never
 * equals 3 and `"true"` never equals true, on any dialect.
 */
const JSON_VALUE_TYPE_NAMES: Record<'pg' | 'mysql' | 'sqlite', { number: string[]; boolean: string[] }> = {
  pg: { number: ['number'], boolean: ['boolean'] },
  mysql: { number: ['INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL'], boolean: ['BOOLEAN'] },
  sqlite: { number: ['integer', 'real'], boolean: ['true', 'false'] },
};

/** `type in ('a', 'b')`, with the fixed type names written as string literals. */
const typeIsOneOf = (type: SQL, names: string[]): SQL =>
  sql`${type} in (${sql.raw(names.map((name) => `'${name}'`).join(', '))})`;

/**
 * The value at a JSON path, as the expressions a comparison can be built on: read as text,
 * read as a number, and read as the dialect spells a boolean. The number and boolean reads
 * check the value's JSON type first (see {@link JSON_VALUE_TYPE_NAMES}) and are NULL for any
 * other type, so a value of the wrong shape answers "no match" rather than erroring or being
 * converted:
 *
 * - **Postgres** — `#>>` with a bound `text[]` path, which works on `json` and `jsonb` alike;
 *   the type comes from `json_typeof` / `jsonb_typeof` on `#>`, whichever the column is.
 * - **MySQL** — `JSON_UNQUOTE(JSON_EXTRACT(col, ?))`, so a JSON string arrives without its
 *   quotes. Unquoting a JSON *null* would otherwise yield the string `'null'`, so it is mapped
 *   back to SQL NULL first. The type comes from `JSON_TYPE`.
 * - **SQLite** — `json_extract` returns the value in SQLite's own type, so the reads cast
 *   explicitly: without that, SQLite's cross-type ordering puts every string above every
 *   number and `'admin' > 0` would be true. A JSON boolean comes back as 1 / 0, and
 *   `json_type` still tells `true` apart from `1`.
 */
const jsonPathExprs = (
  column: Column,
  path: string[],
): { text: SQL; number: SQL; boolean: SQL; encodeBoolean: (value: boolean) => string | number } => {
  switch (columnDialect(column)) {
    case 'pg': {
      const pathArray = sql`array[${sql.join(
        path.map((part) => sql`${part}`),
        sql`, `,
      )}]::text[]`;
      const text = sql`(${column} #>> ${pathArray})`;
      const typeOf = (column as any).columnType === 'PgJson' ? sql.raw('json_typeof') : sql.raw('jsonb_typeof');
      const type = sql`${typeOf}(${column} #> ${pathArray})`;
      const names = JSON_VALUE_TYPE_NAMES.pg;
      return {
        text,
        number: sql`(case when ${typeIsOneOf(type, names.number)} then ${text}::numeric end)`,
        boolean: sql`(case when ${typeIsOneOf(type, names.boolean)} then ${text} end)`,
        encodeBoolean: (value) => String(value),
      };
    }
    case 'mysql': {
      const extracted = sql`json_extract(${column}, ${jsonPathString(path, 'mysql')})`;
      const type = sql`json_type(${extracted})`;
      const text = sql`(case when ${type} = 'NULL' then null else json_unquote(${extracted}) end)`;
      const names = JSON_VALUE_TYPE_NAMES.mysql;
      return {
        text,
        number: sql`(case when ${typeIsOneOf(type, names.number)} then cast(${text} as decimal(65, 30)) end)`,
        boolean: sql`(case when ${typeIsOneOf(type, names.boolean)} then ${text} end)`,
        encodeBoolean: (value) => String(value),
      };
    }
    default: {
      const extracted = sql`json_extract(${column}, ${jsonPathString(path, 'sqlite')})`;
      const type = sql`json_type(${column}, ${jsonPathString(path, 'sqlite')})`;
      const names = JSON_VALUE_TYPE_NAMES.sqlite;
      return {
        text: sql`(case ${type} when 'true' then 'true' when 'false' then 'false' else cast(${extracted} as text) end)`,
        number: sql`(case when ${typeIsOneOf(type, names.number)} then ${extracted} end)`,
        boolean: sql`(case when ${typeIsOneOf(type, names.boolean)} then ${extracted} end)`,
        encodeBoolean: (value) => (value ? 1 : 0),
      };
    }
  }
};

/** Comparison operators available inside a JSON path filter, as their SQL spelling. */
const JSON_PATH_COMPARISONS: Record<string, string> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/**
 * How the value at a path is read when the filter does not say: a GraphQL number compares
 * numerically, a boolean as a boolean, everything else as text.
 */
const inferJsonPathCast = (value: unknown): 'text' | 'number' | 'boolean' =>
  typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';

/**
 * Compiles one entry of a column's `path` filter: `as` (or the operand's own type) picks
 * which of {@link jsonPathExprs}' reads the comparison is built on, and the operand is bound
 * in the shape that read expects.
 */
const jsonPathCondition = (column: Column, columnName: string, filter: Record<string, any>): SQL | undefined => {
  const { path, as: castOverride, ...operators } = filter;
  const locator = `${columnName}.path`;

  if (!Array.isArray(path) || !path.length) {
    throw drizzleError(`WHERE ${locator}: 'path' must name at least one key`, { code: 'DRIZZLE_INVALID_FILTER' });
  }

  const exprs = jsonPathExprs(column, path);
  const variants: SQL[] = [];

  for (const [operatorName, operatorValue] of Object.entries(operators)) {
    if (operatorValue === null || operatorValue === undefined) {
      continue;
    }

    if (operatorName === 'isNull' || operatorName === 'isNotNull') {
      if (operatorValue === false) {
        continue;
      }
      variants.push(operatorName === 'isNull' ? sql`${exprs.text} is null` : sql`${exprs.text} is not null`);
      continue;
    }

    if (operatorName in safeLikeOps) {
      const op = safeLikeOps[operatorName]!;
      if (typeof operatorValue !== 'string') {
        throw drizzleError(`WHERE ${locator}: operator '${operatorName}' takes a string`, {
          code: 'DRIZZLE_INVALID_FILTER',
        });
      }
      // The extracted value is an expression, not a column, so the case-insensitive form
      // always goes through `lower()` rather than Postgres's ILIKE.
      variants.push(safeLikeCondition(exprs.text as any, operatorValue, op, op.insensitive, column));
      continue;
    }

    const comparison = JSON_PATH_COMPARISONS[operatorName];
    if (!comparison) {
      throw drizzleError(`WHERE ${locator}: Unknown operator: ${operatorName}`, { code: 'DRIZZLE_INVALID_FILTER' });
    }

    const cast = castOverride ?? inferJsonPathCast(operatorValue);
    if (cast === 'number') {
      const numeric = Number(operatorValue);
      if (Number.isNaN(numeric)) {
        throw drizzleError(
          `WHERE ${locator}: operator '${operatorName}' compares as a number, so its value must be one`,
          { code: 'DRIZZLE_INVALID_FILTER' },
        );
      }
      variants.push(sql`${exprs.number} ${sql.raw(comparison)} ${numeric}`);
    } else if (cast === 'boolean') {
      const truthy = operatorValue === true || operatorValue === 'true';
      variants.push(sql`${exprs.boolean} ${sql.raw(comparison)} ${exprs.encodeBoolean(truthy)}`);
    } else {
      variants.push(sql`${exprs.text} ${sql.raw(comparison)} ${String(operatorValue)}`);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};

// The operator dispatch tables. Constant, and hoisted out of `extractFiltersColumn` — which
// recurses once per AND/OR/NOT branch of every filter of every request — so they are built
// once per process rather than five objects per call.
const singleValueOps: Record<string, (...args: any[]) => SQL> = { eq, ne, gt, gte, lt, lte };
const stringValueOps: Record<string, (...args: any[]) => SQL> = { like, notLike, ilike, notIlike };
const arrayValueOps: Record<string, (...args: any[]) => SQL> = { inArray, notInArray };
/** Membership operators for array columns: element list → SQL. Empty lists are rejected below. */
const arrayMembershipOps: Record<string, (...args: any[]) => SQL> = {
  hasSome: arrayOverlaps,
  hasEvery: arrayContains,
};
const nullableOps: Record<string, (...args: any[]) => SQL> = { isNull, isNotNull };
/** Operators whose operand is an on/off flag rather than a value: `false` adds no condition. */
const FLAG_OPERATORS: ReadonlySet<string> = new Set(['isNull', 'isNotNull', 'isEmpty']);

export const extractFiltersColumn = <TColumn extends Column>(
  column: TColumn,
  columnName: string,
  operators: FilterColumnOperators<TColumn>,
): CompiledFilter => {
  // Boolean branches compose with sibling operators: siblings and the AND list are ANDed
  // together, NOT negates its whole branch, and the OR group is ANDed with the rest.
  const { OR, AND, NOT, insensitive, ...restOperators } = operators;

  // `insensitive` is a modifier, not a predicate: it changes how the operators beside it
  // compile and contributes no condition of its own. It applies to this object only —
  // a nested AND/OR/NOT branch is a separate object and sets its own.
  const foldCase = insensitive === true;

  const entries = Object.entries(restOperators as FilterColumnOperatorsCore<TColumn>);

  const variants = [] as SQL[];
  for (const [operatorName, operatorValue] of entries) {
    // A null operand is an absent operand. `false` means "no restriction" only for the flag
    // operators (`isNull: false` and friends); every other operator binds it as a value, so
    // `eq: false` matches the false rows rather than dropping out and matching all of them.
    if (operatorValue === null || operatorValue === undefined) {
      continue;
    }
    if (operatorValue === false && FLAG_OPERATORS.has(operatorName)) {
      continue;
    }

    if ((operatorName === 'eq' || operatorName === 'ne') && isJsonColumn(column)) {
      variants.push(jsonEquality(column, columnName, operatorValue, operatorName === 'ne'));
    } else if (operatorName in singleValueOps) {
      const singleValue = secondsBoundOperand(
        column,
        operatorName,
        remapFromGraphQLCore(operatorValue, column, columnName),
      );
      variants.push(
        foldCase
          ? lowerComparison(column, operatorName, singleValue)
          : singleValueOps[operatorName]!(column, comparableOperand(column, singleValue)),
      );
    } else if (operatorName in stringValueOps) {
      // Under `insensitive`, `like`/`notLike` compile the same way their `i` counterparts
      // do; `ilike`/`notIlike` are already case-insensitive and are left alone.
      // MySQL and SQLite have no `ILIKE` keyword, so there `ilike`/`notIlike` go through the
      // same `lower()` form instead of drizzle's Postgres-only helpers.
      const isLike = operatorName === 'like' || operatorName === 'notLike';
      const isIlike = operatorName === 'ilike' || operatorName === 'notIlike';
      if ((isLike && foldCase) || (isIlike && columnDialect(column) !== 'pg')) {
        variants.push(
          insensitiveLike(column, operatorValue as string, operatorName === 'notLike' || operatorName === 'notIlike'),
        );
      } else if (isLike && columnDialect(column) === 'sqlite') {
        // SQLite's LIKE folds ASCII case; the same pattern as a GLOB keeps it, as on Postgres.
        const glob = likePatternToGlob(operatorValue as string);
        variants.push(operatorName === 'like' ? sql`${column} glob ${glob}` : sql`${column} not glob ${glob}`);
      } else {
        variants.push(stringValueOps[operatorName]!(column, operatorValue as string));
      }
    } else if (operatorName === 'path' && isJsonColumn(column)) {
      // Several path predicates on one column are ANDed, matching how sibling operators
      // already combine. GraphQL coerces a lone object into a one-element list.
      for (const pathFilter of operatorValue as Record<string, any>[]) {
        const extracted = jsonPathCondition(column, columnName, pathFilter);
        if (extracted) {
          variants.push(extracted);
        }
      }
    } else if (operatorName === 'contains' && isJsonColumn(column)) {
      // `contains` is JSON containment on json/jsonb columns; on string columns it is the
      // safe substring operator handled by safeLikeOps below.
      variants.push(jsonContains(column, columnName, operatorValue));
    } else if (operatorName in safeLikeOps) {
      const op = safeLikeOps[operatorName]!;
      variants.push(safeLikeCondition(column, operatorValue as string, op, op.insensitive || foldCase));
    } else if (operatorName in arrayValueOps) {
      // An empty candidate list is a well-formed question with a known answer — nothing is
      // `IN ()`, everything is `NOT IN ()` — so it resolves to "no row" or "every row" rather
      // than an error. SQL has no empty-list literal, hence no `IN ()`.
      if (!(operatorValue as any[]).length) {
        if (operatorName === 'inArray') {
          variants.push(matchesNoRow());
        }
        continue;
      }
      const arrayValue = (operatorValue as any[]).map((val) => remapFromGraphQLCore(val, column, columnName));
      variants.push(
        foldCase
          ? lowerMembership(column, arrayValue, operatorName === 'notInArray')
          : arrayValueOps[operatorName]!(
              column,
              arrayValue.map((value) => comparableOperand(column, value)),
            ),
      );
    } else if (operatorName === 'has') {
      // Single-element membership: containment with a one-element array (`col @> ARRAY[value]`).
      // Elements are converted as a write converts them — a `DateTime` to a `Date`, a `BigInt`
      // string to a bigint — so the column's encoder accepts them.
      variants.push(arrayContains(column, [remapFromGraphQLCore(operatorValue, column, columnName)]));
    } else if (operatorName in arrayMembershipOps) {
      // Same reasoning as inArray/notInArray: overlapping with no elements is never true,
      // and every array contains all zero of them.
      if (!(operatorValue as any[]).length) {
        if (operatorName === 'hasSome') {
          variants.push(matchesNoRow());
        }
        continue;
      }
      variants.push(
        arrayMembershipOps[operatorName]!(
          column,
          (operatorValue as any[]).map((element) => remapFromGraphQLCore(element, column, columnName)),
        ),
      );
    } else if (operatorName === 'isEmpty') {
      variants.push(sql`cardinality(${column}) = 0`);
    } else if (operatorName in nullableOps) {
      variants.push(nullableOps[operatorName]!(column));
    } else {
      // An unrecognized operator must throw rather than be dropped: when the generated
      // schema is stitched/merged with another schema, foreign operators (e.g. `equals`,
      // `contains`, `mode`) can pass input validation, and silently dropping them could
      // turn a constrained where into an unbounded one.
      throw drizzleError(`WHERE ${columnName}: Unknown operator: ${operatorName}`, { code: 'DRIZZLE_INVALID_FILTER' });
    }
  }

  compileBooleanBranches(variants, { AND, NOT, OR }, (branch) => extractFiltersColumn(column, columnName, branch));

  return allOf(variants);
};
