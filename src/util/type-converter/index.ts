import type { Column, Table } from 'drizzle-orm';
import { extractExtendedColumnType, getColumns, is } from 'drizzle-orm';
import {
  MySqlDate,
  MySqlDateString,
  MySqlDateTime,
  MySqlDateTimeString,
  MySqlTimestamp,
  MySqlTimestampString,
} from 'drizzle-orm/mysql-core';
import { PgDate, PgDateString, PgTimestamp, PgTimestampString, PgUUID } from 'drizzle-orm/pg-core';
import { SQLiteTimestamp } from 'drizzle-orm/sqlite-core';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLString,
} from 'graphql';
import { capitalize, constantCase } from '../case-ops/index.ts';
import { declarePerBuildRegistry } from '../per-build-registry.ts';
import {
  GraphQLBigIntString,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLDecimalString,
  GraphQLJSON,
  GraphQLUUID,
} from '../scalars/index.ts';
import type {
  ColumnTypeMapper,
  ConvertedColumn,
  EnumNameMapper,
  EnumValueNameMapper,
  NullableConvertedColumnType,
  ScalarOverride,
  ScalarOverridesConfig,
} from './types.ts';

/** drizzle's `number` constraints whose values always fit a GraphQL `Int` (32-bit signed). */
const smallIntegerConstraints = new Set<string>([
  'int8',
  'uint8',
  'int16',
  'uint16',
  'int24',
  'uint24',
  'int32',
  'year',
]);

/** drizzle's `string` constraints of a numeric / decimal column in string mode; MySQL unsigned is `unumeric`. */
const decimalStringConstraints = new Set<string>(['numeric', 'unumeric']);

/** drizzle's `string` constraints of a bigint column in string mode (PG and MySQL). */
const bigIntStringConstraints = new Set<string>(['int64', 'uint64']);

/** A GraphQL `Name` that is also allowed as an enum value — the spec reserves the three literals. */
const validEnumValueName = (name: string): boolean =>
  /^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name) && name !== 'true' && name !== 'false' && name !== 'null';

/**
 * The enum type a column was declared with, when it is a *named* one — `pgEnum('status', …)`
 * shared by however many tables reference it. An inline value list (`text({ enum: [...] })`,
 * `mysqlEnum('role', [...])`) has no such object: the values belong to that one column.
 */
const declaredEnum = (column: Column): { enumName: string; schema: string | undefined } | undefined => {
  const declared = (column as any).enum as { enumName?: unknown; schema?: unknown } | undefined;
  return typeof declared?.enumName === 'string'
    ? { enumName: declared.enumName, schema: typeof declared.schema === 'string' ? declared.schema : undefined }
    : undefined;
};

/**
 * `user_status` / `user-status` / `user status` → `UserStatus`; an already-PascalCase name is left
 * alone. A GraphQL name cannot start with a digit, so a name that would (`2fa_mode`) is prefixed
 * with an underscore: `_2faMode`.
 */
const pascalize = (input: string): string => {
  const pascal = input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => capitalize(part))
    .join('');
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
};

/**
 * Identity of the values a GraphQL enum was built from, so a name claimed twice can be told
 * apart from the same enum reached twice.
 */
const enumValuesKey = (values: readonly string[]): string => JSON.stringify(values);

/**
 * Identity of the GraphQL names those values were given. Kept apart from {@link enumValuesKey}
 * because `enumValueNameMapper` sees the column, so two columns reaching one type can name its
 * values differently — and only one set of names can win.
 */
const enumValueNamesKey = (names: readonly string[]): string => JSON.stringify(names);

/**
 * Every GraphQL enum name this build has handed out. Two columns that resolve to the same
 * name share one type — that is how the columns of one `pgEnum` end up on a single type —
 * so the values are kept alongside it to tell a genuine collision from a re-use.
 */
let enumNamesInUse = new Map<string, { type: GraphQLEnumType; valuesKey: string; namesKey: string }>();
let enumNameMapper: EnumNameMapper | undefined;
let enumValueNameMapper: EnumValueNameMapper | undefined;
const enumConfigInstalled = declarePerBuildRegistry('enum config');

