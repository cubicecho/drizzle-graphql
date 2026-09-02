// Compiling one column's filter operators into SQL, including the LIKE escaping and the
// JSON-path machinery the JSON operators are built on.

import type { Column } from 'drizzle-orm';
import {
  and,
  arrayContains,
  arrayOverlaps,
  eq,
  gt,
  gte,
  ilike,
  inArray,
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
const safeLikeOps: Record<string, { buildPattern: (value: string) => string; insensitive: boolean }> = {
  startsWith: { buildPattern: (value) => `${escapeLikeValue(value)}%`, insensitive: false },
  endsWith: { buildPattern: (value) => `%${escapeLikeValue(value)}`, insensitive: false },
  contains: { buildPattern: (value) => `%${escapeLikeValue(value)}%`, insensitive: false },
  iStartsWith: { buildPattern: (value) => `${escapeLikeValue(value)}%`, insensitive: true },
  iEndsWith: { buildPattern: (value) => `%${escapeLikeValue(value)}`, insensitive: true },
  iContains: { buildPattern: (value) => `%${escapeLikeValue(value)}%`, insensitive: true },
};

/**
 * `LIKE <pattern> ESCAPE '\'` for a safe string operator. Case-insensitive variants use
 * Postgres's native `ILIKE`; MySQL and SQLite have no `ILIKE`, so they compare `lower()`
 * on both sides instead (mirroring how the raw `ilike` operator is Postgres-only).
 */
const safeLikeCondition = (column: Column, pattern: string, insensitive: boolean): SQL => {
  if (!insensitive) {
    return sql`${column} like ${pattern} escape ${LIKE_ESCAPE_CHAR}`;
  }

  const isPg = (((column as any).columnType ?? '') as string).startsWith('Pg');
  return isPg
    ? sql`${column} ilike ${pattern} escape ${LIKE_ESCAPE_CHAR}`
    : sql`lower(${column}) like ${pattern.toLowerCase()} escape ${LIKE_ESCAPE_CHAR}`;
};

/**
 * The case-insensitive form of the raw `like` / `notLike` operators, whose operand is a
 * caller-written pattern rather than a literal. Postgres has `ILIKE`; the other two dialects
 * compare `lower()` on both sides, exactly as {@link safeLikeCondition} does.
 */
const insensitiveLike = (column: Column, pattern: string, negated: boolean): SQL => {
  if (columnDialect(column) === 'pg') {
    return negated ? notIlike(column, pattern) : ilike(column, pattern);
  }
  return negated ? sql`lower(${column}) not like lower(${pattern})` : sql`lower(${column}) like lower(${pattern})`;
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
const lowerComparison = (column: Column, operatorName: string, value: unknown): SQL =>
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
 * Constant predicates, used where an operator's operand list is empty and the answer is
 * therefore known without touching the column. Written as `1 = 0` / `1 = 1` rather than the
 * `FALSE` / `TRUE` keywords so they compile identically on all three dialects. Built fresh
 * per call because a `SQL` object is spliced into whatever query consumes it.
 */
const sqlFalse = (): SQL => sql`1 = 0`;
const sqlTrue = (): SQL => sql`1 = 1`;

/**
 * A MySQL / SQLite JSON path expression for the given key walk. Bound as a query parameter,
 * never spliced into the SQL text; an all-digits key becomes an array index, and quotes and
 * backslashes inside a key are escaped so a key can never end the path segment early.
 */
const jsonPathString = (path: string[]): string =>
  `$${path.map((part) => (/^\d+$/.test(part) ? `[${part}]` : `."${part.replace(/(["\\])/g, '\\$1')}"`)).join('')}`;

/**
 * Matches the text forms a database will accept as a number. Used to guard both numeric casts —
 * Postgres has no TRY_CAST and errors outright on a bad `::numeric`, while MySQL quietly casts
 * a non-numeric string to 0; neither is what a non-matching row should do.
 */
const NUMERIC_TEXT_PATTERN = '^\\s*-?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?\\s*$';

