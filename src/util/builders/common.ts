// =============================================================================
// LOCAL MODIFICATION — diverges from upstream drizzle-graphql
//
// 1. generateColumnFilterValues() rewritten to produce generic shared filter
//    types (IdFilter, StringFilter, IntFilter, FloatFilter, BigIntFilter,
//    DecimalFilter, DateTimeFilter, BooleanFilter, per-enum, per-array) instead
//    of one type per (table, column) pair. The filter is picked by column data
//    type, not name.
//
// 2. Type naming:
//    - Select types: ${capitalize(tableName)} (e.g. Users)
//    - Relation fields: reference the target table's type directly (e.g. posts: [Posts!]!)
//    - Mutation return: same type as select (${capitalize(tableName)})
//    - Insert input: ${capitalize(insertPrefix)}${toTypeName(tableName)}Input (e.g. CreateUsersInput)
//    - Update input: ${capitalize(updatePrefix)}${toTypeName(tableName)}Input (e.g. UpdateUsersInput)
// =============================================================================

// The implementation lives in focused modules under ./common/; this file is the barrel
// that keeps `from './common.ts'` working for every dialect builder. It re-exports exactly
// the names this module exported before the split, and nothing more.

export { deletedArg, selectArrayArgs, selectSingleArgs } from './common/args.ts';
export { generateColumnEnum, generateDistinctEnum } from './common/column-enums.ts';
export type { ConflictBatch, ConflictPlan, OnConflictArg } from './common/conflict.ts';
export {
  applyConflictPlan,
  conflictActionEnumType,
  excludedColumnRef,
  generateOnConflictInput,
  mysqlValuesColumnRef,
  resolveConflictPlan,
} from './common/conflict.ts';
export type { CursorOrderEntry, NullOrdering } from './common/cursor.ts';
export {
  attachRowCursors,
  buildCursorCondition,
  CURSOR_FIELD_NAME,
  cursorOrderExprs,
  cursorOrderingEntries,
  DIALECT_NULL_ORDERING,
  decodeCursor,
  encodeCursor,
  isCursorFieldSelected,
  orderByCursorObstacle,
  orderByHasRelationEntry,
  rowCursorResolver,
} from './common/cursor.ts';
export { distinctRowsCondition } from './common/distinct.ts';
export { columnDocs } from './common/docs.ts';
export {
  applyErrorMapper,
  type DrizzleErrorCode,
  type DrizzleErrorContext,
  defaultErrorMapper,
  drizzleError,
  toGraphQLError,
  withErrorContext,
} from './common/errors.ts';
export {
  excludedColumnsKey,
  hasExcludedColumns,
  registerColumnExclusions,
  visibleColumns,
} from './common/exclusions.ts';
export { drizzleExecutorKey, resolveExecutor, resolveQueryExecutor } from './common/executor.ts';
export { extractFiltersColumn } from './common/filters.ts';
export { innerOrderType, orderNullsType } from './common/input-order.ts';
export {
  getPrimaryKeyPropNames,
  getPrimaryKeyPropNamesFromConfig,
  getUniqueColumnSets,
  getUniqueTargets,
  memoizeTableConfig,
  primaryKeyOrderExprs,
  type UniqueTarget,
  withPrimaryKeyColumns,
} from './common/keys.ts';
export type {
  ComplexityEstimator,
  DefaultOrderByFor,
  LimitPolicyFor,
  ResolvedComplexityOptions,
  ResolvedLimitPolicy,
} from './common/limits.ts';
export {
  aggregateFieldComplexity,
  applyLimitPolicy,
  listFieldComplexity,
  resolveLimitPolicy,
  withDefaultOrderBy,
} from './common/limits.ts';
export {
  extractRequiredFilters,
  generateUpdateManyInput,
  generateWriteCount,
  hardDeleteArg,
  mutationSelection,
  narrowToSingleMatch,
  prepareMutationRelationColumns,
  rowsAffected,
  visibleWhere,
  withEagerRelations,
} from './common/mutation-helpers.ts';
export type { TypeNameMapper } from './common/naming.ts';
export { applyObjectTypeName, resolveObjectTypeName, resolveTypeName } from './common/naming.ts';
export type { OrderNullsOption } from './common/order-by.ts';
export { extractOrderBy, orderByEntries, orderExpressions } from './common/order-by.ts';
export type {
  ContextValueHook,
  ContextValuesFor,
  DeletedMode,
  ResolverPolicies,
  RowVisibility,
  ScopeFor,
  SoftDeleteFor,
  SoftDeleteInfo,
  TablePolicies,
} from './common/policies.ts';
export {
  applyContextValues,
  applyContextValuesAll,
  bindPolicies,
  deletedFilterEnumType,
  insertStamps,
  junctionPolicy,
  junctionTableName,
  relationDeletedDefault,
  resolveSoftDeleteInfo,
  softDeletePredicate,
  stripContextValues,
  withRowVisibility,
} from './common/policies.ts';
export type { RelationFilterBase, RelationFilterContext } from './common/relation-filters.ts';
export { extractFilters, relationFilterCtx } from './common/relation-filters.ts';
export { extractRelationsParams, pruneNonEagerRelations } from './common/relation-params.ts';
export { createRelationResolverFactory } from './common/relation-resolvers.ts';
export type { RelationAggregateFactory, RelationResolverFactory, TablesRelationalConfig } from './common/relations.ts';
export {
  attachTargetPrimaryKeys,
  buildNamedRelations,
  buildRelationGraph,
  extractJunctionColumns,
  extractRelationJoinColumnPairs,
  extractRelationJoinColumns,
  isRelationFilterReversed,
  joinKeyOf,
  parentJoinValues,
  parentKeyChunks,
  parentKeyCondition,
  relatedRowParents,
  relationColumns,
  relationOwnCondition,
  tablesOfRelations,
  unwrapRelationColumn,
  warnUnresolvedJoin,
} from './common/relations.ts';
export { computeResolverFieldNames, type ResolverFieldNames } from './common/resolver-names.ts';
export { defineRootField } from './common/root-fields.ts';
export { eagerLoadMutationRelations, runRelationalSelect } from './common/select-runtime.ts';
export type { SelectionCtx } from './common/selected-columns.ts';
export { extractSelectedColumnsFromTree, extractSelectedColumnsFromTreeSQLFormat } from './common/selected-columns.ts';
export { generateTableTypes } from './common/table-types.ts';
export type { MutationTxCtx } from './common/transactions.ts';
export {
  createMutationTxCtx,
  DEFAULT_TRANSACTION_TIMEOUT_MS,
  MAX_TIMER_MS,
  runMutation,
} from './common/transactions.ts';
export type { TypeCacheCtx } from './common/type-cache.ts';
export type {
  DerivedTypeNameMapper,
  GeneratedTypeInfo,
  GeneratedTypeKind,
  GeneratedTypeNameConfig,
  TypeNameResolver,
} from './common/type-names.ts';
export { resolveGeneratedTypeNames, sharedType } from './common/type-names.ts';
export { tableUniqueKeyMap, type UniqueKeyMap, uniqueKeyFieldName } from './common/unique-keys.ts';
export type {
  NestedWriteOp,
  NestedWriteOrigin,
  ResolvedWriteHooks,
  WriteHook,
  WriteHookFor,
  WriteHookPayload,
  WriteHookPositions,
  WriteHooks,
  WriteOperation,
} from './common/write-hooks.ts';
export { normalizeWriteHooks, runWriteHook } from './common/write-hooks.ts';
export type { WriteBody, WriteHookEmitter, WriteResolverSpec } from './common/write-scaffold.ts';
export { writeResolver } from './common/write-scaffold.ts';
