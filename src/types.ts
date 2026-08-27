// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import type { Many, One, Relation, Table, TableRelationalConfig, TablesRelationalConfig } from 'drizzle-orm';

// Relations class was removed in drizzle-orm 1.0; stub for type compatibility
type Relations<TTable extends string = string, TConfig extends Record<string, Relation> = Record<string, Relation>> = {
  table: { _: { name: TTable } };
  config: (helpers: unknown) => TConfig;
};

import type { MySqlDatabase } from 'drizzle-orm/mysql-core';
import type { RelationalQueryBuilder as MySqlQuery } from 'drizzle-orm/mysql-core/query-builders/query';
import type { PgAsyncDatabase } from 'drizzle-orm/pg-core';
import type { RelationalQueryBuilder as PgQuery } from 'drizzle-orm/pg-core/query-builders/query';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { RelationalQueryBuilder as SQLiteQuery } from 'drizzle-orm/sqlite-core/query-builders/query';
import type {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLSchema,
} from 'graphql';

import type { WriteHooks } from './util/builders/common.ts';
import type {
  Filters,
  GetRemappedTableDataType,
  GetRemappedTableInsertDataType,
  GetRemappedTableUpdateDataType,
  OrderByArgs,
} from './util/builders/index.ts';
import type {
  ColumnDeprecator,
  ColumnDescriber,
  ColumnTypeMapper,
  EnumNameMapper,
  RelationDescriber,
  ScalarOverridesConfig,
  TableDescriber,
} from './util/type-converter/types.ts';

export type MakeRequired<T> = T & { [P in keyof T]-?: T[P] };

export type AnyDrizzleDB<TSchema extends Record<string, any>> =
  | PgAsyncDatabase<any, TSchema>
  | BaseSQLiteDatabase<any, any, TSchema>
  | MySqlDatabase<any, any, TSchema>;

export type AnyQueryBuiler<TConfig extends TablesRelationalConfig = any, TFields extends TableRelationalConfig = any> =
  | PgQuery<TConfig, TFields>
  | MySqlQuery<any, TConfig, TFields>
  | SQLiteQuery<any, any, TConfig, TFields>;

export type ExtractTables<TSchema extends Record<string, Table | unknown>> = {
  [K in keyof TSchema as TSchema[K] extends Table ? K : never]: TSchema[K] extends Table ? TSchema[K] : never;
};

export type ExtractRelations<TSchema extends Record<string, Table | unknown>> = {
  [K in keyof TSchema as TSchema[K] extends Relations ? K : never]: TSchema[K] extends Relations ? TSchema[K] : never;
};

export type ExtractTableRelations<TTable extends Table, TSchemaRelations extends Record<string, Relations>> = {
  [K in keyof TSchemaRelations as TSchemaRelations[K]['table']['_']['name'] extends TTable['_']['name']
    ? K
    : never]: TSchemaRelations[K]['table']['_']['name'] extends TTable['_']['name']
    ? TSchemaRelations[K] extends Relations<any, infer RelationConfig>
      ? RelationConfig
      : never
    : never;
};

export type ExtractTableByName<TTableSchema extends Record<string, Table>, TName extends string> = {
  [K in keyof TTableSchema as TTableSchema[K]['_']['name'] extends TName
    ? K
    : never]: TTableSchema[K]['_']['name'] extends TName ? TTableSchema[K] : never;
};

export type MutationReturnlessResult = {
  isSuccess: boolean;
};

export type QueryArgs<TTable extends Table, isSingle extends boolean> = Partial<
  (isSingle extends true
    ? {
        offset: number;
      }
    : {
        offset: number;
        limit: number;
      }) & {
    where: Filters<TTable>;
    orderBy: OrderByArgs<TTable>;
  }
>;

export type InsertArgs<TTable extends Table, isSingle extends boolean> = isSingle extends true
  ? {
      values: GetRemappedTableInsertDataType<TTable>;
    }
  : {
      values: Array<GetRemappedTableInsertDataType<TTable>>;
    };

export type UpdateArgs<TTable extends Table> = Partial<{
  set: GetRemappedTableUpdateDataType<TTable>;
  where?: Filters<TTable>;
}>;

/**
 * One entry of an `update<Table>Many` mutation: the rows `where` matches get this
 * entry's `set` applied. An omitted `where` matches every row, same as `update<Table>`.
 */
export type UpdateManyEntry<TTable extends Table> = {
  where?: Filters<TTable>;
  set: GetRemappedTableUpdateDataType<TTable>;
};

export type UpdateManyArgs<TTable extends Table> = {
  updates: Array<UpdateManyEntry<TTable>>;
};

/**
 * The `onConflict` argument of the generated upsert mutations.
 *
 * `target` and `where` exist on PostgreSQL and SQLite only: MySQL's
 * `ON DUPLICATE KEY UPDATE` fires on whichever unique key was violated and takes no
 * predicate, so neither field is generated there.
 */
export type UpsertConflictArgs<TTable extends Table> = {
  action?: 'UPDATE' | 'NOTHING';
  target?: string[];
  update?: string[];
  where?: Filters<TTable>;
};

export type UpsertArgs<TTable extends Table, isSingle extends boolean> = InsertArgs<TTable, isSingle> & {
  onConflict?: UpsertConflictArgs<TTable>;
};

export type DeleteArgs<TTable extends Table> = {
  where?: Filters<TTable>;
};

/** Arguments of `update<Table>Single` — unlike the plural variant, `where` is required. */
export type UpdateSingleArgs<TTable extends Table> = {
  set: GetRemappedTableUpdateDataType<TTable>;
  where: Filters<TTable>;
};

/** Arguments of `delete<Table>Single` — unlike the plural variant, `where` is required. */
export type DeleteSingleArgs<TTable extends Table> = {
  where: Filters<TTable>;
};

export type SelectResolver<
  TTable extends Table,
  TTables extends Record<string, Table>,
  TRelations extends Record<string, Relation>,
