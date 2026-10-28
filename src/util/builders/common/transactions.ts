// =============================================================================
// Automatic per-request transactions for multi-mutation documents
// (`BuildSchemaConfig.transactions: 'auto'`).
//
// GraphQL executes root mutation fields serially, but each one is a separate
// resolver call on whatever server hosts the schema — the library never sees
// the request as a whole. So the FIRST mutation resolver of a request inspects
// `info.operation`: when the document selects more than one root mutation
// field, it opens `db.transaction()` once, parks the transaction on a
// per-request state object (WeakMap keyed by the execution, see `executionKey`),
// publishes it for that execution's reads (`executor.ts publishAutoTransaction`),
// and every later mutation resolver of the same request runs on that transaction. The
// transaction callback awaits a latch; the last field to complete resolves it
// (COMMIT) and the first failure rejects it (ROLLBACK).
// =============================================================================

import type { GraphQLError } from 'graphql';
import { executionKey } from '../../execution.ts';
import type { FragmentVariableScope } from '../../graphql-variables.ts';
import {
  argumentValues,
  enterFragmentScope,
  fragmentArgumentsInUse,
  isExcludedByDirectives,
} from '../../graphql-variables.ts';
import { type CommitQueue, type CommitUnit, callerCommitStage, createCommitUnit } from './commit-callbacks.ts';
import { drizzleError } from './errors.ts';
import {
  callerExecutor,
  drizzleExecutorKey,
  publishAutoTransaction,
  resolveExecutor,
  withdrawAutoTransaction,
} from './executor.ts';

/** How long a shared transaction may sit idle between resolver calls before it is rolled back. */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;

/** The longest delay `setTimeout` honours; anything above, Infinity included, fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

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
  /** True when the first failure was the inactivity timeout rather than a field's error. */
  timedOut: boolean;
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
  /** The `onCommit` callbacks of every field that succeeded so far; run after COMMIT. */
  commits: CommitUnit;
};

/** What a mutation body runs with: its executor, and the queue `payload.onCommit` adds to. */
export type MutationBody<T> = (executor: any, commits: CommitQueue) => Promise<T>;

type RequestTxState = { kind: 'passthrough' } | SharedTxState;

/** What the root-mutation walk reads off `info`, fixed for the whole walk. */
type RootMutationWalk = {
  schema: any;
  fragments: any;
  /** `info.variableValues` as the executing major shaped it — see `graphql-variables.ts`. */
  variableValues: unknown;
  known: ReadonlySet<string>;
  keys: Set<string>;
  visitedFragments: Set<string>;
  argumentsCoerce: (field: any, scope: FragmentVariableScope | undefined) => boolean;
};

/**
 * Collects the response keys of every root mutation field the executor will run, expanding
 * fragments and honoring `@skip` / `@include`. Distinct response keys (alias ?? name) are
 * counted, matching graphql-js field collection, so a field selected twice under one key is
 * still one resolver call. Returns `false` when the document selects a root mutation field
 * this build did not generate — its completion cannot be tracked, so the caller must not
 * open a transaction it might never be able to close.
 *
 * Variables are read through `graphql-variables.ts`, so a `@skip(if: $v)` sees the coerced
 * value under graphql 17's `{ sources, coerced }` record as well as 16's plain map, and a
 * `$v` declared by a fragment (17's fragment arguments) reads the spread's value.
 */