/** The value-name presets, by the string a config passes for them. */
const enumValueNamePresets: Record<string, EnumValueNameMapper> = {
  constant: ({ value }) => constantCase(value),
};

/**
 * Resets the enum registry for a fresh schema build and installs that build's
 * `enumNameMapper` and `enumValueNameMapper`. Called once per `generateSchemaData`, alongside
 * {@link registerScalarOverrides} — without the reset a second build would reuse the first
 * build's enum types, and so its naming decisions.
 */
export const registerEnumConfig = (config: {
  enumNameMapper?: EnumNameMapper;
  enumValueNameMapper?: 'constant' | EnumValueNameMapper;
}): void => {
  enumConfigInstalled();
  enumNameMapper = config.enumNameMapper;
  const valueMapper = config.enumValueNameMapper;
  if (typeof valueMapper === 'string') {
    const preset = enumValueNamePresets[valueMapper];
    if (!preset) {
      throw new Error(
        `Drizzle-GraphQL Error: Unknown enumValueNameMapper preset '${valueMapper}'. The only preset is 'constant'; pass a function for anything else.`,
      );
    }
    enumValueNameMapper = preset;
  } else {
    enumValueNameMapper = valueMapper;
  }
  enumNamesInUse = new Map();
};

/**
 * The GraphQL enum for a column's value list.
 *
 * The name decides the sharing: a column declared with a named `pgEnum` is named for the
 * enum, so every column declared with that same `pgEnum` lands on one GraphQL type — the
 * database column is literally the same type, and a client variable typed `StatusEnum!`
 * should be passable to any of them. A column with an inline value list is named for the
 * table and column instead, and so keeps a type of its own; its values are not shared with
 * anything.
 *
 * `enumNameMapper` is consulted for every column and overrides that name either way, which
 * makes it both the way to unify inline enums that were declared separately but mean the
 * same thing, and the way to split apart columns of one `pgEnum` that should not share.
 * Sending two *different* value lists to one name is a build-time error rather than an
 * invalid schema.
 */
const generateEnumCached = (column: Column, columnName: string, tableName: string): GraphQLEnumType => {
  const declared = declaredEnum(column);
  const values = column.enumValues!;
  const name =
    enumNameMapper?.({
      enumName: declared?.enumName,
      schema: declared?.schema,
      tableName,
      columnName,
      values,
    }) ?? (declared ? `${pascalize(declared.enumName)}Enum` : `${capitalize(tableName)}${capitalize(columnName)}Enum`);

  const valueNames = values.map((value, index) => {
    const mapped = enumValueNameMapper?.({
      enumName: declared?.enumName,
      schema: declared?.schema,
      tableName,
      columnName,
      values,
      value,
      index,
      typeName: name,
    });
    if (mapped === undefined) {
      return validEnumValueName(value) ? value : `Option${index}`;
    }
    if (!validEnumValueName(mapped)) {
      throw new Error(
        `Drizzle-GraphQL Error: config.enumValueNameMapper named value '${value}' of enum '${name}' (on '${tableName}.${columnName}') '${mapped}', which is not a valid GraphQL enum value name. A name must match /^[_a-zA-Z][_a-zA-Z0-9]*$/ and not be true, false or null.`,
      );
    }
    return mapped;
  });

  const seen = new Map<string, string>();
  values.forEach((value, index) => {
    const valueName = valueNames[index]!;
    const earlier = seen.get(valueName);
    if (earlier !== undefined) {
      throw new Error(
        `Drizzle-GraphQL Error: Values '${earlier}' and '${value}' of enum '${name}' (on '${tableName}.${columnName}') both map to the GraphQL value name '${valueName}'. Give one of them a different name via config.enumValueNameMapper.`,
      );
    }
    seen.set(valueName, value);
  });

  const valuesKey = enumValuesKey(values);
  const namesKey = enumValueNamesKey(valueNames);
  const claimed = enumNamesInUse.get(name);
  if (claimed) {
    if (claimed.valuesKey !== valuesKey) {
      throw new Error(
        `Drizzle-GraphQL Error: Two different enums both map to the GraphQL type name '${name}' (most recently '${tableName}.${columnName}'). Give one of them a different name via config.enumNameMapper.`,
      );
    }
    if (claimed.namesKey !== namesKey) {
      const before = claimed.type
        .getValues()
        .map((v) => v.name)
        .join(', ');
      throw new Error(
        `Drizzle-GraphQL Error: Columns sharing the GraphQL enum '${name}' name its values differently ('${tableName}.${columnName}' gives ${valueNames.join(', ')}; an earlier column gave ${before}). config.enumValueNameMapper must name a shared enum's values the same way for every column, or config.enumNameMapper must give the columns separate types.`,
      );
    }
    return claimed.type;
  }

  const gqlEnum = new GraphQLEnumType({
    name,
    values: Object.fromEntries(
      values.map((e, index) => [
        valueNames[index]!,
        {
          value: e,
          description: `Value: ${e}`,
        },
      ]),
    ),
  });

  enumNamesInUse.set(name, { type: gqlEnum, valuesKey, namesKey });

  return gqlEnum;
};