> = (
  source: any,
  args: Partial<QueryArgs<TTable, false>>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<
  keyof TRelations extends infer RelKey
    ? RelKey extends string
      ? Array<
          GetRemappedTableDataType<TTable> & {
            [K in RelKey]: TRelations[K] extends One<string>
              ? GetRemappedTableDataType<
                  ExtractTableByName<TTables, TRelations[K]['referencedTableName']> extends infer T ? T[keyof T] : never
                > | null
              : TRelations[K] extends Many<string>
                ? Array<
                    GetRemappedTableDataType<
                      ExtractTableByName<TTables, TRelations[K]['referencedTableName']> extends infer T
                        ? T[keyof T]
                        : never
                    >
                  >
                : never;
          }
        >
      : Array<GetRemappedTableDataType<TTable>>
    : Array<GetRemappedTableDataType<TTable>>
>;

export type SelectSingleResolver<
  TTable extends Table,
  TTables extends Record<string, Table>,
  TRelations extends Record<string, Relation>,
> = (
  source: any,
  args: Partial<QueryArgs<TTable, true>>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<
  | (keyof TRelations extends infer RelKey
      ? RelKey extends string
        ? GetRemappedTableDataType<TTable> & {
            [K in RelKey]: TRelations[K] extends One<string>
              ? GetRemappedTableDataType<
                  ExtractTableByName<TTables, TRelations[K]['referencedTableName']> extends infer T ? T[keyof T] : never
                > | null
              : TRelations[K] extends Many<string>
                ? Array<
                    GetRemappedTableDataType<
                      ExtractTableByName<TTables, TRelations[K]['referencedTableName']> extends infer T
                        ? T[keyof T]
                        : never
                    >
                  >
                : never;
          }
        : GetRemappedTableDataType<TTable>
      : GetRemappedTableDataType<TTable>)
  | null
>;

/** Resolver for `create<Table>Single`: one row in, one row (or `undefined`) out. */
export type InsertResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: Partial<InsertArgs<TTable, true>>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? GetRemappedTableDataType<TTable> | undefined : MutationReturnlessResult>;

/** Resolver for `create<Table>`: an array of rows in, an array of rows out. */
export type InsertArrResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: Partial<InsertArgs<TTable, false>>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? Array<GetRemappedTableDataType<TTable>> : MutationReturnlessResult>;

export type UpdateResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: UpdateArgs<TTable>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? GetRemappedTableDataType<TTable> | undefined : MutationReturnlessResult>;

/**
 * Resolver for `update<Table>Many`: per-entry `set`/`where` pairs applied in input order
 * inside one transaction. Where the dialect returns rows, the result holds each entry's
 * updated rows in entry order, with `null` standing in for an entry whose `where`
 * matched no rows.
 */
export type UpdateManyResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: UpdateManyArgs<TTable>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? Array<GetRemappedTableDataType<TTable> | null> : MutationReturnlessResult>;

/**
 * Resolver for `update<Table>Single`: `where` required, the single (nullable) affected row
 * out. Throws before writing anything when `where` matches more than one row.
 */
export type UpdateSingleResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: UpdateSingleArgs<TTable>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? GetRemappedTableDataType<TTable> | undefined : MutationReturnlessResult>;

/** Resolver for `upsert<Table>Single`. */
export type UpsertResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: Partial<UpsertArgs<TTable, true>>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? GetRemappedTableDataType<TTable> | undefined : MutationReturnlessResult>;

/** Resolver for `upsert<Table>`. */
export type UpsertArrResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: Partial<UpsertArgs<TTable, false>>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? Array<GetRemappedTableDataType<TTable>> : MutationReturnlessResult>;

/**
 * Resolver for a table's generated aggregate query (`<plural>Aggregate`).
 * Returns only the requested aggregations: `count` plus per-column `avg` / `sum`
 * (numeric columns, as Float) and `min` / `max` (orderable columns, as the column's type).
 */
export type AggregateResolver<TTable extends Table> = (
  source: any,
  args: { where?: Filters<TTable> },
  context: any,
  info: GraphQLResolveInfo,
) => Promise<Record<string, any>>;

export type DeleteResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: DeleteArgs<TTable>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? GetRemappedTableDataType<TTable> | undefined : MutationReturnlessResult>;

/**
 * Resolver for `delete<Table>Single`: `where` required, the single (nullable) deleted row
 * out. Throws before writing anything when `where` matches more than one row.
 */
export type DeleteSingleResolver<TTable extends Table, IsReturnless extends boolean> = (
  source: any,
  args: DeleteSingleArgs<TTable>,
  context: any,
  info: GraphQLResolveInfo,
) => Promise<IsReturnless extends false ? GetRemappedTableDataType<TTable> | undefined : MutationReturnlessResult>;

export type QueriesCore<
  TSchemaTables extends Record<string, Table>,
  TSchemaRelations extends Record<string, Relations>,
  TInputs extends Record<string, GraphQLInputObjectType>,
  TOutputs extends Record<string, GraphQLObjectType>,
> = {
  [TName in keyof TSchemaTables as TName extends string ? `${Uncapitalize<TName>}` : never]: TName extends string
    ? {
        type: GraphQLNonNull<GraphQLList<GraphQLNonNull<TOutputs[`${Capitalize<TName>}SelectItem`]>>>;
        args: {
          offset: {
            type: GraphQLScalarType<number, number>;
          };
          limit: {
            type: GraphQLScalarType<number, number>;
          };
          orderBy: {
            type: TInputs[`${Capitalize<TName>}OrderBy`] extends GraphQLInputObjectType
              ? TInputs[`${Capitalize<TName>}OrderBy`]
              : never;
          };
          where: {
            type: TInputs[`${Capitalize<TName>}Filters`] extends GraphQLInputObjectType
              ? TInputs[`${Capitalize<TName>}Filters`]
              : never;
          };
          distinct: {
            type: GraphQLList<GraphQLNonNull<GraphQLEnumType>>;
          };
        };
        resolve: SelectResolver<
          TSchemaTables[TName],
          TSchemaTables,
          ExtractTableRelations<TSchemaTables[TName], TSchemaRelations> extends infer R ? R[keyof R] : never
        >;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string ? `${Uncapitalize<TName>}Single` : never]: TName extends string
    ? {
        type: TOutputs[`${Capitalize<TName>}SelectItem`];
        args: {
          offset: {
            type: GraphQLScalarType<number, number>;
          };
          orderBy: {
            type: TInputs[`${Capitalize<TName>}OrderBy`] extends GraphQLInputObjectType
              ? TInputs[`${Capitalize<TName>}OrderBy`]
              : never;
          };
          where: {
            type: TInputs[`${Capitalize<TName>}Filters`] extends GraphQLInputObjectType
              ? TInputs[`${Capitalize<TName>}Filters`]
              : never;
          };
        };
        resolve: SelectSingleResolver<
          TSchemaTables[TName],
          TSchemaTables,
          ExtractTableRelations<TSchemaTables[TName], TSchemaRelations> extends infer R ? R[keyof R] : never
        >;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string
    ? `${Uncapitalize<TName>}Aggregate`
    : never]: TName extends string
    ? {
        type: GraphQLNonNull<
          TOutputs[`${Capitalize<TName>}Aggregate`] extends GraphQLObjectType
            ? TOutputs[`${Capitalize<TName>}Aggregate`]
            : GraphQLObjectType
        >;
        args: {
          where: {
            type: TInputs[`${Capitalize<TName>}Filters`] extends GraphQLInputObjectType
              ? TInputs[`${Capitalize<TName>}Filters`]
              : never;
          };
        };
        resolve: AggregateResolver<TSchemaTables[TName]>;
      }
    : never;
};

export type MutationsCore<
  TSchemaTables extends Record<string, Table>,
  TInputs extends Record<string, GraphQLInputObjectType>,
  TOutputs extends Record<string, GraphQLObjectType>,
  IsReturnless extends boolean,
> = {
  [TName in keyof TSchemaTables as TName extends string ? `create${Capitalize<TName>}` : never]: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : GraphQLNonNull<GraphQLList<GraphQLNonNull<TOutputs[`${Capitalize<TName>}Item`]>>>;
        args: {
          values: {
            type: GraphQLNonNull<GraphQLList<GraphQLNonNull<TInputs[`${Capitalize<TName>}InsertInput`]>>>;
          };
        };
        resolve: InsertArrResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string
    ? `create${Capitalize<TName>}Single`
    : never]: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : TOutputs[`${Capitalize<TName>}Item`];

        args: {
          values: {
            type: GraphQLNonNull<TInputs[`${Capitalize<TName>}InsertInput`]>;
          };
        };
        resolve: InsertResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  // Optional, because upsert is the one feature that is off unless asked for — and on
  // PostgreSQL and SQLite a table with nothing unique to conflict on never gets one.
  [TName in keyof TSchemaTables as TName extends string ? `upsert${Capitalize<TName>}` : never]?: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : GraphQLNonNull<GraphQLList<GraphQLNonNull<TOutputs[`${Capitalize<TName>}Item`]>>>;
        args: {
          values: {
            type: GraphQLNonNull<GraphQLList<GraphQLNonNull<TInputs[`${Capitalize<TName>}InsertInput`]>>>;
          };
          onConflict: {
            type: GraphQLInputObjectType;
          };
        };
        resolve: UpsertArrResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string
    ? `upsert${Capitalize<TName>}Single`
    : never]?: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : TOutputs[`${Capitalize<TName>}Item`];
        args: {
          values: {
            type: GraphQLNonNull<TInputs[`${Capitalize<TName>}InsertInput`]>;
          };
          onConflict: {
            type: GraphQLInputObjectType;
          };
        };
        resolve: UpsertResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string ? `update${Capitalize<TName>}` : never]: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : GraphQLNonNull<GraphQLList<GraphQLNonNull<TOutputs[`${Capitalize<TName>}Item`]>>>;
        args: {
          set: {
            type: GraphQLNonNull<TInputs[`${Capitalize<TName>}UpdateInput`]>;
          };
          where: {
            type: TInputs[`${Capitalize<TName>}Filters`] extends GraphQLInputObjectType
              ? TInputs[`${Capitalize<TName>}Filters`]
              : never;
          };
        };
        resolve: UpdateResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string
    ? `update${Capitalize<TName>}Many`
    : never]: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : // The list items are nullable: an entry whose `where` matched no rows
            // yields `null` in its slot, keeping the result aligned with the input.
            GraphQLNonNull<GraphQLList<TOutputs[`${Capitalize<TName>}Item`]>>;
        args: {
          updates: {
            type: GraphQLNonNull<GraphQLList<GraphQLNonNull<TInputs[`${Capitalize<TName>}UpdateManyInput`]>>>;
          };
        };
        resolve: UpdateManyResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string
    ? `update${Capitalize<TName>}Single`
    : never]: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : TOutputs[`${Capitalize<TName>}Item`];
        args: {
          set: {
            type: GraphQLNonNull<TInputs[`${Capitalize<TName>}UpdateInput`]>;
          };
          where: {
            type: GraphQLNonNull<
              TInputs[`${Capitalize<TName>}Filters`] extends GraphQLInputObjectType
                ? TInputs[`${Capitalize<TName>}Filters`]
                : never
            >;
          };
        };
        resolve: UpdateSingleResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string ? `delete${Capitalize<TName>}` : never]: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : GraphQLNonNull<GraphQLList<GraphQLNonNull<TOutputs[`${Capitalize<TName>}Item`]>>>;
        args: {
          where: {
            type: TInputs[`${Capitalize<TName>}Filters`] extends GraphQLInputObjectType
              ? TInputs[`${Capitalize<TName>}Filters`]
              : never;
          };
        };
        resolve: DeleteResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
} & {
  [TName in keyof TSchemaTables as TName extends string
    ? `delete${Capitalize<TName>}Single`
    : never]: TName extends string
    ? {
        type: IsReturnless extends true
          ? TOutputs['MutationReturn'] extends GraphQLObjectType
            ? TOutputs['MutationReturn']
            : never
          : TOutputs[`${Capitalize<TName>}Item`];
        args: {
          where: {
            type: GraphQLNonNull<
              TInputs[`${Capitalize<TName>}Filters`] extends GraphQLInputObjectType
                ? TInputs[`${Capitalize<TName>}Filters`]
                : never
            >;
          };
        };
        resolve: DeleteSingleResolver<TSchemaTables[TName], IsReturnless>;
      }
    : never;
};

