/**
 * Atomic column operations on the update `set` (`features.fieldUpdateOperations`).
 *
 * Without them `Update<Table>Input` is set-only, so "increment the view count" is a read
 * followed by a write of the value the read returned — two round trips, and a lost update
 * whenever two clients read the same number. The operation happens in the database instead:
 * `set: { views: { increment: 1 } }` compiles to `SET views = views + 1`.
 *
 * The build side turns a qualifying column's update-input field into an operations input;
 * the runtime side splits a `set` back into plain column values and SQL expressions, which
 * drizzle's `.set()` accepts side by side.
 */
import type { Column, SQL, Table } from 'drizzle-orm';
import { getColumns, is, sql } from 'drizzle-orm';
import { SQLiteBigInt } from 'drizzle-orm/sqlite-core';
import {
  GraphQLFloat,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLScalarType,
} from 'graphql';
import type { BuildRegistries } from '../build-registries.ts';
import { remapFromGraphQLCore, remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
import { GraphQLBigIntString, GraphQLDecimalString } from '../scalars/index.ts';
import {
  drizzleColumnToGraphQLType,
  getColumnScalarOverride,
  isBufferColumn,
  isFloatTupleColumn,
} from '../type-converter/index.ts';
import { columnDialect } from './common/column-filters.ts';
import { drizzleError } from './common/errors.ts';
import type { TypeNameResolver } from './common/type-names.ts';

/** What a column's update-input field offers: arithmetic, list append, or nothing. */
export type FieldUpdateKind = 'numeric' | 'list' | 'none';

/**
 * The scalars arithmetic is offered on. Decimal and BigInt transport as strings but are
 * numbers in the database, so `views: { increment: "1" }` is as meaningful there as on an
 * `Int`. Identity rather than name: a column an override owns is excluded before this is
 * consulted, so these are always the built-ins.
 */
const NUMERIC_SCALARS = new Set<GraphQLInputType>([
  GraphQLInt,
  GraphQLFloat,
  GraphQLBigIntString,
  GraphQLDecimalString,
]);

/**
 * Column types that convert to a GraphQL list without being a list *in the database* —
 * a bytea or SQLite buffer blob reads as `[Int]`, a vector, a point or a line as `[Float]` —
 * so appending to them is not the operation `push` means.
 */
const isNonListArrayColumn = (column: Column): boolean => isFloatTupleColumn(column) || isBufferColumn(column);

/**
 * One build's field-update caches: a column's kind depends on the build's scalar overrides,
 * and the `${Scalar}FieldUpdate` / `${Scalar}ListFieldUpdate` inputs are shared by every column
 * of that type in the build. Part of the build's `BuildRegistries`.
 */
export type FieldUpdateCaches = {
  kinds: WeakMap<Column, FieldUpdateKind>;
  inputs: Map<string, GraphQLInputObjectType>;
};

/** Empty field-update caches for a new build. */
export const createFieldUpdateCaches = (): FieldUpdateCaches => ({ kinds: new WeakMap(), inputs: new Map() });

/**
 * Whether a column takes an operations input, and which one.
 *
 * A column owned by a scalar override is always `'none'`: the override decides what the
 * column accepts, and wrapping it would overrule that. Everything else is decided by the
 * GraphQL type the column already converts to, so the operations follow the same
 * scalar-mapping rules as the rest of the schema.
 */
export const fieldUpdateKind = (
  registries: BuildRegistries,
  column: Column,
  columnName: string,
  tableName: string,
): FieldUpdateKind => {
  const cached = registries.fieldUpdates.kinds.get(column);
  if (cached) {
    return cached;
  }

  let kind: FieldUpdateKind = 'none';
  if (!getColumnScalarOverride(registries.scalarOverrides, column, true)) {
    const { type } = drizzleColumnToGraphQLType(registries, column, columnName, tableName, true, false, true);
    if (NUMERIC_SCALARS.has(type)) {
      kind = 'numeric';
    } else if (type instanceof GraphQLList && !isNonListArrayColumn(column)) {
      kind = 'list';
    }
  }

  registries.fieldUpdates.kinds.set(column, kind);
  return kind;
};

/** `${Scalar}FieldUpdate` / `${Scalar}ListFieldUpdate`, shared by every column of that type. */
const namedFieldUpdateInput = (
  inputCache: Map<string, GraphQLInputObjectType>,
  name: string,
  fields: () => Record<string, { type: GraphQLInputType; description: string }>,
  description: string,
): GraphQLInputObjectType => {
  const cached = inputCache.get(name);
  if (cached) {
    return cached;
  }
  const input = new GraphQLInputObjectType({ name, description, fields: fields() });
  inputCache.set(name, input);
  return input;
};

/**
 * The operations input replacing a column's plain field on the update input, or `undefined`
 * when the column keeps its plain type.
 *
 * The type is named for the scalar, not the column, so every `Int` column in the schema
 * shares one `IntFieldUpdate` — the operations are the same wherever they appear.
 */
export const fieldUpdateInputType = (
  registries: BuildRegistries,
  column: Column,
  columnName: string,
  tableName: string,
  resolveName?: TypeNameResolver,
): GraphQLInputObjectType | undefined => {
  const kind = fieldUpdateKind(registries, column, columnName, tableName);
  if (kind === 'none') {
    return undefined;
  }
  // Named for the scalar rather than the column, so the naming rule is asked without a table:
  // one instance covers every column of that type across the schema.
  const nameOf = (defaultName: string) =>
    resolveName?.({ kind: 'fieldUpdateInput', defaultName, operation: kind }) ?? defaultName;

  const { type } = drizzleColumnToGraphQLType(registries, column, columnName, tableName, true, false, true);

  if (kind === 'numeric') {
    const scalar = type as GraphQLScalarType;
    return namedFieldUpdateInput(
      registries.fieldUpdates.inputs,
      nameOf(`${scalar.name}FieldUpdate`),
      () => ({
        set: { type: scalar, description: 'Replace the current value with this one' },
        increment: { type: scalar, description: 'Add this to the current value (SQL `column + value`)' },
        decrement: { type: scalar, description: 'Subtract this from the current value (SQL `column - value`)' },
        multiply: { type: scalar, description: 'Multiply the current value by this (SQL `column * value`)' },
        divide: {
          type: scalar,
          description: 'Divide the current value by this (SQL `column / value`), rounding as the database does',
        },
      }),
      `An update to a ${scalar.name} column: exactly one of these operations`,
    );
  }

  // The element type carries the list's own non-null wrapper, so `push` and `set` accept
  // exactly what the plain field accepted.
  const list = type as GraphQLList<GraphQLInputType>;
  const element = list.ofType;
  const elementName = element instanceof GraphQLNonNull ? String(element.ofType) : String(element);
  return namedFieldUpdateInput(
    registries.fieldUpdates.inputs,
    nameOf(`${elementName}ListFieldUpdate`),
    () => ({
      set: { type: list, description: 'Replace the current array with this one' },
      push: { type: list, description: 'Append these elements to the current array' },
    }),
    `An update to a ${elementName} array column: exactly one of these operations`,
  );
};

/** The operation keys, in the order they are reported when a caller passes several. */
const OPERATIONS = ['set', 'increment', 'decrement', 'multiply', 'divide', 'push'] as const;

/**
 * The single operation an operations input carries. graphql-js has no `@oneOf` on the
 * version range this library supports, so "exactly one" is enforced here rather than by the
 * type — and a caller who passes none has written `{}`, which would otherwise update
 * nothing while looking like it updated something.
 */
const singleOperation = (value: Record<string, any>, columnName: string): [string, any] => {
  const given = OPERATIONS.filter((operation) => value[operation] !== undefined);
  if (given.length === 1) {
    return [given[0]!, value[given[0]!]];
  }
  throw drizzleError(
    given.length
      ? `Field '${columnName}' takes exactly one update operation, but ${given.length} were given (${given.join(', ')}).`
      : `Field '${columnName}' was given no update operation. Pass exactly one of ${OPERATIONS.join(', ')}.`,
    { code: 'DRIZZLE_INVALID_UPDATE_OPERATION' },
  );
};

type ArithmeticOperation = 'increment' | 'decrement' | 'multiply' | 'divide';

const ARITHMETIC_SQL: Record<ArithmeticOperation, string> = {
  increment: '+',
  decrement: '-',
  multiply: '*',
  divide: '/',
};

/** Decimal text without an exponent, digit for digit: `1.5e3` → `1500`, `-2E-2` → `-0.02`. */
const plainDecimalText = (text: string): string => {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) {
    return text;
  }
  const [, sign, whole = '', fraction = '', exponent] = match;
  let digits = `${whole}${fraction}`;
  let point = whole.length + Number(exponent ?? 0);
  if (point < 0) {
    digits = `${'0'.repeat(-point)}${digits}`;
    point = 0;
  } else if (point > digits.length) {
    digits = `${digits}${'0'.repeat(point - digits.length)}`;
  }
  const intPart = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = digits.slice(point).replace(/0+$/, '');
  return `${sign === '-' ? '-' : ''}${intPart}${fracPart ? `.${fracPart}` : ''}`;
};