const geoXyType = new GraphQLObjectType({
  name: 'PgGeometryObject',
  fields: {
    x: { type: GraphQLFloat },
    y: { type: GraphQLFloat },
  },
});

const geoXyInputType = new GraphQLInputObjectType({
  name: 'PgGeometryObjectInput',
  fields: {
    x: { type: GraphQLFloat },
    y: { type: GraphQLFloat },
  },
});

/**
 * Whether the column holds a calendar day with no time component — a SQL `date`, in either of
 * the modes drizzle reads one in (`'date'` → a JS `Date`, `'string'` → `YYYY-MM-DD`). Every
 * position a column's type appears in — output, create/update input, filter operands,
 * aggregates and group keys — gives such a column the `Date` scalar, whichever mode it uses:
 * the mode is how the server holds the value, not what the value is. SQLite has no date-only
 * column type (its integer timestamps are instants — see {@link isDateTimeColumn}), so only
 * Postgres and MySQL appear here.
 */
export const isDateOnlyColumn = (column: Column): boolean =>
  is(column, PgDate) || is(column, PgDateString) || is(column, MySqlDate) || is(column, MySqlDateString);

/**
 * Whether the column is a MySQL `timestamp` / `datetime` read in drizzle's `'string'` mode. The
 * driver hands such a column back as MySQL's own `YYYY-MM-DD HH:MM:SS[.fraction]` text, with no
 * offset, and expects that form on write, so the data mappers translate between it and the ISO
 * 8601 instant the `DateTime` scalar carries. The text is read as UTC, the way drizzle's own
 * `'date'`-mode codecs for these columns read it.
 */
export const isMySqlDateTimeStringColumn = (column: Column): boolean =>
  is(column, MySqlTimestampString) || is(column, MySqlDateTimeString);

/**
 * Whether the column is a Postgres `timestamp` read in drizzle's `'string'` mode. The driver hands
 * such a column back as Postgres's own text — `YYYY-MM-DD HH:MM:SS[.fraction]`, followed by an
 * offset (`+00`, `-06`, `+05:30`) for `timestamptz` — so the data mappers translate between it
 * and the ISO 8601 instant the `DateTime` scalar carries. Text without an offset (`timestamp`
 * without time zone) is read as UTC, the way drizzle's own `'date'`-mode codec reads it.
 */
export const isPgTimestampStringColumn = (column: Column): boolean => is(column, PgTimestampString);

/**
 * Whether the column is a SQLite `integer({ mode: 'timestamp' | 'timestamp_ms' })`. Both modes
 * are one drizzle class, told apart by `mode`: the stored integer counts seconds or milliseconds
 * since the Unix epoch. drizzle converts a JS `Date` to that integer on write (`'timestamp'`
 * floors to the whole second) and back on read, but a value read through a path that skips the
 * column's decoder arrives as the bare integer, which {@link sqliteTimestampToDate} reads.
 */
export const isSQLiteTimestampColumn = (column: Column): boolean => is(column, SQLiteTimestamp);

/**
 * A SQLite timestamp column's stored integer as the instant it names, using the column's own
 * unit (seconds for `'timestamp'`, milliseconds for `'timestamp_ms'`).
 */
export const sqliteTimestampToDate = (column: Column, value: number): Date =>
  new Date((column as any).mode === 'timestamp' ? value * 1000 : value);