export type GeneratedInputs<TSchema extends Record<string, Table>> = {
  [TName in keyof TSchema as TName extends string ? `${Capitalize<TName>}InsertInput` : never]: GraphQLInputObjectType;
} & {
  [TName in keyof TSchema as TName extends string ? `${Capitalize<TName>}UpdateInput` : never]: GraphQLInputObjectType;
} & {
  [TName in keyof TSchema as TName extends string
    ? `${Capitalize<TName>}UpdateManyInput`
    : never]: GraphQLInputObjectType;
} & {
  [TName in keyof TSchema as TName extends string ? `${Capitalize<TName>}OrderBy` : never]: GraphQLInputObjectType;
} & {
  [TName in keyof TSchema as TName extends string ? `${Capitalize<TName>}Filters` : never]: GraphQLInputObjectType;
};

export type GeneratedOutputs<TSchema extends Record<string, Table>, IsReturnless extends boolean> = {
  [TName in keyof TSchema as TName extends string ? `${Capitalize<TName>}SelectItem` : never]: GraphQLObjectType;
} & {
  [TName in keyof TSchema as TName extends string ? `${Capitalize<TName>}Aggregate` : never]: GraphQLObjectType;
} & (IsReturnless extends true
    ? {
        MutationReturn: GraphQLObjectType;
      }
    : {
        [TName in keyof TSchema as TName extends string ? `${Capitalize<TName>}Item` : never]: GraphQLObjectType;
      });

export type GeneratedEntities<
  TDatabase extends AnyDrizzleDB<TSchema>,
  TSchema extends Record<string, unknown> = TDatabase extends AnyDrizzleDB<infer ISchema> ? ISchema : never,
  TSchemaTables extends ExtractTables<TSchema> = ExtractTables<TSchema>,
  TSchemaRelations extends ExtractRelations<TSchema> = ExtractRelations<TSchema>,
  TInputs extends GeneratedInputs<TSchemaTables> = GeneratedInputs<TSchemaTables>,
  TOutputs extends GeneratedOutputs<
    TSchemaTables,
    TDatabase extends MySqlDatabase<any, any, any, any> ? true : false
  > = GeneratedOutputs<TSchemaTables, TDatabase extends MySqlDatabase<any, any, any, any> ? true : false>,
> = {
  queries: QueriesCore<TSchemaTables, TSchemaRelations, TInputs, TOutputs>;
  mutations: MutationsCore<
    TSchemaTables,
    TInputs,
    TOutputs,
    TDatabase extends MySqlDatabase<any, any, any, any> ? true : false
  >;
  inputs: TInputs;
  types: TOutputs;
  /**
   * Field-level resolvers for each relation on each table.
   * Each resolver handles both the eager path (data pre-fetched by the parent query)
   * and the lazy path (data fetched on demand with N+1 protection via request-scoped batching).
   * Keyed as `fieldResolvers[tableSchemaKey][relationName]`.
   */
  fieldResolvers: {
    [TName in keyof TSchemaTables as TName extends string ? TName : never]?: Record<
      string,
      (source: any, args: any, context: any, info: GraphQLResolveInfo) => Promise<any>
    >;
  };
};

export type GeneratedData<TDatabase extends AnyDrizzleDB<any>> = {
  schema: GraphQLSchema;
  entities: GeneratedEntities<TDatabase>;
};

/**
 * A feature switch. `true` / `false` decides for the whole build; a predicate decides per
 * table, receiving the table's key in the Drizzle schema.
 *
 * ```ts
 * features: { delete: (table) => table !== 'auditLog' }
 * ```
 */
export type FeatureSwitch = boolean | ((tableName: string) => boolean);

/**
 * Per-feature switches for what `buildSchema` generates. Every flag defaults to `true` except
 * `upsert`, `nestedWrites`, `fieldUpdateOperations`, `countMutations` and `requireWhere`.
 * Each one takes a boolean or a per-table predicate, apart from `nestedWrites`, which is
 * build-wide.
 * See {@link BuildSchemaConfig.features}.
 */
