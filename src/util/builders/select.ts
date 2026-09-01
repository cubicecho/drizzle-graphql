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
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { parseResolveInfo } from 'graphql-parse-resolve-info';
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
import { missingQueryBuilderError } from './errors.ts';
import type { CreatedResolver, TableNamedRelations, TableSelectArgs } from './types.ts';

/** `<table>` — the list field. */
export type SelectArrayGenerator = (
  db: any,
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  distinctEnabled?: boolean,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
  /** The build's type-naming rule, which names the `distinct` enum. */
  resolveName?: TypeNameResolver,
) => CreatedResolver;

/** `<table>Single` — the same read, capped at one row. */
export type SelectSingleGenerator = (
  db: any,
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  fieldName: string,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  limits?: LimitPolicyFor,
  policies?: ResolverPolicies,
  /** The build's type-naming rule, which names the `deleted` argument's enum. */
  resolveName?: TypeNameResolver,
) => CreatedResolver;

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
  const generateSelectArray: SelectArrayGenerator = (
    db,
    tableName,
    tables,
    relationMap,
    orderArgs,
    filterArgs,
    fieldName,
    typeName,
    typeNameMapper,
    filterCtx,
    distinctEnabled = true,
    limits,
    policies,
    resolveName,
  ): CreatedResolver => {
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
          const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
          return await runRelationalSelect({
            queryBase: requestQueryBase,
            tables,
            tableName,
            table,
            relationMap,
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
            scope: policies?.scope?.(context),
            nullOrdering,
          });
        } catch (e) {
          throw withErrorContext(toGraphQLError(e), errorCtx);
        }
      },
      args: queryArgs,
    };
  };

  const generateSelectSingle: SelectSingleGenerator = (
    db,
    tableName,
    tables,
    relationMap,
    orderArgs,
    filterArgs,
    fieldName,
    // The list field's only use for the default type name is naming its `distinct` enum,
    // and a single-row read has no `distinct` argument. The slot stays so the two
    // generators keep one positional shape at the call site in `build-context.ts`.
    _typeName,
    typeNameMapper,
    filterCtx,
    limits,
    policies,
    resolveName,
  ): CreatedResolver => {
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
          const { executor, queryBase: requestQueryBase } = resolveQueryExecutor(db, context, tableName, queryBase);
          return await runRelationalSelect({
            queryBase: requestQueryBase,
            tables,
            tableName,
            table,
            relationMap,
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
            scope: policies?.scope?.(context),
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
