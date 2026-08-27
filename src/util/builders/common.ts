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
// @ts-nocheck — vendored file, drizzle-orm 1.0 type compat not guaranteed
import type { Column, Relation, Table } from 'drizzle-orm';
import {
  aliasedTable,
  and,
  arrayContains,
  arrayOverlaps,
  asc,
  desc,
  eq,
  extractExtendedColumnType,
  getColumns,
  getTableAsAliasSQL,
  gt,
  gte,
  ilike,
  inArray,
  is,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notIlike,
  notInArray,
  notLike,
  One,
  or,
  relationsFilterToSQL,
  SQL,
  sql,
} from 'drizzle-orm';
import type { GraphQLFieldResolver } from 'graphql';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLScalarType,
  GraphQLString,
} from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import { getOrCreateLoader } from '../batch-loader/index.ts';
import { capitalize, uncapitalize } from '../case-ops/index.ts';
import { remapFromGraphQLCore, remapToGraphQLArrayOutput, remapToGraphQLSingleOutput } from '../data-mappers/index.ts';
import { relationFieldExtension, tableTypeExtension } from '../extensions.ts';
import {
  GraphQLBigIntString,
  GraphQLDate,
  GraphQLDateTime,
  GraphQLDecimalString,
  GraphQLJSON,
  GraphQLUUID,
} from '../scalars/index.ts';
import { drizzleColumnToGraphQLType, getColumnScalarOverride } from '../type-converter/index.ts';
import type {
  ConvertedColumn,
  ConvertedInputColumn,
  ConvertedRelationColumnWithArgs,
  SchemaDocs,
} from '../type-converter/types.ts';
// Type-only: the nested-write module imports this one at runtime, so the dependency has to
// stay one-directional. The implementation is injected by the dialect builder.
import type { NestedWriteTypes } from './nested-writes.ts';
import type {
  FilterColumnOperators,
  FilterColumnOperatorsCore,
  Filters,
  FiltersCore,
  GeneratedTableTypes,
  GeneratedTableTypesOutputs,
  OrderByArgs,
  ProcessedTableSelectArgs,
  SelectData,
  SelectedColumnsRaw,
  SelectedSQLColumns,
  TableNamedRelations,
  TableSelectArgs,
} from './types.ts';

const rqbCrashTypes = ['SQLiteBigInt', 'SQLiteBlobJson', 'SQLiteBlobBuffer'];

/** Optional mapper from table key to singular/plural name pair. Return undefined to use default naming for a table. */
export type TypeNameMapper = (tableName: string) => { singular: string; plural: string } | undefined;

/** Produce the GraphQL object type name for a table, using the mapper if provided. */
export const resolveTypeName = (name: string, typeNameMapper?: TypeNameMapper): string => {
  const mapped = typeNameMapper?.(name);
  return mapped ? capitalize(mapped.singular) : capitalize(name);
};

/**
 * Shape of the relational config from drizzle-orm v1 db._.relations.
 * Each entry has { table, name, relations }.
 */
interface TableRelationalConfig {
  table: Table;
  name: string;
  relations: Record<string, Relation<string>>;
}
export type TablesRelationalConfig = Record<string, TableRelationalConfig>;

/**
 * Flatten drizzle-orm v1 TablesRelationalConfig into the canonical
 * Record<tableName, Record<relName, TableNamedRelations>> shape used
 * throughout common.ts.  Both pg.ts and sqlite.ts call this before
 * passing the relation map to any shared function.
 */
export const buildNamedRelations = (
  relations: TablesRelationalConfig,
  tableEntries: [string, Table][],
): Record<string, Record<string, TableNamedRelations>> => {
  const namedRelations: Record<string, Record<string, TableNamedRelations>> = {};

  for (const [relTableName, relConfig] of Object.entries(relations)) {
    if (!relConfig?.relations) {
      continue;
    }

    const namedConfig: Record<string, TableNamedRelations> = {};

    for (const [innerRelName, innerRelValue] of Object.entries(relConfig.relations)) {
      // drizzle-orm v1 uses `targetTable` (not `referencedTable`)
      // and provides `targetTableName` directly.
      const targetTable = (innerRelValue as any).targetTable ?? (innerRelValue as any).referencedTable;
      const directTargetName = (innerRelValue as any).targetTableName as string | undefined;

      let targetTableName: string | undefined;

      if (directTargetName) {
        // v1: use the direct name to find the schema key
        const targetEntry = tableEntries.find(([key]) => key === directTargetName);
        targetTableName = targetEntry?.[0];
      } else if (targetTable) {
        // fallback: match by object reference
        const targetEntry = tableEntries.find(([, tableValue]) => tableValue === targetTable);
        targetTableName = targetEntry?.[0];
      }

      if (!targetTableName) {
        continue;
      }

      namedConfig[innerRelName] = {
        relation: innerRelValue,
        targetTableName,
      };
    }

    if (Object.keys(namedConfig).length > 0) {
      namedRelations[relTableName] = namedConfig;
    }
  }

  return namedRelations;
};

/**
 * Records each relation's target-table primary-key property names on the relation entry,
 * so the pagination paths (the window-function batch loader and the eager `with:` orderBy
 * default) can fall back to a deterministic PK order without re-deriving it per request.
 *
 * Composite primary keys are only visible through the dialect's getTableConfig, so the
 * dialect builder passes a `resolvePkNames` that threads the composite column names in.
 * Mutates the relation entries in place (they are shared with the pruned eager map and
 * the resolver factory, so attaching once covers every consumer).
 */
export const attachTargetPrimaryKeys = (
  namedRelations: Record<string, Record<string, TableNamedRelations>>,
  tables: Record<string, Table>,
  resolvePkNames: (table: Table) => string[],
): void => {
  const cache = new Map<string, readonly string[]>();
  for (const rels of Object.values(namedRelations)) {
    for (const relEntry of Object.values(rels)) {
      const { targetTableName } = relEntry;
      let pk = cache.get(targetTableName);
      if (!pk) {
        const targetTable = tables[targetTableName];
        pk = targetTable ? resolvePkNames(targetTable) : [];
        cache.set(targetTableName, pk);
      }
      relEntry.targetPkNames = pk;
    }
  }
};

/**
 * Extracts the join column info from a drizzle-orm v1 Relation object.
 * Returns the JS property name of the local column on the parent table and the
 * Column object for the foreign column on the target table, or undefined if the
 * relation internals are not accessible.
 */
export const extractRelationJoinColumns = (
  relEntry: TableNamedRelations,
  parentTable: Table,
  targetTable: Table,
): { localColPropName: string; foreignCol: Column; foreignColPropName: string } | undefined => {
  const rel = (relEntry as any).relation ?? relEntry;
  const sourceColumns: any[] | undefined = rel.sourceColumns;
  const targetColumns: any[] | undefined = rel.targetColumns;

  if (!sourceColumns?.length || !targetColumns?.length) {
    return undefined;
  }

  const sourceCol = sourceColumns[0];
  const targetCol = targetColumns[0];

  const parentCols = getColumns(parentTable);
  const localColPropName = Object.entries(parentCols).find(([, c]) => c === sourceCol)?.[0];

  const targetCols = getColumns(targetTable);
  const foreignColPropName = Object.entries(targetCols).find(([, c]) => c === targetCol)?.[0];

  if (!localColPropName || !foreignColPropName) {
    return undefined;
  }

  return { localColPropName, foreignCol: targetCol, foreignColPropName };
};

export type RelationResolverFactory = (params: {
  tableName: string;
  relationName: string;
  relEntry: TableNamedRelations;
  isOne: boolean;
}) => GraphQLFieldResolver<any, any> | undefined;

/**
 * Builds the `${relationName}Aggregate` field for a to-many relation. Implemented in
 * `aggregates.ts` and injected here so the aggregate code can depend on this module
 * without the two importing each other.
 */
export type RelationAggregateFactory = (params: {
  tableName: string;
  relationName: string;
  relEntry: TableNamedRelations;
}) => { type: GraphQLObjectType; resolve: GraphQLFieldResolver<any, any> } | undefined;

/**
 * Key on the GraphQL context object under which a caller can place a Drizzle transaction
 * (or any other executor: a pooled connection, a logging proxy). Every generated resolver
 * reads it at resolve time and runs its statements there instead of on the database the
 * schema was built from, which is what lets several mutations in one request share a
 * transaction and lets a query see that transaction's uncommitted rows:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   await graphql({ schema, source, contextValue: { [drizzleExecutorKey]: tx } });
 * });
 * ```
 *
 * Registered with `Symbol.for` so the ESM and CJS builds of this package agree on it when
 * both end up loaded in one process.
 */
export const drizzleExecutorKey: unique symbol = Symbol.for('drizzle-graphql:executor') as any;

/**
 * The executor a resolver should run on: the request's transaction when the context
 * carries one, otherwise the database the schema was built from.
 */
export const resolveExecutor = <T>(db: T, context: any): T => {
  if (context && typeof context === 'object') {
    const executor = context[drizzleExecutorKey];
    if (executor) {
      return executor as T;
    }
  }
  return db;
};

/**
 * This request's executor together with the relational query builder to select through.
 *
 * `buildTimeQueryBase` decides whether the table supports the relational query builder at
 * all — a table with no relations has none, and the caller falls back to a plain select.
 * The executor only decides which connection the query runs on, so a transaction that is
 * missing `query` (or a table absent from its schema) keeps the build-time builder.
 */
export const resolveQueryExecutor = (
  db: any,
  context: any,
  tableName: string,
  buildTimeQueryBase: any,
): { executor: any; queryBase: any } => {
  const executor = resolveExecutor(db, context);
  return {
    executor,
    queryBase: buildTimeQueryBase ? (executor?.query?.[tableName] ?? buildTimeQueryBase) : buildTimeQueryBase,
  };
};

// =============================================================================
// Automatic per-request transactions for multi-mutation documents
// (`BuildSchemaConfig.transactions: 'auto'`).
//
// GraphQL executes root mutation fields serially, but each one is a separate
// resolver call on whatever server hosts the schema — the library never sees
// the request as a whole. So the FIRST mutation resolver of a request inspects
// `info.operation`: when the document selects more than one root mutation
// field, it opens `db.transaction()` once, parks the transaction on a
// per-request state object (WeakMap keyed by the context object), and every
// later mutation resolver of the same request runs on that transaction. The
// transaction callback awaits a latch; the last field to complete resolves it
// (COMMIT) and the first failure rejects it (ROLLBACK).
// =============================================================================

/** How long a shared transaction may sit idle between resolver calls before it is rolled back. */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * One per built schema (when `transactions: 'auto'` is on). `fieldNames` is filled by the
 * dialect generator once every mutation field name is known, so a request-time count can
 * tell library mutations apart from consumer-added ones.
 */
export type MutationTxCtx = {
  timeoutMs: number;
  fieldNames: Set<string>;
  states: WeakMap<object, RequestTxState>;
};

export const createMutationTxCtx = (options: { timeoutMs: number } | undefined): MutationTxCtx | undefined =>
  options ? { timeoutMs: options.timeoutMs, fieldNames: new Set(), states: new WeakMap() } : undefined;

type SharedTxState = {
  kind: 'shared';
  /** Distinct root mutation response keys the document will execute. */
  expected: number;
  completed: number;
  /** First failure; set once, before the latch is rejected. */
  failure: unknown;
  aborted: boolean;
  /** True once the underlying `db.transaction()` promise has settled (committed or rolled back). */
  done: boolean;
  /** Resolves with the transaction once BEGIN succeeded; rejects if it never will. */
  ready: Promise<any>;
  /** The `db.transaction()` promise itself — rejects when the transaction rolls back. */
  settled: Promise<unknown>;
  release: () => void;
  abort: (e: unknown) => void;
  /** Pause the inactivity timer while a resolver is actively working. */
  suspendTimer: () => void;
  /** (Re)arm the inactivity timer while waiting for the next resolver call. */
  bumpTimer: () => void;
};

type RequestTxState = { kind: 'passthrough' } | SharedTxState;

const includedByDirectives = (node: { directives?: readonly any[] }, variables: any): boolean => {
  for (const directive of node.directives ?? []) {
    const name = directive.name.value;
    if (name !== 'skip' && name !== 'include') {
      continue;
    }
    const ifArg = directive.arguments?.find((arg: any) => arg.name.value === 'if');
    let value: unknown;
    if (ifArg?.value.kind === 'BooleanValue') {
      value = ifArg.value.value;
    } else if (ifArg?.value.kind === 'Variable') {
      value = variables?.[ifArg.value.name.value];
    }
    if (name === 'skip' && value === true) {
      return false;
    }
    if (name === 'include' && value !== true) {
      return false;
    }
  }
  return true;
};

/**
 * Collects the response keys of every root mutation field the executor will run, expanding
 * fragments and honoring `@skip` / `@include`. Distinct response keys (alias ?? name) are
 * counted, matching graphql-js field collection, so a field selected twice under one key is
 * still one resolver call. Returns `false` when the document selects a root mutation field
 * this build did not generate — its completion cannot be tracked, so the caller must not
 * open a transaction it might never be able to close.
 */
const collectRootMutationKeys = (
  selectionSet: any,
  fragments: any,
  variables: any,
  known: ReadonlySet<string>,
  keys: Set<string>,
  visitedFragments: Set<string>,
): boolean => {
  for (const selection of selectionSet.selections) {
    if (!includedByDirectives(selection, variables)) {
      continue;
    }
    if (selection.kind === 'Field') {
      const name = selection.name.value;
      if (name === '__typename') {
        continue;
      }
      if (!known.has(name)) {
        return false;
      }
      keys.add(selection.alias?.value ?? name);
    } else if (selection.kind === 'InlineFragment') {
      if (!collectRootMutationKeys(selection.selectionSet, fragments, variables, known, keys, visitedFragments)) {
        return false;
      }
    } else if (selection.kind === 'FragmentSpread') {
      const fragmentName = selection.name.value;
      if (visitedFragments.has(fragmentName)) {
        continue;
      }
      visitedFragments.add(fragmentName);
      const fragment = fragments?.[fragmentName];
      if (!fragment) {
        return false;
      }
      if (!collectRootMutationKeys(fragment.selectionSet, fragments, variables, known, keys, visitedFragments)) {
        return false;
      }
    }
  }
  return true;
};

const abortedBatchError = (): GraphQLError =>
  new GraphQLError(
    'Drizzle-GraphQL Error: Mutation was not executed because an earlier mutation in the same request failed and the shared transaction was rolled back.',
  );