export type SchemaFeatures = {
  /** `<plural>Aggregate` root queries and the aggregate output types. @default true */
  aggregates?: FeatureSwitch;
  /**
   * `<plural>GroupBy` root queries — the same aggregates, one row per group. Requires
   * `aggregates`, whose output types the grouped result reuses.
   *
   * @default true
   */
  groupBy?: FeatureSwitch;
  /** `<relation>Aggregate` fields on object types, for to-many relations. @default true */
  relationAggregates?: FeatureSwitch;
  /** The `distinct` argument on list queries. @default true */
  distinct?: FeatureSwitch;
  /** `create<Table>` / `create<Table>Single` mutations. @default true */
  insert?: FeatureSwitch;
  /** `update<Table>` / `update<Table>Single` mutations. @default true */
  update?: FeatureSwitch;
  /**
   * `update<Table>Many` mutations — batch update with a per-entry `set` and `where`,
   * executed inside one transaction. Only generated when `update` is also enabled,
   * since the entries reuse the update `set` input.
   *
   * @default true
   */
  updateMany?: FeatureSwitch;
  /** `delete<Table>` / `delete<Table>Single` mutations. @default true */
  delete?: FeatureSwitch;
  /**
   * `upsert<Table>` / `upsert<Table>Single` mutations — insert, or update the row that
   * already holds the same unique key. Off unless asked for, so an existing schema does
   * not grow new mutations on upgrade.
   *
   * @default false
   */
  upsert?: FeatureSwitch;
  /**
   * Relation fields on `Create<Table>Input` and `Update<Table>Input`, so a parent row and
   * the rows it is related to can be written in one mutation. Off unless asked for: it adds
   * a field per writable relation to every create and update input.
   *
   * ```graphql
   * createPostsSingle(values: {
   *   title: "Hello"
   *   author: { connect: { id: { eq: "a1" } } }
   *   tags: { create: [{ name: "drizzle" }] }
   * }) { id }
   * ```
   *
   * Each relation field offers `create` and `connect`; the update input adds `disconnect`
   * and, for a to-many relation, `set` (replace the whole set). `disconnect` and `set` are
   * generated only when the foreign key is nullable — there is no way to detach a row whose
   * key is NOT NULL — and many-to-many (`.through()`) relations are not written through at
   * all. Nesting is one level deep: the row a nested `create` inserts takes columns only.
   *
   * The whole tree runs in one transaction (a savepoint when the request already carries
   * one), and a column a relation fills in (`authorId`, when `author: { create: … }` is
   * offered) becomes nullable on the create input, since the relation is the other way to
   * supply it.
   *
   * PostgreSQL and SQLite only. MySQL cannot return the rows it just wrote, which is how a
   * nested write learns the parent's key, so `buildSchema` rejects the flag there. On SQLite
   * the driver must be asynchronous (libsql, D1, …): a synchronous one commits before an
   * awaited statement runs, so `buildSchema` rejects the combination outright.
   *
   * @default false
   */
  nestedWrites?: boolean;
  /**
   * Operation inputs on the update `set`, so a column can be changed relative to its current
   * value instead of only replaced.
   *
   * ```graphql
   * updatePostsSingle(where: { id: { eq: "p1" } }, set: { views: { increment: 1 } }) { views }
   * ```
   *
   * Every numeric column's field on `Update<Table>Input` becomes a `<Scalar>FieldUpdate`
   * input carrying `set`, `increment`, `decrement`, `multiply` and `divide`; every array
   * column's becomes a `<Scalar>ListFieldUpdate` carrying `set` and `push`. Exactly one
   * operation per field, checked at resolve time. `set` is the explicit spelling of what the
   * field did before, so `set: { views: 42 }` becomes `set: { views: { set: 42 } }`.
   *
   * The arithmetic happens in the database (`SET views = views + 1`), so a counter no longer
   * needs a read-modify-write round trip and no longer loses concurrent updates. Rounding on
   * an integer column, and division by zero, follow the database's own rules rather than
   * being guarded here. Columns owned by a scalar override keep their plain type — an
   * override owns what the column accepts.
   *
   * Off by default: it changes the type of every numeric and array field on every update
   * input, which no existing document is written against.
   *
   * @default false
   */
  fieldUpdateOperations?: FeatureSwitch;
  /**
   * `update<Table>Count` / `delete<Table>Count` mutations — the same write as the plural
   * `update<Table>` / `delete<Table>`, returning the number of rows affected instead of the
   * rows themselves.
   *
   * ```graphql
   * deletePostsCount(where: { published: { eq: false } })   # Int!
   * ```
   *
   * A mass update or delete otherwise has to `RETURNING *` every row it touched purely so
   * the caller can count them, which crosses the driver and is serialized through GraphQL
   * for nothing. Each mutation is generated only when its plural counterpart is
   * (`features.update` / `features.delete`), and honours `features.requireWhere`.
   *
   * Off unless asked for, so an existing schema does not grow new mutations on upgrade.
   *
   * @default false
   */
  countMutations?: FeatureSwitch;
  /**
   * Makes `where` non-null on the plural `update<Table>` / `delete<Table>` mutations, and
   * rejects a `where` that collapses to no filters (e.g. `where: {}`), so a schema can rule
   * out unbounded writes at the type level. Off by default for backwards compatibility.
   *
   * The `Single` variants (`update<Table>Single` / `delete<Table>Single`) require a
   * non-empty `where` regardless of this flag.
   *
   * @default false
   */
  requireWhere?: FeatureSwitch;
};

/**
 * Per-field cost hints for `graphql-query-complexity` (or any estimator that reads
 * `extensions.complexity`). See {@link BuildSchemaConfig.complexity}.
 */
export type ComplexityConfig = {
  /**
   * Rows a list field is assumed to return when the query passes no `limit`. Raise it if your
   * tables are large and clients routinely omit `limit`.
   *
   * @default 10
   */
  defaultListSize?: number;
  /**
   * Flat cost charged for an aggregate field, on top of whatever is selected inside it. An
   * aggregate returns one row but reads however many match, so it is priced as a scan.
   *
   * @default 10
   */
  aggregateCost?: number;
};

/**
 * A limit policy: what a request without `limit` gets, and how large a `limit` may be.
 * Every field is optional — an empty policy is the default unbounded behavior.
 */
export type TableLimitPolicy = {
  /** Applied when the client passes no `limit`. Capped by `maxLimit` when both are set. */
  defaultLimit?: number;
  /**
   * The largest `limit` a client may ask for. Also bounds a request that passes no `limit` at
   * all, since that means every row.
   */
  maxLimit?: number;
  /**
   * `false` (default) rejects a `limit` above `maxLimit` with a GraphQL error; `true` reduces
   * it to `maxLimit` instead.
   */
  clampToMax?: boolean;
};

/** {@link BuildSchemaConfig.limits} — a global policy plus per-table overrides. */
export type LimitsConfig = TableLimitPolicy & {
  /** Per-table overrides, keyed by the table's key in the Drizzle schema. */
  tables?: Record<string, TableLimitPolicy>;
};

/**
 * What a {@link RowScope} may return: a Drizzle `SQL` expression, a filter object in the same
 * shape as the generated `where` argument, or `undefined`/`null` for "no restriction".
 *
 * The filter-object form is compiled with the same code that compiles a client `where`, so it
 * supports relation filters — `{ author: { orgId: { eq: 1 } } }` scopes a table through a join
 * rather than a column it owns.
 */