const collectRootMutationKeys = (
  selectionSet: any,
  walk: RootMutationWalk,
  scope: FragmentVariableScope | undefined,
): boolean => {
  for (const selection of selectionSet.selections) {
    if (isExcludedByDirectives(selection, walk.variableValues, scope)) {
      continue;
    }
    if (selection.kind === 'Field') {
      const name = selection.name.value;
      if (name === '__typename') {
        continue;
      }
      if (!walk.known.has(name)) {
        return false;
      }
      // A field whose arguments fail to coerce is answered with an error by the executor
      // without its resolver ever running. Counting it would leave the transaction waiting
      // for a completion that never comes — until the timeout rolls back writes the
      // response already reported as done.
      if (walk.argumentsCoerce(selection, scope)) {
        walk.keys.add(selection.alias?.value ?? name);
      }
    } else if (selection.kind === 'InlineFragment') {
      if (!collectRootMutationKeys(selection.selectionSet, walk, scope)) {
        return false;
      }
    } else if (selection.kind === 'FragmentSpread') {
      const fragmentName = selection.name.value;
      if (walk.visitedFragments.has(fragmentName)) {
        continue;
      }
      walk.visitedFragments.add(fragmentName);
      const fragment = walk.fragments?.[fragmentName];
      if (!fragment) {
        return false;
      }
      let fragmentScope: FragmentVariableScope | undefined;
      if (fragmentArgumentsInUse(walk.variableValues, walk.fragments)) {
        try {
          fragmentScope = enterFragmentScope(walk.schema, selection, fragment, walk.variableValues, scope);
        } catch {
          // A spread whose arguments fail to coerce: the executor errors on the fields under
          // it without running their resolvers, so none of them can be counted.
          continue;
        }
      }
      if (!collectRootMutationKeys(fragment.selectionSet, walk, fragmentScope)) {
        return false;
      }
    }
  }
  return true;
};

const abortedBatchError = (state: SharedTxState, timeoutMs: number): GraphQLError =>
  drizzleError(
    state.timedOut
      ? `Drizzle-GraphQL Error: Mutation was not executed because the shared transaction timed out after ${timeoutMs}ms waiting for the remaining mutation fields and was rolled back.`
      : 'Drizzle-GraphQL Error: Mutation was not executed because an earlier mutation in the same request failed and the shared transaction was rolled back.',
    { code: 'DRIZZLE_TRANSACTION_ABORTED' },
  );