/** Opens the request-wide transaction and wires up latch, inactivity timer and cleanup. */
const openSharedTx = (
  db: any,
  context: any,
  txCtx: MutationTxCtx,
  stateKey: object,
  expected: number,
): SharedTxState => {
  let release!: () => void;
  let rejectLatch!: (e: unknown) => void;
  const latch = new Promise<void>((resolve, reject) => {
    release = resolve;
    rejectLatch = reject;
  });

  let readyResolve!: (tx: any) => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<any>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Nobody may be awaiting `ready` when BEGIN fails — keep that from surfacing as an
  // unhandled rejection; each resolver still observes it through its own `await`.
  ready.catch(() => {});

  const canStash = context !== null && typeof context === 'object' && !Object.isFrozen(context);

  const settled: Promise<unknown> = db.transaction(async (tx: any) => {
    if (canStash) {
      // Publish our transaction under the caller-facing key so nested resolvers (lazy
      // relation fields, relation aggregates) selected under a mutation read through it
      // and see its uncommitted rows — the same wrapper a caller-supplied transaction uses.
      context[drizzleExecutorKey] = tx;
    }
    readyResolve(tx);
    // Held open across resolver calls: the last mutation field to complete resolves the
    // latch (COMMIT); the first failure — or the inactivity timeout — rejects it (ROLLBACK).
    await latch;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const state: SharedTxState = {
    kind: 'shared',
    expected,
    completed: 0,
    failure: undefined,
    aborted: false,
    done: false,
    ready,
    settled,
    release,
    abort: (e: unknown) => {
      if (!state.aborted) {
        state.aborted = true;
        state.failure = e;
      }
      rejectLatch(e);
    },
    suspendTimer: clearTimer,
    bumpTimer: () => {
      clearTimer();
      if (state.done) {
        return;
      }
      timer = setTimeout(() => {
        // The host never called the remaining resolvers (e.g. a non-null completion error
        // outside our resolvers aborted serial execution). Roll back rather than leak.
        state.abort(
          new GraphQLError(
            `Drizzle-GraphQL Error: Shared mutation transaction timed out after ${txCtx.timeoutMs}ms waiting for the remaining mutation fields; rolling back.`,
          ),
        );
      }, txCtx.timeoutMs);
      (timer as any).unref?.();
    },
  };

  const cleanup = () => {
    state.done = true;
    clearTimer();
    if (canStash) {
      delete context[drizzleExecutorKey];
    }
    // A committed state left in the map would poison a reused context object; an aborted
    // one must stay so late-arriving fields of THIS request keep failing fast.
    if (!state.aborted) {
      txCtx.states.delete(stateKey);
    }
  };
  settled.then(cleanup, (e) => {
    cleanup();
    // BEGIN itself may have failed (driver without transaction support) — unblock waiters.
    readyReject(e);
  });

  state.bumpTimer();
  return state;
};

const runOnSharedTx = async <T>(state: SharedTxState, body: (executor: any) => Promise<T>): Promise<T> => {
  if (state.aborted) {
    // Fail fast: never run a later field against a transaction that already rolled back.
    await (state.settled as Promise<unknown>).catch(() => {});
    throw abortedBatchError();
  }
  state.suspendTimer();
  const tx = await state.ready;
  try {
    if (state.aborted) {
      throw abortedBatchError();
    }
    const result = await body(tx);
    state.completed += 1;
    if (state.completed >= state.expected) {
      state.release();
      // COMMIT before this (final) field resolves, so the data is durable — and a commit
      // failure surfaces as this field's error.
      await state.settled;
    } else {
      state.bumpTimer();
    }
    return result;
  } catch (e) {
    state.abort(e);
    // Wait for the ROLLBACK to finish before surfacing, so the caller never observes a
    // response produced while the transaction is still being unwound.
    await (state.settled as Promise<unknown>).catch(() => {});
    throw e;
  }
};

/**
 * Executor selection for every generated mutation resolver. Runs `body` with:
 *
 * - the caller-supplied executor, when the context carries one under
 *   {@link drizzleExecutorKey} — the library never nests a transaction inside it;
 * - the build-time `db`, when auto-transactions are off, the document has at most one root
 *   mutation field, or it selects a mutation field this build did not generate (a consumer
 *   extension whose completion cannot be tracked);
 * - otherwise, the request's shared transaction, opened on the first mutation resolver call
 *   and committed when the last one completes / rolled back when any fails.
 */
export const runMutation = async <T>(
  db: any,
  context: any,
  info: any,
  txCtx: MutationTxCtx | undefined,
  body: (executor: any) => Promise<T>,
): Promise<T> => {
  const contextIsObject = context !== null && (typeof context === 'object' || typeof context === 'function');
  // Check our own request state FIRST: once the shared transaction is stashed on the
  // context it is indistinguishable from a caller-supplied one, but its completion still
  // has to be accounted here.
  const stateKey: object = contextIsObject ? context : info.operation;
  let state = txCtx?.states.get(stateKey);

  if (!state) {
    if (contextIsObject && context[drizzleExecutorKey]) {
      // The caller already runs this request on its own transaction/executor — use it as-is.
      return body(context[drizzleExecutorKey]);
    }
    if (!txCtx || info.operation.operation !== 'mutation') {
      return body(db);
    }
    const keys = new Set<string>();
    const allKnown = collectRootMutationKeys(
      info.operation.selectionSet,
      info.fragments,
      info.variableValues,
      txCtx.fieldNames,
      keys,
      new Set(),
    );
    state =
      !allKnown || keys.size <= 1 ? { kind: 'passthrough' } : openSharedTx(db, context, txCtx, stateKey, keys.size);
    txCtx.states.set(stateKey, state);
  }

  if (state.kind === 'passthrough') {
    return body(resolveExecutor(db, context));
  }
  return runOnSharedTx(state, body);
};

/**
 * Fetches a to-many relation with per-parent limit/offset for ALL parents in a
 * single query, using a window function (ROW_NUMBER() OVER (PARTITION BY fk ...)).
 *
 * This replaces the previous per-parent fallback that issued one query per parent
 * (true N+1) whenever pagination args were present. Each parent gets its own
 * limit/offset window while the database is hit exactly once for the whole batch.
 *
 * Window functions require PostgreSQL, MySQL >= 8.0, or SQLite >= 3.25.
 * Returns raw rows (NOT remapped); the caller groups + remaps them.
 */
const batchedPaginatedRelationQuery = async (
  db: any,
  targetTable: Table,
  foreignCol: Column,
  whereCondition: SQL | undefined,
  orderByArg: any,
  limit: number | null,
  offset: number | null,
  pkNames: readonly string[],
  orderCtx?: RelationFilterContext,
  whereArgs?: Record<string, any>,
): Promise<any[]> => {
  const cols = getColumns(targetTable);

  // Always tiebreak the window by the target's primary key so per-parent limit/offset
  // slices are deterministic even when the client supplies no (or a non-unique) orderBy.
  // pkNames is resolved at build time and includes composite keys.
  const orderExprs = [
    ...(orderByArg ? extractOrderBy(targetTable, orderByArg, orderCtx, whereArgs) : []),
    ...primaryKeyOrderExprs(targetTable, pkNames),
  ];
  const orderClause = orderExprs.length ? sql` order by ${sql.join(orderExprs, sql`, `)}` : sql``;
  // Namespaced alias so it can't collide with a real column on the target table.
  const RN = '__drizzle_graphql_rn';
  const rowNumber = sql`row_number() over (partition by ${foreignCol}${orderClause})`.as(RN);

  // Subquery: every target column plus a per-partition row number.
  const sub = db
    .select({ ...cols, [RN]: rowNumber })
    .from(targetTable)
    .where(whereCondition)
    .as('__paginated');

  // Outer: keep only the rows that fall inside each parent's window.
  const lower = offset ?? 0;
  const windowConds: any[] = [gt(sub[RN], lower)];
  if (limit != null) {
    windowConds.push(lte(sub[RN], lower + limit));
  }

  const rows: any[] = await db
    .select()
    .from(sub)
    .where(and(...windowConds))
    .orderBy(sub[RN]);

  // Strip the helper column so it doesn't leak into remapping/output.
  for (const row of rows) {
    delete row[RN];
  }
  return rows;
};

/**
 * Creates a RelationResolverFactory that generates field-level resolvers for each relation.
 * Each resolver:
 *   1. Returns pre-fetched data if the parent resolver already included it (eager path, zero cost).
 *   2. When limit/offset args are present, falls back to a direct per-item query.
 *   3. Otherwise batches all sibling resolver calls within the same GraphQL execution tick
 *      into a single IN-clause query, eliminating N+1 database round-trips.
 */
export const createRelationResolverFactory =
  (
    db: any,
    tables: Record<string, Table>,
    filterCtx?: RelationFilterBase,
    limits?: LimitPolicyFor,
    policies?: TablePolicies,
  ): RelationResolverFactory =>
  ({ tableName, relationName, relEntry, isOne }) => {
    const parentTable = tables[tableName];
    const targetTableName = relEntry.targetTableName;
    const targetTable = tables[targetTableName];

    if (!parentTable || !targetTable) {
      return undefined;
    }

    const joinCols = extractRelationJoinColumns(relEntry, parentTable, targetTable);
    if (!joinCols) {
      return undefined;
    }

    const { localColPropName, foreignCol, foreignColPropName } = joinCols;
    // A relation field is bounded by the policy of the table it reads, not the parent's.
    const limitPolicy = isOne ? undefined : limits?.(targetTableName);
    // Resolved at build time (composite keys included) — used to tiebreak paginated batches.
    const targetPkNames = relEntry.targetPkNames ?? [];

    return async (parent, args, context) => {
      // Eager path: the parent resolver pre-fetched this relation via Drizzle's `with`.
      if (parent[relationName] !== undefined) {
        return parent[relationName];
      }

      const localValue = parent[localColPropName];
      if (localValue == null) {
        return isOne ? null : [];
      }

      const { where: whereArg, orderBy: orderByArg, limit: requestedLimit, offset, deleted } = (args ?? {}) as any;
      const limit = applyLimitPolicy(requestedLimit, limitPolicy, `${tableName}.${relationName}`);

      // Batch path: collect all sibling calls in this tick and execute one query.
      // Pagination args are part of the loader key so siblings sharing identical
      // args batch together; per-parent limit/offset is applied inside the batch
      // via a window function rather than bailing to a per-parent query (N+1).
      const argsKey = JSON.stringify({
        where: whereArg ?? null,
        orderBy: orderByArg ?? null,
        limit: limit ?? null,
        offset: offset ?? null,
        deleted: deleted ?? null,
      });
      const loaderKey = `${tableName}::${relationName}::${argsKey}`;

      const loader = getOrCreateLoader(context, loaderKey, async (parentIds: readonly any[]) => {
        // Loaders are cached per context, so every call batched here shares this request's
        // executor — the transaction on the context, when there is one.
        const executor = resolveExecutor(db, context);
        const uniqueIds = [...new Set(parentIds)];
        // Loaders are keyed per context too, so the scope resolved here is this request's.
        const scope = resolveScope(policies, context, filterCtx);
        const whereCondition = withScope(
          scope,
          targetTableName,
          targetTable,
          and(
            inArray(foreignCol, uniqueIds),
            whereArg
              ? extractFilters(targetTable, targetTableName, whereArg, relationFilterCtx(filterCtx, targetTableName))
              : undefined,
          ),
          deleted,
        );

        let rows: any[];
        if (limit != null || offset != null) {
          // Per-parent pagination across the whole batch in one query.
          rows = await batchedPaginatedRelationQuery(
            executor,
            targetTable,
            foreignCol,
            whereCondition,
            orderByArg,
            limit ?? null,
            offset ?? null,
            targetPkNames,
            relationFilterCtx(filterCtx, targetTableName),
            whereArg,
          );
        } else {
          // Use plain db.select() so column refs are never aliased — avoids drizzle-orm v1
          // RQB aliasing requirements that would require referencing via aliasedTable proxy.
          let q = executor.select().from(targetTable).where(whereCondition) as any;
          if (orderByArg) {
            q = q.orderBy(
              ...extractOrderBy(targetTable, orderByArg, relationFilterCtx(filterCtx, targetTableName), whereArg),
            );
          }
          rows = await q;
        }

        // Group by FK value before remapping (remapping may delete null fields).
        if (isOne) {
          const byKey = new Map(rows.map((row: any) => [String(row[foreignColPropName]), row]));
          remapToGraphQLArrayOutput(rows, targetTableName, targetTable);
          return parentIds.map((id) => byKey.get(String(id)) ?? null);
        }

        const grouped = new Map<string, any[]>(uniqueIds.map((id) => [String(id), []]));
        for (const row of rows) {
          grouped.get(String(row[foreignColPropName]))?.push(row);
        }
        remapToGraphQLArrayOutput(rows, targetTableName, targetTable);
        return parentIds.map((id) => grouped.get(String(id)) ?? []);
      });

      return loader.load(localValue);
    };
  };

/**
 * The `extensions.drizzle` block for one relation field. The relation entry already carries
 * the target table's primary key (resolved at build time for pagination), so the field can
 * publish it without the dialect's key resolver being reachable from here.
 */
const relationExtensionFor = (
  relEntry: TableNamedRelations,
  parentTable: string,
  relationName: string,
  isOne: boolean,
  aggregate?: boolean,
) =>
  relationFieldExtension({
    targetTable: relEntry.targetTableName,
    parentTable,
    relation: relationName,
    single: isOne,
    primaryKey: relEntry.targetPkNames ?? [],
    aggregate,
  });

/** Per-call cache context — created fresh on each generateSchemaData call to avoid type name collisions. */
export interface TypeCacheCtx {
  /** Cache of generic filter types, keyed by generic name (e.g. "String", "DateTime"). */
  genericFilterCache: Map<string, GraphQLInputObjectType>;
  /**
   * Cache of shared select object types, keyed by table name.
   * Value: the ${capitalize(tableName)} type (columns + relation fields).
   * A table may be pre-registered here as a columns-only shell before its root call runs.
   * Use fullyBuiltTables to distinguish a complete type from a pre-registered shell.
   */
  objectTypeCache: Map<string, GraphQLObjectType>;
  /**
   * Mutable containers for relation fields, keyed by table name.
   * Each container object is closed over by the corresponding GraphQLObjectType thunk so that
   * when the root call for a table populates its relation fields, the thunk automatically picks
   * them up — even if the shell was pre-registered by a different table's relation traversal.
   */
  relationFieldContainers: Map<string, { fields: Record<string, ConvertedRelationColumnWithArgs> }>;
  /**
   * Set of table names whose GraphQL object type has been fully built (root call completed).
   * Pre-registered shells (created when another table references this table as a relation target)
   * are NOT in this set until the root call for that table runs.
   */
  fullyBuiltTables: Set<string>;
  /**
   * Cache of relation types, keyed by "${fromTableName}::${relName}".
   * @deprecated No longer used — relation fields now reference the target table's own type directly.
   */
  relationTypeCache: Map<string, GraphQLObjectType>;
  /**
   * Per-call cache for a table's converted select-field map, keyed by table reference.
   * Per-call (not module-level) because scalar overrides can differ between builds that
   * share the same table objects.
   */
  selectFieldCache: WeakMap<object, Record<string, ConvertedColumn>>;
  /** Per-call cache for a table's column-filter field map, keyed by table reference. */
  filterFieldCache: WeakMap<object, Record<string, ConvertedInputColumn>>;
  /** Per-call cache for order GraphQL input types, keyed by table reference. */
  orderTypeCache: WeakMap<object, GraphQLInputObjectType>;
  /** Per-call cache for filter GraphQL input types, keyed by table reference. */
  filterTypeCache: WeakMap<object, GraphQLInputObjectType>;
  /**
   * Per-call cache for `${Target}ListRelationFilter` input types (the some/every/none wrapper
   * used by to-many relation filters), keyed by target table name.
   */
  listRelationFilterCache: Map<string, GraphQLInputObjectType>;
  /**
   * Per-call cache for `${Table}Aggregate` output types, keyed by table name. Shared between the
   * root `<table>Aggregate` query and the `<relation>Aggregate` field on every table that points
   * at it, so the schema never holds two types with the same name.
   */
  aggregateTypeCache: Map<string, GraphQLObjectType>;
  /**
   * Resolved complexity settings for this call, or `undefined` when the caller turned the hints
   * off. Not a cache, but the type builders are several calls deep and this context is already
   * threaded through all of them.
   */
  complexity: ResolvedComplexityOptions | undefined;
  /**
   * The build's documentation hooks (`describeColumn`, `describeTable`, `describeRelation`,
   * `deprecateColumn`). Empty when the caller configured none, which is the default — the
   * generator emits no descriptions of its own for column and relation fields.
   */
  docs: SchemaDocs;
  /**
   * The build's resolved limit policy, or `undefined` when the caller configured none. Read
   * here so a to-many relation field can price its cost hint against the policy of the table
   * it targets, the same one its resolver enforces.
   */
  limits: LimitPolicyFor | undefined;
  /**
   * A table's primary-key property names, from the dialect's own resolver. Object types and
   * relation fields publish it on `extensions.drizzle` so a consumer can identify the rows a
   * field is about without re-deriving the key from the Drizzle schema.
   */
  primaryKeyOf?: (tableName: string) => readonly string[];
  /**
   * The context-derived columns of a table, if any. Read when the create/update inputs are
   * built: a column the server fills in is not part of either.
   */
  contextValuesOf?: ContextValuesFor;
  /**
   * The soft-delete convention of a table, if it declares one. Read when the write inputs are
   * built — the marker column is written by the delete and restore mutations, not by a client
   * — and when a read field's `deleted` argument is generated.
   */
  softDeleteOf?: SoftDeleteFor;
}

/**
 * The `description` / `deprecationReason` a column field should carry, from the build's
 * documentation hooks. Both are omitted rather than set to `undefined` so a field config
 * built by spreading this stays identical to one built without it.
 */
export const columnDocs = (
  docs: SchemaDocs,
  column: Column,
  tableName: string,
  columnName: string,
): { description?: string; deprecationReason?: string } => {
  const description = docs.describeColumn?.(column, { tableName, columnName });
  const deprecationReason = docs.deprecateColumn?.(column, { tableName, columnName });
  return {
    ...(description !== undefined ? { description } : {}),
    ...(deprecationReason !== undefined ? { deprecationReason } : {}),
  };
};

/**
 * A required input field cannot be deprecated — graphql-js rejects the schema outright, since
 * a client has no way to stop sending it. `deprecateColumn` is written against the column, not
 * against each generated input, so drop the reason where it cannot apply rather than making
 * the caller predict which inputs made the column non-null.
 */
const inputFieldDocs = (
  docs: SchemaDocs,
  column: Column,
  tableName: string,
  columnName: string,
  fieldType: unknown,
): { description?: string; deprecationReason?: string } => {
  const resolved = columnDocs(docs, column, tableName, columnName);
  if (resolved.deprecationReason !== undefined && fieldType instanceof GraphQLNonNull) {
    const { deprecationReason: _dropped, ...rest } = resolved;
    return rest;
  }
  return resolved;
};

/** The shape `graphql-query-complexity`'s `fieldExtensionsEstimator` hands to a field's hint. */
export type ComplexityEstimatorArgs = { args: Record<string, any>; childComplexity: number };

/** A field's cost hint, published as `extensions.complexity` on the generated field config. */
export type ComplexityEstimator = (options: ComplexityEstimatorArgs) => number;

/** {@link BuildSchemaConfig.complexity} with its defaults filled in. */
export type ResolvedComplexityOptions = {
  /** Rows a list field is assumed to return when the query passes no `limit`. */
  defaultListSize: number;
  /** Flat cost charged for an aggregate field, on top of the fields selected inside it. */
  aggregateCost: number;
};

/** {@link BuildSchemaConfig.limits} resolved for one table. `undefined` means no policy. */
export type ResolvedLimitPolicy = {
  defaultLimit: number | undefined;
  maxLimit: number | undefined;
  clampToMax: boolean;
};

/**
 * Looks up the limit policy for a table by its Drizzle schema key. Built once per schema by
 * `buildSchema`; `undefined` for a table the caller left unbounded.
 */
export type LimitPolicyFor = (tableName: string) => ResolvedLimitPolicy | undefined;

/**
 * The `limit` a query actually runs with, given the policy for the table it reads.
 *
 * A request that passes no `limit` falls back to `defaultLimit`, or to `maxLimit` when only
 * that is configured — an absent limit means every row, which is above any maximum. A limit
 * the client did ask for is rejected when it exceeds `maxLimit`, since silently truncating a
 * page tells a paginating client it has reached the end when it has not; `clampToMax` opts
 * into the truncation instead. A limit the *policy* supplied is capped rather than rejected —
 * a misconfigured `defaultLimit` above `maxLimit` is the operator's problem, not something to
 * fail a client's query over.
 */
export const applyLimitPolicy = (
  limit: number | null | undefined,
  policy: ResolvedLimitPolicy | undefined,
  fieldName: string,
): number | undefined => {
  if (!policy) {
    return limit ?? undefined;
  }
  const { defaultLimit, maxLimit, clampToMax } = policy;

  if (limit == null) {
    const fallback = defaultLimit ?? maxLimit;
    if (fallback === undefined) {
      return undefined;
    }
    return maxLimit === undefined ? fallback : Math.min(fallback, maxLimit);
  }

  if (maxLimit !== undefined && limit > maxLimit) {
    if (clampToMax) {
      return maxLimit;
    }
    throw new GraphQLError(`${fieldName}: 'limit' of ${limit} exceeds the maximum of ${maxLimit}.`);
  }
  return limit;
};

/** Merges a per-table override over the global policy, or `undefined` when neither bounds anything. */
export const resolveLimitPolicy = (
  global: { defaultLimit?: number; maxLimit?: number; clampToMax?: boolean } | undefined,
  table: { defaultLimit?: number; maxLimit?: number; clampToMax?: boolean } | undefined,
): ResolvedLimitPolicy | undefined => {
  const defaultLimit = table?.defaultLimit ?? global?.defaultLimit;
  const maxLimit = table?.maxLimit ?? global?.maxLimit;
  if (defaultLimit === undefined && maxLimit === undefined) {
    return undefined;
  }
  return { defaultLimit, maxLimit, clampToMax: table?.clampToMax ?? global?.clampToMax ?? false };
};

/**
 * Columns this build keeps out of the generated schema, keyed by the table object.
 *
 * A registry rather than a threaded parameter because the sites that decide schema shape —
 * the object type, every input, the filter, `orderBy`, the aggregates, the column enums —
 * are spread across four files and reach a table with no config in hand. Runtime code keeps
 * calling `getColumns` directly: a primary key that a client cannot name is still the key a
 * cursor is built from, and hiding it there would break pagination rather than secure it.
 *
 * {@link registerColumnExclusions} runs on every build, including with no config, so a
 * second build against the same table objects never inherits the first build's exclusions.
 */
const excludedColumnRegistry = new WeakMap<object, Set<string>>();

/** Installs this build's column exclusions and clears any left by a previous build. */
export const registerColumnExclusions = (
  tables: Record<string, Table>,
  exclude?: { columns?: Record<string, string[]> },
): void => {
  for (const [tableName, table] of Object.entries(tables)) {
    const hidden = exclude?.columns?.[tableName];
    if (hidden?.length) {
      excludedColumnRegistry.set(table, new Set(hidden));
    } else {
      excludedColumnRegistry.delete(table);
    }
  }
};

/** Whether any column of this table was excluded from the schema. */
export const hasExcludedColumns = (table: Table): boolean => excludedColumnRegistry.has(table);

/**
 * The columns of `table` that this build exposes — every column unless some were excluded.
 * Use this anywhere the result decides what the *schema* contains; use `getColumns` where it
 * decides what SQL to write.
 */
export const visibleColumns = (table: Table): Record<string, Column> => {
  const columns = getColumns(table);
  const hidden = excludedColumnRegistry.get(table);
  if (!hidden) {
    return columns;
  }
  return Object.fromEntries(Object.entries(columns).filter(([columnName]) => !hidden.has(columnName)));
};

/**
 * A paginated field costs its page size times whatever one row of it costs, so `users(limit: 100)
 * { posts(limit: 10) { id } }` is charged for the thousand rows it can return rather than the two
 * fields it mentions. `childComplexity` floors at 1 so a row is never free.
 *
 * The page size is the *effective* one: a request without `limit` is priced at the policy's
 * `defaultLimit` rather than the estimator's guess, and no request is priced above `maxLimit`,
 * so the cost a query is charged matches the rows it can actually pull.
 */
export const listFieldComplexity =
  (options: ResolvedComplexityOptions, policy?: ResolvedLimitPolicy): ComplexityEstimator =>
  ({ args, childComplexity }) => {
    const limit = args['limit'];
    const requested = typeof limit === 'number' && limit > 0 ? limit : undefined;
    let rows = requested ?? policy?.defaultLimit ?? options.defaultListSize;
    if (policy?.maxLimit !== undefined) {
      rows = Math.min(rows, policy.maxLimit);
    }
    return rows * Math.max(childComplexity, 1);
  };

/**
 * An aggregate returns a single row but reads however many match, so its cost tracks the scan
 * rather than the response.
 */
export const aggregateFieldComplexity =
  (options: ResolvedComplexityOptions): ComplexityEstimator =>
  ({ childComplexity }) =>
    options.aggregateCost + childComplexity;

/**
 * Everything needed to work out which extra columns a selection implies. Passed to the column
 * extractors so a requested `<relation>Aggregate` field can pull in the join column it resolves
 * from, which the client has no reason to have selected itself.
 */
export interface SelectionCtx {
  tableName: string;
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  tables: Record<string, Table>;
  /**
   * Every relation on the table, including those `relationMap` omits because they are not
   * eager-loaded. A lazily-resolved relation still correlates on a join column, so the
   * column extractors need to see it even when the eager map doesn't.
   */
  allRelations?: Record<string, Record<string, TableNamedRelations>>;
}

const AGGREGATE_FIELD_SUFFIX = 'Aggregate';

/**
 * Property names of the join columns that this selection's relation fields correlate on.
 * Without them the parent row reaches the relation resolver with no key: an aggregate counts
 * 0 and a relation list comes back empty.
 *
 * Needed by every relation field that resolves through its own resolver rather than the
 * parent's `with:` clause — `<relation>Aggregate` fields, which are always lazy; relations
 * excluded by `eagerLoadRelations`; and relations dropped from `with:` because they were
 * selected more than once under different aliases. Forcing the column for *any* selected
 * relation covers all three without the extractor having to predict which path will run: the
 * cost is one extra column (usually the primary key) in the parent SELECT, and GraphQL only
 * returns the fields the query asked for, so it never reaches the response.
 */
const relationJoinColumns = (
  tree: Record<string, ResolveTree>,
  table: Table,
  selectionCtx: SelectionCtx | undefined,
): string[] => {
  if (!selectionCtx) {
    return [];
  }
  const relations =
    (selectionCtx.allRelations ?? selectionCtx.relationMap)[selectionCtx.tableName] ??
    selectionCtx.relationMap[selectionCtx.tableName];
  if (!relations) {
    return [];
  }

  const tableColumns = getColumns(table);
  const needed: string[] = [];

  for (const fieldData of Object.values(tree)) {
    // A column that happens to be named like a relation is a column.
    if (tableColumns[fieldData.name]) {
      continue;
    }

    const relEntry = fieldData.name.endsWith(AGGREGATE_FIELD_SUFFIX)
      ? relations[fieldData.name.slice(0, -AGGREGATE_FIELD_SUFFIX.length)]
      : relations[fieldData.name];
    const targetTable = relEntry ? selectionCtx.tables[relEntry.targetTableName] : undefined;
    if (!relEntry || !targetTable) {
      continue;
    }

    const joinCols = extractRelationJoinColumns(relEntry, table, targetTable);
    if (joinCols) {
      needed.push(joinCols.localColPropName);
    }
  }

  return needed;
};

export const extractSelectedColumnsFromTree = (
  tree: Record<string, ResolveTree>,
  table: Table,
  selectionCtx?: SelectionCtx,
): Record<string, true> => {
  const tableColumns = getColumns(table);

  const treeEntries = Object.entries(tree);
  const selectedColumns: SelectedColumnsRaw = [];

  for (const [_fieldName, fieldData] of treeEntries) {
    if (!tableColumns[fieldData.name]) {
      continue;
    }

    selectedColumns.push([fieldData.name, true]);
  }

  for (const columnName of relationJoinColumns(tree, table, selectionCtx)) {
    selectedColumns.push([columnName, true]);
  }

  if (!selectedColumns.length) {
    const columnKeys = Object.entries(tableColumns);
    const columnName =
      columnKeys.find((e) => rqbCrashTypes.find((haram) => e[1].columnType !== haram))?.[0] ?? columnKeys[0]![0];

    selectedColumns.push([columnName, true]);
  }

  return Object.fromEntries(selectedColumns);
};

/**
 * Can't automatically determine column type on type level
 * Since drizzle table types extend eachother
 */
export const extractSelectedColumnsFromTreeSQLFormat = <TColType extends Column = Column>(
  tree: Record<string, ResolveTree>,
  table: Table,
  selectionCtx?: SelectionCtx,
): Record<string, TColType> => {
  const tableColumns = getColumns(table);

  const treeEntries = Object.entries(tree);
  const selectedColumns: SelectedSQLColumns = [];

  for (const [_fieldName, fieldData] of treeEntries) {
    if (!tableColumns[fieldData.name]) {
      continue;
    }

    selectedColumns.push([fieldData.name, tableColumns[fieldData.name]!]);
  }

  for (const columnName of relationJoinColumns(tree, table, selectionCtx)) {
    selectedColumns.push([columnName, tableColumns[columnName]!]);
  }

  if (!selectedColumns.length) {
    const columnKeys = Object.entries(tableColumns);
    const columnName =
      columnKeys.find((e) => rqbCrashTypes.find((haram) => e[1].columnType !== haram))?.[0] ?? columnKeys[0]![0];

    selectedColumns.push([columnName, tableColumns[columnName]!]);
  }

  return Object.fromEntries(selectedColumns) as Record<string, TColType>;
};

/**
 * Where NULL values sort relative to non-NULL values. Compiled to native
 * `NULLS FIRST` / `NULLS LAST` on PostgreSQL and SQLite (3.30+); MySQL has no such
 * clause, so there it is emulated with an extra `<expr> IS NULL` sort key ahead of
 * the column itself.
 */
export const orderNulls = new GraphQLEnumType({
  name: 'OrderNulls',
  description: 'Where NULL values sort relative to non-NULL values',
  values: {
    first: {
      value: 'first',
      description: 'NULL values sort before all non-NULL values',
    },
    last: {
      value: 'last',
      description: 'NULL values sort after all non-NULL values',
    },
  },
});

export const innerOrder = new GraphQLInputObjectType({
  name: 'InnerOrder' as const,
  fields: {
    direction: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'OrderDirection',
          description: 'Order by direction',
          values: {
            asc: {
              value: 'asc',
              description: 'Ascending order',
            },
            desc: {
              value: 'desc',
              description: 'Descending order',
            },
          },
        }),
      ),
    },
    priority: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Priority of current field',
    },
    nulls: {
      type: orderNulls,
      description:
        "Where NULL values sort. Defaults to the database's own rule (PostgreSQL: last on asc, first on desc; MySQL/SQLite: first on asc, last on desc)",
    },
    matchFilterOrder: {
      type: GraphQLBoolean,
      description:
        "Sort by this column's position in the `inArray` list the same request's `where` gives it, rather than by the column's own value — `direction: asc` keeps the list's order, `desc` reverses it. Requires an `inArray` filter on the same column at the top level of `where`, and cannot be combined with `after` or `distinct`.",
    },
  } as const,
});

/** The dialect a column belongs to, inferred from its drizzle columnType string (e.g. 'PgJsonb'). */
const columnDialect = (column: Column): 'pg' | 'mysql' | 'sqlite' | undefined => {
  const ct: string = (column as any).columnType ?? '';
  if (ct.startsWith('Pg')) {
    return 'pg';
  }
  if (ct.startsWith('MySql')) {
    return 'mysql';
  }
  if (ct.startsWith('SQLite')) {
    return 'sqlite';
  }
  return undefined;
};

/** How a column's generic filter input should be shaped, alongside the cache key to store it under. */
interface GenericFilterDescriptor {
  name: string;
  kind: 'scalar' | 'json' | 'array';
}

/**
 * Maps a Drizzle column to the generic filter type to use.
 *
 * Selection is keyed on the column's data type, never its name: a text column named
 * `userId` gets the full String filter (string operators included), while a uuid column
 * gets the lean Id filter whatever it is called.
 * - "JSON"            → json/jsonb columns (eq/ne + containment, no scalar comparison ops)
 * - `${Element}Array` → array columns, keyed per element type (IntArray, FloatArray,
 *                       StringArray, …) so arrays with different element types never share
 *                       one filter input; membership operators instead of scalar comparisons
 * - "Id"          → uuid-typed columns (no string pattern operators)
 * - "Boolean"     → boolean columns
 * - "BigInt"      → bigint columns (BigInt-scalar-typed operators, no string pattern operators)
 * - "Decimal"     → numeric/decimal columns (Decimal-scalar-typed operators, no string pattern operators)
 * - the enum GraphQL type name → enum columns (still unique per enum)
 * - "DateTime"    → timestamp and date columns
 * - "Int"         → integer/serial columns (no string pattern operators)
 * - "Float"       → real/double columns (no string pattern operators)
 * - "String"      → all other text/varchar columns
 */
const resolveGenericFilterDescriptor = (
  column: Column,
  columnGraphQLType: ReturnType<typeof drizzleColumnToGraphQLType>,
): GenericFilterDescriptor => {
  // JSON / JSONB columns — structural values with their own operator set.
  if (columnGraphQLType.type === GraphQLJSON) {
    return { name: 'JSON', kind: 'json' };
  }
  // Array columns — keyed per element type so an int[] and a text[] column never share
  // one cached filter input.
  if (columnGraphQLType.type instanceof GraphQLList) {
    let element = columnGraphQLType.type.ofType;
    if (element instanceof GraphQLNonNull) {
      element = element.ofType;
    }
    return { name: `${element.name}Array`, kind: 'array' };
  }
  // Opaque uuid keys — keyed on the column type, not on an `id`/`*Id` naming convention.
  if (columnGraphQLType.type === GraphQLUUID) {
    return { name: 'Id', kind: 'scalar' };
  }
  // Boolean scalar
  if (columnGraphQLType.type === GraphQLBoolean) {
    return { name: 'Boolean', kind: 'scalar' };
  }
  // Enum type — keep unique per enum since values differ
  if (columnGraphQLType.type instanceof GraphQLEnumType) {
    return { name: columnGraphQLType.type.name, kind: 'scalar' };
  }
  // Named numeric-string scalars — give them their own filters so the operators
  // are typed with the scalar (and validated by it) instead of a shared StringFilter.
  if (columnGraphQLType.type === GraphQLBigIntString) {
    return { name: 'BigInt', kind: 'scalar' };
  }
  if (columnGraphQLType.type === GraphQLDecimalString) {
    return { name: 'Decimal', kind: 'scalar' };
  }
  // Date / timestamp columns (check Drizzle internal columnType string)
  const ct: string = (column as any).columnType ?? '';
  if (ct === 'PgTimestamp' || ct === 'PgTimestampString' || ct === 'PgDate') {
    return { name: 'DateTime', kind: 'scalar' };
  }
  // Numeric scalars — distinct names so an int/float column never shares (and never
  // mistypes) the StringFilter, and integer ids keep a filter without string operators.
  // (BigInt/Decimal columns are handled above via their named scalars.)
  if (columnGraphQLType.type === GraphQLInt) {
    return { name: 'Int', kind: 'scalar' };
  }
  if (columnGraphQLType.type === GraphQLFloat) {
    return { name: 'Float', kind: 'scalar' };
  }
  // Default: plain text/varchar
  return { name: 'String', kind: 'scalar' };
};

