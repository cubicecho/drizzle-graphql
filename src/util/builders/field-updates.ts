// @ts-nocheck — drizzle-orm 1.0 type compat not guaranteed, same as its sibling builders
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
import { getColumns, sql } from 'drizzle-orm';
import {
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLScalarType,
} from 'graphql';
import { remapFromGraphQLCore, remapFromGraphQLSingleInput } from '../data-mappers/index.ts';
import { GraphQLBigIntString, GraphQLDecimalString } from '../scalars/index.ts';
import { drizzleColumnToGraphQLType, getColumnScalarOverride } from '../type-converter/index.ts';

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
 * a bytea reads as `[Int]`, a vector and a geometry point as `[Float]` — so appending to
 * them is not the operation `push` means.
 */
const NON_LIST_ARRAY_COLUMNS = new Set(['PgVector', 'PgGeometry', 'PgBytea']);

const kindCache = new WeakMap<Column, FieldUpdateKind>();

/**
 * Whether a column takes an operations input, and which one.
 *
 * A column owned by a scalar override is always `'none'`: the override decides what the
 * column accepts, and wrapping it would overrule that. Everything else is decided by the
 * GraphQL type the column already converts to, so the operations follow the same
 * scalar-mapping rules as the rest of the schema.
 */
export const fieldUpdateKind = (column: Column, columnName: string, tableName: string): FieldUpdateKind => {
  const cached = kindCache.get(column);
  if (cached) {
    return cached;
  }

  let kind: FieldUpdateKind = 'none';
  if (!getColumnScalarOverride(column, true)) {
    const { type } = drizzleColumnToGraphQLType(column, columnName, tableName, true, false, true);
    if (NUMERIC_SCALARS.has(type)) {
      kind = 'numeric';
    } else if (type instanceof GraphQLList && !NON_LIST_ARRAY_COLUMNS.has((column as any).columnType)) {
      kind = 'list';
    }
  }

  kindCache.set(column, kind);
  return kind;
};

/** `${Scalar}FieldUpdate` / `${Scalar}ListFieldUpdate`, shared by every column of that type. */
const inputCache = new Map<string, GraphQLInputObjectType>();

const namedFieldUpdateInput = (
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
  column: Column,
  columnName: string,
  tableName: string,
): GraphQLInputObjectType | undefined => {
  const kind = fieldUpdateKind(column, columnName, tableName);
  if (kind === 'none') {
    return undefined;
  }

  const { type } = drizzleColumnToGraphQLType(column, columnName, tableName, true, false, true);

  if (kind === 'numeric') {
    const scalar = type as GraphQLScalarType;
    return namedFieldUpdateInput(
      `${scalar.name}FieldUpdate`,
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
    `${elementName}ListFieldUpdate`,
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
  throw new GraphQLError(
    given.length
      ? `Field '${columnName}' takes exactly one update operation, but ${given.length} were given (${given.join(', ')}).`
      : `Field '${columnName}' was given no update operation. Pass exactly one of ${OPERATIONS.join(', ')}.`,
  );
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
    if (!isOperations || fieldUpdateKind(column as Column, columnName, tableName) === 'none') {
      columns[columnName] = value;
      continue;
    }

    const [operation, operand] = singleOperation(value, columnName);
    if (operation === 'set') {
      columns[columnName] = operand;
      continue;
    }

    const param = sql.param(remapFromGraphQLCore(operand, column as Column, columnName), column);
    expressions[columnName] =
      operation === 'increment'
        ? sql`${column} + ${param}`
        : operation === 'decrement'
          ? sql`${column} - ${param}`
          : operation === 'multiply'
            ? sql`${column} * ${param}`
            : operation === 'divide'
              ? sql`${column} / ${param}`
              : // `push`: array concatenation, which is the only dialect-specific operation
                // here — and arrays are a PostgreSQL column type to begin with.
                sql`${column} || ${param}`;
  }

  return { columns, expressions };
};

/**
 * Remaps an update `set` into the values drizzle's `.set()` takes: plain columns through the
 * usual input remapping, column-relative operations as SQL expressions alongside them.
 *
 * Safe to call on every update path regardless of `features.fieldUpdateOperations` — see the
 * shape check in {@link splitFieldUpdateOperations}.
 */
export const remapUpdateInput = (values: Record<string, any>, table: Table, tableName: string): Record<string, any> => {
  const { columns, expressions } = splitFieldUpdateOperations(values, table, tableName);
  const remapped = remapFromGraphQLSingleInput(columns, table);
  return Object.keys(expressions).length ? { ...remapped, ...expressions } : remapped;
};
