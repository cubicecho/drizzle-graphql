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

import { GraphQLError } from 'graphql';
import { drizzleExecutorKey, resolveExecutor } from './executor.ts';

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
  /**
   * Opens a transaction for a field that would otherwise have run straight on `db`. Set when
   * the field carries an `onWrite` hook, whose whole purpose is to write atomically with the
   * mutation — a hook that ran outside a transaction could not roll anything back.
   */
  forceTx?: boolean,
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
      return forceTx ? db.transaction((tx: any) => body(tx)) : body(db);
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
    const executor = resolveExecutor(db, context);
    return forceTx && executor === db ? db.transaction((tx: any) => body(tx)) : body(executor);
  }
  return runOnSharedTx(state, body);
};