/**
 * Filter fields for a json/jsonb column. `eq`/`ne` compare the whole document (jsonb equality
 * on Postgres, driver-level comparison elsewhere); `contains` is structural containment —
 * Postgres `@>` / MySQL `JSON_CONTAINS`. SQLite stores json as text and has no containment
 * operator, so `contains` is omitted there (same precedent as dialect-specific ops like ilike).
 */
const jsonFilterFields = (column: Column, colType: ReturnType<typeof drizzleColumnToGraphQLType>['type']) => {
  const dialect = columnDialect(column);
  return {
    eq: { type: colType, description: 'JSON equality on the whole value' },
    ne: { type: colType, description: 'JSON inequality on the whole value' },
    ...(dialect === 'pg' || dialect === 'mysql'
      ? {
          contains: {
            type: colType,
            description: 'Value structurally contains this JSON (Postgres `@>` / MySQL JSON_CONTAINS)',
          },
        }
      : {}),
    path: {
      type: new GraphQLList(new GraphQLNonNull(jsonPathFilter)),
      description:
        'Compares the value at one path inside the document. Several entries are ANDed; a single object may be passed without the list brackets.',
    },
    isNull: { type: GraphQLBoolean },
    isNotNull: { type: GraphQLBoolean },
  };
};

/**
 * How the value at a JSON path is read before it is compared. Left unset, the operand
 * decides: a GraphQL number compares numerically, a boolean as a boolean, anything else as
 * text. Set it when the operand's type does not match the document's — comparing a numeric
 * field against a `String` variable, say.
 */
const jsonPathCast = new GraphQLEnumType({
  name: 'JSONPathCast',
  description: 'How to read the value at a JSON path before comparing it',
  values: {
    TEXT: { value: 'text', description: 'Compare as text (lexicographic ordering)' },
    NUMBER: { value: 'number', description: 'Compare as a number; a non-numeric value never matches' },
    BOOLEAN: { value: 'boolean', description: 'Compare as a boolean' },
  },
});

/**
 * One predicate on the value at a path inside a json/jsonb column. `path` walks the document
 * key by key (an all-digits element indexes an array), and the remaining operators compare
 * whatever sits there. Operands are `JSON` so a single input type serves string, number and
 * boolean fields; see {@link jsonPathCast} for how the comparison type is chosen.
 *
 * Note that `contains` here is substring matching on the extracted value — unlike `contains`
 * on the column itself, which is structural JSON containment. A path names a scalar, so the
 * string reading is the useful one.
 */
const jsonPathFilter = new GraphQLInputObjectType({
  name: 'JSONPathFilter',
  fields: {
    path: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      description:
        'Keys to walk from the document root, e.g. `["profile", "level"]`. An all-digits key indexes an array.',
    },
    as: { type: jsonPathCast, description: 'Overrides how the value is read before comparing' },
    eq: { type: GraphQLJSON, description: 'Equal to' },
    ne: { type: GraphQLJSON, description: 'Not equal to' },
    lt: { type: GraphQLJSON, description: 'Less than' },
    lte: { type: GraphQLJSON, description: 'Less than or equal to' },
    gt: { type: GraphQLJSON, description: 'Greater than' },
    gte: { type: GraphQLJSON, description: 'Greater than or equal to' },
    startsWith: {
      type: GraphQLString,
      description: 'Extracted value starts with this string. `%`, `_` and `\\` are matched literally.',
    },
    endsWith: {
      type: GraphQLString,
      description: 'Extracted value ends with this string. `%`, `_` and `\\` are matched literally.',
    },
    contains: {
      type: GraphQLString,
      description: 'Extracted value contains this string. `%`, `_` and `\\` are matched literally.',
    },
    iStartsWith: { type: GraphQLString, description: 'Case-insensitive `startsWith`.' },
    iEndsWith: { type: GraphQLString, description: 'Case-insensitive `endsWith`.' },
    iContains: { type: GraphQLString, description: 'Case-insensitive `contains`.' },
    isNull: {
      type: GraphQLBoolean,
      description: 'When true, matches rows where the path is missing or holds JSON null',
    },
    isNotNull: { type: GraphQLBoolean, description: 'When true, matches rows where the path holds a value' },
  },
});

/**
 * `inArray` / `notInArray` take a list of candidate values and compile to SQL `IN` /
 * `NOT IN`. Their descriptions are fixed rather than derived from the column: what the
 * operator does is the same everywhere, and the operand type already says what goes in it.
 */
const IN_ARRAY_DESCRIPTION = 'Matches any one of these values (SQL `IN`)';
const NOT_IN_ARRAY_DESCRIPTION = 'Matches none of these values (SQL `NOT IN`)';

/**
 * Filter fields for an array column (Postgres-only in drizzle). Membership operators replace
 * the scalar comparison and string pattern sets: `has` checks a single element (`@>` with a
 * one-element array), `hasSome` is overlap (`&&`), `hasEvery` is containment (`@>`), `isEmpty`
 * matches arrays with no elements. `eq`/`ne` still compare the whole array, and
 * `inArray`/`notInArray` still match the whole array against a list of candidate arrays
 * (SQL `IN`, typed `[[Element!]!]`).
 */
const arrayFilterFields = (colType: GraphQLList<any>, colArr: GraphQLList<any>) => {
  let element = colType.ofType;
  if (element instanceof GraphQLNonNull) {
    element = element.ofType;
  }
  const elementList = new GraphQLList(new GraphQLNonNull(element));

  return {
    eq: { type: colType, description: 'The whole array equals this array' },
    ne: { type: colType, description: 'The whole array differs from this array' },
    has: { type: element, description: 'Array contains this element' },
    hasSome: { type: elementList, description: 'Array contains at least one of these elements (overlap, `&&`)' },
    hasEvery: { type: elementList, description: 'Array contains every one of these elements (containment, `@>`)' },
    isEmpty: { type: GraphQLBoolean, description: 'When true, matches arrays with no elements' },
    inArray: { type: colArr, description: IN_ARRAY_DESCRIPTION },
    notInArray: { type: colArr, description: NOT_IN_ARRAY_DESCRIPTION },
    isNull: { type: GraphQLBoolean },
    isNotNull: { type: GraphQLBoolean },
  };
};

/**
 * Filters whose fields omit the string pattern operators (like/notLike/ilike/notIlike/
 * startsWith/contains/…): they are nonsensical on opaque uuids and invalid SQL on numeric
 * columns. Keyed on the generic filter name (i.e. on column type) — a string-typed column
 * keeps the string operators whatever it is called.
 */
const FILTERS_WITHOUT_STRING_OPS = new Set(['Id', 'Int', 'Float', 'BigInt', 'Decimal']);

/**
 * Scalars the built-in detection itself can produce. A scalar override to one of these
 * shares the built-in filter type for that scalar, so its shape must stay exactly what a
 * natural column of the scalar gets — whichever column builds the cached type first.
 * Any other override scalar gets its own filter type named after the scalar.
 */
const BUILTIN_FILTER_SCALARS = new Set<GraphQLScalarType>([
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLBigIntString,
  GraphQLDecimalString,
  GraphQLUUID,
  GraphQLJSON,
  GraphQLDate,
  GraphQLDateTime,
]);

/**
 * Filter descriptor for a scalar-overridden column. Overrides to the library's own
 * structural scalars keep the corresponding built-in descriptor (JSON keeps the
 * json-shaped filter, UUID the Id filter), so they share the name-keyed cache with
 * natural columns safely in either build order; every other scalar — the remaining
 * built-ins and all custom scalars — gets a scalar-shaped filter named after it
 * (BigIntFilter, MoneyFilter, …).
 */
const resolveOverrideFilterDescriptor = (scalar: GraphQLScalarType): GenericFilterDescriptor => {
  if (scalar === GraphQLJSON) {
    return { name: 'JSON', kind: 'json' };
  }
  if (scalar === GraphQLUUID) {
    return { name: 'Id', kind: 'scalar' };
  }
  return { name: scalar.name, kind: 'scalar' };
};

const generateColumnFilterValues = (
  column: Column,
  tableName: string,
  columnName: string,
  cacheCtx: TypeCacheCtx,
): GraphQLInputObjectType => {
  const columnGraphQLType = drizzleColumnToGraphQLType(column, columnName, tableName, true, false, true);

  // A scalar-overridden column gets its filter built from the override scalar, which
  // `columnGraphQLType` above already resolved to. An override to one of the library's own
  // scalars shares the built-in filter for that scalar (same descriptor a natural column of
  // that scalar gets); any other scalar gets its own scalar-shaped filter type named after it
  // (e.g. MoneyFilter). The cache stays keyed by name, so all columns overridden with the
  // same scalar share one filter type.
  const inputOverride = getColumnScalarOverride(column, true);

  const { name: genericName, kind } = inputOverride
    ? resolveOverrideFilterDescriptor(inputOverride)
    : resolveGenericFilterDescriptor(column, columnGraphQLType);
  const cached = cacheCtx.genericFilterCache.get(genericName);
  if (cached) {
    return cached;
  }

  const colType = columnGraphQLType.type;
  const colArr = new GraphQLList(new GraphQLNonNull(colType));

  // Uuid and numeric filters omit the string pattern operators
  // (like/ilike/startsWith/contains/…) — decided by column type, never by column name.
  // A filter shared with the built-ins keeps that name-keyed rule even for an overridden
  // column, so the shared type's shape never depends on which column built it first. A
  // custom override scalar's own filter carries the pattern operators only when a pattern
  // match is valid SQL on the underlying database column: string-typed, and not
  // numeric/decimal (those transport as strings but reject LIKE).
  const customOverrideFilter = inputOverride !== undefined && !BUILTIN_FILTER_SCALARS.has(inputOverride);
  const underlying = extractExtendedColumnType(column);
  const omitStringOps = customOverrideFilter
    ? underlying.type !== 'string' || underlying.constraint === 'numeric'
    : FILTERS_WITHOUT_STRING_OPS.has(genericName);

  const baseFields =
    kind === 'json'
      ? jsonFilterFields(column, colType)
      : kind === 'array'
        ? arrayFilterFields(colType as GraphQLList<any>, colArr)
        : {
            eq: { type: colType, description: 'Equal to' },
            ne: { type: colType, description: 'Not equal to' },
            lt: { type: colType, description: 'Less than' },
            lte: { type: colType, description: 'Less than or equal to' },
            gt: { type: colType, description: 'Greater than' },
            gte: { type: colType, description: 'Greater than or equal to' },
            ...(omitStringOps
              ? {}
              : {
                  like: { type: GraphQLString },
                  notLike: { type: GraphQLString },
                  ilike: { type: GraphQLString },
                  notIlike: { type: GraphQLString },
                  startsWith: {
                    type: GraphQLString,
                    description:
                      'Matches values starting with the given string. `%`, `_` and `\\` are matched literally.',
                  },
                  endsWith: {
                    type: GraphQLString,
                    description:
                      'Matches values ending with the given string. `%`, `_` and `\\` are matched literally.',
                  },
                  contains: {
                    type: GraphQLString,
                    description: 'Matches values containing the given string. `%`, `_` and `\\` are matched literally.',
                  },
                  iStartsWith: {
                    type: GraphQLString,
                    description: 'Case-insensitive `startsWith`.',
                  },
                  iEndsWith: {
                    type: GraphQLString,
                    description: 'Case-insensitive `endsWith`.',
                  },
                  iContains: {
                    type: GraphQLString,
                    description: 'Case-insensitive `contains`.',
                  },
                }),
            inArray: { type: colArr, description: IN_ARRAY_DESCRIPTION },
            notInArray: { type: colArr, description: NOT_IN_ARRAY_DESCRIPTION },
            isNull: { type: GraphQLBoolean, description: 'When true, matches rows where the column is NULL' },
            isNotNull: { type: GraphQLBoolean, description: 'When true, matches rows where the column is not NULL' },
          };

  // The boolean branches are recursive — each branch is this filter type itself — so the
  // fields are thunked and reference the type being constructed.
  const mainType: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: `${genericName}Filter`,
    fields: () => ({
      ...baseFields,
      OR: {
        type: new GraphQLList(new GraphQLNonNull(mainType)),
        description: 'At least one branch matches; ANDed with any sibling operators',
      },
      AND: {
        type: new GraphQLList(new GraphQLNonNull(mainType)),
        description: 'Every branch matches',
      },
      NOT: {
        type: mainType,
        description: 'Negates the nested operators',
      },
    }),
  });

  cacheCtx.genericFilterCache.set(genericName, mainType);
  return mainType;
};

const orderMap = new WeakMap<object, Record<string, ConvertedInputColumn>>();
const generateTableOrderCached = (table: Table) => {
  // The cache outlives a build, so a table whose columns this build hides must not read from
  // it (a previous build may have cached the full set) or write to it (a later unfiltered
  // build would inherit the holes).
  const cacheable = !hasExcludedColumns(table);
  if (cacheable && orderMap.has(table)) {
    return orderMap.get(table)!;
  }

  let remapped = {};
  try {
    const columns = visibleColumns(table);
    const columnEntries = Object.entries(columns);

    remapped = Object.fromEntries(
      columnEntries.map(([columnName, _columnDescription]) => [columnName, { type: innerOrder }]),
    );

    if (cacheable) {
      orderMap.set(table, remapped);
    }
  } catch (_err) {}
  return remapped;
};

const generateTableFilterValuesCached = (table: Table, tableName: string, cacheCtx: TypeCacheCtx) => {
  if (cacheCtx.filterFieldCache.has(table)) {
    return cacheCtx.filterFieldCache.get(table)!;
  }

  const columns = visibleColumns(table);
  const columnEntries = Object.entries(columns);

  const remapped = Object.fromEntries(
    columnEntries.map(([columnName, column]) => [
      columnName,
      {
        type: generateColumnFilterValues(column, tableName, columnName, cacheCtx),
        // A filter field is the same column, so it carries the same documentation. Deprecation
        // is not propagated: filtering on a deprecated column is how a caller finds the rows
        // that still use it.
        ...(cacheCtx.docs.describeColumn
          ? { description: cacheCtx.docs.describeColumn(column, { tableName, columnName }) }
          : {}),
      },
    ]),
  );

  cacheCtx.filterFieldCache.set(table, remapped);

  return remapped;
};

const generateTableSelectTypeFieldsCached = (
  table: Table,
  tableName: string,
  cacheCtx: TypeCacheCtx,
): Record<string, ConvertedColumn> => {
  if (cacheCtx.selectFieldCache.has(table)) {
    return cacheCtx.selectFieldCache.get(table)!;
  }

  const columns = visibleColumns(table);
  const columnEntries = Object.entries(columns);

  const remapped = Object.fromEntries(
    columnEntries.map(([columnName, column]) => [
      columnName,
      {
        ...drizzleColumnToGraphQLType(column, columnName, tableName),
        ...columnDocs(cacheCtx.docs, column, tableName, columnName),
      },
    ]),
  );

  // Opaque keyset-pagination cursor. Only populated on rows returned by a list query; a real
  // column named `cursor` keeps the field for itself instead.
  if (!remapped[CURSOR_FIELD_NAME]) {
    remapped[CURSOR_FIELD_NAME] = {
      type: GraphQLString,
      description:
        "Opaque cursor of this row's position in the query's ordering. Pass it as `after` to resume from here. Only set on rows returned by a list query.",
      resolve: rowCursorResolver,
    } as ConvertedColumn;
  }

  cacheCtx.selectFieldCache.set(table, remapped);

  return remapped;
};

/**
 * Whether a to-one relation can back a relation orderBy hop. `.through()` (junction)
 * relations are excluded — the ordering subquery only joins the direct target, never the
 * junction table. (Relation *filters* do support `.through()` — this guard is orderBy-only.)
 */
const isFilterableRelation = (relation: Relation<string>): boolean => !(relation as any).through;

/**
 * Order fields for a table's to-one relations: each takes the target table's own OrderBy
 * input, so a list can be sorted by a related row's column (compiled as a correlated
 * subquery in the ORDER BY — see `extractOrderBy`). To-many relations are left out: "order
 * a parent by its many children" has no single defined value to sort on. A relation whose
 * name collides with a column is skipped — the column keeps the field.
 */
const generateRelationOrderFields = (
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  columnFields: Record<string, ConvertedInputColumn>,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): Record<string, { type: GraphQLInputObjectType; description?: string }> => {
  const relations = relationMap?.[tableName];
  if (!relations || !tables) {
    return {};
  }

  const fields: Record<string, { type: GraphQLInputObjectType; description?: string }> = {};

  for (const [relationName, relEntry] of Object.entries(relations)) {
    if (relationName in columnFields) {
      continue;
    }

    const targetTable = tables[relEntry.targetTableName];
    const relation = (relEntry as any).relation ?? relEntry;
    if (!targetTable || !is(relation, One) || !isFilterableRelation(relation)) {
      continue;
    }

    fields[relationName] = {
      type: generateTableOrderTypeCached(
        targetTable,
        relEntry.targetTableName,
        typeNameMapper,
        cacheCtx,
        relationMap,
        tables,
      ),
      description: `Order by columns of the related ${relationName} row`,
    };
  }

  return fields;
};

const generateTableOrderTypeCached = (
  table: Table,
  tableName: string,
  typeNameMapper: TypeNameMapper | undefined,
  cacheCtx: TypeCacheCtx,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
) => {
  if (cacheCtx.orderTypeCache.has(table)) {
    return cacheCtx.orderTypeCache.get(table)!;
  }

  // Fields are thunked so that relation order fields, which reference other tables' order
  // inputs (and eventually this one again), are only resolved after this type is cached.
  const order = new GraphQLInputObjectType({
    name: `${resolveTypeName(tableName, typeNameMapper)}OrderBy`,
    fields: () => {
      const orderColumns = generateTableOrderCached(table);
      return {
        ...orderColumns,
        ...generateRelationOrderFields(tableName, cacheCtx, typeNameMapper, orderColumns, relationMap, tables),
      };
    },
  });

  cacheCtx.orderTypeCache.set(table, order);

  return order;
};

/**
 * `${Target}ListRelationFilter` — the Prisma-style some/every/none wrapper for a to-many
 * relation. Shared by every table that points at the same target, and built through a thunk
 * so mutually-referencing tables (Users.posts ⇄ Posts.author) don't recurse forever.
 */
const generateListRelationFilterCached = (
  targetTable: Table,
  targetTableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  relationMap: Record<string, Record<string, TableNamedRelations>> | undefined,
  tables: Record<string, Table> | undefined,
): GraphQLInputObjectType => {
  const cached = cacheCtx.listRelationFilterCache.get(targetTableName);
  if (cached) {
    return cached;
  }

  const listFilter = new GraphQLInputObjectType({
    name: `${resolveTypeName(targetTableName, typeNameMapper)}ListRelationFilter`,
    fields: () => {
      const targetFilters = generateTableFilterTypeCached(
        targetTable,
        targetTableName,
        cacheCtx,
        typeNameMapper,
        relationMap,
        tables,
      );

      return {
        some: { type: targetFilters, description: 'At least one related row matches' },
        none: { type: targetFilters, description: 'No related row matches' },
        every: { type: targetFilters, description: 'Every related row matches' },
      };
    },
  });

  cacheCtx.listRelationFilterCache.set(targetTableName, listFilter);

  return listFilter;
};

/**
 * Filter fields for a table's relations: a to-one relation takes the target's own filter input
 * directly, a to-many relation takes the some/every/none wrapper. A relation whose name collides
 * with a column name is skipped — the column keeps the field.
 */
const generateRelationFilterFields = (
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  columnFields: Record<string, ConvertedInputColumn>,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
): Record<string, { type: GraphQLInputObjectType; description?: string }> => {
  const relations = relationMap?.[tableName];
  if (!relations || !tables) {
    return {};
  }

  const fields: Record<string, { type: GraphQLInputObjectType; description?: string }> = {};

  for (const [relationName, relEntry] of Object.entries(relations)) {
    if (relationName in columnFields) {
      continue;
    }

    const targetTable = tables[relEntry.targetTableName];
    const relation = (relEntry as any).relation ?? relEntry;
    if (!targetTable) {
      continue;
    }

    fields[relationName] = is(relation, One)
      ? {
          type: generateTableFilterTypeCached(
            targetTable,
            relEntry.targetTableName,
            cacheCtx,
            typeNameMapper,
            relationMap,
            tables,
          ),
          description: `Matches rows whose ${relationName} matches these filters`,
        }
      : {
          type: generateListRelationFilterCached(
            targetTable,
            relEntry.targetTableName,
            cacheCtx,
            typeNameMapper,
            relationMap,
            tables,
          ),
        };
  }

  return fields;
};

const generateTableFilterTypeCached = (
  table: Table,
  tableName: string,
  cacheCtx: TypeCacheCtx,
  typeNameMapper?: TypeNameMapper,
  relationMap?: Record<string, Record<string, TableNamedRelations>>,
  tables?: Record<string, Table>,
) => {
  if (cacheCtx.filterTypeCache.has(table)) {
    return cacheCtx.filterTypeCache.get(table)!;
  }

  // Fields are thunked so that relation filters, which reference other tables' filter inputs
  // (and eventually this one again), are only resolved after this type is in the cache.
  const buildFields = () => {
    const filterColumns = generateTableFilterValuesCached(table, tableName, cacheCtx);
    return {
      ...filterColumns,
      ...generateRelationFilterFields(tableName, cacheCtx, typeNameMapper, filterColumns, relationMap, tables),
    };
  };

  // The boolean branches (OR / AND / NOT) are recursive — each branch is this filter type
  // itself — so the thunk references the type being constructed. Siblings and branches
  // compose: sibling fields are implicitly ANDed with the OR / AND / NOT groups.
  const filters: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: `${resolveTypeName(tableName, typeNameMapper)}Filters`,
    fields: () => ({
      ...buildFields(),
      OR: {
        type: new GraphQLList(new GraphQLNonNull(filters)),
        description: 'At least one branch matches; ANDed with any sibling fields',
      },
      AND: {
        type: new GraphQLList(new GraphQLNonNull(filters)),
        description: 'Every branch matches',
      },
      NOT: {
        type: filters,
        description: 'Negates the nested filters',
      },
    }),
  });

  cacheCtx.filterTypeCache.set(table, filters);

  return filters;
};

/**
 * Build the select fields for a table.
 * Creates:
 * - Main select type: ${capitalize(tableName)} (e.g. Users)
 * - Relation fields reference the target table's own type directly (e.g. posts: [Posts!]!)
 *   rather than creating intermediate relation types.
 *
 * The function is called recursively for relation targets.
 * Cycle detection: usedTables tracks tables currently being processed in the call stack.
 * When we see a table already in usedTables, we stop recursing (no relation fields for that type).
 */
