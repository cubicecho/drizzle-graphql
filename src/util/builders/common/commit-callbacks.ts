// `payload.onCommit(fn)`: work a write hook defers until the transaction its write ran in has
// committed, and drops when that transaction rolls back.
//
// Callbacks queue per commit unit, the thing whose commit makes the write durable:
//
// - the transaction the library opened for one field (a hooked field is forced into one);
// - the execution's auto-transaction (`transactions: 'auto'`), which commits after its last
//   mutation field;
// - a field that runs on `db` with no transaction of its own (an unhooked root whose nested
//   write fires a hooked table's hooks inside the nested write's own transaction): its write
//   is durable once the field's body has returned;
// - a caller-supplied executor (`drizzleExecutorKey`): the library cannot see that commit, so
//   the callbacks wait, keyed by the context object, until the caller runs `runCommitCallbacks`
//   or `discardCommitCallbacks`.
//
// Inside a unit every field writes into a stage of its own, and so does every savepoint the
// library rolls back without failing the field (a nested entry whose parent write produced no
// row). A stage that fails is dropped; one that succeeds joins its parent in order.

/** A callback registered with `payload.onCommit`. */
export type CommitCallback = () => void | Promise<void>;

/** One commit unit's callbacks, or a stage of one. */
export type CommitQueue = {
  /** Queues `fn`. Throws once the queue has been run, dropped, or merged into its parent. */
  add: (fn: CommitCallback) => void;
  /** A stage whose callbacks join this queue on `keep()` and vanish on `drop()`. */
  stage: () => CommitStage;
};

export type CommitStage = CommitQueue & {
  keep: () => void;
  drop: () => void;
};

const closedError = () =>
  new Error(
    'Drizzle-GraphQL Error: payload.onCommit was called after the write it belongs to had already committed or rolled back. Call it while the hook runs.',
  );

type QueueState = { callbacks: CommitCallback[]; closed: boolean };

const queueOf = (state: QueueState): CommitQueue => ({
  add: (fn) => {
    if (typeof fn !== 'function') {
      throw new Error(`Drizzle-GraphQL Error: payload.onCommit takes a function, got ${typeof fn}.`);
    }
    if (state.closed) {
      throw closedError();
    }
    state.callbacks.push(fn);
  },
  stage: () => stageOf(() => state),
});

/**
 * A stage under the queue `parentOf` returns when the stage is kept — looked up then rather
 * than when the stage opened, so a caller's queue flushed while a field was still running
 * hands that field's callbacks to the next one instead of losing them.
 */
const stageOf = (parentOf: () => QueueState): CommitStage => {
  const own: QueueState = { callbacks: [], closed: false };
  return {
    ...queueOf(own),
    keep: () => {
      if (own.closed) {
        return;
      }
      own.closed = true;
      const parent = parentOf();
      if (parent.closed) {
        // The parent already ran or was dropped; nothing staged under it may run.
        return;
      }
      parent.callbacks.push(...own.callbacks);
      own.callbacks = [];
    },
    drop: () => {
      own.closed = true;
      own.callbacks = [];
    },
  };
};

/** A commit unit the library owns, which it runs once the commit has happened. */
export type CommitUnit = CommitQueue & {
  /** Runs every callback in order, logging any that throws, and closes the unit. */
  run: () => Promise<void>;
  /** Drops every callback and closes the unit. */
  drop: () => void;
};

/**
 * Runs `callbacks` one after another in registration order, each started once the one before
 * has settled. Returns what they threw, without stopping at the first.
 */
const runInOrder = async (callbacks: CommitCallback[]): Promise<unknown[]> => {
  const errors: unknown[] = [];
  for (const fn of callbacks) {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  }
  return errors;
};

/**
 * Takes the callbacks out of a queue state and closes it, so a callback that registers
 * another is told the commit has already happened.
 */
const drain = (state: QueueState): CommitCallback[] => {
  state.closed = true;
  const callbacks = state.callbacks;
  state.callbacks = [];
  return callbacks;
};

export const createCommitUnit = (): CommitUnit => {
  const state: QueueState = { callbacks: [], closed: false };
  return {
    ...queueOf(state),
    run: async () => {
      const callbacks = drain(state);
      if (!callbacks.length) {
        return;
      }
      // The commit has already happened, so a callback's failure cannot fail the mutation
      // after the fact: report it and go on with the rest.
      for (const error of await runInOrder(callbacks)) {
        console.error(
          'Drizzle-GraphQL Error: an onCommit callback threw after the transaction committed; the mutation itself succeeded.',
          error,
        );
      }
    },
    drop: () => {
      drain(state);
    },
  };
};

/**
 * Callbacks registered under a caller-supplied executor, keyed by the context object that
 * carried it: the one handle both the library and the caller hold. Weak, so a context the
 * caller never flushed does not keep its callbacks alive.
 */
const callerQueues = new WeakMap<object, QueueState>();

const callerQueueState = (context: object): QueueState => {
  let state = callerQueues.get(context);
  if (!state) {
    state = { callbacks: [], closed: false };
    callerQueues.set(context, state);
  }
  return state;
};

/**
 * A field's stage under a caller-supplied executor: kept into the context's queue when the
 * field succeeds, dropped when it fails.
 */
export const callerCommitStage = (context: object): CommitStage => stageOf(() => callerQueueState(context));

/** `AggregateError` is ES2021; the lib this compiles against stops at ES2020. */
const AggregateErrorCtor = (globalThis as any).AggregateError as new (
  errors: unknown[],
  message: string,
) => Error & { errors: unknown[] };

/**
 * Runs the `payload.onCommit` callbacks that mutations queued on `context` while it carried a
 * caller-supplied executor under `drizzleExecutorKey`. Call it once your own transaction has
 * committed:
 *
 * ```ts
 * const contextValue = { [drizzleExecutorKey]: undefined as unknown };
 * await db.transaction(async (tx) => {
 *   contextValue[drizzleExecutorKey] = tx;
 *   const result = await graphql({ schema, source, contextValue });
 *   if (result.errors) throw new Error('rolled back');
 * });
 * await runCommitCallbacks(contextValue);
 * ```
 *
 * Callbacks run one after another in the order they were registered, and the queue is cleared
 * before the first one starts, so a later execution on the same context starts a fresh one. A
 * callback that throws does not stop the rest; once all have run, the returned promise
 * rejects with an `AggregateError` holding every error, in order. Resolves at once when nothing
 * is queued.
 *
 * @param context - the GraphQL context object the executions ran with
 */
export const runCommitCallbacks = async (context: object): Promise<void> => {
  const state = context ? callerQueues.get(context) : undefined;
  if (!state) {
    return;
  }
  callerQueues.delete(context);
  const errors = await runInOrder(drain(state));
  if (errors.length) {
    throw new AggregateErrorCtor(
      errors,
      `Drizzle-GraphQL Error: ${errors.length} onCommit callback${errors.length === 1 ? '' : 's'} threw.`,
    );
  }
};

/**
 * Drops the `payload.onCommit` callbacks queued on `context` without running them — what to
 * call when your own transaction rolled back. See {@link runCommitCallbacks}.
 *
 * @param context - the GraphQL context object the executions ran with
 */
export const discardCommitCallbacks = (context: object): void => {
  const state = context ? callerQueues.get(context) : undefined;
  if (state) {
    callerQueues.delete(context);
    drain(state);
  }
};