/**
 * Whether the column holds an instant — a Postgres `timestamp`, a MySQL `timestamp` /
 * `datetime`, in either drizzle mode, or a SQLite integer timestamp in either unit. Every position
 * such a column appears in gives it the `DateTime` scalar and the `DateTimeFilter`, whichever
 * mode it uses, for the same reason as {@link isDateOnlyColumn}.
 */
export const isDateTimeColumn = (column: Column): boolean =>
  is(column, PgTimestamp) ||
  isPgTimestampStringColumn(column) ||
  is(column, MySqlTimestamp) ||
  is(column, MySqlDateTime) ||
  isMySqlDateTimeStringColumn(column) ||
  isSQLiteTimestampColumn(column);

/**
 * Whether the column is a numeric / decimal in string mode (PG, MySQL signed or unsigned,
 * SQLite): transported as text, but a number.
 */
export const isDecimalStringColumn = (column: Column): boolean => {
  const { type, constraint } = extractExtendedColumnType(column);
  return type === 'string' && constraint !== undefined && decimalStringConstraints.has(constraint);
};

/**
 * Whether the column holds raw bytes: Postgres `bytea` and SQLite `blob({ mode: 'buffer' })`,
 * both `object buffer` in drizzle v1. Their values are `[Int!]` lists of the bytes.
 */
export const isBufferColumn = (column: Column): boolean =>
  (((column as any).dataType as string | undefined) ?? '').endsWith(' buffer');

/**
 * Whether the column is a float tuple or vector: drizzle v1 gives every such column an
 * `array …` data type — `point` / `line` in tuple mode (`array point`, `array line`), PostGIS
 * `geometry` in tuple mode, pgvector `vector` and `halfvec`. Each value is one list of numbers,
 * typed `[Float!]`, not a database array of elements.
 */
export const isFloatTupleColumn = (column: Column): boolean =>
  (((column as any).dataType as string | undefined) ?? '').startsWith('array ');

/** The fixed length of a float tuple column's values, or `undefined` for a vector. */
export const floatTupleLength = (column: Column): number | undefined => {
  switch ((column as any).dataType) {
    case 'array point':
    case 'array geometry':
      return 2;
    case 'array line':
      return 3;
    default:
      return undefined;
  }
};

const columnToGraphQLCore = (
  column: Column,
  columnName: string,
  tableName: string,
  isInput: boolean,
): ConvertedColumn<boolean> => {
  // drizzle-orm v1 models `.array()` columns as their base column plus a `dimensions` count
  // (e.g. text().array() keeps columnType=PgText with dimensions=1), so the element type is
  // whatever the base column maps to. PgVector/PgGeometry report dimensions of 0 and keep
  // their dedicated handling below.
  const dimensions = (column as any).dimensions as number | undefined;
  if (dimensions !== undefined && dimensions > 0) {
    const inner = columnBaseToGraphQLCore(column, columnName, tableName, isInput);
    const innerLabel = inner.typeLabel ?? (inner.type as GraphQLScalarType).name;

    // A Postgres array may hold NULL elements at any depth, so output elements are nullable.
    // Inputs keep non-null elements: a write or filter operand has no use for a null element.
    let type: ConvertedColumn<boolean>['type'] = inner.type;
    let typeLabel = innerLabel;
    for (let i = 0; i < dimensions; i++) {
      const element = type as GraphQLScalarType;
      type = isInput ? new GraphQLList(new GraphQLNonNull(element)) : new GraphQLList(element);
      typeLabel = `Array<${typeLabel}>`;
    }

    return { type, typeLabel };
  }

  return columnBaseToGraphQLCore(column, columnName, tableName, isInput);
};