const generateSelectFields = <TWithOrder extends boolean>(
  tables: Record<string, Table>,
  tableName: string,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  fromTableName: string,
  fromRelationName: string,
  withOrder: TWithOrder,
  relationsDepthLimit: number | undefined,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined,
  usedTables: Set<string> = new Set(),
  resolverFactory?: RelationResolverFactory,
  currentDepth: number = 0,
  relationAggregateFactory?: RelationAggregateFactory,
): SelectData<TWithOrder> => {
  const table = tables[tableName]!;
  const order = withOrder
    ? generateTableOrderTypeCached(table, tableName, typeNameMapper, cacheCtx, relationMap, tables)
    : undefined;
  const filters = generateTableFilterTypeCached(table, tableName, cacheCtx, typeNameMapper, relationMap, tables);
  const tableFields = generateTableSelectTypeFieldsCached(table, tableName, cacheCtx);

  const relationsForTable = relationMap[tableName];
  const relationEntries: [string, TableNamedRelations][] = relationsForTable ? Object.entries(relationsForTable) : [];

  // Depth limit: stop generating relation fields once we reach the configured maximum.
  // relationsDepthLimit: 0 → no relation fields on any type.
  // relationsDepthLimit: N → each table's own root call (depth 0) generates its relations,
  // but traversals beyond depth N stop, which prevents unbounded recursive generation.
  if (relationsDepthLimit !== undefined && currentDepth >= relationsDepthLimit) {
    return {
      order,
      filters,
      tableFields,
      relationFields: {},
    } as SelectData<TWithOrder>;
  }

  // If this table is already being processed (cycle), stop recursing.
  // Return just the base fields with no relation fields.
  if (usedTables.has(tableName)) {
    return {
      order,
      filters,
      tableFields,
      relationFields: {},
    } as SelectData<TWithOrder>;
  }

  // For the root call (fromTableName === '' && fromRelationName === ''), this builds the
  // main ${capitalize(tableName)}SelectItem type.
  // For recursive calls, this builds the relation type.
  const isRootCall = fromTableName === '' && fromRelationName === '';

  // If the root type has already been fully built (not just pre-registered as a shell), return early.
  if (isRootCall && cacheCtx.fullyBuiltTables.has(tableName)) {
    return {
      order,
      filters,
      tableFields,
      relationFields: {},
    } as SelectData<TWithOrder>;
  }

  // Obtain or create the mutable relation-fields container for this table.
  // The container is a plain object whose `fields` property the GraphQLObjectType thunk reads.
  // Pre-registering it here (before recursion) allows sibling relation traversals to reference
  // the same single GraphQLObjectType instance even when it hasn't been fully built yet.
  let container = cacheCtx.relationFieldContainers.get(tableName);
  if (!container) {
    container = { fields: {} };
    cacheCtx.relationFieldContainers.set(tableName, container);
  }

  if (isRootCall && !cacheCtx.objectTypeCache.has(tableName)) {
    const typeName = resolveTypeName(tableName, typeNameMapper);
    // Pre-register shell with thunk BEFORE recursing to break circular refs.
    // The thunk reads container.fields, which will be populated after recursion completes.
    const shell = new GraphQLObjectType({
      name: typeName,
      description: cacheCtx.docs.describeTable?.(tableName),
      fields: () => ({ ...tableFields, ...container!.fields }),
      extensions: { drizzle: tableTypeExtension(tableName, cacheCtx.primaryKeyOf?.(tableName) ?? []) },
    });
    cacheCtx.objectTypeCache.set(tableName, shell);
  }

  // Build relation fields — recurse into each related table.
  // Mark this table as in-progress before recursing to detect cycles.
  if (relationEntries.length > 0) {
    const rawRelationFields: [string, ConvertedRelationColumnWithArgs][] = [];

    // Mark this table as currently being processed.
    const nextUsedTables = new Set(usedTables);
    nextUsedTables.add(tableName);

    for (const [relationName, relEntry] of relationEntries) {
      const { targetTableName } = relEntry;
      const relation = (relEntry as any).relation ?? relEntry;
      const isOne = is(relation, One);

      // Always recurse to get the target table's filters/order (needed for args).
      // The usedTables check inside the recursive call prevents actual infinite recursion.
      const relSelectData = generateSelectFields(
        tables,
        targetTableName,
        relationMap,
        tableName, // fromTableName for the relation type
        relationName, // fromRelationName for the relation type
        !isOne,
        relationsDepthLimit,
        cacheCtx,
        typeNameMapper,
        nextUsedTables,
        resolverFactory,
        currentDepth + 1,
        relationAggregateFactory,
      );

      // Use the target table's own GraphQL type directly instead of creating an intermediate relation type.
      // Ensure exactly one GraphQLObjectType instance exists for the target table.
      // If the root call for the target table has already run (or pre-registered a shell),
      // reuse that instance so the schema never contains duplicate type names.
      let relType = cacheCtx.objectTypeCache.get(targetTableName);
      if (!relType) {
        // The target table hasn't been processed yet. Pre-register a shell so that:
        //   (a) this relation field has a concrete type reference, and
        //   (b) when the target table's root call eventually runs, it reuses this same object.
        const targetTable = tables[targetTableName]!;
        const targetTableFields = generateTableSelectTypeFieldsCached(targetTable, targetTableName, cacheCtx);
        // Get or create a container for the target table's relation fields.
        let targetContainer = cacheCtx.relationFieldContainers.get(targetTableName);
        if (!targetContainer) {
          targetContainer = { fields: {} };
          cacheCtx.relationFieldContainers.set(targetTableName, targetContainer);
        }
        const capturedTargetContainer = targetContainer;
        // The thunk reads capturedTargetContainer.fields so that when the target table's root
        // call populates the container, the shell automatically includes those relation fields.
        relType = new GraphQLObjectType({
          name: resolveTypeName(targetTableName, typeNameMapper),
          description: cacheCtx.docs.describeTable?.(targetTableName),
          fields: () => ({ ...targetTableFields, ...capturedTargetContainer.fields }),
          extensions: {
            drizzle: tableTypeExtension(targetTableName, cacheCtx.primaryKeyOf?.(targetTableName) ?? []),
          },
        });
        cacheCtx.objectTypeCache.set(targetTableName, relType);
      }

      const resolve = resolverFactory?.({ tableName, relationName, relEntry: relEntry as TableNamedRelations, isOne });
      const relationDescription = cacheCtx.docs.describeRelation?.(tableName, relationName);
      const relationDocs = relationDescription !== undefined ? { description: relationDescription } : {};

      if (isOne) {
        // Honor the relation's declared optionality: `r.one.Target({ ..., optional: false })`
        // asserts the related row always exists (a NOT NULL foreign key), so the field is
        // emitted as `Target!`. The default (`optional: true` / omitted) stays nullable.
        // Column nullability alone is NOT used to infer this — a notNull `from` column does
        // not guarantee a related row exists when the FK constraint lives on the other side
        // (e.g. `Users.customer` joins the notNull `Users.id` to `Customers.userId`).
        const isRequired = (relation as One<any, any>).optional === false;
        rawRelationFields.push([
          relationName,
          {
            type: isRequired ? new GraphQLNonNull(relType) : relType,
            args: {
              where: { type: relSelectData.filters },
              ...deletedArg(cacheCtx.softDeleteOf, targetTableName),
            },
            resolve,
            ...relationDocs,
            extensions: { drizzle: relationExtensionFor(relEntry, tableName, relationName, true) },
          },
        ]);
        continue;
      }

      rawRelationFields.push([
        relationName,
        {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relType))),
          args: {
            where: { type: relSelectData.filters },
            orderBy: { type: relSelectData.order! },
            offset: { type: GraphQLInt },
            limit: { type: GraphQLInt },
            ...deletedArg(cacheCtx.softDeleteOf, targetTableName),
          },
          resolve,
          ...relationDocs,
          extensions: {
            drizzle: relationExtensionFor(relEntry, tableName, relationName, false),
            ...(cacheCtx.complexity
              ? { complexity: listFieldComplexity(cacheCtx.complexity, cacheCtx.limits?.(targetTableName)) }
              : {}),
          },
        },
      ]);

      // Aggregate over the related rows without fetching them: `user { postsAggregate { count } }`.
      // Skipped when the name would shadow a column or another relation.
      const aggregateFieldName = `${relationName}Aggregate`;
      if (!tableFields[aggregateFieldName] && !relationsForTable?.[aggregateFieldName]) {
        const relationAggregate = relationAggregateFactory?.({
          tableName,
          relationName,
          relEntry: relEntry as TableNamedRelations,
        });

        if (relationAggregate) {
          rawRelationFields.push([
            aggregateFieldName,
            {
              type: new GraphQLNonNull(relationAggregate.type),
              args: {
                where: { type: relSelectData.filters },
                ...deletedArg(cacheCtx.softDeleteOf, targetTableName),
              },
              resolve: relationAggregate.resolve,
              extensions: {
                drizzle: relationExtensionFor(relEntry, tableName, relationName, isOne, true),
                ...(cacheCtx.complexity ? { complexity: aggregateFieldComplexity(cacheCtx.complexity) } : {}),
              },
            } as unknown as ConvertedRelationColumnWithArgs,
          ]);
        }
      }
    }

    const builtRelationFields = Object.fromEntries(rawRelationFields);

    // Only the root call should populate the container — non-root calls are temporary traversals
    // to collect filters/order for args and should not overwrite the canonical relation fields.
    if (isRootCall) {
      // Populate the container so that the thunk on the GraphQLObjectType shell (whether it was
      // created here or pre-registered by another table's relation traversal) picks up the fields.
      container.fields = builtRelationFields;
      cacheCtx.fullyBuiltTables.add(tableName);
    }

    return {
      order,
      filters,
      tableFields,
      relationFields: builtRelationFields,
    } as SelectData<TWithOrder>;
  }

  // No relation entries — mark as fully built if root call.
  if (isRootCall) {
    cacheCtx.fullyBuiltTables.add(tableName);
  }

  return {
    order,
    filters,
    tableFields,
    relationFields: {},
  } as SelectData<TWithOrder>;
};

export const generateTableTypes = <WithReturning extends boolean>(
  tableName: string,
  tables: Record<string, Table>,
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  withReturning: WithReturning,
  relationsDepthLimit: number | undefined,
  cacheCtx: TypeCacheCtx,
  typeNameMapper: TypeNameMapper | undefined = undefined,
  insertPrefix: string = 'create',
  updatePrefix: string = 'update',
  resolverFactory?: RelationResolverFactory,
  relationAggregateFactory?: RelationAggregateFactory,
  nestedWrites?: NestedWriteTypes,
): GeneratedTableTypes<WithReturning> => {
  const { tableFields, relationFields, filters, order } = generateSelectFields(
    tables,
    tableName,
    relationMap,
    '', // root call: no fromTableName
    '', // root call: no fromRelationName
    true,
    relationsDepthLimit,
    cacheCtx,
    typeNameMapper,
    new Set(),
    resolverFactory,
    0,
    relationAggregateFactory,
  );

  const table = tables[tableName]!;
  const columns = visibleColumns(table);
  const columnEntries = Object.entries(columns);

  // A column whose value comes from the request context is not part of any write input: the
  // client cannot supply one on create, and cannot reassign one on update. It stays an
  // ordinary column everywhere else — the output type, the filters, the ordering.
  const contextColumns = cacheCtx.contextValuesOf?.(tableName);
  // Same for the column that marks a row deleted: `delete` and `restore` own it, and a client
  // that could write it through an ordinary create or update could delete or undelete a row
  // without going through either.
  const markerColumn = cacheCtx.softDeleteOf?.(tableName)?.columnName;
  const writableEntries =
    contextColumns || markerColumn
      ? columnEntries.filter(
          ([columnName]) => !(contextColumns && columnName in contextColumns) && columnName !== markerColumn,
        )
      : columnEntries;

  // A column a nested write can supply (`author: { create: … }` fills in `authorId`) cannot
  // stay required on the create input, or the two ways of setting it would be mutually
  // exclusive at the type level.
  const relaxedColumns = nestedWrites?.relaxedColumns(tableName);

  const insertFields = Object.fromEntries(
    writableEntries.map(([columnName, column]) => {
      const converted = drizzleColumnToGraphQLType(
        column,
        columnName,
        tableName,
        !!relaxedColumns?.has(columnName),
        true,
        true,
      );
      return [
        columnName,
        { ...converted, ...inputFieldDocs(cacheCtx.docs, column, tableName, columnName, converted.type) },
      ];
    }),
  );

  const updateFields = Object.fromEntries(
    writableEntries.map(([columnName, column]) => {
      const converted = drizzleColumnToGraphQLType(column, columnName, tableName, true, false, true);
      return [
        columnName,
        { ...converted, ...inputFieldDocs(cacheCtx.docs, column, tableName, columnName, converted.type) },
      ];
    }),
  );

  const typeName = resolveTypeName(tableName, typeNameMapper);

  // Insert/update input types: ${capitalize(insertPrefix)}${resolveTypeName(tableName)}Input / ${capitalize(updatePrefix)}${resolveTypeName(tableName)}Input
  // With nested writes on, the fields are thunked: a relation field's operand is the target
  // table's filter input, which does not exist yet while this table is being generated.
  const insertInput = new GraphQLInputObjectType({
    name: `${capitalize(insertPrefix)}${typeName}Input`,
    fields: nestedWrites
      ? () => ({ ...insertFields, ...nestedWrites.createFields(tableName, typeName) })
      : insertFields,
  });

  const updateInput = new GraphQLInputObjectType({
    name: `${capitalize(updatePrefix)}${typeName}Input`,
    fields: nestedWrites
      ? () => ({ ...updateFields, ...nestedWrites.updateFields(tableName, typeName) })
      : updateFields,
  });

  // Select type: ${resolveTypeName(tableName)} (with relation fields)
  // Reuse the cached shell created in generateSelectFields.
  const selectSingleOutput =
    cacheCtx.objectTypeCache.get(tableName) ??
    new GraphQLObjectType({
      name: resolveTypeName(tableName, typeNameMapper),
      description: cacheCtx.docs.describeTable?.(tableName),
      fields: { ...tableFields, ...relationFields },
      extensions: { drizzle: tableTypeExtension(tableName, cacheCtx.primaryKeyOf?.(tableName) ?? []) },
    });

  const selectArrOutput = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(selectSingleOutput)));

  // Mutation return type: ${capitalize(tableName)}Item (table columns only, no relations)
  //   const singleTableItemOutput = withReturning
  //     ? new GraphQLObjectType({
  //         name: `${capitalize(tableName)}`,
  // //         name: `${capitalize(tableName)}Item`,
  //         fields: tableFields,
  //       })
  //     : undefined;

  const arrTableItemOutput = withReturning
    ? //     ? new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(singleTableItemOutput!)))
      new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(selectSingleOutput!)))
    : undefined;

  const inputs = {
    insertInput,
    updateInput,
    tableOrder: order,
    tableFilters: filters,
  };

  const outputs = (
    withReturning
      ? {
          selectSingleOutput,
          selectArrOutput,
          singleTableItemOutput: selectSingleOutput!,
          //           singleTableItemOutput: singleTableItemOutput!,
          arrTableItemOutput: arrTableItemOutput!,
        }
      : {
          selectSingleOutput,
          selectArrOutput,
        }
  ) as GeneratedTableTypesOutputs<WithReturning>;

  return {
    inputs,
    outputs,
  };
};

/** How NULLs are placed relative to non-NULL values in an ordered column. */
export type OrderNullsOption = 'first' | 'last';

/**
 * Column name / direction / nulls triples from an `orderBy` argument, highest priority
 * first. Split out of `extractOrderBy` so the same ordering can be rebuilt against a
 * subquery's fields, where there is no `Table` to read columns from. Because there is no
 * table, ordering through a relation cannot be compiled here — a relation-shaped entry
 * (an object without a `direction`) is rejected with a clear error instead of being
 * silently dropped.
 */
export const orderByEntries = (
  orderArgs: Record<string, any>,
): [string, 'asc' | 'desc', OrderNullsOption | undefined][] =>
  Object.entries(orderArgs)
    .sort((a, b) => (b[1]?.priority ?? 0) - (a[1]?.priority ?? 0))
    .filter(([, config]) => config)
    .map(([column, config]) => {
      if (typeof config === 'object' && config.direction === undefined) {
        throw new GraphQLError(`ORDER BY ${column}: ordering through a relation is not supported in this query`);
      }
      // Same reason as above: the sort key is not a value of the row, so it cannot be
      // rebuilt against a subquery's fields or encoded into a cursor.
      if (config.matchFilterOrder) {
        throw new GraphQLError(`ORDER BY ${column}: 'matchFilterOrder' is not supported in this query`);
      }
      return [column, config.direction, config.nulls ?? undefined];
    });

/**
 * The ORDER BY expression(s) for one ordered value. Without a `nulls` option this is the
 * plain `asc`/`desc` of the expression. With one:
 * - PostgreSQL and SQLite (3.30+) support `NULLS FIRST` / `NULLS LAST` natively, so the
 *   clause is emitted as-is.
 * - MySQL has no such clause, so it is emulated with an extra `<expr> IS NULL` sort key
 *   ahead of the expression itself (`IS NULL DESC` puts nulls first, `ASC` puts them
 *   last). The same GraphQL surface is kept on all three dialects.
 *
 * `dialectColumn` is the real table column the expression derives from — used only to
 * detect the dialect (its `columnType` is prefixed `Pg` / `MySql` / `SQLite`), so `expr`
 * may be the column itself, a subquery field, or a correlated subquery.
 */
export const orderExpressions = (
  expr: Column | SQL | SQL.Aliased | any,
  direction: 'asc' | 'desc',
  nulls: OrderNullsOption | undefined,
  dialectColumn: Column,
): SQL[] => {
  const directed = direction === 'asc' ? asc(expr) : desc(expr);

  if (!nulls) {
    return [directed];
  }

  const isMySql = (((dialectColumn as any).columnType as string) ?? '').startsWith('MySql');
  if (isMySql) {
    const nullsKey = nulls === 'first' ? desc(sql`(${expr} is null)`) : asc(sql`(${expr} is null)`);
    return [nullsKey, directed];
  }

  return [nulls === 'first' ? sql`${directed} nulls first` : sql`${directed} nulls last`];
};

/**
 * One ordering term, flattened out of a (possibly relation-nested) `orderBy` argument.
 * `expression` is what the ORDER BY sorts on — the column itself, or a correlated
 * subquery reaching it through one or more to-one relations. `column` is the leaf table
 * column, kept for dialect detection.
 */
interface FlatOrderEntry {
  expression: Column | SQL;
  column: Column;
  direction: 'asc' | 'desc';
  nulls: OrderNullsOption | undefined;
  priority: number;
}

/**
 * The chain of aliased to-one hops a relation-ordered column is reached through. Rendered
 * as a single correlated scalar subquery: every hop's target sits in the FROM list and
 * its join condition (plus the relation's own `where`, when it declares one) in the WHERE.
 */
interface RelationOrderChain {
  fromParts: SQL[];
  conditions: SQL[];
  /** The aliased target of the last hop — the table the next hop or leaf column resolves from. */
  table: Table;
}

/** Extends the chain (or starts one from `parentTable`) with one to-one hop. */
const extendRelationOrderChain = (
  parentTable: Table,
  relationName: string,
  relEntry: TableNamedRelations,
  ctx: RelationFilterContext,
  chain: RelationOrderChain | undefined,
): RelationOrderChain => {
  const targetTable = ctx.tables[relEntry.targetTableName];
  const relation = ((relEntry as any).relation ?? relEntry) as Relation<string>;

  if (!targetTable || !is(relation, One) || !isFilterableRelation(relation)) {
    throw new GraphQLError(`ORDER BY ${relationName}: Relation cannot be used for ordering`);
  }

  ctx.aliases ??= { n: 0 };
  const aliasedTarget = aliasedTable(targetTable, `dgql_ord_${ctx.aliases.n++}`);

  const joinCondition = buildRelationJoinCondition(parentTable, relation, aliasedTarget, relationName);
  // A relation declared with its own `where` only ever exposes the rows it selects, so the
  // ordering subquery has to honour it too — mirroring the relation-filter subqueries.
  const relationWhere = (relation as any).where
    ? relationsFilterToSQL((relation as any).isReversed ? parentTable : aliasedTarget, (relation as any).where)
    : undefined;

  return {
    fromParts: [...(chain?.fromParts ?? []), getTableAsAliasSQL(aliasedTarget)],
    conditions: [
      ...(chain?.conditions ?? []),
      ...(joinCondition ? [joinCondition] : []),
      ...(relationWhere ? [relationWhere] : []),
    ],
    table: aliasedTarget,
  };
};

/**
 * The sort key behind `matchFilterOrder`: the column's position in the `inArray` list that
 * the same request's `where` gives it, as a `CASE` ladder over that list.
 *
 * A ladder rather than a dialect array function (`array_position` on Postgres, `FIELD()` on
 * MySQL, neither on SQLite) because it is the one form all three share, and because every
 * list value stays a bound parameter. The branch indices are library-generated integers, so
 * they are written into the SQL text — a bound parameter there would leave Postgres unable
 * to infer the CASE result type. Values outside the list sort after every listed one.
 */
const filterOrderExpression = (column: Column, columnName: string, whereArgs: Record<string, any> | undefined): SQL => {
  const values = whereArgs?.[columnName]?.inArray as unknown;
  if (!Array.isArray(values)) {
    throw new GraphQLError(
      `ORDER BY ${columnName}: 'matchFilterOrder' needs an 'inArray' filter on the same column in this query's 'where'`,
    );
  }
  if (!values.length) {
    // An empty `inArray` matches no rows at all, so every row would sort the same anyway;
    // a constant keeps the expression valid without a ladder that has no branches.
    return sql`0`;
  }

  const branches = values.map(
    (value, index) =>
      sql`when ${column} = ${remapFromGraphQLCore(value, column, columnName)} then ${sql.raw(String(index))}`,
  );
  return sql`case ${sql.join(branches, sql` `)} else ${sql.raw(String(values.length))} end`;
};

/**
 * Flattens one level of an `orderBy` argument into `out`. A column key becomes an entry
 * directly (wrapped in a correlated subquery when reached through a relation chain); a
 * to-one relation key recurses with the chain extended by that hop. Priorities live in one
 * global space, so a relation's column can interleave with the parent's own columns.
 */
const collectOrderEntries = (
  table: Table,
  tableKey: string,
  orderArgs: Record<string, any>,
  ctx: RelationFilterContext | undefined,
  chain: RelationOrderChain | undefined,
  out: FlatOrderEntry[],
  whereArgs: Record<string, any> | undefined,
): void => {
  const columns = getColumns(table);
  const relations = ctx?.relationMap[tableKey];

  for (const [key, config] of Object.entries(orderArgs)) {
    if (config === null || config === undefined) {
      continue;
    }

    const column = columns[key];
    if (column) {
      if (config.matchFilterOrder && chain) {
        throw new GraphQLError(`ORDER BY ${key}: 'matchFilterOrder' is not supported through a relation`);
      }
      out.push({
        expression: config.matchFilterOrder
          ? filterOrderExpression(column, key, whereArgs)
          : chain
            ? sql`(select ${column} from ${sql.join(chain.fromParts, sql`, `)} where ${and(...chain.conditions)})`
            : column,
        column,
        direction: config.direction,
        nulls: config.nulls ?? undefined,
        priority: config.priority ?? 0,
      });
      continue;
    }

    const relEntry = relations?.[key];
    if (!relEntry || !ctx) {
      throw new GraphQLError(`ORDER BY ${key}: Unknown column or relation`);
    }

    const nextChain = extendRelationOrderChain(chain?.table ?? table, key, relEntry, ctx, chain);
    collectOrderEntries(nextChain.table, relEntry.targetTableName, config, ctx, nextChain, out, undefined);
  }
};

/**
 * Compiles an `orderBy` argument into ORDER BY expressions, highest priority first.
 *
 * A key naming one of the table's columns orders by that column. A key naming a to-one
 * relation takes the target table's own OrderBy input and orders by the related row's
 * column(s), compiled as a correlated scalar subquery — reusing the aliased-join machinery
 * the relation filters are built on — so it works identically on all three dialects and
 * inside the relational query builder's aliased CTEs. Priorities share one global space
 * across relation boundaries. Each entry may also carry `nulls: first | last`
 * (see {@link orderExpressions} for how MySQL emulates it).
 *
 * An entry may instead set `matchFilterOrder`, which sorts by the column's position in the
 * `inArray` list the same request's `where` gives it — `whereArgs` is that `where`.
 *
 * `ctx` supplies the tables and relation map that relation ordering needs; callers whose
 * inputs cannot contain relation keys may omit it.
 */
export const extractOrderBy = <TTable extends Table, TArgs extends OrderByArgs<any> = OrderByArgs<TTable>>(
  table: TTable,
  orderArgs: TArgs,
  ctx?: RelationFilterContext,
  whereArgs?: Record<string, any>,
): SQL[] => {
  const entries: FlatOrderEntry[] = [];
  collectOrderEntries(table, ctx?.tableKey ?? '', orderArgs, ctx, undefined, entries, whereArgs);

  return entries
    .sort((a, b) => b.priority - a.priority)
    .flatMap((entry) => orderExpressions(entry.expression, entry.direction, entry.nulls, entry.column));
};

/**
 * Escape character pinned via `ESCAPE` on every generated safe-LIKE predicate. Bound as a
 * query parameter (never spliced into the SQL text), so no dialect-specific string-literal
 * escaping rules apply to it.
 */
const LIKE_ESCAPE_CHAR = '\\';

/**
 * Escapes the LIKE wildcards (`%`, `_`) and the escape character itself (`\`) in a literal
 * search term, so the term only ever matches literally inside a LIKE pattern.
 */
const escapeLikeValue = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * The injection-safe string operators: the caller passes a literal search term, the library
 * builds the LIKE pattern with the term's `%` / `_` / `\` escaped and the `ESCAPE` clause pinned.
 * The `i`-prefixed variants match case-insensitively.
 */
