// `drizzleExecutorKey` — the context slot a caller can park a transaction (or any other
// executor) in — and the lookups every generated resolver does through it.

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
