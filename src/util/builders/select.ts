// =============================================================================
// The read side of a table's root fields: `<table>` and `<table>Single`.
//
// All three dialects generate these identically. Everything dialect-specific
// about a relational read lives below this layer — `runRelationalSelect` takes
// the NULL ordering as a parameter, and the primary-key lookup is passed in —
// so a dialect supplies two values and gets both resolvers.
// =============================================================================

import type { Table } from 'drizzle-orm';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import type { GraphQLInputObjectType } from 'graphql';
import {
  applyLimitPolicy,
  type DrizzleErrorContext,
  generateDistinctEnum,
  type LimitPolicyFor,
  type NullOrdering,
  type RelationFilterBase,
  type ResolverPolicies,
  resolveObjectTypeName,
  resolveQueryExecutor,
  runRelationalSelect,
  selectArrayArgs,
  selectSingleArgs,
  type TypeNameMapper,
  type TypeNameResolver,
  toGraphQLError,
  withDefaultOrderBy,
  withErrorContext,
} from '../builders/common.ts';
import type { ResolveTree } from '../parse-resolve-info.ts';
import { parseResolveInfo } from '../parse-resolve-info.ts';
import { missingQueryBuilderError } from './errors.ts';
import type { CreatedResolver, TableNamedRelations, TableSelectArgs } from './types.ts';

/**
 * What a read generator gets from the build rather than from the table — the same for every
 * table, as `WriteBuildOptions` is for the write generators.
 */
export interface ReadBuildOptions {
  db: any;
  tables: Record<string, Table>;
  eagerRelations: Record<string, Record<string, TableNamedRelations>>;
  typeNameMapper?: TypeNameMapper;
  filterCtx?: RelationFilterBase;
  limits?: LimitPolicyFor;
  policies?: ResolverPolicies;
  /** The build's type-naming rule, which names the `distinct` and `deleted` enums. */
  resolveName?: TypeNameResolver;
}

/** The half of a read generator's options that changes from table to table. */
export interface SelectOptions {
  tableName: string;
  orderArgs: GraphQLInputObjectType | undefined;
  filterArgs: GraphQLInputObjectType;
  /** The field's name, already run through the build's naming rules. */
  fieldName: string;
}

/** {@link SelectOptions} for the list field, which can also take a `distinct` argument. */
export interface SelectArrayOptions extends SelectOptions {
  /** The table's default type name, which names its `distinct` enum. */
  typeName: string;
  /** Whether the field takes a `distinct` argument. */
  distinct: boolean;
}

/** `<table>` — the list field. */
export type SelectArrayGenerator = (build: ReadBuildOptions, opts: SelectArrayOptions) => CreatedResolver;

/** `<table>Single` — the same read, capped at one row. */
export type SelectSingleGenerator = (build: ReadBuildOptions, opts: SelectOptions) => CreatedResolver;

/** The table's entry in `db.query`, which is what a relational read runs through. */
const queryBaseFor = (db: any, tableName: string): RelationalQueryBuilder<any, any, any> => {
  const queryBase = db.query[tableName] as RelationalQueryBuilder<any, any, any> | undefined;
  if (!queryBase) {
    throw missingQueryBuilderError(tableName);
  }
  return queryBase;
};

/**
 * Builds a dialect's two select generators.
 *
 * @param primaryKeyPropNames the dialect's composite-aware primary-key lookup
 * @param nullOrdering how the dialect's `ORDER BY` sorts NULLs, which keyset pagination has
 *   to agree with
 */