const safeLikeOps: Record<string, { buildPattern: (value: string) => string; insensitive: boolean }> = {
  startsWith: { buildPattern: (value) => `${escapeLikeValue(value)}%`, insensitive: false },
  endsWith: { buildPattern: (value) => `%${escapeLikeValue(value)}`, insensitive: false },
  contains: { buildPattern: (value) => `%${escapeLikeValue(value)}%`, insensitive: false },
  iStartsWith: { buildPattern: (value) => `${escapeLikeValue(value)}%`, insensitive: true },
  iEndsWith: { buildPattern: (value) => `%${escapeLikeValue(value)}`, insensitive: true },
  iContains: { buildPattern: (value) => `%${escapeLikeValue(value)}%`, insensitive: true },
};

/**
 * `LIKE <pattern> ESCAPE '\'` for a safe string operator. Case-insensitive variants use
 * Postgres's native `ILIKE`; MySQL and SQLite have no `ILIKE`, so they compare `lower()`
 * on both sides instead (mirroring how the raw `ilike` operator is Postgres-only).
 */
const safeLikeCondition = (column: Column, pattern: string, insensitive: boolean): SQL => {
  if (!insensitive) {
    return sql`${column} like ${pattern} escape ${LIKE_ESCAPE_CHAR}`;
  }

  const isPg = (((column as any).columnType ?? '') as string).startsWith('Pg');
  return isPg
    ? sql`${column} ilike ${pattern} escape ${LIKE_ESCAPE_CHAR}`
    : sql`lower(${column}) like ${pattern.toLowerCase()} escape ${LIKE_ESCAPE_CHAR}`;
};

/**
 * Whether the column stores JSON — its `contains` operator is structural containment,
 * not the safe substring operator string columns get.
 */
const isJsonColumn = (column: Column): boolean => (((column as any).columnType ?? '') as string).includes('Json');

/**
 * Structural JSON containment for the `contains` operator on json/jsonb columns.
 * The value is serialized and bound as a parameter (never interpolated into the SQL text):
 * - Postgres: `col @> $1::jsonb` (a plain `json` column is cast through jsonb — `json` has
 *   no containment operator of its own)
 * - MySQL: `JSON_CONTAINS(col, ?)`
 * SQLite has no containment operator, so the filter input never exposes `contains` there;
 * reaching this with an unsupported dialect is a programming error surfaced as a GraphQLError.
 */
const jsonContains = (column: Column, columnName: string, value: any): SQL => {
  const serialized = JSON.stringify(value);

  switch (columnDialect(column)) {
    case 'pg':
      return (column as any).columnType === 'PgJson'
        ? sql`${column}::jsonb @> ${serialized}::jsonb`
        : sql`${column} @> ${serialized}::jsonb`;
    case 'mysql':
      return sql`json_contains(${column}, ${serialized})`;
    default:
      throw new GraphQLError(`WHERE ${columnName}: Operator 'contains' is not supported for this dialect!`);
  }
};

/**
 * Constant predicates, used where an operator's operand list is empty and the answer is
 * therefore known without touching the column. Written as `1 = 0` / `1 = 1` rather than the
 * `FALSE` / `TRUE` keywords so they compile identically on all three dialects. Built fresh
 * per call because a `SQL` object is spliced into whatever query consumes it.
 */
const sqlFalse = (): SQL => sql`1 = 0`;
const sqlTrue = (): SQL => sql`1 = 1`;

/**
 * A MySQL / SQLite JSON path expression for the given key walk. Bound as a query parameter,
 * never spliced into the SQL text; an all-digits key becomes an array index, and quotes and
 * backslashes inside a key are escaped so a key can never end the path segment early.
 */
const jsonPathString = (path: string[]): string =>
  `$${path.map((part) => (/^\d+$/.test(part) ? `[${part}]` : `."${part.replace(/(["\\])/g, '\\$1')}"`)).join('')}`;

/**
 * Matches the text forms a database will accept as a number. Used to guard both numeric casts —
 * Postgres has no TRY_CAST and errors outright on a bad `::numeric`, while MySQL quietly casts
 * a non-numeric string to 0; neither is what a non-matching row should do.
 */
const NUMERIC_TEXT_PATTERN = '^\\s*-?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?\\s*$';

/**
 * The value at a JSON path, as the expressions a comparison can be built on: read as text,
 * read as a number, and read as the dialect spells a boolean. Each dialect extracts
 * differently, and each needs its own guard so a value of the wrong shape answers "no match"
 * rather than erroring or comparing by some unrelated rule:
 *
 * - **Postgres** — `#>>` with a bound `text[]` path, which works on `json` and `jsonb` alike.
 *   `::numeric` on a non-numeric string is a hard error, so the numeric read is guarded by a
 *   pattern test.
 * - **MySQL** — `JSON_UNQUOTE(JSON_EXTRACT(col, ?))`, so a JSON string arrives without its
 *   quotes. Unquoting a JSON *null* would otherwise yield the string `'null'`, so it is mapped
 *   back to SQL NULL first. `CAST` quietly turns a non-numeric string into 0, hence the same
 *   pattern guard.
 * - **SQLite** — `json_extract` returns the value in SQLite's own type, so the reads cast
 *   explicitly: without that, SQLite's cross-type ordering puts every string above every
 *   number and `'admin' > 0` would be true.
 */
const jsonPathExprs = (
  column: Column,
  path: string[],
): { text: SQL; number: SQL; boolean: SQL; encodeBoolean: (value: boolean) => string | number } => {
  switch (columnDialect(column)) {
    case 'pg': {
      const pathArray = sql`array[${sql.join(
        path.map((part) => sql`${part}`),
        sql`, `,
      )}]::text[]`;
      const text = sql`(${column} #>> ${pathArray})`;
      return {
        text,
        number: sql`(case when ${text} ~ ${NUMERIC_TEXT_PATTERN} then ${text}::numeric end)`,
        boolean: text,
        encodeBoolean: (value) => String(value),
      };
    }
    case 'mysql': {
      const extracted = sql`json_extract(${column}, ${jsonPathString(path)})`;
      const text = sql`(case when json_type(${extracted}) = 'NULL' then null else json_unquote(${extracted}) end)`;
      return {
        text,
        number: sql`(case when ${text} regexp ${NUMERIC_TEXT_PATTERN} then cast(${text} as decimal(65, 30)) end)`,
        boolean: text,
        encodeBoolean: (value) => String(value),
      };
    }
    default: {
      const extracted = sql`json_extract(${column}, ${jsonPathString(path)})`;
      return {
        text: sql`cast(${extracted} as text)`,
        number: sql`(case when typeof(${extracted}) in ('integer', 'real') then ${extracted} end)`,
        // SQLite has no boolean type: a JSON `true` comes back as the integer 1.
        boolean: extracted,
        encodeBoolean: (value) => (value ? 1 : 0),
      };
    }
  }
};

