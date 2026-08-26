import type { Column } from 'drizzle-orm';
import type {
  GraphQLEnumType,
  GraphQLFieldConfig,
  GraphQLFieldResolver,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
} from 'graphql';

/**
 * A scalar override for one column. A bare scalar applies to both directions; the object form
 * lets output (object type, aggregate min/max) and input (create/update inputs, filter operands)
 * use different scalars — or override only one side, leaving the other on built-in detection.
 */
export type ScalarOverride = GraphQLScalarType | { output?: GraphQLScalarType; input?: GraphQLScalarType };

/**
 * Declarative per-table, per-column scalar overrides. Keys are the Drizzle schema keys —
 * the table's key in the schema object and the column's property name (not the SQL names).
 */
export type ScalarOverridesConfig = Record<string, Record<string, ScalarOverride>>;

/** Context handed to {@link ColumnTypeMapper} alongside the column itself. */
export type ColumnTypeMapperInfo = {
  /** The table's key in the Drizzle schema object. */
  tableName: string;
  /** The column's property name on the table object. */
  columnName: string;
  /**
   * The GraphQL type built-in detection would use for output positions (without nullability
   * wrapping). `undefined` when detection has no mapping for the column's data type — the
   * mapper is then the only way to give the column a type.
   */
  defaultType: GraphQLOutputType | undefined;
  /** The input-position counterpart of `defaultType`. */
  defaultInputType: GraphQLInputType | undefined;
};

/**
 * Rule-based scalar mapping, called once per column at build time. Return a scalar (or
 * `{ output, input }` pair) to override the column's GraphQL type, or `undefined` to keep
 * the built-in detection.
 */
export type ColumnTypeMapper = (column: Column, info: ColumnTypeMapperInfo) => ScalarOverride | undefined;

export type ConvertedColumn<TIsInput extends boolean = false> = {
  type:
    | GraphQLScalarType
    | GraphQLEnumType
    | GraphQLNonNull<GraphQLScalarType>
    | GraphQLNonNull<GraphQLEnumType>
    | GraphQLList<GraphQLScalarType>
    | GraphQLList<GraphQLNonNull<GraphQLScalarType>>
    | GraphQLNonNull<GraphQLList<GraphQLScalarType>>
    | GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLScalarType>>>
    | (TIsInput extends true
        ?
            | GraphQLInputObjectType
            | GraphQLNonNull<GraphQLInputObjectType>
            | GraphQLList<GraphQLInputObjectType>
            | GraphQLNonNull<GraphQLList<GraphQLInputObjectType>>
            | GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>>
        :
            | GraphQLObjectType
            | GraphQLNonNull<GraphQLObjectType>
            | GraphQLList<GraphQLObjectType>
            | GraphQLNonNull<GraphQLList<GraphQLObjectType>>
            | GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>);
  description?: string;
};

export type ConvertedColumnWithArgs = ConvertedColumn & {
  args?: GraphQLFieldConfig<any, any>['args'];
};

export type ConvertedInputColumn = {
  type: GraphQLInputObjectType;
  description?: string;
};

export type ConvertedRelationColumn = {
  type:
    | GraphQLObjectType
    | GraphQLNonNull<GraphQLObjectType>
    | GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>;
};

export type ConvertedRelationColumnWithArgs = ConvertedRelationColumn & {
  args?: GraphQLFieldConfig<any, any>['args'];
  resolve?: GraphQLFieldResolver<any, any>;
  /** Carries the `complexity` cost hint when the build generates them. */
  extensions?: GraphQLFieldConfig<any, any>['extensions'];
};
