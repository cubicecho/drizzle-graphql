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

import type {
  Filters,
  GetRemappedTableDataType,
  GetRemappedTableInsertDataType,
  GetRemappedTableUpdateDataType,
  OrderByArgs,
} from './util/builders/index.ts';

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
 * Per-feature switches for what `buildSchema` generates. Every flag defaults to `true`.
 * See {@link BuildSchemaConfig.features}.
 */
export type SchemaFeatures = {
  /** `<plural>Aggregate` root queries and the aggregate output types. @default true */
  aggregates?: boolean;
  /**
   * `<plural>GroupBy` root queries — the same aggregates, one row per group. Requires
   * `aggregates`, whose output types the grouped result reuses.
   *
   * @default true
   */
  groupBy?: boolean;
  /** `<relation>Aggregate` fields on object types, for to-many relations. @default true */
  relationAggregates?: boolean;
  /** The `distinct` argument on list queries. @default true */
  distinct?: boolean;
  /** `create<Table>` / `create<Table>Single` mutations. @default true */
  insert?: boolean;
  /** `update<Table>` / `update<Table>Single` mutations. @default true */
  update?: boolean;
  /**
   * `update<Table>Many` mutations — batch update with a per-entry `set` and `where`,
   * executed inside one transaction. Only generated when `update` is also enabled,
   * since the entries reuse the update `set` input.
   *
   * @default true
   */
  updateMany?: boolean;
  /** `delete<Table>` / `delete<Table>Single` mutations. @default true */
  delete?: boolean;
  /**
   * `upsert<Table>` / `upsert<Table>Single` mutations — insert, or update the row that
   * already holds the same unique key. Off unless asked for, so an existing schema does
   * not grow new mutations on upgrade.
   *
   * @default false
   */
  upsert?: boolean;
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
  requireWhere?: boolean;
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
   * Turns individual generated features off.
   *
   * Every flag defaults to `true` except `upsert`, which is opt-in: a build with no
   * `features` block generates exactly what it generated before this option existed.
   * Turning one off removes both the schema surface it adds and the work behind it.
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
   * Turning off every mutation feature omits the `Mutation` type entirely, exactly as
   * `mutations: false` does. Query-side features can all be off — the list and single
   * queries are always generated, so `Query` is never empty.
   */
  features?: SchemaFeatures;
  /**
   * Optional mapper from table key to singular/plural name pair.
   * When provided for a table, overrides the default (table key) naming for GraphQL type names,
   * query field names, and mutation field names.
   * Return `undefined` for tables that should use the default naming.
   *
   * Example: `(name) => name === 'users' ? { singular: 'user', plural: 'users' } : undefined`
   * produces type `User`, queries `users` / `user`, mutations `createUsers` / `createUser` for
   * the `users` table, and leaves other tables with their default names.
   */
  typeNameMapper?: (tableName: string) => { singular: string; plural: string } | undefined;
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
};
