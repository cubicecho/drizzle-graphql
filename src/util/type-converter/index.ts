import type { Column, Table } from 'drizzle-orm';
import { extractExtendedColumnType, getTableColumns, is } from 'drizzle-orm';
import { MySqlInt, MySqlSerial } from 'drizzle-orm/mysql-core';
import { PgDate, PgDateString, PgInteger, PgSerial, PgTimestamp, PgTimestampString, PgUUID } from 'drizzle-orm/pg-core';
import { SQLiteInteger } from 'drizzle-orm/sqlite-core';
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
import { capitalize } from '../case-ops/index.ts';
import {
  GraphQLBigIntString,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLDecimalString,
  GraphQLJSON,
  GraphQLUUID,
} from '../scalars/index.ts';
import type { ColumnTypeMapper, ConvertedColumn, ScalarOverride, ScalarOverridesConfig } from './types.ts';

const allowedNameChars = /^[a-zA-Z0-9_]+$/;

const enumMap = new WeakMap<object, GraphQLEnumType>();
const generateEnumCached = (column: Column, columnName: string, tableName: string): GraphQLEnumType => {
  if (enumMap.has(column)) {
    return enumMap.get(column)!;
  }

  const gqlEnum = new GraphQLEnumType({
    name: `${capitalize(tableName)}${capitalize(columnName)}Enum`,
    values: Object.fromEntries(
      column.enumValues!.map((e, index) => [
        allowedNameChars.test(e) ? e : `Option${index}`,
        {
          value: e,
          description: `Value: ${e}`,
        },
      ]),
    ),
  });

  enumMap.set(column, gqlEnum);

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
    const innerDesc = inner.description ?? (inner.type as GraphQLScalarType).name;

    let type: ConvertedColumn<boolean>['type'] = inner.type;
    let description = innerDesc;
    for (let i = 0; i < dimensions; i++) {
      type = new GraphQLList(new GraphQLNonNull(type as GraphQLScalarType));
      description = `Array<${description}>`;
    }

    return { type, description };
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
      return { type: GraphQLBoolean, description: 'Boolean' };
    case 'object':
      if (column instanceof PgTimestamp || column instanceof PgDate) {
        return { type: GraphQLDateTime, description: 'DateTime' };
      }
      return column.columnType === 'PgGeometryObject'
        ? {
            type: isInput ? geoXyInputType : geoXyType,
            description: 'Geometry points XY',
          }
        : column.columnType === 'PgBytea'
          ? {
              type: new GraphQLList(new GraphQLNonNull(GraphQLInt)),
              description: 'Buffer',
            }
          : { type: GraphQLJSON, description: 'JSON' };
    case 'string':
      if (column.enumValues?.length) {
        return { type: generateEnumCached(column, columnName, tableName) };
      }

      // numeric/decimal columns (pg numeric, mysql decimal, sqlite numeric) transport as
      // strings, but they are numbers — give them the named Decimal scalar so the SDL says
      // so and non-numeric input is rejected. Array-typed numeric columns (dimensions > 0)
      // keep their existing mapping.
      if (constraint === 'numeric' && !(column as any).dimensions) {
        return { type: GraphQLDecimalString, description: 'Decimal' };
      }

      if (column instanceof PgTimestamp || column instanceof PgTimestampString) {
        return { type: GraphQLDateTime, description: 'DateTime' };
      }
      if (column instanceof PgUUID) {
        return { type: GraphQLUUID, description: 'UUID' };
      }
      if (column instanceof PgDateString) {
        // For input, accept any string (drivers truncate ISO timestamps to date on write).
        // For output, keep the strict GraphQLDate scalar so the returned value is validated.
        return isInput ? { type: GraphQLString, description: 'Date' } : { type: GraphQLDate, description: 'Date' };
      }

      return { type: GraphQLString, description: 'String' };
    case 'bigint':
      return { type: GraphQLBigIntString, description: 'BigInt' };
    case 'number': {
      return is(column, PgInteger) ||
        is(column, PgSerial) ||
        is(column, MySqlInt) ||
        is(column, MySqlSerial) ||
        is(column, SQLiteInteger)
        ? { type: GraphQLInt, description: 'Integer' }
        : { type: GraphQLFloat, description: 'Float' };
    }
    case 'array': {
      if (column.columnType === 'PgVector') {
        return {
          type: new GraphQLList(new GraphQLNonNull(GraphQLFloat)),
          description: 'Array<Float>',
        };
      }

      if (column.columnType === 'PgGeometry') {
        return {
          type: new GraphQLList(new GraphQLNonNull(GraphQLFloat)),
          description: 'Tuple<[Float, Float]>',
        };
      }

      const innerType = columnToGraphQLCore(
        (column as unknown as { baseColumn: Column }).baseColumn,
        columnName,
        tableName,
        isInput,
      );

      return {
        type: new GraphQLList(new GraphQLNonNull(innerType.type as GraphQLScalarType)),
        description: `Array<${innerType.description}>`,
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
 * the result in the override registry. Called once per schema build, before any types are
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
  for (const [tableName, table] of Object.entries(tables)) {
    for (const [columnName, column] of Object.entries(getTableColumns(table))) {
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

export const drizzleColumnToGraphQLType = <TColumn extends Column, TIsInput extends boolean>(
  column: TColumn,
  columnName: string,
  tableName: string,
  forceNullable = false,
  defaultIsNullable = false,
  isInput: TIsInput = false as TIsInput,
): ConvertedColumn<TIsInput> => {
  const override = getColumnScalarOverride(column, isInput);
  let typeDesc: ConvertedColumn<boolean>;
  if (override) {
    // The override replaces built-in detection entirely; the description mirrors the
    // pattern used for the built-in named scalars (BigInt, DateTime, JSON, …).
    typeDesc = { type: override, description: override.name };
  } else {
    typeDesc = columnToGraphQLCore(column, columnName, tableName, isInput);
    const noDesc = ['string', 'boolean', 'number'];
    const { type: baseType } = extractExtendedColumnType(column);
    if (noDesc.find((e) => e === baseType)) {
      delete typeDesc.description;
    }
  }

  if (forceNullable) {
    return typeDesc as ConvertedColumn<TIsInput>;
  }
  if (column.notNull && !(defaultIsNullable && (column.hasDefault || column.defaultFn))) {
    return {
      type: new GraphQLNonNull(typeDesc.type),
      description: typeDesc.description,
    } as ConvertedColumn<TIsInput>;
  }

  return typeDesc as ConvertedColumn<TIsInput>;
};