const columnBaseToGraphQLCore = (
  column: Column,
  columnName: string,
  tableName: string,
  isInput: boolean,
): ConvertedColumn<boolean> => {
  const { type: baseType, constraint } = extractExtendedColumnType(column);
  switch (baseType) {
    case 'boolean':
      return { type: GraphQLBoolean, typeLabel: 'Boolean' };
    case 'object':
      if (isDateOnlyColumn(column)) {
        return { type: GraphQLDate, typeLabel: 'Date' };
      }
      if (isDateTimeColumn(column)) {
        return { type: GraphQLDateTime, typeLabel: 'DateTime' };
      }
      return column.columnType === 'PgGeometryObject'
        ? {
            type: isInput ? geoXyInputType : geoXyType,
            typeLabel: 'Geometry points XY',
          }
        : isBufferColumn(column)
          ? {
              type: new GraphQLList(new GraphQLNonNull(GraphQLInt)),
              typeLabel: 'Buffer',
            }
          : { type: GraphQLJSON, typeLabel: 'JSON' };
    case 'string':
      if (column.enumValues?.length) {
        return { type: generateEnumCached(column, columnName, tableName) };
      }

      // numeric/decimal columns (pg numeric, mysql decimal, sqlite numeric) transport as
      // strings, but they are numbers — give them the named Decimal scalar so the SDL says
      // so and non-numeric input is rejected. Array-typed numeric columns (dimensions > 0)
      // keep their existing mapping.
      if (isDecimalStringColumn(column) && !(column as any).dimensions) {
        return { type: GraphQLDecimalString, typeLabel: 'Decimal' };
      }

      // `bigint({ mode: 'string' })` is a 64-bit integer transported as text, so it gets the
      // same `BigInt` scalar (and number filters) as the other bigint modes.
      if (constraint !== undefined && bigIntStringConstraints.has(constraint)) {
        return { type: GraphQLBigIntString, typeLabel: 'BigInt' };
      }

      if (isDateTimeColumn(column)) {
        return { type: GraphQLDateTime, typeLabel: 'DateTime' };
      }
      if (column instanceof PgUUID) {
        return { type: GraphQLUUID, typeLabel: 'UUID' };
      }
      if (isDateOnlyColumn(column)) {
        return { type: GraphQLDate, typeLabel: 'Date' };
      }

      return { type: GraphQLString, typeLabel: 'String' };
    case 'bigint':
      return { type: GraphQLBigIntString, typeLabel: 'BigInt' };
    case 'number': {
      // Only integer kinds whose range fits GraphQL's 32-bit signed Int get `Int`, decided by
      // drizzle's constraint alone. Wider kinds — MySQL unsigned `int` (uint32) and `serial`
      // (uint53), bigint number mode (int53/uint53) and SQLite `integer()` (int53, any 64-bit
      // value) — get `Float`, which carries every integer up to 2^53 exactly.
      return constraint !== undefined && smallIntegerConstraints.has(constraint)
        ? { type: GraphQLInt, typeLabel: 'Integer' }
        : { type: GraphQLFloat, typeLabel: 'Float' };
    }
    case 'array': {
      // Every drizzle v1 column with an `array …` data type is a float tuple or vector — `.array()`
      // columns keep their element's data type and count `dimensions` instead (see
      // `columnToGraphQLCore`).
      const length = floatTupleLength(column);
      return {
        type: new GraphQLList(new GraphQLNonNull(GraphQLFloat)),
        typeLabel: length === undefined ? 'Array<Float>' : `Tuple<[${Array(length).fill('Float').join(', ')}]>`,
      };
    }
    default:
      throw new Error(`Drizzle-GraphQL Error: Type ${column.dataType} is not implemented!`);
  }
};

/**
 * Per-column scalar overrides, resolved at build time from `BuildSchemaConfig.scalars` /
 * `BuildSchemaConfig.mapColumnType` and consulted by every column→GraphQL type decision
 * (select fields, insert/update inputs, filter operands, aggregate min/max) as well as by
 * the runtime data mappers, which must not re-coerce a value an override scalar owns.
 *
 * Keyed weakly by the column object itself so the registry never outlives the schema.
 * `registerScalarOverrides` runs on every build and clears entries for columns that no
 * longer have an override; when two live schemas are built from the same table objects
 * with different scalar configs, the most recent build wins for runtime value mapping.
 */
const columnScalarOverrides = new WeakMap<Column, { output?: GraphQLScalarType; input?: GraphQLScalarType }>();
const scalarOverridesInstalled = declarePerBuildRegistry('scalar overrides');

