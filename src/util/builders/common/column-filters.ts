// The filter input types, generated per column *shape* rather than per (table, column) pair —
// the local modification `../common.ts` describes. Which descriptor a column gets is decided by
// its data type, its dialect, and any scalar override the caller configured.

import type { Column } from 'drizzle-orm';
import { extractExtendedColumnType } from 'drizzle-orm';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLScalarType,
  GraphQLString,
} from 'graphql';
import {
  GraphQLBigIntString,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLDecimalString,
  GraphQLJSON,
  GraphQLUUID,
} from '../../scalars/index.ts';
import { drizzleColumnToGraphQLType, getColumnScalarOverride } from '../../type-converter/index.ts';
import type { ConvertedColumn, NullableConvertedColumnType } from '../../type-converter/types.ts';
import type { TypeCacheCtx } from './type-cache.ts';
import { sharedType, type TypeNameResolver } from './type-names.ts';

/** The dialect a column belongs to, inferred from its drizzle columnType string (e.g. 'PgJsonb'). */
export const columnDialect = (column: Column): 'pg' | 'mysql' | 'sqlite' | undefined => {
  const ct: string = (column as any).columnType ?? '';
  if (ct.startsWith('Pg')) {
    return 'pg';
  }
  if (ct.startsWith('MySql')) {
    return 'mysql';
  }
  if (ct.startsWith('SQLite')) {
    return 'sqlite';
  }
  return undefined;
};

/** How a column's generic filter input should be shaped, alongside the cache key to store it under. */
interface GenericFilterDescriptor {
  name: string;
  kind: 'scalar' | 'json' | 'array';
}

/**
 * Maps a Drizzle column to the generic filter type to use.
 *
 * Selection is keyed on the column's data type, never its name: a text column named
 * `userId` gets the full String filter (string operators included), while a uuid column
 * gets the lean Id filter whatever it is called.
 * - "JSON"            → json/jsonb columns (eq/ne + containment, no scalar comparison ops)
 * - `${Element}Array` → array columns, keyed per element type (IntArray, FloatArray,
 *                       StringArray, …) so arrays with different element types never share
 *                       one filter input; membership operators instead of scalar comparisons
 * - "Id"          → uuid-typed columns (no string pattern operators)
 * - "Boolean"     → boolean columns
 * - "BigInt"      → bigint columns (BigInt-scalar-typed operators, no string pattern operators)
 * - "Decimal"     → numeric/decimal columns (Decimal-scalar-typed operators, no string pattern operators)
 * - the enum GraphQL type name → enum columns (still unique per enum)
 * - "DateTime"    → timestamp and date columns
 * - "Int"         → integer/serial columns (no string pattern operators)
 * - "Float"       → real/double columns (no string pattern operators)
 * - "String"      → all other text/varchar columns
 */
const resolveGenericFilterDescriptor = (
  column: Column,
  columnGraphQLType: ReturnType<typeof drizzleColumnToGraphQLType>,
): GenericFilterDescriptor => {
  // JSON / JSONB columns — structural values with their own operator set.
  if (columnGraphQLType.type === GraphQLJSON) {
    return { name: 'JSON', kind: 'json' };
  }
  // Array columns — keyed per element type so an int[] and a text[] column never share
  // one cached filter input.
  if (columnGraphQLType.type instanceof GraphQLList) {
    let element = columnGraphQLType.type.ofType;
    if (element instanceof GraphQLNonNull) {
      element = element.ofType;
    }
    return { name: `${element.name}Array`, kind: 'array' };
  }
  // Opaque uuid keys — keyed on the column type, not on an `id`/`*Id` naming convention.
  if (columnGraphQLType.type === GraphQLUUID) {
    return { name: 'Id', kind: 'scalar' };
  }
  // Boolean scalar
  if (columnGraphQLType.type === GraphQLBoolean) {
    return { name: 'Boolean', kind: 'scalar' };
  }
  // Enum type — keep unique per enum since values differ
  if (columnGraphQLType.type instanceof GraphQLEnumType) {
    return { name: columnGraphQLType.type.name, kind: 'scalar' };
  }
  // Named numeric-string scalars — give them their own filters so the operators
  // are typed with the scalar (and validated by it) instead of a shared StringFilter.
  if (columnGraphQLType.type === GraphQLBigIntString) {
    return { name: 'BigInt', kind: 'scalar' };
  }
  if (columnGraphQLType.type === GraphQLDecimalString) {
    return { name: 'Decimal', kind: 'scalar' };
  }
  // Date / timestamp columns (check Drizzle internal columnType string)
  const ct: string = (column as any).columnType ?? '';
  if (ct === 'PgTimestamp' || ct === 'PgTimestampString' || ct === 'PgDate') {
    return { name: 'DateTime', kind: 'scalar' };
  }
  // Numeric scalars — distinct names so an int/float column never shares (and never
  // mistypes) the StringFilter, and integer ids keep a filter without string operators.
  // (BigInt/Decimal columns are handled above via their named scalars.)
  if (columnGraphQLType.type === GraphQLInt) {
    return { name: 'Int', kind: 'scalar' };
  }
  if (columnGraphQLType.type === GraphQLFloat) {
    return { name: 'Float', kind: 'scalar' };
  }
  // Default: plain text/varchar
  return { name: 'String', kind: 'scalar' };
};

