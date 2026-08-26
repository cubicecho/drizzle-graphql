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

/** Everything an {@link EnumNameMapper} needs to name — or opt a column out of — a generated enum type. */
export type EnumNameInfo = {
  /**
   * The name the enum type was declared with (`pgEnum('status', …)`), shared by every column
   * that uses it. `undefined` for an inline value list (`text({ enum: [...] })`,
   * `mysqlEnum(...)`), which belongs to the one column that declares it.
   */
  enumName: string | undefined;
  /** The Postgres schema the named enum was declared in, when it declares one. */
  schema: string | undefined;
  /** The table's key in the Drizzle schema object. */
  tableName: string;
  /** The column's property name on the table object. */
  columnName: string;
  /** The enum's values, in declaration order. */
  values: readonly string[];
};

/**
 * Names a generated GraphQL enum type. Return `undefined` to keep the default name. See
 * `BuildSchemaConfig.enumNameMapper`.
 */
export type EnumNameMapper = (info: EnumNameInfo) => string | undefined;

/** Context handed to the documentation and deprecation hooks alongside the column itself. */
export type ColumnDocInfo = {
  /** The table's key in the Drizzle schema object. */
  tableName: string;
  /** The column's property name on the table object. */
  columnName: string;
};

/**
 * Supplies the GraphQL `description` for a generated column field. See
 * `BuildSchemaConfig.describeColumn`.
 */
export type ColumnDescriber = (column: Column, info: ColumnDocInfo) => string | undefined;

/**
 * Supplies the GraphQL `deprecationReason` for a generated column field. See
 * `BuildSchemaConfig.deprecateColumn`.
 */
export type ColumnDeprecator = (column: Column, info: ColumnDocInfo) => string | undefined;

/** Supplies the GraphQL `description` for a table's object type. See `BuildSchemaConfig.describeTable`. */
export type TableDescriber = (tableName: string) => string | undefined;

/**
 * Supplies the GraphQL `description` for a relation field. See
 * `BuildSchemaConfig.describeRelation`.
 */
export type RelationDescriber = (tableName: string, relationName: string) => string | undefined;

/**
 * The documentation hooks a build was configured with, resolved once and threaded through
 * type generation. Every member is optional; a build with no hooks generates fields with no
 * descriptions at all.
 */
export type SchemaDocs = {
  describeColumn?: ColumnDescriber;
  describeTable?: TableDescriber;
  describeRelation?: RelationDescriber;
  deprecateColumn?: ColumnDeprecator;
};

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
  /**
   * Internal label for the shape the column converted to (`'DateTime'`, `'JSON'`,
   * `'Array<Int>'`, …). A discriminator for code that has to know which conversion ran —
   * aggregate min/max date coercion, filter-input selection — never a GraphQL description:
   * restating a field's own type documents nothing, and graphql-js ignores the extra key.
   * Real documentation comes from `BuildSchemaConfig.describeColumn`.
   */
  typeLabel?: string;
  /** GraphQL description, from `BuildSchemaConfig.describeColumn`. Unset unless configured. */
  description?: string;
  /** GraphQL deprecation, from `BuildSchemaConfig.deprecateColumn`. Unset unless configured. */
  deprecationReason?: string;
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
