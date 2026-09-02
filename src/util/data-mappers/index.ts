import { type Column, getColumns, is, One, type Table } from 'drizzle-orm';
import { isJsonColumn } from '../builders/common/column-filters.ts';
import { drizzleError } from '../builders/common/errors.ts';
import type { TableNamedRelations } from '../builders/index.ts';
import { getColumnScalarOverride } from '../type-converter/index.ts';

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

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Buffer) {
    return Array.from(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    if (column.columnType === 'PgGeometry' || column.columnType === 'PgVector') {
      return value;
    }

    return value.map((arrVal) => remapToGraphQLCore(key, arrVal, tableName, column, relationMap));
  }

  if (typeof value === 'object' && value !== null) {
    if (column.columnType === 'PgGeometryObject') {
      return value;
    }

    return JSON.stringify(value);
  }

  return value;
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

    // SQLite blob(bigint) returns 0n for null DB values — treat as absent when nullable.
    if (value === 0n && column && (column as any).columnType === 'SQLiteBigInt' && !(column as any).notNull) {
      delete queryOutput[key];
      continue;
    }

    queryOutput[key] = remapToGraphQLCore(key, value, tableName, column, relationMap);
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

export const remapFromGraphQLCore = (value: any, column: Column, columnName: string) => {
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

  // Timestamp/datetime columns (SQLite: "object date", MySQL timestamp/datetime: "object date").
  // Only convert string→Date for timestamp/datetime columns, NOT pure DATE columns.
  // MySqlDateString has dataType "string date" (excluded by startsWith check).
  // MySqlDate has columnType "MySqlDate" — excluded below since it can accept raw strings.
  const columnType: string = (column as any).columnType ?? '';
  const isTimestampColumn =
    columnType === 'SQLiteTimestamp' ||
    columnType === 'SQLiteTimestampMs' ||
    columnType === 'MySqlTimestamp' ||
    columnType === 'MySqlDateTime' ||
    columnType === 'PgTimestamp' ||
    columnType === 'PgTimestampString';
  if (isTimestampColumn) {
    const formatted = new Date(value);
    if (Number.isNaN(formatted.getTime())) {
      throw drizzleError(`Field '${columnName}' is not a valid date!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
    }

    return formatted;
  }

  // Date-only columns (no time component) — extract YYYY-MM-DD portion to avoid
  // timezone shifts when mysql2 formats Date objects using local time.
  const isDateOnlyColumn = columnType === 'MySqlDate' || columnType === 'PgDate';
  if (isDateOnlyColumn && typeof value === 'string') {
    // Accept ISO strings like "2024-04-04T00:00:00.000Z" or plain "2024-04-04"
    const dateOnly = value.includes('T') ? value.split('T')[0] : value;
    // Validate it's a real date by parsing
    const check = new Date(dateOnly!);
    if (Number.isNaN(check.getTime())) {
      throw drizzleError(`Field '${columnName}' is not a valid date!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
    }

    return dateOnly;
  }

  // BigInt columns (SQLite: "bigint int64", others: "bigint").
  if (dataType.includes('bigint')) {
    try {
      return BigInt(value);
    } catch {
      throw drizzleError(`Field '${columnName}' is not a BigInt!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
    }
  }

  // JSON columns (SQLite: "object json", PG: "json"). The `JSON` scalar has already parsed
  // the literal, so the value goes to the driver untouched — parsing it again here would
  // wrongly reject a JSON value that happens to be a string, like `"hello"`.
  // PgGeometryObject is already handled by the switch case below.
  if (dataType.includes('json') && (column as any).columnType !== 'PgGeometryObject') {
    return value;
  }

  switch (dataType) {
    case 'date': {
      const formatted = new Date(value);
      if (Number.isNaN(formatted.getTime())) {
        throw drizzleError(`Field '${columnName}' is not a valid date!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
      }

      return formatted;
    }

    case 'buffer': {
      if (!Array.isArray(value)) {
        throw drizzleError(`Field '${columnName}' is not an array!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
      }

      return Buffer.from(value);
    }

    case 'json': {
      if (column.columnType === 'PgGeometryObject') {
        return value;
      }

      try {
        return JSON.parse(value);
      } catch (e) {
        throw drizzleError(
          `Invalid JSON in field '${columnName}':\n${e instanceof Error ? e.message : 'Unknown error'}`,
          {
            code: 'DRIZZLE_INVALID_INPUT_VALUE',
          },
        );
      }
    }

    case 'array': {
      if (!Array.isArray(value)) {
        throw drizzleError(`Field '${columnName}' is not an array!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
      }

      if (column.columnType === 'PgGeometry' && value.length !== 2) {
        throw drizzleError(
          `Invalid float tuple in field '${columnName}': expected array with length of 2, received ${value.length}`,
          { code: 'DRIZZLE_INVALID_INPUT_VALUE' },
        );
      }

      return value;
    }

    case 'bigint': {
      try {
        return BigInt(value);
      } catch (_error) {
        throw drizzleError(`Field '${columnName}' is not a BigInt!`, { code: 'DRIZZLE_INVALID_INPUT_VALUE' });
      }
    }

    default: {
      // graphql-js coerces input object types using Object.create(null), producing
      // null-prototype objects. Drizzle's internal is() check accesses
      // Object.getPrototypeOf(value).constructor and throws for null-prototype objects.
      // Convert to a plain object so drizzle can process it safely.
      if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null) {
        return Object.assign({}, value);
      }
      return value;
    }
  }
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