/** The scalar overriding this column in the given direction, if one was registered. */
export const getColumnScalarOverride = (column: Column, isInput: boolean): GraphQLScalarType | undefined => {
  const override = columnScalarOverrides.get(column);
  return override ? (isInput ? override.input : override.output) : undefined;
};

const normalizeScalarOverride = (
  override: ScalarOverride,
  tableName: string,
  columnName: string,
): { output?: GraphQLScalarType; input?: GraphQLScalarType } => {
  const pair =
    override instanceof GraphQLScalarType
      ? { output: override, input: override }
      : { output: override.output, input: override.input };

  for (const scalar of [pair.output, pair.input]) {
    if (scalar !== undefined && !(scalar instanceof GraphQLScalarType)) {
      throw new Error(
        `Drizzle-GraphQL Error: Scalar override for column '${tableName}.${columnName}' must be a GraphQLScalarType!`,
      );
    }
  }

  return pair;
};

/**
 * Resolves the scalar-override config against every column of the given tables and stores
 * the result in the override registry. Called by `installBuildRegistries`, before any types are
 * generated — and always, even with no config, so a rebuild clears overrides left behind
 * by a previous build against the same table objects.
 *
 * The declarative `scalars` map wins over `mapColumnType`; a mapper returning `undefined`
 * leaves the column on built-in detection.
 */
export const registerScalarOverrides = (
  tables: Record<string, Table>,
  config: { scalars?: ScalarOverridesConfig; mapColumnType?: ColumnTypeMapper },
): void => {
  scalarOverridesInstalled();
  for (const [tableName, table] of Object.entries(tables)) {
    for (const [columnName, column] of Object.entries(getColumns(table))) {
      const declared = config.scalars?.[tableName]?.[columnName];

      let resolved: { output?: GraphQLScalarType; input?: GraphQLScalarType } | undefined;
      if (declared !== undefined) {
        resolved = normalizeScalarOverride(declared, tableName, columnName);
      } else if (config.mapColumnType) {
        // Built-in detection throws for column types it has no mapping for; the mapper is
        // exactly the tool to type such columns, so a failed default becomes `undefined`
        // rather than an error.
        let defaultType: GraphQLOutputType | undefined;
        let defaultInputType: GraphQLInputType | undefined;
        try {
          defaultType = columnToGraphQLCore(column, columnName, tableName, false).type as GraphQLOutputType;
        } catch {}
        try {
          defaultInputType = columnToGraphQLCore(column, columnName, tableName, true).type as GraphQLInputType;
        } catch {}

        const mapped = config.mapColumnType(column, { tableName, columnName, defaultType, defaultInputType });
        if (mapped !== undefined) {
          resolved = normalizeScalarOverride(mapped, tableName, columnName);
        }
      }

      if (resolved && (resolved.output !== undefined || resolved.input !== undefined)) {
        columnScalarOverrides.set(column, resolved);
      } else {
        columnScalarOverrides.delete(column);
      }
    }
  }
};

export const drizzleColumnToGraphQLType = <TColumn extends Column, TIsInput extends boolean = false>(
  column: TColumn,
  columnName: string,
  tableName: string,
  forceNullable = false,
  defaultIsNullable = false,
  isInput: TIsInput = false as TIsInput,
): ConvertedColumn<TIsInput> => {
  const override = getColumnScalarOverride(column, isInput);
  // An override replaces built-in detection entirely, so the label is the scalar's own name:
  // nothing downstream should treat an overridden column as the type it would have had.
  const typeDesc: ConvertedColumn<boolean> = override
    ? { type: override, typeLabel: override.name }
    : columnToGraphQLCore(column, columnName, tableName, isInput);

  if (forceNullable) {
    return typeDesc as ConvertedColumn<TIsInput>;
  }
  if (column.notNull && !(defaultIsNullable && (column.hasDefault || column.defaultFn))) {
    return {
      // Neither branch above wraps, so this is the only wrapper the column ever gets; the cast
      // narrows the declared union to the nullable half graphql 17's constructor accepts.
      type: new GraphQLNonNull(typeDesc.type as NullableConvertedColumnType<boolean>),
      typeLabel: typeDesc.typeLabel,
    } as ConvertedColumn<TIsInput>;
  }

  return typeDesc as ConvertedColumn<TIsInput>;
};