/**
 * The value at a JSON path, as the expressions a comparison can be built on: read as text,
 * read as a number, and read as the dialect spells a boolean. Each dialect extracts
 * differently, and each needs its own guard so a value of the wrong shape answers "no match"
 * rather than erroring or comparing by some unrelated rule:
 *
 * - **Postgres** — `#>>` with a bound `text[]` path, which works on `json` and `jsonb` alike.
 *   `::numeric` on a non-numeric string is a hard error, so the numeric read is guarded by a
 *   pattern test.
 * - **MySQL** — `JSON_UNQUOTE(JSON_EXTRACT(col, ?))`, so a JSON string arrives without its
 *   quotes. Unquoting a JSON *null* would otherwise yield the string `'null'`, so it is mapped
 *   back to SQL NULL first. `CAST` quietly turns a non-numeric string into 0, hence the same
 *   pattern guard.
 * - **SQLite** — `json_extract` returns the value in SQLite's own type, so the reads cast
 *   explicitly: without that, SQLite's cross-type ordering puts every string above every
 *   number and `'admin' > 0` would be true.
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
      return {
        text,
        number: sql`(case when ${text} ~ ${NUMERIC_TEXT_PATTERN} then ${text}::numeric end)`,
        boolean: text,
        encodeBoolean: (value) => String(value),
      };
    }
    case 'mysql': {
      const extracted = sql`json_extract(${column}, ${jsonPathString(path)})`;
      const text = sql`(case when json_type(${extracted}) = 'NULL' then null else json_unquote(${extracted}) end)`;
      return {
        text,
        number: sql`(case when ${text} regexp ${NUMERIC_TEXT_PATTERN} then cast(${text} as decimal(65, 30)) end)`,
        boolean: text,
        encodeBoolean: (value) => String(value),
      };
    }
    default: {
      const extracted = sql`json_extract(${column}, ${jsonPathString(path)})`;
      return {
        text: sql`cast(${extracted} as text)`,
        number: sql`(case when typeof(${extracted}) in ('integer', 'real') then ${extracted} end)`,
        // SQLite has no boolean type: a JSON `true` comes back as the integer 1.
        boolean: extracted,
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
      const { buildPattern, insensitive } = safeLikeOps[operatorName]!;
      if (typeof operatorValue !== 'string') {
        throw drizzleError(`WHERE ${locator}: operator '${operatorName}' takes a string`, {
          code: 'DRIZZLE_INVALID_FILTER',
        });
      }
      // The extracted value is an expression, not a column, so the case-insensitive form
      // always goes through `lower()` rather than Postgres's ILIKE.
      variants.push(safeLikeCondition(exprs.text as any, buildPattern(operatorValue), insensitive));
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

export const extractFiltersColumn = <TColumn extends Column>(
  column: TColumn,
  columnName: string,
  operators: FilterColumnOperators<TColumn>,
): SQL | undefined => {
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
    if (operatorValue === null || operatorValue === false) {
      continue;
    }

    if (operatorName in singleValueOps) {
      const singleValue = remapFromGraphQLCore(operatorValue, column, columnName);
      variants.push(
        foldCase
          ? lowerComparison(column, operatorName, singleValue)
          : singleValueOps[operatorName]!(column, singleValue),
      );
    } else if (operatorName in stringValueOps) {
      // Under `insensitive`, `like`/`notLike` compile the same way their `i` counterparts
      // do; `ilike`/`notIlike` are already case-insensitive and are left alone.
      const insensitivePattern = foldCase && (operatorName === 'like' || operatorName === 'notLike');
      variants.push(
        insensitivePattern
          ? insensitiveLike(column, operatorValue as string, operatorName === 'notLike')
          : stringValueOps[operatorName]!(column, operatorValue as string),
      );
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
      const { buildPattern, insensitive: alwaysInsensitive } = safeLikeOps[operatorName]!;
      variants.push(safeLikeCondition(column, buildPattern(operatorValue as string), alwaysInsensitive || foldCase));
    } else if (operatorName in arrayValueOps) {
      // An empty candidate list is a well-formed question with a known answer — nothing is
      // `IN ()`, everything is `NOT IN ()` — so it resolves to a constant predicate rather
      // than an error. SQL has no empty-list literal, hence the constant rather than `IN ()`.
      if (!(operatorValue as any[]).length) {
        variants.push(operatorName === 'inArray' ? sqlFalse() : sqlTrue());
        continue;
      }
      const arrayValue = (operatorValue as any[]).map((val) => remapFromGraphQLCore(val, column, columnName));
      variants.push(
        foldCase
          ? lowerMembership(column, arrayValue, operatorName === 'notInArray')
          : arrayValueOps[operatorName]!(column, arrayValue),
      );
    } else if (operatorName === 'has') {
      // Single-element membership: containment with a one-element array (`col @> ARRAY[value]`).
      variants.push(arrayContains(column, [operatorValue]));
    } else if (operatorName in arrayMembershipOps) {
      // Same reasoning as inArray/notInArray: overlapping with no elements is never true,
      // and every array contains all zero of them.
      if (!(operatorValue as any[]).length) {
        variants.push(operatorName === 'hasSome' ? sqlFalse() : sqlTrue());
        continue;
      }
      variants.push(arrayMembershipOps[operatorName]!(column, operatorValue as any[]));
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

  if (AND?.length) {
    for (const variant of AND) {
      const extracted = extractFiltersColumn(column, columnName, variant);
      if (extracted) {
        variants.push(extracted);
      }
    }
  }

  if (NOT) {
    const extracted = extractFiltersColumn(column, columnName, NOT);
    if (extracted) {
      variants.push(not(extracted));
    }
  }

  if (OR?.length) {
    const orVariants = [] as SQL[];
    for (const variant of OR) {
      const extracted = extractFiltersColumn(column, columnName, variant);
      if (extracted) {
        orVariants.push(extracted);
      }
    }

    if (orVariants.length) {
      variants.push(orVariants.length > 1 ? or(...orVariants)! : orVariants[0]!);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};
