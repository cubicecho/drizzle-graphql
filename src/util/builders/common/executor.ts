// `drizzleExecutorKey` — the context slot a caller can park a transaction (or any other
// executor) in — the auto-transaction each execution may open (`transactions: 'auto'`), and the
// lookups every generated resolver does through them.

import { executionKey } from '../../execution.ts';

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
 * The auto-transaction each execution has open, keyed by `executionKey`. It is kept off the
 * context object on purpose: the context slot belongs to the caller, and a host may hand one
 * context to several executions at once, which must not find each other's transaction.
 */
const autoTransactions = new WeakMap<object, unknown>();

/** Makes `tx` the executor of every resolver of the execution `key` names, until withdrawn. */
export const publishAutoTransaction = (key: object, tx: unknown): void => {
  autoTransactions.set(key, tx);
};

export const withdrawAutoTransaction = (key: object): void => {
  autoTransactions.delete(key);
};

/** The executor the caller put on the context under `drizzleExecutorKey`, if any. */
export const callerExecutor = (context: any): unknown =>
  context !== null && (typeof context === 'object' || typeof context === 'function')
    ? context[drizzleExecutorKey] || undefined
    : undefined;

/**
 * The executor a resolver should run on: the caller's executor when the context carries one,
 * else the auto-transaction this execution has open, else the database the schema was built from.
 */
export const resolveExecutor = <T>(db: T, context: any, info: any): T => {
  const callers = callerExecutor(context);
  if (callers) {
    return callers as T;
  }
  const key = executionKey(context, info);
  return ((key && autoTransactions.get(key)) || db) as T;
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
  info: any,
  tableName: string,
  buildTimeQueryBase: any,
): { executor: any; queryBase: any } => {
  const executor = resolveExecutor(db, context, info);
  return {
    executor,
    queryBase: buildTimeQueryBase ? (executor?.query?.[tableName] ?? buildTimeQueryBase) : buildTimeQueryBase,
  };
};