export type RowScopeFilter = Record<string, any> | undefined | null;

/**
 * A per-table row scope: given the GraphQL context, the predicate every read and write of that
 * table is confined to.
 *
 * `table` is the table instance the current statement runs against. For a relational read that
 * is Drizzle's *aliased* copy of the table, so build the predicate from this argument rather
 * than from the imported table object — `eq(table.orgId, ctx.orgId)` is always correct, while
 * `eq(users.orgId, ctx.orgId)` refers to the wrong alias inside a nested read.
 *
 * See {@link BuildSchemaConfig.scope}.
 */
export type RowScope<TContext = any> = (context: TContext, table: any) => RowScopeFilter | object;

/** {@link BuildSchemaConfig.scope} — a row scope per table, keyed by the Drizzle schema key. */
export type ScopeConfig<TContext = any> = Record<string, RowScope<TContext>>;

/**
 * {@link BuildSchemaConfig.contextValues} — columns whose value the server derives from the
 * request context, keyed by Drizzle schema key and then by column property name.
 */
export type ContextValuesConfig<TContext = any> = Record<string, Record<string, (context: TContext) => any>>;

/**
 * How one table marks a row deleted: the column's property name, or that name plus the values
 * written on delete and on restore. See {@link BuildSchemaConfig.softDelete}.
 */
export type SoftDeleteColumn =
  | string
  | {
      /** Property name of the column that marks a row deleted. */
      column: string;
      /**
       * Written when a row is deleted. A function is evaluated per delete. Defaults by column
       * type: `new Date()` for a timestamp, an ISO string for text, `Date.now()` for a number,
       * `true` for a boolean. Required, as a constant, when the column is NOT NULL and not a
       * boolean — the predicate that hides marked rows has to compare against it.
       */
      deletedValue?: any;
      /**
       * Written when a row is restored. Defaults to `null` for a nullable column and `false`
       * for a NOT NULL boolean; required for any other NOT NULL column.
       */
      restoredValue?: any;
    };

/**
 * The write-hook types, re-exported from the builder that defines them so a consumer can type
 * a hook without reaching into the package's internals. See {@link BuildSchemaConfig.onWrite}.
 */
export type {
  WriteHook,
  WriteHookPayload,
  WriteHookPositions,
  WriteHooks,
  WriteOperation,
} from './util/builders/common.ts';

/**
 * Write hooks, either applied to every table (a bare function, or an object naming the
 * positions) or registered per table by Drizzle schema key. See
 * {@link BuildSchemaConfig.onWrite}.
 */
export type OnWriteConfig = WriteHooks | Record<string, WriteHooks>;

/**
 * Per-table soft-delete declarations, either keyed by Drizzle schema key or as a rule applied
 * to every table. See {@link BuildSchemaConfig.softDelete}.
 */
export type SoftDeleteConfig =
  | Record<string, SoftDeleteColumn>
  | ((table: any, tableName: string) => SoftDeleteColumn | undefined | null);

/**
 * {@link BuildSchemaConfig.exclude} — tables and columns to keep out of the generated schema.
 *
 * Both lists are keyed by the Drizzle schema key, not the database name and not the generated
 * GraphQL name.
 */
export type SchemaExclusions = {
  /**
   * Tables that generate nothing at all: no object type, no queries, no mutations, and no
   * relation fields on other tables that point at them.
   */
  tables?: string[];
  /** Per-table column exclusions, keyed by the table's key in the Drizzle schema. */
  columns?: Record<string, string[]>;
};