/**
 * Filter fields for a json/jsonb column. `eq`/`ne` compare the whole document (jsonb equality
 * on Postgres, driver-level comparison elsewhere); `contains` is structural containment —
 * Postgres `@>` / MySQL `JSON_CONTAINS`. SQLite stores json as text and has no containment
 * operator, so `contains` is omitted there (same precedent as dialect-specific ops like ilike).
 */
const jsonFilterFields = (column: Column, colType: ConvertedColumn<true>['type'], typeName: TypeNameResolver) => {
  const dialect = columnDialect(column);
  return {
    eq: { type: colType, description: 'JSON equality on the whole value' },
    ne: { type: colType, description: 'JSON inequality on the whole value' },
    ...(dialect === 'pg' || dialect === 'mysql'
      ? {
          contains: {
            type: colType,
            description: 'Value structurally contains this JSON (Postgres `@>` / MySQL JSON_CONTAINS)',
          },
        }
      : {}),
    path: {
      type: new GraphQLList(new GraphQLNonNull(jsonPathFilterType(typeName))),
      description:
        'Compares the value at one path inside the document. Several entries are ANDed; a single object may be passed without the list brackets.',
    },
    isNull: { type: GraphQLBoolean },
    isNotNull: { type: GraphQLBoolean },
  };
};

/**
 * How the value at a JSON path is read before it is compared. Left unset, the operand
 * decides: a GraphQL number compares numerically, a boolean as a boolean, anything else as
 * text. Set it when the operand's type does not match the document's — comparing a numeric
 * field against a `String` variable, say.
 */
const jsonPathCastType = (typeName: TypeNameResolver): GraphQLEnumType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'JSONPathCast' },
    (name) =>
      new GraphQLEnumType({
        name,
        description: 'How to read the value at a JSON path before comparing it',
        values: {
          TEXT: { value: 'text', description: 'Compare as text (lexicographic ordering)' },
          NUMBER: { value: 'number', description: 'Compare as a number; a non-numeric value never matches' },
          BOOLEAN: { value: 'boolean', description: 'Compare as a boolean' },
        },
      }),
  );

/**
 * One predicate on the value at a path inside a json/jsonb column. `path` walks the document
 * key by key (an all-digits element indexes an array), and the remaining operators compare
 * whatever sits there. Operands are `JSON` so a single input type serves string, number and
 * boolean fields; see {@link jsonPathCast} for how the comparison type is chosen.
 *
 * Note that `contains` here is substring matching on the extracted value — unlike `contains`
 * on the column itself, which is structural JSON containment. A path names a scalar, so the
 * string reading is the useful one.
 */
const jsonPathFilterType = (typeName: TypeNameResolver): GraphQLInputObjectType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'JSONPathFilter' },
    (name) =>
      new GraphQLInputObjectType({
        name,
        fields: {
          path: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
            description:
              'Keys to walk from the document root, e.g. `["profile", "level"]`. An all-digits key indexes an array.',
          },
          as: { type: jsonPathCastType(typeName), description: 'Overrides how the value is read before comparing' },
          eq: { type: GraphQLJSON, description: 'Equal to' },
          ne: { type: GraphQLJSON, description: 'Not equal to' },
          lt: { type: GraphQLJSON, description: 'Less than' },
          lte: { type: GraphQLJSON, description: 'Less than or equal to' },
          gt: { type: GraphQLJSON, description: 'Greater than' },
          gte: { type: GraphQLJSON, description: 'Greater than or equal to' },
          startsWith: {
            type: GraphQLString,
            description: 'Extracted value starts with this string. `%`, `_` and `\\` are matched literally.',
          },
          endsWith: {
            type: GraphQLString,
            description: 'Extracted value ends with this string. `%`, `_` and `\\` are matched literally.',
          },
          contains: {
            type: GraphQLString,
            description: 'Extracted value contains this string. `%`, `_` and `\\` are matched literally.',
          },
          iStartsWith: { type: GraphQLString, description: 'Case-insensitive `startsWith`.' },
          iEndsWith: { type: GraphQLString, description: 'Case-insensitive `endsWith`.' },
          iContains: { type: GraphQLString, description: 'Case-insensitive `contains`.' },
          isNull: {
            type: GraphQLBoolean,
            description: 'When true, matches rows where the path is missing or holds JSON null',
          },
          isNotNull: { type: GraphQLBoolean, description: 'When true, matches rows where the path holds a value' },
        },
      }),
  );

