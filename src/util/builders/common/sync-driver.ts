// A sync driver: a SQLite driver (better-sqlite3, node:sqlite) whose statements run the moment
// they are called and whose transaction commits the moment its callback returns, so nothing
// awaited inside that callback is part of the transaction.

/** Whether a drizzle handle runs on a sync driver, as the handle itself declares. */
export const isSyncDriver = (db: unknown): boolean =>
  (db as { resultKind?: unknown } | undefined)?.resultKind === 'sync';

/**
 * Runs `run` over `items` in order, from a transaction callback that must not be async. The
 * first result tells the driver families apart, rather than the handle: a promise means an
 * async driver, whose statements are awaited one after another; anything else is a sync
 * driver's, and every statement runs before the callback returns.
 *
 * @param items - What to run, at least one.
 * @param run - Runs one item's statement.
 * @returns Each item's result in order, as a promise on an async driver.
 */
export const runInOrder = <T, R>(items: readonly T[], run: (item: T) => R | Promise<R>): R[] | Promise<R[]> => {
  const first = run(items[0]!);
  const rest = items.slice(1);
  const isAsyncDriver = typeof (first as Promise<R> | undefined)?.then === 'function';
  if (isAsyncDriver) {
    return (async () => {
      const results: R[] = [await first];
      for (const item of rest) {
        results.push(await run(item));
      }
      return results;
    })();
  }
  const results: R[] = [first as R];
  for (const item of rest) {
    results.push(run(item) as R);
  }
  return results;
};