/** MySQL's widest DECIMAL: 65 digits, at most 30 of them after the point. */
const MYSQL_DECIMAL_MAX_PRECISION = 65;
const MYSQL_DECIMAL_MAX_SCALE = 30;

/**
 * A MySQL BIGINT / DECIMAL operand as an exact DECIMAL just wide enough to hold it.
 *
 * Both column types bind their operand as a string, and MySQL evaluates number-plus-string in
 * DOUBLE — `big + '1'` past 2^53 rounds, and a wide DECIMAL loses everything past ~17 digits.
 * Cast to a DECIMAL, the operand keeps the arithmetic exact: integer and decimal operands
 * combine as DECIMAL, and the result is stored back into the column by the column's own rules.
 * The width comes from the operand rather than the column, so `multiply: "1.5"` on a
 * `decimal(10, 0)` still multiplies by 1.5.
 */
const mysqlExactOperand = (text: string, columnName: string): SQL => {
  const plain = plainDecimalText(text);
  const [intPart = '0', fracPart = ''] = plain.replace(/^-/, '').split('.');
  const scale = Math.min(fracPart.length, MYSQL_DECIMAL_MAX_SCALE);
  const precision = Math.max(1, intPart.replace(/^0+/, '').length + scale);
  if (precision > MYSQL_DECIMAL_MAX_PRECISION) {
    throw drizzleError(
      `Field '${columnName}': the operand ${text} has more digits than a MySQL DECIMAL holds (${MYSQL_DECIMAL_MAX_PRECISION}).`,
      { code: 'DRIZZLE_INVALID_UPDATE_OPERATION' },
    );
  }
  // A cast type cannot be a parameter, so the width — two library-computed integers — is
  // written into the SQL text; the operand itself stays bound.
  return sql`cast(${plain} as decimal(${sql.raw(String(precision))}, ${sql.raw(String(scale))}))`;
};