/**
 * `inArray` / `notInArray` take a list of candidate values and compile to SQL `IN` /
 * `NOT IN`. Their descriptions are fixed rather than derived from the column: what the
 * operator does is the same everywhere, and the operand type already says what goes in it.
 */
const IN_ARRAY_DESCRIPTION = 'Matches any one of these values (SQL `IN`)';
const NOT_IN_ARRAY_DESCRIPTION = 'Matches none of these values (SQL `NOT IN`)';

/**
 * Filter fields for an array column (Postgres-only in drizzle). Membership operators replace
 * the scalar comparison and string pattern sets: `has` checks a single element (`@>` with a
 * one-element array), `hasSome` is overlap (`&&`), `hasEvery` is containment (`@>`), `isEmpty`
 * matches arrays with no elements. `eq`/`ne` still compare the whole array, and
 * `inArray`/`notInArray` still match the whole array against a list of candidate arrays
 * (SQL `IN`, typed `[[Element!]!]`).
 */
const arrayFilterFields = (colType: GraphQLList<any>, colArr: GraphQLList<any>) => {
  let element = colType.ofType;
  if (element instanceof GraphQLNonNull) {
    element = element.ofType;
  }
  const elementList = new GraphQLList(new GraphQLNonNull(element));

  return {
    eq: { type: colType, description: 'The whole array equals this array' },
    ne: { type: colType, description: 'The whole array differs from this array' },
    has: { type: element, description: 'Array contains this element' },
    hasSome: { type: elementList, description: 'Array contains at least one of these elements (overlap, `&&`)' },
    hasEvery: { type: elementList, description: 'Array contains every one of these elements (containment, `@>`)' },
    isEmpty: { type: GraphQLBoolean, description: 'When true, matches arrays with no elements' },
    inArray: { type: colArr, description: IN_ARRAY_DESCRIPTION },
    notInArray: { type: colArr, description: NOT_IN_ARRAY_DESCRIPTION },
    isNull: { type: GraphQLBoolean },
    isNotNull: { type: GraphQLBoolean },
  };
};

/**
 * Filters whose fields omit the string pattern operators (like/notLike/ilike/notIlike/
 * startsWith/contains/…): they are nonsensical on opaque uuids and invalid SQL on numeric
 * columns. Keyed on the generic filter name (i.e. on column type) — a string-typed column
 * keeps the string operators whatever it is called.
 */
const FILTERS_WITHOUT_STRING_OPS = new Set(['Id', 'Int', 'Float', 'BigInt', 'Decimal']);

/**
 * Scalars the built-in detection itself can produce. A scalar override to one of these
 * shares the built-in filter type for that scalar, so its shape must stay exactly what a
 * natural column of the scalar gets — whichever column builds the cached type first.
 * Any other override scalar gets its own filter type named after the scalar.
 */
const BUILTIN_FILTER_SCALARS = new Set<GraphQLScalarType>([
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLBigIntString,
  GraphQLDecimalString,
  GraphQLUUID,
  GraphQLJSON,
  GraphQLDate,
  GraphQLDateTime,
]);

/**
 * Filter descriptor for a scalar-overridden column. Overrides to the library's own
 * structural scalars keep the corresponding built-in descriptor (JSON keeps the
 * json-shaped filter, UUID the Id filter), so they share the name-keyed cache with
 * natural columns safely in either build order; every other scalar — the remaining
 * built-ins and all custom scalars — gets a scalar-shaped filter named after it
 * (BigIntFilter, MoneyFilter, …).
 */
const resolveOverrideFilterDescriptor = (scalar: GraphQLScalarType): GenericFilterDescriptor => {
  if (scalar === GraphQLJSON) {
    return { name: 'JSON', kind: 'json' };
  }
  if (scalar === GraphQLUUID) {
    return { name: 'Id', kind: 'scalar' };
  }
  return { name: scalar.name, kind: 'scalar' };
};