export const createSelectGenerators = (
  primaryKeyPropNames: (table: any) => string[],
  nullOrdering: NullOrdering,
): { generateSelectArray: SelectArrayGenerator; generateSelectSingle: SelectSingleGenerator } => {
  const generateSelectArray: SelectArrayGenerator = (build, opts): CreatedResolver => {
    const { db, tables, eagerRelations, typeNameMapper, filterCtx, limits, policies, resolveName } = build;
    const { tableName, orderArgs, filterArgs, fieldName, typeName, distinct: distinctEnabled } = opts;
    const queryBase = queryBaseFor(db, tableName);

    const table = tables[tableName]!;
    const limitPolicy = limits?.(tableName);
    const pkNames = primaryKeyPropNames(table);
    const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'select', field: fieldName };
    const queryArgs = selectArrayArgs(
      orderArgs,
      filterArgs,
      distinctEnabled ? generateDistinctEnum(table, typeName, resolveName, tableName) : undefined,
      policies?.softDelete,
      tableName,
      resolveName,
    );
    // The name the object type actually carries — what `fieldsByTypeName` is keyed by.
    const objectTypeName = resolveObjectTypeName(tableName, typeNameMapper, resolveName);

    return {
      name: fieldName,
      resolver: async (_source: any, rawArgs: Partial<TableSelectArgs>, context: any, info: any) => {
        // An omitted `orderBy` falls back to the table's configured default ordering here,
        // before anything reads the arguments — the cursor tuple and a `distinct` pass both
        // have to agree on one effective ordering.
        const args = withDefaultOrderBy(rawArgs, tableName, policies?.defaultOrderBy);
        try {
          const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
          const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(
            db,
            context,
            info,
            tableName,
            queryBase,
          );
          return await runRelationalSelect({
            queryBase: requestQueryBase,
            tables,
            tableName,
            table,
            eagerRelations,
            typeName: objectTypeName,
            typeNameMapper,
            resolveName,
            parsedInfo,
            ...args,
            limit: applyLimitPolicy(args.limit, limitPolicy),
            single: false,
            filterCtx,
            limits,
            defaultOrderBy: policies?.defaultOrderBy,
            pkNames,
            db: executor,
            visibility: policies?.visibility?.(context),
            nullOrdering,
          });
        } catch (e) {
          throw withErrorContext(toGraphQLError(e), errorCtx);
        }
      },
      args: queryArgs,
    };
  };

  const generateSelectSingle: SelectSingleGenerator = (build, opts): CreatedResolver => {
    const { db, tables, eagerRelations, typeNameMapper, filterCtx, limits, policies, resolveName } = build;
    const { tableName, orderArgs, filterArgs, fieldName } = opts;
    const queryBase = queryBaseFor(db, tableName);

    const queryArgs = selectSingleArgs(orderArgs, filterArgs, policies?.softDelete, tableName, resolveName);
    const objectTypeName = resolveObjectTypeName(tableName, typeNameMapper, resolveName);

    const table = tables[tableName]!;
    const pkNames = primaryKeyPropNames(table);
    const errorCtx: DrizzleErrorContext = { table: tableName, operation: 'select', field: fieldName };

    return {
      name: fieldName,
      resolver: async (_source: any, rawArgs: Partial<TableSelectArgs>, context: any, info: any) => {
        // Same as the list field: the effective ordering is resolved before anything reads it.
        const args = withDefaultOrderBy(rawArgs, tableName, policies?.defaultOrderBy);
        try {
          const parsedInfo = parseResolveInfo(info, { deep: true }) as ResolveTree;
          const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(
            db,
            context,
            info,
            tableName,
            queryBase,
          );
          return await runRelationalSelect({
            queryBase: requestQueryBase,
            tables,
            tableName,
            table,
            eagerRelations,
            typeName: objectTypeName,
            typeNameMapper,
            resolveName,
            parsedInfo,
            ...args,
            single: true,
            filterCtx,
            limits,
            defaultOrderBy: policies?.defaultOrderBy,
            pkNames,
            db: executor,
            visibility: policies?.visibility?.(context),
            nullOrdering,
          });
        } catch (e) {
          throw withErrorContext(toGraphQLError(e), errorCtx);
        }
      },
      args: queryArgs,
    };
  };

  return { generateSelectArray, generateSelectSingle };
};