/** Comparison operators available inside a JSON path filter, as their SQL spelling. */
const JSON_PATH_COMPARISONS: Record<string, string> = {
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/**
 * How the value at a path is read when the filter does not say: a GraphQL number compares
 * numerically, a boolean as a boolean, everything else as text.
 */
const inferJsonPathCast = (value: unknown): 'text' | 'number' | 'boolean' =>
  typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';

/**
 * Compiles one entry of a column's `path` filter: `as` (or the operand's own type) picks
 * which of {@link jsonPathExprs}' reads the comparison is built on, and the operand is bound
 * in the shape that read expects.
 */
const jsonPathCondition = (column: Column, columnName: string, filter: Record<string, any>): SQL | undefined => {
  const { path, as: castOverride, ...operators } = filter;
  const locator = `${columnName}.path`;

  if (!Array.isArray(path) || !path.length) {
    throw new GraphQLError(`WHERE ${locator}: 'path' must name at least one key`);
  }

  const exprs = jsonPathExprs(column, path);
  const variants: SQL[] = [];

  for (const [operatorName, operatorValue] of Object.entries(operators)) {
    if (operatorValue === null || operatorValue === undefined) {
      continue;
    }

    if (operatorName === 'isNull' || operatorName === 'isNotNull') {
      if (operatorValue === false) {
        continue;
      }
      variants.push(operatorName === 'isNull' ? sql`${exprs.text} is null` : sql`${exprs.text} is not null`);
      continue;
    }

    if (operatorName in safeLikeOps) {
      const { buildPattern, insensitive } = safeLikeOps[operatorName]!;
      if (typeof operatorValue !== 'string') {
        throw new GraphQLError(`WHERE ${locator}: operator '${operatorName}' takes a string`);
      }
      // The extracted value is an expression, not a column, so the case-insensitive form
      // always goes through `lower()` rather than Postgres's ILIKE.
      variants.push(safeLikeCondition(exprs.text as any, buildPattern(operatorValue), insensitive));
      continue;
    }

    const comparison = JSON_PATH_COMPARISONS[operatorName];
    if (!comparison) {
      throw new GraphQLError(`WHERE ${locator}: Unknown operator: ${operatorName}`);
    }

    const cast = castOverride ?? inferJsonPathCast(operatorValue);
    if (cast === 'number') {
      const numeric = Number(operatorValue);
      if (Number.isNaN(numeric)) {
        throw new GraphQLError(
          `WHERE ${locator}: operator '${operatorName}' compares as a number, so its value must be one`,
        );
      }
      variants.push(sql`${exprs.number} ${sql.raw(comparison)} ${numeric}`);
    } else if (cast === 'boolean') {
      const truthy = operatorValue === true || operatorValue === 'true';
      variants.push(sql`${exprs.boolean} ${sql.raw(comparison)} ${exprs.encodeBoolean(truthy)}`);
    } else {
      variants.push(sql`${exprs.text} ${sql.raw(comparison)} ${String(operatorValue)}`);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};

export const extractFiltersColumn = <TColumn extends Column>(
  column: TColumn,
  columnName: string,
  operators: FilterColumnOperators<TColumn>,
): SQL | undefined => {
  // Boolean branches compose with sibling operators: siblings and the AND list are ANDed
  // together, NOT negates its whole branch, and the OR group is ANDed with the rest.
  const { OR, AND, NOT, ...restOperators } = operators;

  const entries = Object.entries(restOperators as FilterColumnOperatorsCore<TColumn>);

  const singleValueOps: Record<string, (...args: any[]) => SQL> = { eq, ne, gt, gte, lt, lte };
  const stringValueOps: Record<string, (...args: any[]) => SQL> = { like, notLike, ilike, notIlike };
  const arrayValueOps: Record<string, (...args: any[]) => SQL> = { inArray, notInArray };
  // Membership operators for array columns: element list → SQL. Empty lists are rejected below.
  const arrayMembershipOps: Record<string, (...args: any[]) => SQL> = {
    hasSome: arrayOverlaps,
    hasEvery: arrayContains,
  };
  const nullableOps: Record<string, (...args: any[]) => SQL> = { isNull, isNotNull };

  const variants = [] as SQL[];
  for (const [operatorName, operatorValue] of entries) {
    if (operatorValue === null || operatorValue === false) {
      continue;
    }

    if (operatorName in singleValueOps) {
      const singleValue = remapFromGraphQLCore(operatorValue, column, columnName);
      variants.push(singleValueOps[operatorName]!(column, singleValue));
    } else if (operatorName in stringValueOps) {
      variants.push(stringValueOps[operatorName]!(column, operatorValue as string));
    } else if (operatorName === 'path' && isJsonColumn(column)) {
      // Several path predicates on one column are ANDed, matching how sibling operators
      // already combine. GraphQL coerces a lone object into a one-element list.
      for (const pathFilter of operatorValue as Record<string, any>[]) {
        const extracted = jsonPathCondition(column, columnName, pathFilter);
        if (extracted) {
          variants.push(extracted);
        }
      }
    } else if (operatorName === 'contains' && isJsonColumn(column)) {
      // `contains` is JSON containment on json/jsonb columns; on string columns it is the
      // safe substring operator handled by safeLikeOps below.
      variants.push(jsonContains(column, columnName, operatorValue));
    } else if (operatorName in safeLikeOps) {
      const { buildPattern, insensitive } = safeLikeOps[operatorName]!;
      variants.push(safeLikeCondition(column, buildPattern(operatorValue as string), insensitive));
    } else if (operatorName in arrayValueOps) {
      // An empty candidate list is a well-formed question with a known answer — nothing is
      // `IN ()`, everything is `NOT IN ()` — so it resolves to a constant predicate rather
      // than an error. SQL has no empty-list literal, hence the constant rather than `IN ()`.
      if (!(operatorValue as any[]).length) {
        variants.push(operatorName === 'inArray' ? sqlFalse() : sqlTrue());
        continue;
      }
      const arrayValue = (operatorValue as any[]).map((val) => remapFromGraphQLCore(val, column, columnName));
      variants.push(arrayValueOps[operatorName]!(column, arrayValue));
    } else if (operatorName === 'has') {
      // Single-element membership: containment with a one-element array (`col @> ARRAY[value]`).
      variants.push(arrayContains(column, [operatorValue]));
    } else if (operatorName in arrayMembershipOps) {
      // Same reasoning as inArray/notInArray: overlapping with no elements is never true,
      // and every array contains all zero of them.
      if (!(operatorValue as any[]).length) {
        variants.push(operatorName === 'hasSome' ? sqlFalse() : sqlTrue());
        continue;
      }
      variants.push(arrayMembershipOps[operatorName]!(column, operatorValue as any[]));
    } else if (operatorName === 'isEmpty') {
      variants.push(sql`cardinality(${column}) = 0`);
    } else if (operatorName in nullableOps) {
      variants.push(nullableOps[operatorName]!(column));
    } else {
      // An unrecognized operator must throw rather than be dropped: when the generated
      // schema is stitched/merged with another schema, foreign operators (e.g. `equals`,
      // `contains`, `mode`) can pass input validation, and silently dropping them could
      // turn a constrained where into an unbounded one.
      throw new GraphQLError(`WHERE ${columnName}: Unknown operator: ${operatorName}`);
    }
  }

  if (AND?.length) {
    for (const variant of AND) {
      const extracted = extractFiltersColumn(column, columnName, variant);
      if (extracted) {
        variants.push(extracted);
      }
    }
  }

  if (NOT) {
    const extracted = extractFiltersColumn(column, columnName, NOT);
    if (extracted) {
      variants.push(not(extracted));
    }
  }

  if (OR?.length) {
    const orVariants = [] as SQL[];
    for (const variant of OR) {
      const extracted = extractFiltersColumn(column, columnName, variant);
      if (extracted) {
        orVariants.push(extracted);
      }
    }

    if (orVariants.length) {
      variants.push(orVariants.length > 1 ? or(...orVariants)! : orVariants[0]!);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};

/**
 * Everything `extractFilters` needs to turn a relation key in a `where` argument into a
 * correlated subquery. Omitted by callers that don't generate relation filters, in which case
 * relation keys can't appear in the input to begin with.
 */
export interface RelationFilterContext {
  /** Every table in the schema, keyed by its schema key. */
  tables: Record<string, Table>;
  /** Relations keyed by table schema key, then relation name. */
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  /**
   * Schema key of the table being filtered. Not always the same as the `tableName` label
   * used in error messages (relation `where` callbacks pass the relation name there).
   */
  tableKey: string;
  /** Shared counter making every subquery alias unique within one extraction. */
  aliases?: { n: number };
}

/**
 * The build-scoped half of {@link RelationFilterContext}. Created once per generated schema and
 * handed to every resolver, which adds the table it is filtering.
 */
export type RelationFilterBase = Pick<RelationFilterContext, 'tables' | 'relationMap'>;

/** Narrows the build-scoped relation filter context to the table a resolver is filtering. */
export const relationFilterCtx = (
  base: RelationFilterBase | undefined,
  tableKey: string,
): RelationFilterContext | undefined => (base ? { ...base, tableKey } : undefined);

/** The three ways a to-many relation can be required to match, plus the to-one shorthand. */
type RelationMatchMode = 'some' | 'none' | 'every';

/**
 * Correlates the parent row with the aliased target table using the relation's own join
 * columns. Columns are matched by SQL name rather than object identity so this also works when
 * the parent is an aliased proxy (as it is inside a relational `with:` where callback).
 */
const buildRelationJoinCondition = (
  parentTable: Table,
  relation: Relation<string>,
  aliasedTarget: Table,
  relationName: string,
): SQL | undefined => {
  const sourceColumns = (relation as any).sourceColumns as Column[] | undefined;
  const targetColumns = (relation as any).targetColumns as Column[] | undefined;

  if (!sourceColumns?.length || sourceColumns.length !== targetColumns?.length) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  const parentColumns = Object.values(getColumns(parentTable));
  const targetColumnsByName = Object.values(getColumns(aliasedTarget));

  const conditions: SQL[] = [];
  for (let i = 0; i < sourceColumns.length; i++) {
    const localColumn = parentColumns.find((c) => c.name === sourceColumns[i]!.name);
    const foreignColumn = targetColumnsByName.find((c) => c.name === targetColumns[i]!.name);

    if (!localColumn || !foreignColumn) {
      throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
    }

    conditions.push(eq(localColumn, foreignColumn));
  }

  return conditions.length > 1 ? and(...conditions) : conditions[0];
};

/**
 * Resolves one side of a `.through()` junction pair to the corresponding column on the
 * aliased junction table. Drizzle stores the junction column as a RelationsBuilderColumn
 * (`_.column` is the Column, `_.key` its property name), so look up by property name first
 * and fall back to matching by SQL name.
 */
const resolveJunctionColumn = (aliasedThrough: Table, junctionRef: any, relationName: string): Column => {
  const throughColumns = getColumns(aliasedThrough);

  const key: string | undefined = junctionRef?._?.key;
  const byKey = key ? throughColumns[key] : undefined;
  if (byKey) {
    return byKey;
  }

  const columnName: string | undefined = junctionRef?._?.column?.name;
  const byName = columnName ? Object.values(throughColumns).find((c) => c.name === columnName) : undefined;
  if (!byName) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  return byName;
};

/**
 * Join conditions for a `.through()` (many-to-many) relation, split into the two legs of the
 * junction: `correlation` ties the parent row to the aliased junction table on the relation's
 * source keys, `junctionJoin` ties the aliased junction table to the aliased target on the
 * target keys. Column matching mirrors {@link buildRelationJoinCondition} — by SQL name on the
 * parent/target so aliased proxies work — while junction columns come from the relation's own
 * `through` metadata.
 */
const buildThroughJoinConditions = (
  parentTable: Table,
  relation: Relation<string>,
  aliasedThrough: Table,
  aliasedTarget: Table,
  relationName: string,
): { correlation: SQL | undefined; junctionJoin: SQL | undefined } => {
  const sourceColumns = (relation as any).sourceColumns as Column[] | undefined;
  const targetColumns = (relation as any).targetColumns as Column[] | undefined;
  const through = (relation as any).through as { source: any[]; target: any[] } | undefined;

  if (
    !sourceColumns?.length ||
    !targetColumns?.length ||
    through?.source.length !== sourceColumns.length ||
    through.target.length !== targetColumns.length
  ) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  const parentColumns = Object.values(getColumns(parentTable));
  const targetTableColumns = Object.values(getColumns(aliasedTarget));

  const correlationConditions: SQL[] = [];
  for (let i = 0; i < sourceColumns.length; i++) {
    const localColumn = parentColumns.find((c) => c.name === sourceColumns[i]!.name);
    if (!localColumn) {
      throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
    }
    correlationConditions.push(eq(localColumn, resolveJunctionColumn(aliasedThrough, through.source[i], relationName)));
  }

  const junctionJoinConditions: SQL[] = [];
  for (let i = 0; i < targetColumns.length; i++) {
    const foreignColumn = targetTableColumns.find((c) => c.name === targetColumns[i]!.name);
    if (!foreignColumn) {
      throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
    }
    junctionJoinConditions.push(
      eq(resolveJunctionColumn(aliasedThrough, through.target[i], relationName), foreignColumn),
    );
  }

  return {
    correlation: correlationConditions.length > 1 ? and(...correlationConditions) : correlationConditions[0],
    junctionJoin: junctionJoinConditions.length > 1 ? and(...junctionJoinConditions) : junctionJoinConditions[0],
  };
};

/**
 * Builds one `[NOT] EXISTS (SELECT 1 FROM target alias WHERE …)` for a relation filter.
 * A `.through()` (many-to-many) relation adds an `INNER JOIN` on the aliased junction table
 * inside the subquery, correlated to the parent on the relation's source keys.
 *
 * `some` / the to-one shorthand match when a related row satisfies the inner filters, `none`
 * when none does, and `every` is expressed as "no related row fails the inner filters".
 * Because `every` negates the inner condition, a related row whose compared column is NULL
 * counts as matching (SQL three-valued logic) — the same caveat Prisma carries.
 */
const buildRelationExists = (
  parentTable: Table,
  relationName: string,
  relEntry: TableNamedRelations,
  innerFilters: Filters<Table> | undefined,
  mode: RelationMatchMode,
  ctx: RelationFilterContext,
): SQL | undefined => {
  const { targetTableName } = relEntry;
  const targetTable = ctx.tables[targetTableName];
  const relation = ((relEntry as any).relation ?? relEntry) as Relation<string>;

  if (!targetTable) {
    throw new GraphQLError(`WHERE ${relationName}: Relation cannot be used as a filter`);
  }

  ctx.aliases ??= { n: 0 };
  const aliases = ctx.aliases;
  const aliasedTarget = aliasedTable(targetTable, `dgql_rel_${aliases.n++}`);

  // A `.through()` relation reaches the target via a junction table: the subquery joins the
  // aliased junction to the aliased target and correlates the junction to the parent, so
  // `some` / `none` / `every` compile exactly like the direct case with a longer FROM clause.
  const throughTable = (relation as any).throughTable as Table | undefined;
  let fromClause: SQL;
  let joinCondition: SQL | undefined;
  if (throughTable) {
    const aliasedThrough = aliasedTable(throughTable, `dgql_rel_${aliases.n++}`);
    const { correlation, junctionJoin } = buildThroughJoinConditions(
      parentTable,
      relation,
      aliasedThrough,
      aliasedTarget,
      relationName,
    );
    fromClause = sql`${getTableAsAliasSQL(aliasedTarget)} inner join ${getTableAsAliasSQL(aliasedThrough)} on ${junctionJoin}`;
    joinCondition = correlation;
  } else {
    fromClause = getTableAsAliasSQL(aliasedTarget);
    joinCondition = buildRelationJoinCondition(parentTable, relation, aliasedTarget, relationName);
  }

  // A relation declared with its own `where` only ever exposes the rows it selects, so the
  // subquery has to honour it too — otherwise a filter could match a row the relation hides.
  const relationWhere = (relation as any).where
    ? relationsFilterToSQL((relation as any).isReversed ? parentTable : aliasedTarget, (relation as any).where)
    : undefined;

  const inner = innerFilters
    ? extractFilters(aliasedTarget, targetTableName, innerFilters, { ...ctx, tableKey: targetTableName, aliases })
    : undefined;

  if (mode === 'every') {
    // "every related row matches" with no inner condition is vacuously true.
    if (!inner) {
      return undefined;
    }

    return sql`not exists (select 1 from ${fromClause} where ${and(joinCondition, relationWhere, not(inner))})`;
  }

  const condition = and(joinCondition, relationWhere, inner);

  return mode === 'none'
    ? sql`not exists (select 1 from ${fromClause} where ${condition})`
    : sql`exists (select 1 from ${fromClause} where ${condition})`;
};

/**
 * Handles one relation key in a `where` argument. To-one relations take the target's filters
 * inline; to-many relations take any combination of `some` / `none` / `every`, ANDed together.
 */
const extractRelationFilter = (
  parentTable: Table,
  relationName: string,
  relEntry: TableNamedRelations,
  value: Record<string, any>,
  ctx: RelationFilterContext,
): SQL | undefined => {
  const relation = ((relEntry as any).relation ?? relEntry) as Relation<string>;

  if (is(relation, One)) {
    return buildRelationExists(parentTable, relationName, relEntry, value, 'some', ctx);
  }

  const relationMatchModes: readonly RelationMatchMode[] = ['some', 'none', 'every'];

  const variants: SQL[] = [];
  for (const [mode, inner] of Object.entries(value)) {
    if (inner === undefined || inner === null) {
      continue;
    }

    // Unknown keys inside the some/none/every wrapper must throw rather than be dropped —
    // a stitched schema can contribute foreign keys here too, and dropping them all would
    // silently turn the relation filter into no filter at all.
    if (!relationMatchModes.includes(mode as RelationMatchMode)) {
      throw new GraphQLError(`WHERE ${relationName}: Unknown relation filter key: ${mode}`);
    }

    const extracted = buildRelationExists(parentTable, relationName, relEntry, inner, mode as RelationMatchMode, ctx);
    if (extracted) {
      variants.push(extracted);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};

export const extractFilters = <TTable extends Table>(
  table: TTable,
  tableName: string,
  filters: Filters<TTable>,
  relationCtx?: RelationFilterContext,
): SQL | undefined => {
  // Boolean branches compose with sibling fields: siblings and the AND list are ANDed
  // together, NOT negates its whole branch, and the OR group is ANDed with the rest —
  // `{ a: …, OR: [{ b: … }, { c: … }] }` reads as `a AND (b OR c)`. Every branch is the
  // filter type itself, so the tree nests arbitrarily.
  const { OR, AND, NOT, ...fieldFilters } = filters;

  const entries = Object.entries(fieldFilters as FiltersCore<TTable>);

  const columns = getColumns(table);
  const relations = relationCtx?.relationMap[relationCtx.tableKey];

  const variants = [] as SQL[];
  for (const [fieldName, operators] of entries) {
    if (operators === null || operators === undefined) {
      continue;
    }

    const column = columns[fieldName];

    // A key that is neither a column nor a filterable relation must throw rather than be
    // dropped: when the generated schema is stitched/merged with another schema, same-named
    // inputs can contribute foreign keys that pass input validation, and a where that loses
    // all of its keys silently becomes an unbounded select/update/delete.
    if (!column && !(relations?.[fieldName] && relationCtx)) {
      throw new GraphQLError(`WHERE ${tableName}: Unknown filter key: ${fieldName}`);
    }

    const extracted = column
      ? extractFiltersColumn(column, fieldName, operators)
      : extractRelationFilter(table, fieldName, relations![fieldName]!, operators as any, relationCtx!);

    if (extracted) {
      variants.push(extracted);
    }
  }

  if (AND?.length) {
    for (const variant of AND) {
      const extracted = extractFilters(table, tableName, variant, relationCtx);
      if (extracted) {
        variants.push(extracted);
      }
    }
  }

  if (NOT) {
    const extracted = extractFilters(table, tableName, NOT, relationCtx);
    if (extracted) {
      variants.push(not(extracted));
    }
  }

  if (OR?.length) {
    const orVariants = [] as SQL[];
    for (const variant of OR) {
      const extracted = extractFilters(table, tableName, variant, relationCtx);
      if (extracted) {
        orVariants.push(extracted);
      }
    }

    if (orVariants.length) {
      variants.push(orVariants.length > 1 ? or(...orVariants)! : orVariants[0]!);
    }
  }

  return variants.length ? (variants.length > 1 ? and(...variants) : variants[0]) : undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// Row-level scoping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A table's row-level scope: the predicate every generated read, update and delete on that
 * table is narrowed by. See `BuildSchemaConfig.scope`.
 *
 * `table` is the table the predicate must be built against. On the relational-query path
 * drizzle hands its callbacks an *aliased* proxy (`d0`, `d1`, …), so a predicate built from
 * the imported schema table would reference a name that isn't in the query — always build
 * from the argument. Returning a filter object instead (the same shape as the field's
 * `where`) sidesteps aliasing entirely, and is the only form that can reach through a
 * relation — which is what ownership through a join table needs.
 */
export type ScopeHook<TContext = any> = (context: TContext, table: any) => SQL | Record<string, any> | undefined | null;

/** Build-time lookup: the scope configured for a table, if any. */
export type ScopeFor = (tableName: string) => ScopeHook | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Soft delete
// ─────────────────────────────────────────────────────────────────────────────

/** What a read over a soft-deleting table does with rows that are marked deleted. */
export type DeletedMode = 'EXCLUDE' | 'INCLUDE' | 'ONLY';

/**
 * One table's soft-delete convention, resolved against the real column at build time.
 *
 * `nullable` picks the shape of the predicate. A nullable column marks a row deleted by
 * holding a value at all (`deletedAt IS NOT NULL`), which is the common timestamp form; a
 * non-nullable one marks it by holding `marker` (`isDeleted = true`), so the column has to
 * have a constant that means "deleted" and another that means "not deleted".
 */
export type SoftDeleteInfo = {
  /** Property name of the column on the drizzle table — also the key on an aliased proxy. */
  columnName: string;
  column: Column;
  nullable: boolean;
  /** Evaluated per delete, so a timestamp form stamps the moment of the delete. */
  writeDeleted: () => any;
  /** Written by the restore mutation. */
  writeRestored: any;
  /** Non-nullable form only: the constant that means "this row is deleted". */
  marker?: any;
};

/** Build-time lookup: the soft-delete convention of a table, if it declares one. */
export type SoftDeleteFor = (tableName: string) => SoftDeleteInfo | undefined;

/**
 * The enum behind the `deleted` argument on every read over a soft-deleting table. One
 * instance shared by every build — it carries no per-build state.
 */
export const deletedFilterEnum = new GraphQLEnumType({
  name: 'DeletedFilter',
  description: 'Which rows a read over a soft-deleting table returns.',
  values: {
    EXCLUDE: { value: 'EXCLUDE', description: 'Only rows that are not marked deleted. The default.' },
    INCLUDE: { value: 'INCLUDE', description: 'Marked and unmarked rows alike.' },
    ONLY: { value: 'ONLY', description: 'Only rows that are marked deleted — a trash view.' },
  },
});

/**
 * Resolves one table's `softDelete` declaration against the real column, at build time, so a
 * renamed column fails the build instead of quietly making every row visible again.
 */
export const resolveSoftDeleteInfo = (
  table: Table,
  tableName: string,
  declaration: string | { column: string; deletedValue?: any; restoredValue?: any },
): SoftDeleteInfo => {
  const config = typeof declaration === 'string' ? { column: declaration } : declaration;
  const columnName = config?.column;
  if (typeof columnName !== 'string' || !columnName) {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete.${tableName} must be a column name or an object with a 'column' property.`,
    );
  }
  const column = getColumns(table)[columnName];
  if (!column) {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete names '${tableName}.${columnName}', which is not a column of that table.`,
    );
  }
  const nullable = !column.notNull;
  // drizzle-orm v1 reports compound dataType strings ("object date", "number int32"), so the
  // shape of the column has to come from the extended type rather than a string compare.
  const { type: baseType, constraint } = extractExtendedColumnType(column);
  const hasDeleted = 'deletedValue' in (config as object) && config.deletedValue !== undefined;
  // The default depends on what the column can hold: a timestamp records when, a flag records
  // whether. Both are the shapes the convention actually takes in the wild.
  const writeDeleted: () => any = hasDeleted
    ? typeof config.deletedValue === 'function'
      ? (config.deletedValue as () => any)
      : () => config.deletedValue
    : constraint === 'date' && baseType === 'object'
      ? () => new Date()
      : baseType === 'string'
        ? () => new Date().toISOString()
        : baseType === 'number'
          ? () => Date.now()
          : baseType === 'bigint'
            ? () => BigInt(Date.now())
            : () => true;

  let marker: any;
  if (!nullable) {
    // A non-nullable column has no "absent" state, so the predicate has to compare against a
    // constant — which a function cannot supply, and which the boolean form supplies for free.
    if (hasDeleted && typeof config.deletedValue !== 'function') {
      marker = config.deletedValue;
    } else if (!hasDeleted && baseType === 'boolean') {
      marker = true;
    } else {
      throw new Error(
        `Drizzle-GraphQL Error: config.softDelete.${tableName} marks a NOT NULL column ('${columnName}'), so 'deletedValue' must be a constant that means deleted — not a function, and not omitted for a non-boolean column.`,
      );
    }
  }

  const hasRestored = 'restoredValue' in (config as object);
  const writeRestored = hasRestored
    ? config.restoredValue
    : nullable
      ? null
      : baseType === 'boolean'
        ? false
        : undefined;
  if (!nullable && writeRestored === undefined) {
    throw new Error(
      `Drizzle-GraphQL Error: config.softDelete.${tableName} marks a NOT NULL column ('${columnName}'), so 'restoredValue' must say what restoring writes back.`,
    );
  }

  return { columnName, column, nullable, writeDeleted, writeRestored, marker };
};

/**
 * The predicate that selects the rows a `deleted` mode asks for: nothing for `INCLUDE`, the
 * marked rows for `ONLY`, the unmarked ones for `EXCLUDE`. Built against the table it is
 * handed, which on the relational path is drizzle's aliased proxy rather than the schema
 * table — the same rule a scope hook follows.
 */
export const softDeletePredicate = (info: SoftDeleteInfo, table: Table, mode: DeletedMode): SQL | undefined => {
  if (mode === 'INCLUDE') {
    return undefined;
  }
  const column = ((table as any)?.[info.columnName] ?? info.column) as Column;
  if (info.nullable) {
    return mode === 'ONLY' ? isNotNull(column) : isNull(column);
  }
  return mode === 'ONLY' ? eq(column, info.marker) : ne(column, info.marker);
};

/**
 * The row policies of one request, bound to its context: the table's scope and its
 * soft-delete convention, which both narrow the same `where`. `has` answers "does this table
 * restrict anything at all", cheaply and without evaluating a hook; `on` compiles the
 * predicate against a given table.
 */
export type ScopeResolver = {
  has: (tableName: string, mode?: DeletedMode) => boolean;
  on: (tableName: string, table: Table, mode?: DeletedMode) => SQL | undefined;
};

/**
 * Binds the configured row policies to one request's GraphQL context. Returns `undefined`
 * when neither a scope nor a soft-delete column is configured, so every call site skips the
 * machinery with a single check and an unconfigured build generates exactly the SQL it did
 * before.
 */
export const resolveScope = (
  policies: TablePolicies | undefined,
  context: any,
  filterCtx?: RelationFilterBase,
): ScopeResolver | undefined => {
  const scopes = policies?.scope;
  const softDelete = policies?.softDelete;
  if (!scopes && !softDelete) {
    return undefined;
  }
  return {
    has: (tableName, mode) => !!scopes?.(tableName) || (!!softDelete?.(tableName) && (mode ?? 'EXCLUDE') !== 'INCLUDE'),
    on: (tableName, table, mode) => {
      // Order is fixed: the soft-delete predicate first, the scope after it, both ANDed. They
      // commute, but a fixed order keeps the generated SQL stable between requests.
      const marked = softDelete?.(tableName);
      const deleted = marked ? softDeletePredicate(marked, table, mode ?? 'EXCLUDE') : undefined;
      const hook = scopes?.(tableName);
      if (!hook) {
        return deleted;
      }
      const predicate = hook(context, table);
      if (predicate === undefined || predicate === null) {
        return deleted;
      }
      if (is(predicate, SQL)) {
        return and(deleted, predicate as SQL);
      }
      if (typeof predicate !== 'object') {
        throw new GraphQLError(
          `Drizzle-GraphQL Error: the scope for '${tableName}' returned a ${typeof predicate}. A scope returns a filter object, a Drizzle SQL expression, or undefined.`,
        );
      }
      // A filter object is compiled the same way the field's own `where` is, against the
      // table it was handed — which is what keeps it correct under RQB aliasing.
      return and(deleted, extractFilters(table, tableName, predicate as any, relationFilterCtx(filterCtx, tableName)));
    },
  };
};

/**
 * `condition AND <the row policies of tableName>` — the single way a scope or a soft-delete
 * predicate is ever combined with a caller-supplied filter, so a `where` can only ever narrow
 * them, never widen them. `mode` is the read's `deleted` argument, and defaults to hiding
 * marked rows; a write passes nothing and so never touches one.
 */
export const withScope = (
  scope: ScopeResolver | undefined,
  tableName: string,
  table: Table,
  condition: SQL | undefined,
  mode?: DeletedMode,
): SQL | undefined => {
  const predicate = scope?.on(tableName, table, mode);
  return predicate ? and(condition, predicate) : condition;
};

// ─────────────────────────────────────────────────────────────────────────────
// Context-derived column values
// ─────────────────────────────────────────────────────────────────────────────

/** Produces one column's value from the GraphQL context. See `BuildSchemaConfig.contextValues`. */
export type ContextValueHook<TContext = any> = (context: TContext) => any;

/** Build-time lookup: the context-derived columns of a table, keyed by column property name. */
export type ContextValuesFor = (tableName: string) => Record<string, ContextValueHook> | undefined;

/**
 * The two request-time policies a generated resolver applies, passed to the dialect
 * generators as one value so a table's read scope and its server-owned columns travel
 * together. Both stay `undefined` when nothing is configured, and every call site checks
 * before doing any work — an unconfigured build generates exactly the SQL it did before.
 */
export type TablePolicies = {
  /** See `BuildSchemaConfig.scope`. */
  scope?: ScopeFor;
  /** See `BuildSchemaConfig.contextValues`. */
  contextValues?: ContextValuesFor;
  /** See `BuildSchemaConfig.softDelete`. */
  softDelete?: SoftDeleteFor;
};

/**
 * {@link TablePolicies} with the scope already bound to the build's relation context, which
 * is what a dialect generator is handed: `scope(context)` is all a resolver needs to compile
 * a predicate, and it stays `undefined` when nothing is scoped.
 */
export type ResolverPolicies = {
  scope?: (context: any) => ScopeResolver | undefined;
  contextValues?: ContextValuesFor;
  softDelete?: SoftDeleteFor;
};

/** Binds a build's {@link TablePolicies} to its relation context, once, at schema-build time. */
export const bindPolicies = (
  policies: TablePolicies | undefined,
  filterCtx: RelationFilterBase | undefined,
): ResolverPolicies | undefined =>
  policies?.scope || policies?.contextValues || policies?.softDelete
    ? {
        scope:
          policies.scope || policies.softDelete
            ? (context: any) => resolveScope(policies, context, filterCtx)
            : undefined,
        contextValues: policies.contextValues,
        softDelete: policies.softDelete,
      }
    : undefined;

/**
 * Merges a table's context-derived values into one row's insert values. The hooks run per
 * row — a value may depend on the row's own contents through the closure the caller built —
 * and they overwrite whatever was there: the columns are not in the create input, so nothing
 * legitimate can be lost, but a stitched-in input could still carry the key and the server's
 * value has to win.
 */
export const applyContextValues = (
  values: Record<string, any>,
  hooks: Record<string, ContextValueHook> | undefined,
  context: any,
): Record<string, any> => {
  if (!hooks) {
    return values;
  }
  for (const [columnName, hook] of Object.entries(hooks)) {
    values[columnName] = hook(context);
  }
  return values;
};

/** {@link applyContextValues} over a batch — every row in an insert gets its own evaluation. */
export const applyContextValuesAll = (
  rows: Record<string, any>[],
  hooks: Record<string, ContextValueHook> | undefined,
  context: any,
): Record<string, any>[] => {
  if (!hooks) {
    return rows;
  }
  for (const row of rows) {
    applyContextValues(row, hooks, context);
  }
  return rows;
};

/**
 * Drops context-derived columns from an update's `set`. They are not in the update input
 * either, so this only matters when the key arrives some other way — and reassigning one is
 * exactly the ownership transfer the feature exists to prevent.
 */
export const stripContextValues = (
  values: Record<string, any>,
  hooks: Record<string, ContextValueHook> | undefined,
): Record<string, any> => {
  if (!hooks) {
    return values;
  }
  for (const columnName of Object.keys(hooks)) {
    delete values[columnName];
  }
  return values;
};

const extractRelationsParamsInner = (
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  tables: Record<string, Table>,
  tableName: string,
  typeName: string,
  originField: ResolveTree,
  typeNameMapper?: TypeNameMapper,
  _isInitial: boolean = false,
  filterCtx?: RelationFilterBase,
  limits?: LimitPolicyFor,
  scope?: ScopeResolver,
) => {
  const relationsForTable = relationMap[tableName];
  if (!relationsForTable) {
    return undefined;
  }

  const baseField = Object.entries(originField.fieldsByTypeName).find(([key, _value]) => key === typeName)?.[1];
  if (!baseField) {
    return undefined;
  }

  const args: Record<string, Partial<ProcessedTableSelectArgs>> = {};

  for (const [relName, relEntry] of Object.entries(relationsForTable)) {
    const { targetTableName, targetPkNames } = relEntry;
    // The relation field resolves to the target table's own type, e.g. "Posts" not "UsersPostsRelation".
    const relTypeName = resolveTypeName(targetTableName, typeNameMapper);
    // Look up by field name OR by alias (when the caller uses an alias for the relation).
    // graphql-parse-resolve-info keys fieldsByTypeName entries by alias.
    const field = baseField[relName] ?? Object.values(baseField).find((f) => (f as ResolveTree).name === relName);
    if (!field) {
      continue;
    }

    // The `with:` clause is keyed by relation name, so one relation selected twice under
    // different aliases has no eager representation: the first selection's args and column
    // set would win, and both aliases would then read the same pre-fetched array off the
    // parent — wrong rows for the loser, and missing columns it selected. Drizzle's RQB
    // cannot fetch one relation twice under two keys, so there is no eager fix. Leave the
    // relation out of `with:` and let every alias resolve through the field resolver's
    // batch loader, which keys its loader by the serialized args and so is per-alias
    // correct (and still batched across parents).
    const selectionCount = Object.values(baseField).reduce(
      (n, f) => n + ((f as ResolveTree).name === relName ? 1 : 0),
      0,
    );
    if (selectionCount > 1) {
      continue;
    }
    const relField = (field as ResolveTree)?.fieldsByTypeName;
    const relFieldSelection = relField?.[relTypeName];

    // Guard: if the relation type is not in fieldsByTypeName, this field is
    // either an aliased scalar column (not an actual relation) or the relation
    // was not selected in the query. Skip it in both cases.
    if (!relFieldSelection) {
      continue;
    }

    const columns = extractSelectedColumnsFromTree(relFieldSelection, tables[targetTableName]!, {
      tableName: targetTableName,
      relationMap,
      tables,
      allRelations: filterCtx?.relationMap,
    });

    const thisRecord: Partial<ProcessedTableSelectArgs> = {};
    thisRecord.columns = columns;

    const relationField = Object.values(baseField).find((e) => e.name === relName);
    const relationArgs: Partial<TableSelectArgs> | undefined = relationField?.args;

    const offset = relationArgs?.offset ?? undefined;
    // The eager path reads its arguments off the AST rather than through the relation field's
    // resolver, so the policy has to be applied here too — otherwise an eagerly loaded
    // relation would be the one way around it. A to-one relation takes no `limit` and is a
    // single row by definition, so it is left alone.
    const limit = is(relEntry.relation, One)
      ? (relationArgs?.limit ?? undefined)
      : applyLimitPolicy(relationArgs?.limit, limits?.(targetTableName), `${tableName}.${relName}`);

    // drizzle-orm v1 RQB calls both `where` and `orderBy` callbacks with an
    // aliased table proxy (e.g. d0, d1). Pass the proxy through so column
    // references in the generated SQL match the CTE alias rather than the
    // original unaliased table name.
    const relWhere = relationArgs?.where;
    const relDeleted = (relationArgs as any)?.deleted as DeletedMode | undefined;
    // The eager path is the one read that never passes through the relation field's own
    // resolver, so the target's scope has to be applied here as well — otherwise selecting a
    // relation would be the way around it.
    thisRecord.where =
      relWhere || scope?.has(targetTableName, relDeleted)
        ? {
            RAW: (aliasedTable: Table) =>
              withScope(
                scope,
                targetTableName,
                aliasedTable,
                relWhere
                  ? extractFilters(aliasedTable, relName, relWhere, relationFilterCtx(filterCtx, targetTableName))
                  : undefined,
                relDeleted,
              ),
          }
        : undefined;
    // When a relation is paginated (limit/offset) but unordered, default to the target's
    // primary key so the per-parent slice is deterministic. Drizzle's RQB calls orderBy
    // with the aliased table proxy, so resolve the PK columns from it. targetPkNames is
    // resolved at build time and includes composite keys.
    const hasPagination = offset != null || limit != null;
    const pkNames = targetPkNames ?? [];
    thisRecord.orderBy = relationArgs?.orderBy
      ? (aliasedTable: Table) =>
          extractOrderBy(aliasedTable, relationArgs.orderBy!, relationFilterCtx(filterCtx, targetTableName), relWhere)
      : hasPagination && pkNames.length
        ? (aliasedTable: Table) => primaryKeyOrderExprs(aliasedTable, pkNames)
        : undefined;
    thisRecord.offset = offset;
    thisRecord.limit = limit;

    const relWith = relationField
      ? extractRelationsParamsInner(
          relationMap,
          tables,
          targetTableName,
          relTypeName,
          relationField,
          typeNameMapper,
          false,
          filterCtx,
          limits,
          scope,
        )
      : undefined;
    thisRecord.with = relWith;

    args[relName] = thisRecord;
  }

  return args;
};

export const extractRelationsParams = (
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  tables: Record<string, Table>,
  tableName: string,
  info: ResolveTree | undefined,
  typeName: string,
  typeNameMapper?: TypeNameMapper,
  filterCtx?: RelationFilterBase,
  limits?: LimitPolicyFor,
  scope?: ScopeResolver,
): Record<string, Partial<ProcessedTableSelectArgs>> | undefined => {
  if (!info) {
    return undefined;
  }

  return extractRelationsParamsInner(
    relationMap,
    tables,
    tableName,
    typeName,
    info,
    typeNameMapper,
    true,
    filterCtx,
    limits,
    scope,
  );
};

/**
 * Returns a copy of `relationMap` containing only the relations that should be eagerly
 * pre-fetched (per the `shouldEagerLoad` predicate). Pass the result wherever a query or
 * mutation resolver builds its `with:` clause; pass the full map to type generation so
 * opted-out relations still get a (lazily-resolved) field. Relations excluded here are
 * never added to `with:`, so they don't overfetch — they resolve through their field
 * resolver instead (or a resolver you override, e.g. via `@graphql-tools/schema`).
 */
export const pruneNonEagerRelations = (
  relationMap: Record<string, Record<string, TableNamedRelations>>,
  shouldEagerLoad: (tableName: string, relationName: string) => boolean,
): Record<string, Record<string, TableNamedRelations>> => {
  const out: Record<string, Record<string, TableNamedRelations>> = {};
  for (const [tableName, rels] of Object.entries(relationMap)) {
    out[tableName] = Object.fromEntries(
      Object.entries(rels).filter(([relationName]) => shouldEagerLoad(tableName, relationName)),
    );
  }
  return out;
};

/**
 * Returns the property names of a table's primary key column(s).
 *
 * drizzle-orm marks inline `.primaryKey()` columns with `column.primary === true`,
 * but table-level composite keys (`primaryKey({ columns })`) leave `column.primary`
 * false on each member — those are only visible via the per-dialect `getTableConfig`.
 * Dialect builders pass the composite members' DB column names in via
 * `compositePkColumnNames`; we map them back to property names here.
 *
 * Resolution order: inline PK columns → composite PK columns → empty. We deliberately
 * do NOT guess a column named `id`: if no real primary key is declared, returning empty
 * lets callers fall back to the batch loader rather than re-keying on a possibly
 * non-unique column.
 */
export const getPrimaryKeyPropNames = (table: Table, compositePkColumnNames?: readonly string[]): string[] => {
  const cols = getColumns(table);
  const entries = Object.entries(cols);

  // Inline single `.primaryKey()` columns.
  const inlinePks = entries.filter(([, c]) => (c as any).primary).map(([k]) => k);
  if (inlinePks.length) {
    return inlinePks;
  }

  // Composite primary key (DB column names supplied by the dialect builder).
  if (compositePkColumnNames?.length) {
    const wanted = new Set(compositePkColumnNames);
    const fromComposite = entries.filter(([, c]) => wanted.has((c as any).name)).map(([k]) => k);
    if (fromComposite.length) {
      return fromComposite;
    }
  }

  // No declared primary key — let the caller fall back to the batch loader.
  return [];
};

/**
 * Ensures a selected-columns map (SQL format: prop name → Column) includes the table's
 * primary-key columns. Mutation resolvers pass their RETURNING columns through this so
 * the eager-loader can re-key rows by PK even when the client didn't select it. Mutates
 * and returns the same map.
 */
export const withPrimaryKeyColumns = <T extends Record<string, any>>(
  columns: T,
  table: Table,
  pkNames: readonly string[],
): T => {
  const allCols = getColumns(table);
  for (const pk of pkNames) {
    if (!(pk in columns) && allCols[pk]) {
      (columns as any)[pk] = allCols[pk];
    }
  }
  return columns;
};

/**
 * Resolves a table's primary-key property names using a dialect's `getTableConfig` to
 * surface table-level composite keys (whose member columns aren't flagged `.primary`).
 * Each dialect builder binds this with its own getTableConfig and reuses the binding for
 * both relation pagination and mutation re-fetch keying.
 */
export const getPrimaryKeyPropNamesFromConfig = (
  table: Table,
  getTableConfig: (table: Table) => { primaryKeys: { columns: { name: string }[] }[] },
): string[] => {
  const compositePkColumnNames = getTableConfig(table).primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));
  return getPrimaryKeyPropNames(table, compositePkColumnNames);
};

/**
 * Ascending order expressions for a table's primary key — the deterministic tiebreak for
 * paginated relations. Shared by the window-function batch path and the eager `with:`
 * orderBy default so both order identically. `table` may be the aliased RQB proxy.
 */
export const primaryKeyOrderExprs = (table: Table, pkNames: readonly string[]): any[] => {
  const cols = getColumns(table);
  return pkNames
    .map((n) => cols[n])
    .filter(Boolean)
    .map((col) => asc(col!));
};

// ── cursor (keyset) pagination ───────────────────────────────────────────────

/** Name of the field on generated select types that exposes a row's opaque pagination cursor. */
export const CURSOR_FIELD_NAME = 'cursor';

/**
 * Property the list resolvers stash each row's computed cursor under. Namespaced so it can't
 * collide with a real column; the `cursor` field's resolver reads it back off the row.
 */
const ROW_CURSOR_PROP = '__drizzle_graphql_cursor';

/**
 * Where a dialect's default sort places NULLs relative to non-NULL values:
 * - `nulls-largest` — PostgreSQL: NULLs sort as the largest values (last in ASC, first in DESC).
 * - `nulls-smallest` — MySQL and SQLite: NULLs sort as the smallest values (first in ASC, last
 *   in DESC).
 * The keyset predicate has to agree with the dialect's ORDER BY, so each builder passes its own.
 */
export type NullOrdering = 'nulls-largest' | 'nulls-smallest';

/**
 * One key of the total order a cursor is defined over: column property name + direction,
 * plus the request's `nulls: first | last` override when it carries one (absent/null means
 * the dialect's native NULL placement).
 */
export type CursorOrderEntry = [string, 'asc' | 'desc', (OrderNullsOption | null)?];

/**
 * Whether an `orderBy` argument orders through a to-one relation (a nested object entry
 * rather than a direction). A cursor encodes the row's own ordering-tuple values, and a
 * related row's value is not part of the row, so cursor pagination refuses these orderings —
 * `after` raises an error and the `cursor` field resolves to null, while the ordering itself
 * still applies.
 */
export const orderByHasRelationEntry = (orderBy: Record<string, any> | undefined): boolean =>
  !!orderBy &&
  Object.values(orderBy).some((config) => config && typeof config === 'object' && config.direction === undefined);

/**
 * Why the given `orderBy` cannot back a cursor, as the message to raise — or `undefined`
 * when it can. Both cases sort on something that is not a value of the row: a related row's
 * column, or a position in the request's own `inArray` list. `after` raises the message and
 * the `cursor` field resolves to null, while the ordering itself still applies.
 */
export const orderByCursorObstacle = (orderBy: Record<string, any> | undefined): string | undefined => {
  if (orderByHasRelationEntry(orderBy)) {
    return "'after' cannot be combined with an orderBy that orders through a relation — a related row's value cannot be encoded into a cursor.";
  }
  if (
    orderBy &&
    Object.values(orderBy).some((config) => config && typeof config === 'object' && config.matchFilterOrder)
  ) {
    return "'after' cannot be combined with 'matchFilterOrder' — a row's position in the request's own filter list is not a value of the row, so it cannot be encoded into a cursor.";
  }
  return undefined;
};

/**
 * The total order a list query's rows follow when cursor pagination is in play: the request's
 * `orderBy` entries (highest priority first), then the primary key ascending as a tiebreak —
 * skipping PK columns the `orderBy` already names, so no key appears twice.
 */
export const cursorOrderingEntries = (
  orderBy: Record<string, any> | undefined,
  pkNames: readonly string[],
): CursorOrderEntry[] => {
  const entries: CursorOrderEntry[] = orderBy ? orderByEntries(orderBy) : [];
  const seen = new Set(entries.map(([column]) => column));
  for (const pk of pkNames) {
    if (!seen.has(pk)) {
      entries.push([pk, 'asc']);
    }
  }
  return entries;
};

/**
 * ORDER BY expressions realizing a cursor's total order on `table` (which may be the aliased
 * RQB proxy) — each key's direction plus its `nulls` override, exactly the order the keyset
 * predicate in {@link buildCursorCondition} compares against.
 */
export const cursorOrderExprs = (table: Table, entries: CursorOrderEntry[]): SQL[] => {
  const cols = getColumns(table);
  return entries.flatMap(([column, direction, nulls]) =>
    orderExpressions(cols[column]!, direction, nulls ?? undefined, cols[column]!),
  );
};

/**
 * Serializes one ordering-tuple value into a JSON-safe shape. Dates and bigints don't survive
 * JSON.stringify losslessly (bigint throws, Date turns into an untagged string), so they are
 * tagged; decimals already arrive from the driver as strings, which are lossless as-is.
 */
const encodeCursorValue = (value: any): any => {
  if (value instanceof Date) {
    return { $type: 'date', value: value.toISOString() };
  }
  if (typeof value === 'bigint') {
    return { $type: 'bigint', value: value.toString() };
  }
  return value;
};

const decodeCursorValue = (value: any): any => {
  if (value && typeof value === 'object' && typeof value.$type === 'string') {
    if (value.$type === 'date') {
      return new Date(value.value);
    }
    if (value.$type === 'bigint') {
      return BigInt(value.value);
    }
  }
  return value;
};

/**
 * Encodes a row's position in the given total order as an opaque cursor: base64url of a JSON
 * payload holding the ordering spec (`o`) and the row's values for it (`v`). The spec rides
 * along so a later request can verify the cursor was issued for the same ordering it is using.
 */
export const encodeCursor = (entries: CursorOrderEntry[], row: Record<string, any>): string => {
  const payload = {
    o: entries,
    v: entries.map(([column]) => encodeCursorValue(row[column] ?? null)),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
};

/**
 * Decodes an `after` cursor and validates it against the ordering the current request pages
 * over. A cursor issued under a different `orderBy` would combine one ordering's predicate
 * with another's sort — silently wrong pages — so a mismatch is an error, as is anything that
 * doesn't decode to the expected payload shape.
 */
export const decodeCursor = (after: string, entries: CursorOrderEntry[]): any[] => {
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
  } catch (_e) {
    throw new GraphQLError('Invalid cursor: unable to decode it. Pass a cursor returned by a previous page.');
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.o) ||
    !Array.isArray(payload.v) ||
    payload.o.length !== payload.v.length
  ) {
    throw new GraphQLError('Invalid cursor: malformed payload. Pass a cursor returned by a previous page.');
  }

  const matchesOrdering =
    payload.o.length === entries.length &&
    payload.o.every(
      (entry: any, i: number) =>
        Array.isArray(entry) &&
        entry[0] === entries[i]![0] &&
        entry[1] === entries[i]![1] &&
        // The nulls override changes where NULLs sort, so it is part of the ordering identity.
        // JSON round-trips undefined as null — compare the normalized forms.
        (entry[2] ?? null) === (entries[i]![2] ?? null),
    );
  if (!matchesOrdering) {
    throw new GraphQLError(
      "Invalid cursor: it was issued for a different ordering. Pass the same orderBy the cursor's page used.",
    );
  }

  return payload.v.map(decodeCursorValue);
};

/**
 * The keyset predicate selecting rows strictly after the cursor position in the given total
 * order — the expanded lexicographic form
 * `after(k0) OR (k0 = v0 AND after(k1)) OR (k0 = v0 AND k1 = v1 AND after(k2)) …`,
 * built with and/or/gt/lt/eq rather than SQL row-value syntax, which cannot express mixed
 * asc/desc directions and mishandles NULLs.
 *
 * NULL handling follows each key's `nulls: first | last` override when present, and otherwise
 * the dialect's default sort position (see {@link NullOrdering}): where NULLs sort last for a
 * key, "after a non-NULL value" includes the NULL rows and nothing sorts after a NULL one;
 * where NULLs sort first, "after NULL" is every non-NULL row.
 * `table` may be the aliased RQB proxy.
 */
export const buildCursorCondition = (
  table: Table,
  entries: CursorOrderEntry[],
  values: any[],
  nullOrdering: NullOrdering,
): SQL => {
  const cols = getColumns(table);
  const disjuncts: SQL[] = [];
  const equalities: SQL[] = [];

  entries.forEach(([column, direction, nulls], i) => {
    const col = cols[column];
    if (!col) {
      throw new GraphQLError(`Invalid cursor: unknown column '${column}'.`);
    }

    const value = values[i];
    const nullsSortLast =
      nulls != null ? nulls === 'last' : (direction === 'asc') === (nullOrdering === 'nulls-largest');

    let strictlyAfter: SQL | undefined;
    if (value === null || value === undefined) {
      // Nothing sorts after NULL when NULLs are last; every non-NULL row does when first.
      strictlyAfter = nullsSortLast ? undefined : isNotNull(col);
    } else {
      const comparison = direction === 'asc' ? gt(col, value) : lt(col, value);
      strictlyAfter = nullsSortLast ? or(comparison, isNull(col)) : comparison;
    }

    if (strictlyAfter) {
      disjuncts.push(equalities.length ? and(...equalities, strictlyAfter)! : strictlyAfter);
    }
    equalities.push(value === null || value === undefined ? isNull(col) : eq(col, value));
  });

  if (!disjuncts.length) {
    // Every key's strict term was impossible (e.g. a NULLs-last cursor position of all NULLs) —
    // nothing sorts after this cursor.
    return sql`1 = 0`;
  }

  return disjuncts.length > 1 ? or(...disjuncts)! : disjuncts[0]!;
};

/**
 * Whether the selection asks for the `cursor` meta field. A real column named `cursor` keeps
 * the field for itself, so the meta field only exists (and is only computed) when the table
 * has no such column.
 */
export const isCursorFieldSelected = (tree: Record<string, ResolveTree> | undefined, table: Table): boolean => {
  if (!tree) {
    return false;
  }
  if (getColumns(table)[CURSOR_FIELD_NAME]) {
    return false;
  }
  return Object.values(tree).some((field) => field.name === CURSOR_FIELD_NAME);
};

/**
 * Computes and attaches each row's opaque cursor (under a namespaced property the `cursor`
 * field's resolver reads). Must run on the raw driver rows, before output remapping rewrites
 * dates and bigints into their transport forms.
 */
export const attachRowCursors = (rows: Record<string, any>[], entries: CursorOrderEntry[]): void => {
  for (const row of rows) {
    row[ROW_CURSOR_PROP] = encodeCursor(entries, row);
  }
};

/** Resolver for the `cursor` meta field: reads the value a list resolver attached, if any. */
export const rowCursorResolver = (source: any): string | null => source?.[ROW_CURSOR_PROP] ?? null;

/**
 * Every set of columns that uniquely identifies a row of `table`: the primary key first,
 * then each unique constraint and unique index, then each column declared `.unique()`
 * inline. Sets are property names (what GraphQL inputs use), not database column names.
 *
 * `getTableConfig` is the dialect's own — the three dialects expose the same
 * `{ primaryKeys, uniqueConstraints, indexes }` shape but from different modules, so the
 * caller passes theirs in, as `getPrimaryKeyPropNamesFromConfig` does.
 *
 * Index entries whose columns are SQL expressions rather than plain columns are skipped:
 * an expression index is a valid conflict target in the database but cannot be named by a
 * column enum. Deduplicated, order-insensitive — a column that is both the primary key and
 * a unique constraint yields one set.
 */
export const getUniqueColumnSets = (
  table: Table,
  getTableConfig: (table: Table) => {
    primaryKeys: { columns: { name: string }[] }[];
    uniqueConstraints?: { columns: { name: string }[] }[];
    indexes?: { config: { unique?: boolean; columns: any[] } }[];
  },
): string[][] => {
  const cols = visibleColumns(table);
  const propNameByColumnName = new Map(Object.entries(cols).map(([propName, col]) => [(col as any).name, propName]));
  // A set is usable only if every one of its columns maps back to a property on the table.
  const toPropNames = (columnNames: (string | undefined)[]): string[] | undefined => {
    const propNames: string[] = [];
    for (const columnName of columnNames) {
      const propName = columnName === undefined ? undefined : propNameByColumnName.get(columnName);
      if (!propName) {
        return undefined;
      }
      propNames.push(propName);
    }
    return propNames.length ? propNames : undefined;
  };

  const config = getTableConfig(table);
  const candidates: (string[] | undefined)[] = [
    // Inline `.primaryKey()` columns, then table-level `primaryKey({ columns })`.
    Object.entries(cols)
      .filter(([, col]) => (col as any).primary)
      .map(([propName]) => propName),
    ...config.primaryKeys.map((pk) => toPropNames(pk.columns.map((c) => c.name))),
    ...(config.uniqueConstraints ?? []).map((uc) => toPropNames(uc.columns.map((c) => c.name))),
    ...(config.indexes ?? [])
      .filter((index) => index.config.unique)
      .map((index) => toPropNames(index.config.columns.map((c) => (c as any)?.name))),
    ...Object.entries(cols)
      .filter(([, col]) => (col as any).isUnique)
      .map(([propName]) => [propName]),
  ];

  const seen = new Set<string>();
  const sets: string[][] = [];
  for (const set of candidates) {
    if (!set?.length) {
      continue;
    }
    const key = [...set].sort().join(',');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sets.push(set);
  }
  return sets;
};

/** Alias of the row-number helper column in the `distinct` pass. Namespaced against real columns. */
const DISTINCT_RN = '__drizzle_graphql_distinct_rn';

const columnEnumCache = new WeakMap<object, Map<string, GraphQLEnumType>>();

/**
 * An enum of a table's column property names, under `enumName`. Cached per (table, enum
 * name), like the order/filter inputs, so repeated builds reuse one instance and two enums
 * over the same table never collide.
 *
 * Returns `undefined` when no column qualifies — the caller then omits the argument or
 * input field the enum would have typed, rather than emitting an empty enum, which is
 * invalid GraphQL.
 */
export const generateColumnEnum = (
  table: Table,
  enumName: string,
  description: string,
  predicate: (column: Column, columnName: string) => boolean = () => true,
): GraphQLEnumType | undefined => {
  // Same reasoning as `generateTableOrderCached`: the cache is keyed only by the table object,
  // so a build that hides columns neither reads it nor writes to it.
  const cacheable = !hasExcludedColumns(table);
  let tableCache = cacheable ? columnEnumCache.get(table) : undefined;
  const cached = tableCache?.get(enumName);
  if (cached) {
    return cached;
  }

  const columnNames = Object.entries(visibleColumns(table))
    .filter(([columnName, column]) => predicate(column as Column, columnName))
    .map(([columnName]) => columnName);
  if (!columnNames.length) {
    return undefined;
  }

  const enumType = new GraphQLEnumType({
    name: enumName,
    description,
    values: Object.fromEntries(columnNames.map((columnName) => [columnName, { value: columnName }])),
  });

  if (cacheable) {
    if (!tableCache) {
      tableCache = new Map();
      columnEnumCache.set(table, tableCache);
    }
    tableCache.set(enumName, enumType);
  }
  return enumType;
};

/** `${typeName}DistinctColumn` — the enum of columns a list query may be made distinct on. */
export const generateDistinctEnum = (table: Table, typeName: string): GraphQLEnumType | undefined =>
  generateColumnEnum(table, `${typeName}DistinctColumn`, `Columns of ${typeName} that a query can be made distinct on`);

// ── upsert / conflict handling ────────────────────────────────────────────────

/** Shared by every table's `${typeName}OnConflict` input, so it is created once. */
export const conflictActionEnum = new GraphQLEnumType({
  name: 'ConflictAction',
  description: 'What an upsert does when a row with the same unique key already exists',
  values: {
    UPDATE: { value: 'UPDATE', description: 'Overwrite the conflicting row with the supplied values' },
    NOTHING: { value: 'NOTHING', description: 'Keep the existing row and insert nothing' },
  },
});

/**
 * The `${typeName}OnConflict` input that types an upsert's `onConflict` argument.
 *
 * `target` and `where` only exist when the dialect can express them: MySQL's
 * `ON DUPLICATE KEY UPDATE` fires on any unique key and takes no predicate, so offering
 * either there would mean silently ignoring it.
 *
 * Returns `undefined` when the table has nothing to conflict on (`withTarget` dialects
 * only) — the caller then generates no upsert mutations for that table at all, rather than
 * an operation whose every call is a database error.
 */
export const generateOnConflictInput = (params: {
  table: Table;
  typeName: string;
  uniqueSets: string[][];
  tableFilters: GraphQLInputObjectType;
  withTarget: boolean;
}): GraphQLInputObjectType | undefined => {
  const { table, typeName, uniqueSets, tableFilters, withTarget } = params;

  const updateEnum = generateColumnEnum(
    table,
    `${typeName}UpdateColumn`,
    `Columns of ${typeName} that an upsert can overwrite`,
  );
  if (!updateEnum) {
    return undefined;
  }

  const fields: Record<string, any> = {
    action: {
      type: conflictActionEnum,
      defaultValue: 'UPDATE',
      description: 'Whether a conflicting row is overwritten or left alone. Defaults to UPDATE.',
    },
    update: {
      type: new GraphQLList(new GraphQLNonNull(updateEnum)),
      description:
        'Columns to overwrite on conflict. Defaults to every column the request supplied, minus the conflict target. Columns the request did not supply cannot be listed here — there would be no value to write.',
    },
  };

  if (withTarget) {
    const uniqueColumns = new Set(uniqueSets.flat());
    const targetEnum = generateColumnEnum(
      table,
      `${typeName}ConflictTarget`,
      `Columns of ${typeName} that carry a unique constraint, and so can be conflicted on`,
      (_column, columnName) => uniqueColumns.has(columnName),
    );
    if (!targetEnum) {
      return undefined;
    }

    fields['target'] = {
      type: new GraphQLList(new GraphQLNonNull(targetEnum)),
      description:
        'The unique column set a conflict is detected on. Must match one of the table’s unique constraints exactly. Defaults to the primary key.',
    };
    fields['where'] = {
      type: tableFilters,
      description: 'Only overwrite conflicting rows that match this filter. Others are left alone.',
    };
  }

  return new GraphQLInputObjectType({
    name: `${typeName}OnConflict`,
    description: `Conflict handling for an upsert of ${typeName}`,
    fields,
  });
};

/** The `onConflict` argument as it arrives from GraphQL. */
export type OnConflictArg = {
  action?: 'UPDATE' | 'NOTHING';
  target?: string[];
  update?: string[];
  where?: any;
};

/** What a dialect needs to turn an insert into an upsert. */
export type ConflictPlan = {
  action: 'UPDATE' | 'NOTHING';
  /** Columns to conflict on, or `undefined` on dialects that take no conflict target. */
  target: Column[] | undefined;
  /** `column -> value to write`, in Drizzle's `set` shape. Empty when the action is NOTHING. */
  set: Record<string, SQL>;
  setWhere: SQL | undefined;
};

/**
 * Turns the request's `onConflict` argument and the rows it is inserting into the clause a
 * dialect should attach.
 *
 * `excludedRef` names the row that failed to insert in the dialect's own terms
 * (`excluded.col` on PostgreSQL and SQLite, `values(col)` on MySQL), which is what makes a
 * batch upsert update each row with its own values instead of the last row's.
 *
 * An UPDATE with nothing left to write degrades to NOTHING: `DO UPDATE SET` with an empty
 * body is not valid SQL, and doing nothing is what the request asked for anyway.
 */
export const resolveConflictPlan = (params: {
  table: Table;
  values: Record<string, any>[];
  onConflict: OnConflictArg | undefined;
  pkNames: readonly string[];
  uniqueSets: string[][];
  excludedRef: (columnName: string) => SQL;
  withTarget: boolean;
  buildWhere?: (where: any) => SQL | undefined;
}): ConflictPlan => {
  const { table, values, onConflict, pkNames, uniqueSets, excludedRef, withTarget, buildWhere } = params;
  const columns = getColumns(table) as Record<string, Column>;

  let target: Column[] | undefined;
  if (withTarget) {
    const targetNames = onConflict?.target?.length ? onConflict.target : [...pkNames];
    if (!targetNames.length) {
      throw new GraphQLError(
        'Unable to upsert: no conflict target was given and this table has no primary key. Pass onConflict.target.',
      );
    }
    // A target that is not itself a unique constraint is a database error, and a confusing
    // one ("there is no unique or exclusion constraint matching the ON CONFLICT
    // specification"), so reject it here where we can say which sets are valid.
    const requested = [...targetNames].sort().join(',');
    if (!uniqueSets.some((set) => [...set].sort().join(',') === requested)) {
      throw new GraphQLError(
        `Unable to upsert: [${targetNames.join(', ')}] is not a unique constraint on this table. Valid conflict targets: ${uniqueSets
          .map((set) => `[${set.join(', ')}]`)
          .join(', ')}.`,
      );
    }
    target = targetNames.map((name) => columns[name]!);
  }

  if ((onConflict?.action ?? 'UPDATE') === 'NOTHING') {
    return { action: 'NOTHING', target, set: {}, setWhere: undefined };
  }

  // Only columns the request actually supplied have a value to copy over; anything else
  // would write the column's default (usually null) onto the row that already exists.
  const supplied = new Set(values.flatMap((row) => Object.keys(row)));
  const targetNames = new Set(withTarget ? (onConflict?.target?.length ? onConflict.target : pkNames) : []);

  let updateNames: string[];
  if (onConflict?.update?.length) {
    const unsupplied = onConflict.update.filter((name) => !supplied.has(name));
    if (unsupplied.length) {
      throw new GraphQLError(
        `Unable to upsert: onConflict.update lists ${unsupplied.join(', ')}, which the values do not supply.`,
      );
    }
    updateNames = onConflict.update;
  } else {
    updateNames = [...supplied].filter((name) => !targetNames.has(name));
  }

  if (!updateNames.length) {
    return { action: 'NOTHING', target, set: {}, setWhere: undefined };
  }

  const set = Object.fromEntries(updateNames.map((name) => [name, excludedRef(columns[name]!.name)]));
  const setWhere = onConflict?.where && buildWhere ? buildWhere(onConflict.where) : undefined;

  return { action: 'UPDATE', target, set, setWhere };
};

/** `excluded.<column>` — PostgreSQL and SQLite name the rejected row this way. */
export const excludedColumnRef = (columnName: string): SQL => sql`excluded.${sql.identifier(columnName)}`;

/** `values(<column>)` — MySQL's equivalent inside ON DUPLICATE KEY UPDATE. */
export const mysqlValuesColumnRef = (columnName: string): SQL => sql`values(${sql.identifier(columnName)})`;

/**
 * Keeps the first row of each distinct combination of the requested columns, following the
 * query's own ordering, then applies `limit`/`offset` to what survives — and returns the
 * surviving rows' primary key values in that order.
 *
 * The relational query builder has no `distinct` support, so this runs as its own
 * `row_number() over (partition by … order by …)` pass and the main query is narrowed to the
 * keys it returns. `orderExprs` is the full ordering (the request's `orderBy` plus the primary
 * key tiebreak); the caller applies the same ordering to the main query, so the two agree.
 */
export const selectDistinctKeys = async (params: {
  db: any;
  table: Table;
  tableName: string;
  distinct: string[];
  pkNames: readonly string[];
  where: SQL | undefined;
  orderBy: Record<string, any> | undefined;
  limit?: number;
  offset?: number;
}): Promise<Record<string, any>[]> => {
  const { db, table, tableName, distinct, pkNames, where, orderBy, limit, offset } = params;
  const cols = getColumns(table);

  if (!pkNames.length) {
    throw new GraphQLError(`Table ${tableName} has no primary key, so 'distinct' cannot be applied to it.`);
  }

  const partitionCols = distinct.map((name) => cols[name]).filter(Boolean);
  if (!partitionCols.length) {
    throw new GraphQLError(`No known columns were given to 'distinct' on ${tableName}.`);
  }

  const orderEntries = orderBy ? orderByEntries(orderBy) : [];
  // Both orderings must agree, so build each from the same entries — once against the table
  // (inside the window) and once against the subquery's fields (for the outer row order).
  const windowOrder = [
    ...orderEntries.flatMap(([column, direction, nulls]) =>
      orderExpressions(cols[column]!, direction, nulls, cols[column]!),
    ),
    ...primaryKeyOrderExprs(table, pkNames),
  ];

  const rowNumber = sql`row_number() over (partition by ${sql.join(partitionCols, sql`, `)} order by ${sql.join(
    windowOrder,
    sql`, `,
  )})`.as(DISTINCT_RN);

  const sub = db
    .select({ ...cols, [DISTINCT_RN]: rowNumber })
    .from(table)
    .where(where)
    .as('__dgql_distinct');

  const outerOrder = [
    ...orderEntries.flatMap(([column, direction, nulls]) =>
      orderExpressions(sub[column], direction, nulls, cols[column]!),
    ),
    ...pkNames.filter((name) => sub[name]).map((name) => asc(sub[name])),
  ];

  let query = db
    .select(Object.fromEntries(pkNames.map((name) => [name, sub[name]])))
    .from(sub)
    .where(eq(sub[DISTINCT_RN], 1))
    .orderBy(...outerOrder);

  if (offset) {
    query = query.offset(offset);
  }
  if (limit != null) {
    query = query.limit(limit);
  }

  return await query;
};

/**
 * Condition matching exactly the rows identified by `keys` — an `IN (…)` for a single-column
 * primary key, an `OR` of per-row equality for a composite one. `table` may be the aliased
 * RQB proxy.
 */
export const primaryKeyRestriction = (table: Table, pkNames: readonly string[], keys: Record<string, any>[]): SQL => {
  const cols = getColumns(table);

  if (pkNames.length === 1) {
    const name = pkNames[0]!;
    return inArray(
      cols[name]!,
      keys.map((key) => key[name]),
    );
  }

  return or(...keys.map((key) => and(...pkNames.map((name) => eq(cols[name]!, key[name])))))!;
};

/**
 * Computes the RETURNING columns and relation selection for a mutation resolver: extracts
 * the selected scalar columns, determines whether any relations were selected, and only
 * then forces the primary key into the column set (so the post-mutation eager-load can
 * re-key rows). Returns everything the resolver needs to decide whether to eager-load.
 */
export const prepareMutationRelationColumns = (params: {
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  tables: Record<string, Table>;
  tableName: string;
  typeName: string;
  typeNameMapper: TypeNameMapper | undefined;
  table: Table;
  pkNames: readonly string[];
  parsedInfo: ResolveTree;
  limits?: LimitPolicyFor;
  scope?: ScopeResolver;
}): {
  columns: Record<string, Column>;
  hasRelations: boolean;
  withParams: Record<string, Partial<ProcessedTableSelectArgs>> | undefined;
} => {
  const { relationMap, tables, tableName, typeName, typeNameMapper, table, pkNames, parsedInfo } = params;
  const withParams = relationMap[tableName]
    ? extractRelationsParams(
        relationMap,
        tables,
        tableName,
        parsedInfo,
        typeName,
        typeNameMapper,
        undefined,
        params.limits,
        params.scope,
      )
    : undefined;
  const hasRelations = !!(withParams && Object.keys(withParams).length);
  const baseColumns = extractSelectedColumnsFromTreeSQLFormat(parsedInfo.fieldsByTypeName[typeName]!, table, {
    tableName,
    relationMap,
    tables,
  });
  const columns = hasRelations ? withPrimaryKeyColumns(baseColumns, table, pkNames) : baseColumns;
  return { columns, hasRelations, withParams };
};

/** Wraps a thrown Error as a (message-only) GraphQLError; passes non-Errors through unchanged. */
/**
 * Normalizes whatever a driver threw into a `GraphQLError`. Errors drizzle-graphql raised
 * itself pass straight through; anything else keeps the thrown value on `originalError`,
 * which is how {@link defaultErrorMapper} later tells the two apart.
 */
export const toGraphQLError = (e: unknown): unknown => {
  if (e instanceof GraphQLError) {
    return e;
  }
  return e instanceof Error ? new GraphQLError(e.message, { originalError: e }) : e;
};

/**
 * Default for `config.onError`: keeps drizzle-graphql's own errors, which are written for
 * the client, and replaces driver/database errors with a generic message. Their text names
 * tables, columns, constraints and offending values, none of which belongs in a response.
 * The original is preserved on `originalError` for server-side logging.
 */
export const defaultErrorMapper = (error: unknown): unknown => {
  if (error instanceof GraphQLError && !error.originalError) {
    return error;
  }

  return new GraphQLError('Internal server error', {
    originalError:
      error instanceof GraphQLError ? (error.originalError ?? error) : error instanceof Error ? error : null,
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  });
};

/**
 * Wraps every resolver reachable from a generated entity set so that its errors pass through
 * `mapError` first. Done here rather than at each `throw` site so that the hook also covers
 * relation field resolvers and anything that throws outside a builder's own try/catch.
 */
export const applyErrorMapper = (
  entities: {
    queries: Record<string, { resolve?: (...args: any[]) => any }>;
    mutations: Record<string, { resolve?: (...args: any[]) => any }>;
    types: Record<string, { getFields?: () => Record<string, { resolve?: (...args: any[]) => any }> }>;
    fieldResolvers?: Record<string, Record<string, (...args: any[]) => any>>;
  },
  mapError: (error: unknown) => unknown,
): void => {
  const wrap =
    (resolve: (...args: any[]) => any) =>
    (...args: any[]) => {
      try {
        const result = resolve(...args);
        if (result && typeof result.then === 'function') {
          return result.then(undefined, (e: unknown) => {
            throw mapError(e);
          });
        }
        return result;
      } catch (e) {
        throw mapError(e);
      }
    };

  for (const field of [...Object.values(entities.queries), ...Object.values(entities.mutations)]) {
    if (field?.resolve) {
      field.resolve = wrap(field.resolve);
    }
  }

  // Relation and aggregate fields live on the object types, not in the query/mutation maps.
  for (const type of Object.values(entities.types)) {
    if (typeof type?.getFields !== 'function') {
      continue;
    }
    for (const field of Object.values(type.getFields())) {
      if (field?.resolve) {
        field.resolve = wrap(field.resolve);
      }
    }
  }

  // Standalone relation resolvers, handed out for use in hand-written schemas.
  for (const tableResolvers of Object.values(entities.fieldResolvers ?? {})) {
    for (const [relationName, resolve] of Object.entries(tableResolvers)) {
      tableResolvers[relationName] = wrap(resolve);
    }
  }
};

/**
 * Derives the generated query/mutation field names for a table from the naming config
 * (typeNameMapper + prefixes/suffixes). Shared by all three dialect builders.
 */
export const computeResolverFieldNames = (
  tableName: string,
  typeNameMapper: TypeNameMapper | undefined,
  prefixes: { insert: string; update: string; delete: string; upsert?: string; restore?: string },
  suffixes: { list: string; single: string },
): {
  typeName: string;
  listFieldName: string;
  singleFieldName: string;
  aggregateFieldName: string;
  groupByFieldName: string;
  createArrayFieldName: string;
  createSingleFieldName: string;
  upsertArrayFieldName: string;
  upsertSingleFieldName: string;
  updateFieldName: string;
  updateManyFieldName: string;
  updateSingleFieldName: string;
  deleteFieldName: string;
  deleteSingleFieldName: string;
  restoreFieldName: string;
  restoreSingleFieldName: string;
} => {
  const mapped = typeNameMapper?.(tableName);
  const typeName = mapped ? capitalize(mapped.singular) : capitalize(tableName);
  const listFieldName = (mapped?.plural ?? uncapitalize(tableName)) + suffixes.list;
  const singleFieldName = mapped?.singular ?? uncapitalize(tableName) + suffixes.single;
  const aggregateFieldName = `${mapped?.plural ?? uncapitalize(tableName)}Aggregate`;
  const groupByFieldName = `${mapped?.plural ?? uncapitalize(tableName)}GroupBy`;
  const createArrayFieldName = `${prefixes.insert}${mapped ? capitalize(mapped.plural) : capitalize(tableName)}`;
  const createSingleFieldName = mapped
    ? `${prefixes.insert}${capitalize(mapped.singular)}`
    : `${prefixes.insert}${capitalize(tableName)}${suffixes.single}`;
  const upsertPrefix = prefixes.upsert ?? 'upsert';
  const upsertArrayFieldName = `${upsertPrefix}${mapped ? capitalize(mapped.plural) : capitalize(tableName)}`;
  const upsertSingleFieldName = mapped
    ? `${upsertPrefix}${capitalize(mapped.singular)}`
    : `${upsertPrefix}${capitalize(tableName)}${suffixes.single}`;
  const updateFieldName = `${prefixes.update}${mapped ? capitalize(mapped.singular) : capitalize(tableName)}`;
  // The batch variant is plural like the array insert/upsert, with an explicit `Many`
  // suffix so it never collides with the single-set update.
  const updateManyFieldName = `${prefixes.update}${mapped ? capitalize(mapped.plural) : capitalize(tableName)}Many`;
  const deleteFieldName = `${prefixes.delete}${mapped ? capitalize(mapped.singular) : capitalize(tableName)}`;
  // The soft-delete counterpart, named the same way so `deleteUser` / `restoreUser` read as a
  // pair however the delete prefix and the single suffix are configured.
  const restoreFieldName = `${prefixes.restore ?? 'restore'}${mapped ? capitalize(mapped.singular) : capitalize(tableName)}`;
  // The plural update/delete mutations already use the singular noun when a mapper is
  // present, so — unlike create — the Single variants can't rely on singular vs plural to
  // stay distinct. They always carry a suffix, falling back to 'Single' when the configured
  // suffix is empty (a mapper config may set it to '' for the query side).
  const writeSingleSuffix = suffixes.single === '' ? 'Single' : suffixes.single;
  const updateSingleFieldName = `${updateFieldName}${writeSingleSuffix}`;
  const deleteSingleFieldName = `${deleteFieldName}${writeSingleSuffix}`;
  const restoreSingleFieldName = `${restoreFieldName}${writeSingleSuffix}`;
  return {
    typeName,
    listFieldName,
    singleFieldName,
    aggregateFieldName,
    groupByFieldName,
    createArrayFieldName,
    createSingleFieldName,
    upsertArrayFieldName,
    upsertSingleFieldName,
    updateFieldName,
    updateManyFieldName,
    updateSingleFieldName,
    deleteFieldName,
    deleteSingleFieldName,
    restoreFieldName,
    restoreSingleFieldName,
  };
};

/**
 * The per-entry input of `update<Table>Many`: `{ where, set }`, reusing the table's
 * update `set` input and filter input. Shared by all three dialect builders.
 */
export const generateUpdateManyInput = (params: {
  typeName: string;
  updatePrefix: string;
  updateInput: GraphQLInputObjectType;
  tableFilters: GraphQLInputObjectType;
}): GraphQLInputObjectType => {
  const { typeName, updatePrefix, updateInput, tableFilters } = params;
  return new GraphQLInputObjectType({
    name: `${capitalize(updatePrefix)}${typeName}ManyInput`,
    description: `One entry of a batch update of ${typeName}: the rows \`where\` matches get this entry's \`set\` applied.`,
    fields: {
      where: {
        type: tableFilters,
        description: 'Rows this entry updates. An omitted filter updates every row.',
      },
      set: {
        type: new GraphQLNonNull(updateInput),
      },
    },
  });
};

/**
 * Extracts a `where` argument that a mutation refuses to run without: missing, or present
 * but matching every row (e.g. `where: {}` or filters that all collapse to nothing), both
 * throw instead of becoming an unbounded write. Used by the `Single` write variants always
 * and by the plural update/delete mutations when `features.requireWhere` is on.
 */
export const extractRequiredFilters = <TTable extends Table>(
  table: TTable,
  tableName: string,
  where: Filters<TTable> | undefined,
  fieldName: string,
  relationCtx?: RelationFilterContext,
): SQL => {
  const filters = where ? extractFilters(table, tableName, where, relationCtx) : undefined;
  if (!filters) {
    throw new GraphQLError(`${fieldName} requires a 'where' argument with at least one filter!`);
  }
  return filters;
};

/**
 * Guard for the `Single` write variants: throws before anything is written when `where`
 * matches more than one row, so a multi-row update/delete never executes. Probed with a
 * `LIMIT 2` select rather than a count so the check stays cheap on large matches.
 */
export const assertSingleMatch = async (
  executor: any,
  table: Table,
  filters: SQL,
  fieldName: string,
): Promise<void> => {
  const matched = await executor.select({ found: sql`1` }).from(table).where(filters).limit(2);
  if (matched.length > 1) {
    throw new GraphQLError(`${fieldName}: 'where' matched more than one row — nothing was written!`);
  }
};

/** GraphQL argument map for a list/array select field. */
/**
 * The `deleted` argument, emitted only on reads over a table that declares a soft-delete
 * column — a schema with no soft delete anywhere keeps exactly the arguments it had.
 */
export const deletedArg = (
  softDelete: SoftDeleteFor | undefined,
  tableName: string,
): Record<string, { type: any; description: string }> =>
  softDelete?.(tableName)
    ? {
        deleted: {
          type: deletedFilterEnum,
          description: 'Whether rows marked deleted are returned. Defaults to EXCLUDE.',
        },
      }
    : {};

export const selectArrayArgs = (
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  distinctEnum?: GraphQLEnumType,
  softDelete?: SoftDeleteFor,
  tableName?: string,
): Record<string, { type: any; description?: string }> => ({
  offset: { type: GraphQLInt },
  limit: { type: GraphQLInt },
  orderBy: { type: orderArgs },
  where: { type: filterArgs },
  after: {
    type: GraphQLString,
    description:
      "Keyset pagination: only return rows strictly after this cursor (a row's `cursor` field from a previous page, under the same orderBy).",
  },
  ...(distinctEnum ? { distinct: { type: new GraphQLList(new GraphQLNonNull(distinctEnum)) } } : {}),
  ...deletedArg(softDelete, tableName!),
});

/** GraphQL argument map for a single-row select field (no `limit`). */
export const selectSingleArgs = (
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  softDelete?: SoftDeleteFor,
  tableName?: string,
): Record<string, { type: any }> => ({
  offset: { type: GraphQLInt },
  orderBy: { type: orderArgs },
  where: { type: filterArgs },
  ...deletedArg(softDelete, tableName!),
});

/**
 * Runs the relational-query-builder select shared by every dialect's `generateSelect*`
 * resolver: selected columns + offset/limit + aliased orderBy/where callbacks + the eager
 * `with:` relation params, then remaps the result. `single` switches between
 * findFirst/findMany (and the single path omits `limit`). The PG fallback for tables
 * without RQB support stays in pg.ts; this covers the common RQB path for all three.
 */
export const runRelationalSelect = async (opts: {
  queryBase: any;
  tables: Record<string, Table>;
  tableName: string;
  table: Table;
  relationMap: Record<string, Record<string, TableNamedRelations>>;
  typeName: string;
  typeNameMapper: TypeNameMapper | undefined;
  parsedInfo: ResolveTree;
  offset?: number;
  limit?: number;
  orderBy?: any;
  where?: any;
  single: boolean;
  filterCtx?: RelationFilterBase;
  pkNames?: readonly string[];
  db?: any;
  distinct?: string[];
  after?: string;
  nullOrdering?: NullOrdering;
  limits?: LimitPolicyFor;
  scope?: ScopeResolver;
  deleted?: DeletedMode;
}): Promise<any> => {
  const {
    queryBase,
    tables,
    tableName,
    table,
    relationMap,
    typeName,
    typeNameMapper,
    parsedInfo,
    offset,
    orderBy,
    where,
    single,
    filterCtx,
    pkNames,
    after,
    scope,
    deleted,
  } = opts;
  const distinct = opts.distinct?.length ? opts.distinct : undefined;

  // ── keyset (cursor) pagination ──
  // Active when the request passes `after` or selects the `cursor` meta field. The cursor is
  // defined over a total order — the request's orderBy plus the primary-key tiebreak — so both
  // need the PK; a table without one gets an error for `after` and null cursors otherwise.
  const cursorSelected = !single && isCursorFieldSelected(parsedInfo.fieldsByTypeName[typeName], table);
  let cursorEntries: CursorOrderEntry[] | undefined;
  if (!single && (after != null || cursorSelected)) {
    if (after != null && distinct) {
      throw new GraphQLError("'after' cannot be combined with 'distinct'.");
    }
    const cursorObstacle = orderByCursorObstacle(orderBy);
    if (cursorObstacle) {
      if (after != null) {
        throw new GraphQLError(cursorObstacle);
      }
      // `cursor` was selected under an ordering a cursor cannot express — the field resolves
      // to null and the ordering itself still applies.
    } else if (!pkNames?.length) {
      if (after != null) {
        throw new GraphQLError(`Table ${tableName} has no primary key, so cursor pagination cannot be used on it.`);
      }
      // `cursor` was selected but no total order exists — the field resolves to null.
    } else {
      cursorEntries = cursorOrderingEntries(orderBy, pkNames);
    }
  }
  const cursorValues = after != null && cursorEntries ? decodeCursor(after, cursorEntries) : undefined;
  // Taking a slice of an unordered result lets the database return any rows it likes, so
  // `limit`/`offset` pages can overlap or skip rows between requests, and a single query
  // can return a different row each time. Default to the primary key whenever the query is
  // narrowed to a subset, mirroring the relation-level default in extractRelationsParamsInner.
  const needsDefaultOrder = single || offset != null || opts.limit != null;

  // `distinct` runs as its own pass — the relational query builder cannot express it — and
  // the main query is then narrowed to the primary keys it picked, with the same ordering
  // and without re-applying limit/offset.
  let distinctKeys: Record<string, any>[] | undefined;
  if (distinct) {
    distinctKeys = await selectDistinctKeys({
      db: opts.db,
      table,
      tableName,
      distinct,
      pkNames: pkNames ?? [],
      where: withScope(
        scope,
        tableName,
        table,
        where ? extractFilters(table, tableName, where, relationFilterCtx(filterCtx, tableName)) : undefined,
        deleted,
      ),
      orderBy,
      limit: single ? 1 : opts.limit,
      offset,
    });

    if (!distinctKeys.length) {
      return single ? undefined : [];
    }
  }

  const params: any = {
    columns: extractSelectedColumnsFromTree(parsedInfo.fieldsByTypeName[typeName]!, table, {
      tableName,
      relationMap,
      tables,
      allRelations: filterCtx?.relationMap,
    }),
    offset: distinctKeys ? undefined : offset,
    // drizzle-orm v1 RQB calls orderBy/where with the aliased table proxy — use it
    // directly so column refs match the CTE alias.
    orderBy: distinctKeys
      ? (aliasedTable: Table) => [
          ...(orderBy ? extractOrderBy(aliasedTable, orderBy, relationFilterCtx(filterCtx, tableName), where) : []),
          ...primaryKeyOrderExprs(aliasedTable, pkNames!),
        ]
      : cursorEntries
        ? // Cursor pagination needs a total order: the request's orderBy plus the PK tiebreak,
          // exactly the ordering the cursor encodes and the keyset predicate compares against.
          (aliasedTable: Table) => cursorOrderExprs(aliasedTable, cursorEntries!)
        : orderBy
          ? (aliasedTable: Table) =>
              extractOrderBy(aliasedTable, orderBy, relationFilterCtx(filterCtx, tableName), where)
          : needsDefaultOrder && pkNames?.length
            ? (aliasedTable: Table) => primaryKeyOrderExprs(aliasedTable, pkNames)
            : undefined,
    where: distinctKeys
      ? // The distinct pass already ran inside the scope, so the keys it picked are in it.
        { RAW: (aliasedTable: Table) => primaryKeyRestriction(aliasedTable, pkNames!, distinctKeys!) }
      : where || cursorValues || scope?.has(tableName, deleted)
        ? {
            RAW: (aliasedTable: Table) =>
              withScope(
                scope,
                tableName,
                aliasedTable,
                and(
                  where
                    ? extractFilters(aliasedTable, tableName, where, relationFilterCtx(filterCtx, tableName))
                    : undefined,
                  cursorValues
                    ? buildCursorCondition(
                        aliasedTable,
                        cursorEntries!,
                        cursorValues,
                        opts.nullOrdering ?? 'nulls-smallest',
                      )
                    : undefined,
                ),
                deleted,
              ),
          }
        : undefined,
    with: relationMap[tableName]
      ? extractRelationsParams(
          relationMap,
          tables,
          tableName,
          parsedInfo,
          typeName,
          typeNameMapper,
          filterCtx,
          opts.limits,
          scope,
        )
      : undefined,
  };

  if (single) {
    const result = await queryBase.findFirst(params);
    return result ? remapToGraphQLSingleOutput(result, tableName, table, relationMap) : undefined;
  }

  // Computing each row's cursor needs the whole ordering tuple, which the client has no
  // reason to have selected — force those columns into the fetch (GraphQL only returns
  // the fields the query asked for, so extra properties never leak into the response).
  if (cursorEntries && cursorSelected) {
    for (const [column] of cursorEntries) {
      params.columns[column] = true;
    }
  }

  params.limit = distinctKeys ? undefined : opts.limit;
  const result = await queryBase.findMany(params);
  if (cursorEntries && cursorSelected) {
    // On the raw rows, before remapping rewrites dates/bigints into transport forms.
    attachRowCursors(result, cursorEntries);
  }
  return remapToGraphQLArrayOutput(result, tableName, table, relationMap);
};

/**
 * After a mutation, re-fetch the mutated rows through the relational query builder so the
 * selected relations are eagerly loaded in a single query, then merge those relations onto
 * the `.returning()` rows — making the per-field BatchLoader fallback unnecessary.
 *
 * `withParams` is the pre-computed relation selection (from extractRelationsParams); the
 * caller only invokes this when relations are actually selected, so it also gates whether
 * the PK was forced into RETURNING.
 *
 * Falls back to the original `.returning()` rows (relations then resolve via the
 * field-level BatchLoader) when the table has no RQB support, no primary key columns can be
 * determined, or the re-fetch fails. Supports single- and multi-column primary keys.
 */
export const eagerLoadMutationRelations = async (
  db: any,
  tableName: string,
  rows: any[],
  pkNames: readonly string[],
  withParams: Record<string, Partial<ProcessedTableSelectArgs>> | undefined,
): Promise<any[]> => {
  if (!rows.length || !pkNames.length || !withParams || !Object.keys(withParams).length) {
    return rows;
  }

  const queryBase = db.query?.[tableName];
  if (!queryBase) {
    return rows;
  }

  // Only rows that carry every PK value can be re-keyed. Callers force the PK into
  // RETURNING, but if a value is still missing for some rows, eager-load just those that
  // are keyable and leave the rest untouched (their relations resolve lazily) rather than
  // bailing the whole batch.
  const keyableRows = rows.filter((row) => pkNames.every((n) => row[n] != null));
  if (!keyableRows.length) {
    return rows;
  }

  // Re-fetch ONLY the primary key + relations: the scalar columns are already present
  // on `rows` from RETURNING, so re-selecting them would transfer them a second time
  // (and would lose them on the fallback path). We merge the fetched relations back in.
  const pkColumns: Record<string, true> = {};
  for (const pk of pkNames) {
    pkColumns[pk] = true;
  }
  const relationNames = Object.keys(withParams);

  // Normalize bigint PK values to strings: JSON.stringify throws on bigint, and a
  // bigint and its string form never collide within a single column's values.
  const keyOf = (row: any) =>
    JSON.stringify(pkNames.map((n) => (typeof row[n] === 'bigint' ? row[n].toString() : row[n])));

  let whereRaw: (aliased: any) => SQL | undefined;
  if (pkNames.length === 1) {
    const pkName = pkNames[0]!;
    const ids = keyableRows.map((r) => r[pkName]);
    // drizzle-orm v1 RQB calls the where callback with the aliased table proxy;
    // reference the PK through it so the column ref matches the CTE alias.
    whereRaw = (aliased: any) => inArray(aliased[pkName], ids);
  } else {
    // Composite PK: use a row-value IN — `(a, b) IN ((..), (..))` — so the database can
    // plan it as a set membership test, instead of an OR of N per-row AND-tuples that
    // blows up for large bulk mutations.
    whereRaw = (aliased: any) => {
      const lhs = sql.join(
        pkNames.map((n) => sql`${aliased[n]}`),
        sql`, `,
      );
      const tuples = sql.join(
        keyableRows.map(
          (row) =>
            sql`(${sql.join(
              pkNames.map((n) => sql`${row[n]}`),
              sql`, `,
            )})`,
        ),
        sql`, `,
      );
      return sql`(${lhs}) in (${tuples})`;
    };
  }

  let enriched: any[];
  try {
    enriched = await queryBase.findMany({
      columns: pkColumns,
      where: { RAW: whereRaw },
      with: withParams,
    });
  } catch (err) {
    // The write has already committed; a re-fetch failure (e.g. an RQB-incompatible
    // column or relation) must not turn a successful mutation into an error. Fall back
    // to the raw rows — relations then resolve lazily via the batch loader — but surface
    // the cause so a genuine misconfiguration isn't silently hidden.
    console.warn(
      `[drizzle-graphql] eager-loading relations for a "${tableName}" mutation failed; ` +
        'falling back to lazy resolution.',
      err,
    );
    return rows;
  }

  // Merge the fetched relations onto the RETURNING rows in place, preserving order. A row
  // the re-fetch didn't return (e.g. deleted concurrently) keeps its scalar columns and
  // its relations resolve lazily, so the result never reports fewer rows than were mutated.
  const byKey = new Map(enriched.map((e) => [keyOf(e), e]));
  for (const row of rows) {
    const match = byKey.get(keyOf(row));
    if (!match) {
      continue;
    }
    for (const rel of relationNames) {
      row[rel] = match[rel];
    }
  }
  return rows;
};