export const generateColumnFilterValues = (
  column: Column,
  tableName: string,
  columnName: string,
  cacheCtx: TypeCacheCtx,
): GraphQLInputObjectType => {
  const columnGraphQLType = drizzleColumnToGraphQLType(column, columnName, tableName, true, false, true);

  // A scalar-overridden column gets its filter built from the override scalar, which
  // `columnGraphQLType` above already resolved to. An override to one of the library's own
  // scalars shares the built-in filter for that scalar (same descriptor a natural column of
  // that scalar gets); any other scalar gets its own scalar-shaped filter type named after it
  // (e.g. MoneyFilter). The cache stays keyed by name, so all columns overridden with the
  // same scalar share one filter type.
  const inputOverride = getColumnScalarOverride(column, true);

  const { name: genericName, kind } = inputOverride
    ? resolveOverrideFilterDescriptor(inputOverride)
    : resolveGenericFilterDescriptor(column, columnGraphQLType);
  const cached = cacheCtx.genericFilterCache.get(genericName);
  if (cached) {
    return cached;
  }

  // Built with `forceNullable`, so the value is never a `GraphQLNonNull` — only the union is
  // wide enough to say so, and graphql 17's branded constructor cares.
  const colType = columnGraphQLType.type as NullableConvertedColumnType<true>;
  const colArr = new GraphQLList(new GraphQLNonNull(colType));

  // Uuid and numeric filters omit the string pattern operators
  // (like/ilike/startsWith/contains/…) — decided by column type, never by column name.
  // A filter shared with the built-ins keeps that name-keyed rule even for an overridden
  // column, so the shared type's shape never depends on which column built it first. A
  // custom override scalar's own filter carries the pattern operators only when a pattern
  // match is valid SQL on the underlying database column: string-typed, and not
  // numeric/decimal (those transport as strings but reject LIKE).
  const customOverrideFilter = inputOverride !== undefined && !BUILTIN_FILTER_SCALARS.has(inputOverride);
  const underlying = extractExtendedColumnType(column);
  const omitStringOps = customOverrideFilter
    ? underlying.type !== 'string' || underlying.constraint === 'numeric'
    : FILTERS_WITHOUT_STRING_OPS.has(genericName);

  const baseFields =
    kind === 'json'
      ? jsonFilterFields(column, colType, cacheCtx.typeName)
      : kind === 'array'
        ? arrayFilterFields(colType as GraphQLList<any>, colArr)
        : {
            eq: { type: colType, description: 'Equal to' },
            ne: { type: colType, description: 'Not equal to' },
            lt: { type: colType, description: 'Less than' },
            lte: { type: colType, description: 'Less than or equal to' },
            gt: { type: colType, description: 'Greater than' },
            gte: { type: colType, description: 'Greater than or equal to' },
            ...(omitStringOps
              ? {}
              : {
                  like: { type: GraphQLString },
                  notLike: { type: GraphQLString },
                  ilike: { type: GraphQLString },
                  notIlike: { type: GraphQLString },
                  startsWith: {
                    type: GraphQLString,
                    description:
                      'Matches values starting with the given string. `%`, `_` and `\\` are matched literally.',
                  },
                  endsWith: {
                    type: GraphQLString,
                    description:
                      'Matches values ending with the given string. `%`, `_` and `\\` are matched literally.',
                  },
                  contains: {
                    type: GraphQLString,
                    description: 'Matches values containing the given string. `%`, `_` and `\\` are matched literally.',
                  },
                  iStartsWith: {
                    type: GraphQLString,
                    description: 'Case-insensitive `startsWith`.',
                  },
                  iEndsWith: {
                    type: GraphQLString,
                    description: 'Case-insensitive `endsWith`.',
                  },
                  iContains: {
                    type: GraphQLString,
                    description: 'Case-insensitive `contains`.',
                  },
                  insensitive: {
                    type: GraphQLBoolean,
                    description:
                      'When true, every comparison operator in this object matches case-insensitively — `eq`, `ne`, the ordering operators, `inArray`/`notInArray` and the pattern operators all compare `lower(column)` against `lower(operand)`. Applies only to the operators beside it; a nested `AND`/`OR`/`NOT` branch sets its own.',
                  },
                }),
            inArray: { type: colArr, description: IN_ARRAY_DESCRIPTION },
            notInArray: { type: colArr, description: NOT_IN_ARRAY_DESCRIPTION },
            isNull: { type: GraphQLBoolean, description: 'When true, matches rows where the column is NULL' },
            isNotNull: { type: GraphQLBoolean, description: 'When true, matches rows where the column is not NULL' },
          };

  // The boolean branches are recursive — each branch is this filter type itself — so the
  // fields are thunked and reference the type being constructed.
  const mainType: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: cacheCtx.typeName({ kind: 'columnFilter', defaultName: `${genericName}Filter`, operation: genericName }),
    fields: () => ({
      ...baseFields,
      OR: {
        type: new GraphQLList(new GraphQLNonNull(mainType)),
        description: 'At least one branch matches; ANDed with any sibling operators',
      },
      AND: {
        type: new GraphQLList(new GraphQLNonNull(mainType)),
        description: 'Every branch matches',
      },
      NOT: {
        type: mainType,
        description: 'Negates the nested operators',
      },
    }),
  });

  cacheCtx.genericFilterCache.set(genericName, mainType);
  return mainType;
};