/**
 * Arithmetic on a SQLite `blob({ mode: 'bigint' })` column, which drizzle stores as the
 * value's decimal text in a BLOB. A bare `big + 1` makes SQLite read that text as a number and
 * store an INTEGER back, which the column's decoder cannot read — the row would be unreadable
 * from then on. Instead the text is read as a 64-bit integer (the column's declared range), the
 * operation runs in SQLite's exact integer arithmetic, and the result is written back in the
 * same text-in-a-BLOB form.
 *
 * SQLite turns an integer overflow into a REAL, and reads a stored value outside the 64-bit
 * range clamped; either would write back the wrong number, so both raise SQLite's own
 * `integer overflow` error instead — `abs()` of the smallest 64-bit integer, the one expression
 * SQLite raises on rather than converting, reached only in that branch (the `is null` term
 * keeps it from being evaluated ahead of time as a constant).
 */
const sqliteBlobBigIntArithmetic = (
  column: Column,
  columnName: string,
  operation: ArithmeticOperation,
  operand: unknown,
): SQL => {
  const text = String(operand);
  if (operation === 'divide' && /^[+-]?0+$/.test(text)) {
    // SQLite answers x / 0 with NULL; PostgreSQL and MySQL raise, and so does this.
    throw drizzleError(`Field '${columnName}': division by zero.`, { code: 'DRIZZLE_INVALID_UPDATE_OPERATION' });
  }
  const current = sql`cast(cast(${column} as text) as integer)`;
  const result = sql`(${current} ${sql.raw(ARITHMETIC_SQL[operation])} cast(${text} as integer))`;
  return sql`(case when ${column} is null then null when typeof(${result}) = 'integer' and cast(${current} as text) = cast(${column} as text) then cast(cast(${result} as text) as blob) else abs(-9223372036854775807 - 1 - (${column} is null)) end)`;
};