/** Opens the request-wide transaction and wires up latch, inactivity timer and cleanup. */
const openSharedTx = (db: any, txCtx: MutationTxCtx, stateKey: object, expected: number): SharedTxState => {
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

  const settled: Promise<unknown> = db.transaction(async (tx: any) => {
    // Publish our transaction for this execution, so nested resolvers (lazy relation fields,
    // relation aggregates) selected under a mutation read through it and see its uncommitted
    // rows. It is keyed by the execution, not put on the context: another execution handed the
    // same context object must neither run on it nor mistake it for a caller-supplied one.
    publishAutoTransaction(stateKey, tx);
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
    timedOut: false,
    done: false,
    ready,
    settled,
    release,
    commits: createCommitUnit(),
    abort: (e: unknown) => {
      if (!state.aborted) {
        state.aborted = true;
        state.failure = e;
      }
      // Whatever rolls the transaction back takes every queued callback with it.
      state.commits.drop();
      rejectLatch(e);
    },
    suspendTimer: clearTimer,
    bumpTimer: () => {
      clearTimer();
      // Infinity is the configured "never time out"; build-config rejects every other value
      // `setTimeout` cannot honour.
      if (state.done || txCtx.timeoutMs === Number.POSITIVE_INFINITY) {
        return;
      }
      timer = setTimeout(() => {
        if (!state.aborted) {
          state.timedOut = true;
        }
        // The host never called the remaining resolvers (e.g. a non-null completion error
        // outside our resolvers aborted serial execution). Roll back rather than leak.
        state.abort(
          drizzleError(
            `Drizzle-GraphQL Error: Shared mutation transaction timed out after ${txCtx.timeoutMs}ms waiting for the remaining mutation fields; rolling back.`,
            { code: 'DRIZZLE_TRANSACTION_ABORTED' },
          ),
        );
      }, txCtx.timeoutMs);
      (timer as any).unref?.();
    },
  };

  const cleanup = () => {
    state.done = true;
    clearTimer();
    withdrawAutoTransaction(stateKey);
    // An aborted state stays so late-arriving fields of THIS execution keep failing fast. It is
    // keyed by the execution, so the next one starts without it.
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

const runOnSharedTx = async <T>(state: SharedTxState, timeoutMs: number, body: MutationBody<T>): Promise<T> => {
  if (state.aborted) {
    // Fail fast: never run a later field against a transaction that already rolled back.
    await (state.settled as Promise<unknown>).catch(() => {});
    throw abortedBatchError(state, timeoutMs);
  }
  state.suspendTimer();
  const tx = await state.ready;
  // This field's callbacks join the transaction's only once the field has succeeded.
  const stage = state.commits.stage();
  let committed = false;
  let result: T;
  try {
    if (state.aborted) {
      throw abortedBatchError(state, timeoutMs);
    }
    result = await body(tx, stage);
    stage.keep();
    state.completed += 1;
    if (state.completed >= state.expected) {
      state.release();
      // COMMIT before this (final) field resolves, so the data is durable — and a commit
      // failure surfaces as this field's error.
      await state.settled;
      committed = true;
    } else {
      state.bumpTimer();
    }
  } catch (e) {
    stage.drop();
    state.abort(e);
    // Wait for the ROLLBACK to finish before surfacing, so the caller never observes a
    // response produced while the transaction is still being unwound.
    await (state.settled as Promise<unknown>).catch(() => {});
    throw e;
  }
  if (committed) {
    // Every field's callbacks, after the one COMMIT, before the last field resolves.
    await state.commits.run();
  }
  return result;
};

/**
 * Runs a field that is its own commit unit — in a transaction opened for it, or straight on
 * `db` — and its `onCommit` callbacks once `run` has resolved, which is once that commit has
 * happened. A failure drops them.
 */
const runAsOwnUnit = async <T>(run: (commits: CommitQueue) => Promise<T>): Promise<T> => {
  const unit = createCommitUnit();
  let result: T;
  try {
    result = await run(unit);
  } catch (e) {
    unit.drop();
    throw e;
  }
  await unit.run();
  return result;
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
  body: MutationBody<T>,
  /**
   * Opens a transaction for a field that would otherwise have run straight on `db`. Set when
   * the field carries an `onWrite` hook, whose whole purpose is to write atomically with the
   * mutation — a hook that ran outside a transaction could not roll anything back.
   */
  forceTx?: boolean,
): Promise<T> => {
  // The state belongs to this execution, never to the context or the document, which a host
  // may reuse across requests or share between concurrent ones. Our own transaction is never
  // put on the context, so whatever sits under `drizzleExecutorKey` is the caller's.
  const stateKey = executionKey(context, info);
  let state = stateKey ? txCtx?.states.get(stateKey) : undefined;

  if (!state) {
    const callers = callerExecutor(context);
    if (callers) {
      // The caller already runs this request on its own transaction/executor — use it as-is.
      // Its commit is the caller's, so the callbacks wait on the context for the caller to
      // run them; a field that fails takes its own with it.
      const stage = callerCommitStage(context);
      try {
        const result = await body(callers, stage);
        stage.keep();
        return result;
      } catch (e) {
        stage.drop();
        throw e;
      }
    }
    // Without an execution to key on, no later field could find a shared transaction.
    if (!txCtx || !stateKey || info.operation.operation !== 'mutation') {
      return runAsOwnUnit((commits) => (forceTx ? db.transaction((tx: any) => body(tx, commits)) : body(db, commits)));
    }
    const keys = new Set<string>();
    const mutationFields = info.schema.getMutationType()?.getFields() ?? {};
    const allKnown = collectRootMutationKeys(
      info.operation.selectionSet,
      {
        schema: info.schema,
        fragments: info.fragments,
        variableValues: info.variableValues,
        known: txCtx.fieldNames,
        keys,
        visitedFragments: new Set(),
        argumentsCoerce: (node, scope) => {
          const fieldDef = mutationFields[node.name.value];
          if (!fieldDef) {
            return false;
          }
          try {
            // Passed through untouched, as in `parse-resolve-info.ts`: each graphql major's
            // `getArgumentValues` takes the variable shape its own resolvers are handed.
            argumentValues(fieldDef, node, info.variableValues, scope);
            return true;
          } catch {
            return false;
          }
        },
      },
      undefined,
    );
    state = !allKnown || keys.size <= 1 ? { kind: 'passthrough' } : openSharedTx(db, txCtx, stateKey, keys.size);
    txCtx.states.set(stateKey, state);
  }

  if (state.kind === 'passthrough') {
    const executor = resolveExecutor(db, context, info);
    return runAsOwnUnit((commits) =>
      forceTx && executor === db ? db.transaction((tx: any) => body(tx, commits)) : body(executor, commits),
    );
  }
  return runOnSharedTx(state, txCtx!.timeoutMs, body);
};