export type BuildSchemaConfig = {
  /**
   * Determines whether generated mutations will be passed to returned schema.
   *
   * Set value to `false` to omit mutations from returned schema.
   *
   * Flag is treated as if set to `true` by default.
   */
  mutations?: boolean;
  /**
   * Limits depth of relation-field generation.
   *
   * Expects a non-negative integer or `undefined`.
   *
   * `undefined` (default) — no limit; all relations are generated recursively
   * until a cycle is detected.
   *
   * `0` — no relation fields are generated on any type. Useful for a flat,
   * columns-only schema.
   *
   * `N > 0` — each table's own direct relations are still generated (every
   * table's root type is processed at depth 0, which is always < N). The
   * depth limit controls how deep the generation RECURSES when traversing
   * related types; because all types share a single instance via the type
   * cache, setting N > 0 currently behaves the same as `undefined` for the
   * final schema shape. The principal useful values are `0` (no relations)
   * and `undefined` (unlimited).
   */
  relationsDepthLimit?: number;
  /**
   * Customizes query name prefixes for generated GraphQL operations.
   *
   * @default { insert: 'create', delete: 'delete', update: 'update', upsert: 'upsert' }
   */
  prefixes?: {
    /** Prefix for insert mutations (e.g., 'users' -> 'createUsers') */
    insert?: string;
    /** Prefix for delete mutations (e.g., 'users' -> 'deleteUsers') */
    delete?: string;
    /** Prefix for update mutations (e.g., 'users' -> 'updateUsers') */
    update?: string;
    /** Prefix for upsert mutations (e.g., 'users' -> 'upsertUsers') */
    upsert?: string;
    /**
     * Prefix for the restore mutations of a soft-deleting table (e.g., 'users' ->
     * 'restoreUsers'). Only used when {@link BuildSchemaConfig.softDelete} names the table.
     */
    restore?: string;
  };

  /**
   * Customizes query name suffixes for generated GraphQL operations.
   *
   * @default { list: '', single: 'Single' }
   */
  suffixes?: {
    /** Suffix for list queries (e.g., 'users' -> 'users' + suffix) */
    list?: string;
    /** Suffix for single queries (e.g., 'users' -> 'users' + suffix) */
    single?: string;
  };
  /**
   * When true, insert mutations will use onConflictDoNothing() to silently
   * ignore duplicate key violations. Defaults to false (conflicts throw errors).
   *
   * PostgreSQL and SQLite only — MySQL's insert builder has no equivalent, so the flag is
   * ignored there and conflicts keep throwing.
   *
   * @deprecated Build-wide and unconditional: a request cannot opt out of it, and a
   * swallowed insert returns `null` with no indication why. Turn on `features.upsert` and
   * pass `onConflict: { action: NOTHING }` per request instead. This flag keeps working
   * until the next major.
   */
  conflictDoNothing?: boolean;
  /**
   * Cost hints published as `extensions.complexity` on the generated fields, for
   * `graphql-query-complexity`'s `fieldExtensionsEstimator`.
   *
   * The generator knows which fields are paginated and which are aggregates, so a list field is
   * priced at `(limit ?? defaultListSize) * childComplexity` and an aggregate at
   * `aggregateCost + childComplexity`. Everything else is left alone and falls through to your
   * estimator's default. The hints are inert until you install a complexity rule, so they are on
   * by default; pass `false` to omit them.
   *
   * Cost is not a depth bound — a cyclic relation graph still lets a client nest arbitrarily
   * deep. Put a depth limit in front of a publicly exposed schema as well.
   *
   * ```ts
   * import { createComplexityRule, fieldExtensionsEstimator, simpleEstimator } from 'graphql-query-complexity';
   *
   * const rule = createComplexityRule({
   *   maximumComplexity: 1000,
   *   estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
   * });
   * ```
   *
   * @default true
   */
  complexity?: boolean | ComplexityConfig;
  /**
   * Turns individual generated features off, for the whole build or per table.
   *
   * Every flag defaults to `true` except `upsert` and `nestedWrites`, which are opt-in: a
   * build with no `features` block generates exactly what it generated before this option
   * existed. Turning one off removes both the schema surface it adds and the work behind it.
   *
   * ```ts
   * buildSchema(db, {
   *   features: {
   *     aggregates: false,         // no `<plural>Aggregate` root queries
   *     relationAggregates: false, // no `<relation>Aggregate` fields on object types
   *     distinct: false,           // no `distinct` argument on list queries
   *     delete: false,             // no delete mutations
   *     upsert: true,              // opt in to `upsert<Table>` mutations
   *   },
   * });
   * ```
   *
   * Any flag may instead be a predicate, which is asked once per table with the table's key
   * in the Drizzle schema — the usual case, where a handful of tables must not be written
   * through the API and the rest want the full set:
   *
   * ```ts
   * buildSchema(db, {
   *   features: {
   *     delete: (table) => table !== 'auditLog',
   *     update: (table) => !ownedByCustomResolver.has(table),
   *     upsert: (table) => table === 'settings',
   *   },
   * });
   * ```
   *
   * A table that generates nothing at all belongs in {@link BuildSchemaConfig.exclude}; this
   * decides which operations a table that *is* in the schema offers. `nestedWrites` is the one
   * flag that stays build-wide: its plans are computed once over the whole relation graph, and
   * a nested write reaches a second table by definition.
   *
   * Some operations are built out of others — an upsert writes through insert and update, a
   * batch update reuses the update input, a grouped query reuses the aggregate types. Flags
   * that contradict those implications warn on the console at build time (naming the tables)
   * rather than leaving a second write path past the operation you turned off to be found
   * later.
   *
   * Turning off every mutation feature for every table omits the `Mutation` type entirely,
   * exactly as `mutations: false` does. Query-side features can all be off — the list and
   * single queries are always generated, so `Query` is never empty.
   */
  features?: SchemaFeatures;
  /**
   * Automatic transactions for GraphQL documents that fire more than one mutation.
   *
   * `'none'` (default) — every root mutation field runs on its own connection, so a failure
   * mid-document leaves the earlier mutations committed (today's behavior).
   *
   * `'auto'` — when a request's document selects more than one root mutation field, the
   * library opens `db.transaction()` once for the whole request and runs every mutation
   * field (and the reads nested under them) inside it. The transaction commits when the
   * last mutation field completes and rolls back when any of them fails; mutation fields
   * after a failure are not executed against the rolled-back transaction — they fail fast.
   * The object form additionally sets the safety timeout (default 30000ms) after which an
   * abandoned transaction — e.g. the host server stopped calling resolvers because of a
   * non-null completion error — is rolled back instead of leaking a connection.
   *
   * Never nests: a caller-supplied executor on the GraphQL context under
   * `drizzleExecutorKey` always wins, and the library opens nothing of its own.
   *
   * Requirements and caveats:
   * - The driver must support `db.transaction()` (e.g. `neon-http` does not). For SQLite
   *   only asynchronous drivers (libsql, better-sqlite3 is synchronous) can hold a
   *   transaction open across resolvers; `buildSchema` throws for synchronous ones.
   * - The GraphQL context value must be a fresh object per request (every mainstream
   *   server does this) — it keys the per-request transaction state.
   * - Documents that mix in mutation fields not generated by this build (consumer
   *   extensions) are left alone: their completion cannot be tracked, so no transaction
   *   is opened.
   *
   * @default 'none'
   */
  transactions?: 'auto' | 'none' | { mode: 'auto'; timeoutMs?: number };
  /**
   * Bounds on the `limit` argument of list queries and to-many relation fields.
   *
   * Both knobs are off by default: without them a client can omit `limit` and pull a whole
   * table, or pass `limit: 1000000` and do the same thing politely. Turning either on changes
   * observable behavior for existing consumers, so nothing is applied unless asked for.
   *
   * ```ts
   * buildSchema(db, {
   *   limits: {
   *     defaultLimit: 50,  // used when the client passes no `limit`
   *     maxLimit: 500,     // anything above is rejected
   *     tables: {
   *       auditLog: { defaultLimit: 20, maxLimit: 100 },
   *     },
   *   },
   * });
   * ```
   *
   * - Applies to root list queries **and** to to-many relation fields — an unbounded relation
   *   inside a bounded root is the same scan one level down. A relation field takes the policy
   *   of the table it *targets*, so a table is bounded wherever it is reached from. Single-row
   *   queries and aggregates take no `limit` and are unaffected.
   * - A `limit` above `maxLimit` is rejected with a GraphQL error. Set `clampToMax: true` to
   *   silently reduce it instead — honest paginating clients prefer the error, since a clamped
   *   page looks like the end of the results.
   * - `maxLimit` on its own also bounds the *omitted* case: no `limit` means every row, which
   *   is above any maximum. `defaultLimit` is what a request without `limit` gets, capped by
   *   `maxLimit` if both are set.
   * - `tables` overrides per table, keyed by the Drizzle schema key. A table's entry replaces
   *   the top-level value for whichever keys it sets.
   * - Cursor pagination inherits the same policy — a keyset page needs a limit to be
   *   meaningful, and `defaultLimit` is what makes `after`-only pagination well-formed.
   * - The complexity hints price the *effective* limit, so cost estimation and enforcement
   *   agree.
   */
  limits?: LimitsConfig;
  /**
   * Row-level scoping: a predicate, derived from the GraphQL context, that every read and
   * write of a table is confined to. This is the multi-tenancy / ownership knob — the one
   * rule a wrapper cannot enforce from outside, because a nested relation field never passes
   * through a root resolver.
   *
   * ```ts
   * import { and, eq } from 'drizzle-orm';
   *
   * buildSchema(db, {
   *   scope: {
   *     posts: (ctx, table) => eq(table.orgId, ctx.orgId),
   *     // A filter object works too, and can scope through a relation:
   *     comments: (ctx) => ({ post: { orgId: { eq: ctx.orgId } } }),
   *   },
   * });
   * ```
   *
   * - The predicate is ANDed on **last**, after the client's `where`, so a client filter can
   *   only ever narrow the scope, never widen it.
   * - It applies to every path that reads the table: list and single queries, aggregates and
   *   `groupBy`, relation fields (batched and eager), relation aggregates, and cursor pages.
   * - It applies to every path that writes it: `update`, `updateMany`, `delete`, the
   *   conflict-update half of an upsert (PostgreSQL and SQLite), and the rows a nested
   *   `connect` / `disconnect` / `set` is allowed to reach. An out-of-scope row is simply not
   *   matched — a scoped `delete` reports zero rows rather than refusing.
   * - It cannot apply to a plain `insert`: there is no existing row to filter. Use
   *   {@link BuildSchemaConfig.contextValues} to stamp the owning column on the way in.
   * - `table` is the table the current statement runs against, which for a relational read is
   *   Drizzle's aliased copy — always build the predicate from that argument.
   * - Returning `undefined` means "no restriction for this context", so a hook can let an
   *   admin through. A table with no entry is unscoped.
   * - MySQL's `ON DUPLICATE KEY UPDATE` takes no predicate, so a MySQL upsert cannot be
   *   scoped on the conflict path; scope the table's `update` and rely on `contextValues`
   *   for the insert half.
   */
  scope?: ScopeConfig;
  /**
   * Columns whose value the server derives from the request context rather than accepting
   * from the client — the write-side half of {@link BuildSchemaConfig.scope}.
   *
   * ```ts
   * buildSchema(db, {
   *   contextValues: {
   *     posts: {
   *       orgId: (ctx) => ctx.orgId,
   *       authorId: (ctx) => ctx.userId,
   *     },
   *   },
   * });
   * ```
   *
   * - The column is removed from the generated insert and update inputs, so a client cannot
   *   send it at all — the schema itself documents that it is server-owned.
   * - Every insert stamps it, including the rows created by a nested `create`.
   * - Updates never write it: an update cannot hand a row to another owner.
   * - Keyed by the Drizzle schema key, then by the column's property name (not its database
   *   name), the same keying {@link BuildSchemaConfig.exclude} uses.
   */
  contextValues?: ContextValuesConfig;
  /**
   * Tables that mark rows deleted instead of removing them.
   *
   * ```ts
   * buildSchema(db, {
   *   softDelete: {
   *     users: 'deletedAt',                          // nullable timestamp: stamped on delete
   *     posts: { column: 'isDeleted', deletedValue: true, restoredValue: false },
   *   },
   * });
   *
   * // or as a convention across the whole schema:
   * buildSchema(db, { softDelete: (table) => ('deletedAt' in table ? 'deletedAt' : undefined) });
   * ```
   *
   * For a table that declares one:
   *
   * - `delete<Table>` and `delete<Table>Single` issue an `UPDATE` of the marker column
   *   instead of a `DELETE`, and return the rows as they now stand.
   * - `restore<Table>` and `restore<Table>Single` are generated alongside them, matching only
   *   marked rows and writing the restored value. The prefix is configurable through
   *   {@link BuildSchemaConfig.prefixes}.
   * - Every generated read hides marked rows: list and single queries, aggregates, `groupBy`,
   *   relation fields on both the eager and the batched path, and relation aggregates. Each
   *   of those fields takes a `deleted: EXCLUDE | INCLUDE | ONLY` argument (default
   *   `EXCLUDE`); `ONLY` is a trash view.
   * - Every generated write skips them too: an `update`, a `delete`, or a nested `connect`
   *   cannot reach a row that is already marked.
   * - The marker column is removed from the create and update inputs, so the only ways to set
   *   or clear it are the delete and restore mutations.
   * - The predicate is ANDed on before {@link BuildSchemaConfig.scope}, and both are ANDed
   *   after the client's `where` — a request can only ever narrow them.
   *
   * Two consequences of the pattern itself, which this does not paper over:
   *
   * - A marked row still occupies its unique keys, so inserting a row that reuses the natural
   *   key of a deleted one still fails on the constraint.
   * - An upsert whose conflict target hits a marked row updates nothing on PostgreSQL and
   *   SQLite (the conflict predicate excludes it) but revives it on MySQL, whose
   *   `ON DUPLICATE KEY UPDATE` takes no predicate.
   *
   * Marking a parent deleted does not mark its children — a cascade is a schema decision.
   */
  softDelete?: SoftDeleteConfig;
  /**
   * A hook that runs **inside the mutation's transaction**, so its writes commit or roll back
   * with the mutation itself — the position an audit row, an outbox row, or a denormalized
   * counter needs, and the one a `graphql-middleware` wrapper cannot occupy.
   *
   * ```ts
   * buildSchema(db, {
   *   onWrite: {
   *     posts: async ({ table, operation, rows, tx }) => {
   *       await tx.insert(auditLog).values(rows.map((row) => ({ table, operation, rowId: row.id })));
   *     },
   *   },
   * });
   * ```
   *
   * A bare function is the **`after`** hook — the position that has rows. `{ before, after }`
   * names them explicitly; `before` receives the field's args ahead of the statement, for a
   * check that has to read inside the same snapshot. Registering a bare function (or a
   * positions object) at the top level applies it to every table; anything else is read as a
   * table map keyed by Drizzle schema key, and an unknown name fails the build.
   *
   * - **`tx` is the executor the mutation ran on** — a caller-supplied executor under
   *   `drizzleExecutorKey`, the request's auto-transaction, or, for a field that would
   *   otherwise have run unwrapped, a transaction opened for it because the hook is there.
   * - **Throwing rolls the mutation back.** That is the point of the position.
   * - **`rows` are the post-write rows as the database returned them**, before the output
   *   mapper. Empty at the `before` position, and on MySQL, whose mutations return no rows.
   * - The hook fires for the **mutation field's own table**. Rows a nested write creates in
   *   another table do not fire that table's hook.
   *
   * Off by default, and a build without it opens exactly the transactions it did before.
   */
  onWrite?: OnWriteConfig;
  /**
   * Tables and columns to leave out of the generated schema entirely.
   *
   * ```ts
   * buildSchema(db, {
   *   exclude: {
   *     tables: ['magicLinks', 'sessions'],
   *     columns: { apiKeys: ['keyHash'] },
   *   },
   * });
   * ```
   *
   * An excluded **table** generates nothing: no object type, no root queries or mutations, no
   * aggregates, and no relation field on any other table that points at it. Filtering another
   * table by a relation to it is gone too, so it is unreachable rather than merely unnamed.
   *
   * An excluded **column** disappears from every surface at once — the object type, the
   * create/update/upsert inputs, the filter type, `orderBy`, the aggregate fields, the
   * `distinct` and `groupBy` enums, and the upsert conflict targets. The exclusion is
   * deliberately all-or-nothing: a column you can filter on but not select is an oracle, since
   * `where: { keyHash: { eq: '…' } }` confirms a value without ever returning it.
   *
   * Excluding a `NOT NULL` column that has no default makes that table's inserts impossible to
   * satisfy — `buildSchema` warns on the console when it sees this, and still builds, since a
   * read-only table is a reasonable thing to want.
   *
   * Names that match nothing throw, so a renamed column fails the build instead of quietly
   * un-hiding itself.
   */
  exclude?: SchemaExclusions;
  /**
   * Optional mapper from table key to singular/plural name pair.
   * When provided for a table, overrides the default (table key) naming for GraphQL type names,
   * query field names, and mutation field names.
   * Return `undefined` for tables that should use the default naming.
   *
   * Example: `(name) => name === 'users' ? { singular: 'user', plural: 'users' } : undefined`
   * produces type `User`, queries `users` / `user`, mutations `createUsers` / `createUser` for
   * the `users` table, and leaves other tables with their default names.
   *
   * Pass the string `'singularize'` for the built-in preset, which derives both forms of every
   * table key with the library's own `pluralize` — the mapper most schemas with plural table
   * keys would otherwise write by hand:
   *
   * ```ts
   * buildSchema(db, { typeNameMapper: 'singularize' });
   * // tasks -> type Task, queries `tasks` / `task`, mutations `createTasks` / `createTask`
   * ```
   *
   * The same function is exported as `singularizeMapper` for wrapping — e.g. to keep one
   * table's names as they are: `(t) => (t === 'audit_log' ? undefined : singularizeMapper(t))`.
   */
  typeNameMapper?: 'singularize' | ((tableName: string) => { singular: string; plural: string } | undefined);
  /**
   * Controls whether a relation is eagerly pre-fetched via Drizzle's `with:` clause
   * when its parent is loaded through a generated query or mutation.
   *
   * `true` (default) — every selected relation is eager-loaded in the parent's query.
   *
   * `false` — no relation is ever eager-loaded; all relations resolve lazily through
   * their (request-batched) field resolvers.
   *
   * `(tableName, relationName) => boolean` — decide per relation. Return `false` to
   * exclude that relation from `with:` (and from the mutation eager re-fetch).
   *
   * Opting a relation out does NOT remove its field resolver — it still resolves
   * lazily via the request-scoped batch loader. This is the hook for overriding a
   * relation's resolver (e.g. via `@graphql-tools/schema`'s `addResolversToSchema`)
   * without the eager `with:` query also fetching it from the database:
   *
   * ```ts
   * const { schema } = buildSchema(db, {
   *   eagerLoadRelations: (t, r) => !(t === 'Users' && r === 'posts'),
   * });
   * const finalSchema = addResolversToSchema({
   *   schema,
   *   resolvers: { Users: { posts: (parent) => myLoader.load(parent.id) } },
   * });
   * ```
   *
   * Table and relation names are the Drizzle schema keys (e.g. `Users`, `posts`),
   * matching the keys of `entities.fieldResolvers`.
   *
   * @default true
   */
  eagerLoadRelations?: boolean | ((tableName: string, relationName: string) => boolean);
  /**
   * Declarative per-table, per-column scalar overrides — replaces the GraphQL type built-in
   * detection would pick for a column with the scalar you provide, everywhere that column's
   * type surfaces: the object type, create/update inputs, filter operands (in a filter type
   * named `${Scalar}Filter`), and aggregate min/max fields.
   *
   * Keys are the Drizzle schema keys: the table's key in your schema object and the column's
   * property name. The value is either one scalar for both directions, or `{ output, input }`
   * to type outputs and inputs differently (either side may be omitted to keep the default).
   *
   * ```ts
   * buildSchema(db, {
   *   scalars: {
   *     users: {
   *       balance: GraphQLBigIntString,                      // both directions
   *       settings: { output: PrettyJSON },                  // output only, input stays default
   *     },
   *   },
   * });
   * ```
   *
   * Validation and coercion become the scalar's job: for an overridden column the generated
   * resolvers pass values through untouched — `parseValue`/`parseLiteral` results go to the
   * database driver as-is, and raw driver values go to `serialize` as-is — so the scalar must
   * accept what the driver produces and produce what the driver accepts.
   *
   * A declarative entry fully decides its column and wins over {@link mapColumnType}.
   */
  scalars?: ScalarOverridesConfig;
  /**
   * Rule-based scalar mapping, called once per column at build time — the tool for applying
   * a convention across many columns (e.g. "every `numeric` column is `Money`") or for typing
   * custom column types the built-in detection does not know.
   *
   * Return a scalar (or `{ output, input }` pair) to override the column, or `undefined` to
   * keep the default. `info` carries the table/column schema keys and the types built-in
   * detection would use (`defaultType` / `defaultInputType`), so rules can key off either the
   * Drizzle column or the default GraphQL type.
   *
   * ```ts
   * buildSchema(db, {
   *   mapColumnType: (column, { columnName }) =>
   *     column.columnType === 'PgNumeric' ? MoneyScalar : undefined,
   * });
   * ```
   *
   * Same semantics as {@link scalars} otherwise; a column matched by both is decided by
   * `scalars` alone.
   */
  mapColumnType?: ColumnTypeMapper;
  /**
   * Called for every error thrown by a generated resolver, before it reaches the client.
   *
   * Return an error to surface that one instead. Return nothing to fall through to the
   * default handling, which makes this a pure logging hook:
   *
   * ```ts
   * buildSchema(db, { onError: (error) => { logger.error(error) } })
   * ```
   *
   * The default passes through errors drizzle-graphql raises itself (bad filter, missing
   * values, invalid date, …) and replaces everything else — driver and database errors —
   * with a generic `Internal server error`, keeping the original on `originalError` so it
   * is still available to server-side logging. Database messages routinely name tables,
   * columns, constraints and the values that violated them, which is not something a
   * public API should hand back.
   *
   * To surface raw database errors instead (useful in development):
   *
   * ```ts
   * buildSchema(db, { onError: (error) => error as Error })
   * ```
   */
  onError?: (error: unknown) => unknown;
  /**
   * Supplies the GraphQL `description` for a column, everywhere that column becomes a field:
   * the object type, the create/update inputs, the filter input, and the aggregate
   * `min`/`max`/`group` fields.
   *
   * Nothing is generated by default. The library used to emit the column's own type name
   * ("DateTime", "JSON") as its description, which documented nothing a reader could not see
   * from the type — that is gone, and this hook is what puts real prose in its place. Drizzle
   * carries no column-comment metadata to read, so the text has to come from here.
   *
   * ```ts
   * const columnDocs = { Users: { email: 'Primary contact address. Unique, case-insensitive.' } };
   *
   * buildSchema(db, {
   *   describeColumn: (_column, { tableName, columnName }) => columnDocs[tableName]?.[columnName],
   * });
   * ```
   *
   * `tableName` and `columnName` are the Drizzle schema keys. Return `undefined` to leave the
   * field undocumented.
   */
  describeColumn?: ColumnDescriber;
  /**
   * Supplies the GraphQL `description` for a table's object type.
   *
   * ```ts
   * buildSchema(db, { describeTable: (tableName) => tableDocs[tableName] });
   * ```
   */
  describeTable?: TableDescriber;
  /**
   * Supplies the GraphQL `description` for a relation field on a table's object type.
   *
   * ```ts
   * buildSchema(db, {
   *   describeRelation: (tableName, relationName) =>
   *     tableName === 'Users' && relationName === 'posts' ? 'Posts this user authored.' : undefined,
   * });
   * ```
   *
   * The generated `<relation>Aggregate` companion fields are not covered — they are derived
   * fields rather than the relation itself.
   */
  describeRelation?: RelationDescriber;
  /**
   * Supplies the GraphQL `deprecationReason` for a column, marking it `@deprecated` on the
   * object type and on the create/update inputs.
   *
   * ```ts
   * buildSchema(db, {
   *   deprecateColumn: (_column, { columnName }) =>
   *     columnName === 'legacyFlag' ? 'Use `status` instead.' : undefined,
   * });
   * ```
   *
   * A required input field cannot be deprecated — GraphQL rejects the schema, since a client
   * has no way to stop sending it — so the reason is dropped on non-null input fields and
   * kept everywhere else. Filter and orderBy fields are never deprecated either: filtering on
   * a deprecated column is how a caller finds the rows that still use it.
   */
  deprecateColumn?: ColumnDeprecator;
  /**
   * Names the GraphQL enum types generated for enum columns.
   *
   * By default a column declared with a named `pgEnum` gets one shared type named after the
   * enum (`pgEnum('status', …)` → `StatusEnum`), reused by every column declared with that
   * same `pgEnum` — the database column is the same type, so a client variable typed
   * `StatusEnum!` is passable to any of them. A column with an inline value list
   * (`text({ enum: [...] })`, `mysqlEnum(...)`) keeps a per-column type named for its table
   * and column (`UsersRoleTextEnum`), because its values are shared with nothing.
   *
   * This hook overrides the name either way — for lining the schema up with another schema it
   * is stitched into, or for opting a specific column back into a type of its own:
   *
   * ```ts
   * buildSchema(db, {
   *   enumNameMapper: (info) => (info.enumName === 'status' ? 'PublicationStatus' : undefined),
   * });
   * ```
   *
   * Two columns the mapper sends to the same name share one type when their values match —
   * the way to unify inline enums declared separately that mean the same thing. Sending two
   * *different* value lists to one name throws at build time rather than producing an
   * invalid schema.
   *
   * Return `undefined` to keep the default name.
   */
  enumNameMapper?: EnumNameMapper;
};