/**
 * `column <op> operand` for the arithmetic operations, built so the arithmetic is exact on
 * every dialect: see {@link mysqlExactOperand} and {@link sqliteBlobBigIntArithmetic} for the
 * two column types where the plain form is not.
 */
const arithmeticExpression = (
  registries: BuildRegistries,
  column: Column,
  columnName: string,
  operation: ArithmeticOperation,
  operand: unknown,
): SQL => {
  const value = remapFromGraphQLCore(operand, column, columnName, registries.scalarOverrides);
  if (is(column, SQLiteBigInt)) {
    return sqliteBlobBigIntArithmetic(column, columnName, operation, value);
  }
  const op = sql.raw(ARITHMETIC_SQL[operation]);
  if (columnDialect(column) === 'mysql' && (typeof value === 'bigint' || typeof value === 'string')) {
    return sql`${column} ${op} ${mysqlExactOperand(String(value), columnName)}`;
  }
  return sql`${column} ${op} ${sql.param(value, column)}`;
};

/** An update `set` split into values drizzle assigns directly and ones it assigns from SQL. */
export type SplitUpdateValues = {
  /** Column values still to go through `remapFromGraphQLSingleInput`. */
  columns: Record<string, any>;
  /** Column-relative expressions, already driver-ready, to merge into the same `.set()`. */
  expressions: Record<string, SQL>;
};

/**
 * Splits an update `set` into plain values and column-relative SQL expressions.
 *
 * Only columns the build side gave an operations input to are read as operations, so a JSON
 * column that happens to hold `{ increment: 1 }` is still just a value. `set` is the
 * explicit spelling of a plain assignment and stays on the plain side, where the usual
 * input remapping applies to it.
 */
export const splitFieldUpdateOperations = (
  registries: BuildRegistries,
  values: Record<string, any>,
  table: Table,
  tableName: string,
): SplitUpdateValues => {
  const cols = getColumns(table);
  const columns: Record<string, any> = {};
  const expressions: Record<string, SQL> = {};

  for (const [columnName, value] of Object.entries(values)) {
    const column = cols[columnName];
    // An unknown key is left for the remapper, whose error names it.
    if (!column || value === null || value === undefined) {
      columns[columnName] = value;
      continue;
    }

    // The operations arrive as an input object; a plain value is a plain assignment. That
    // is what makes this safe to run whether or not `features.fieldUpdateOperations` is on —
    // with it off, a numeric or list column's field is typed as the scalar or the list, so
    // graphql-js has already ruled out the object shape by the time the value gets here.
    const isOperations = typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
    if (!isOperations || fieldUpdateKind(registries, column as Column, columnName, tableName) === 'none') {
      columns[columnName] = value;
      continue;
    }

    const [operation, operand] = singleOperation(value, columnName);
    if (operation === 'set') {
      columns[columnName] = operand;
      continue;
    }

    if (operation === 'push') {
      // Array concatenation — and arrays are a PostgreSQL column type to begin with.
      const param = sql.param(
        remapFromGraphQLCore(operand, column as Column, columnName, registries.scalarOverrides),
        column,
      );
      expressions[columnName] = sql`${column} || ${param}`;
      continue;
    }
    expressions[columnName] = arithmeticExpression(
      registries,
      column as Column,
      columnName,
      operation as ArithmeticOperation,
      operand,
    );
  }

  return { columns, expressions };
};

/**
 * Remaps an update `set` into the values drizzle's `.set()` takes: plain columns through the
 * usual input remapping, column-relative operations as SQL expressions alongside them.
 *
 * Safe to call on every update path regardless of `features.fieldUpdateOperations` — see the
 * shape check in {@link splitFieldUpdateOperations}.
 *
 * This is the single funnel every update goes through — the plural and `Single` mutations,
 * `updateMany`, the `Count` mutations and the MySQL builder's own — which is why it is the
 * one place that has to tell the remapper it is serving an update rather than an insert.
 */
export const remapUpdateInput = (
  registries: BuildRegistries,
  values: Record<string, any>,
  table: Table,
  tableName: string,
): Record<string, any> => {
  const { columns, expressions } = splitFieldUpdateOperations(registries, values, table, tableName);
  const remapped = remapFromGraphQLSingleInput(columns, table, registries.scalarOverrides, 'update');
  return Object.keys(expressions).length ? { ...remapped, ...expressions } : remapped;
};
