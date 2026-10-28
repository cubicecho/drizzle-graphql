/**
 * Wraps a Drizzle database (and any transaction it opens) so that `arrive(executor)` runs on
 * the same executor just before each UPDATE / DELETE statement executes. That simulates
 * another writer whose row lands between a `Single` write's match probe and its statement.
 */
export const withRowArrivingBeforeWrite = (target: any, arrive: (executor: any) => Promise<unknown>): any => {
  const delayExecution = (statement: any) => {
    const execute = statement.then;
    // biome-ignore lint/suspicious/noThenProperty: a Drizzle statement executes when awaited, through `then`.
    statement.then = (resolve: any, reject: any) => arrive(target).then(() => execute.call(statement, resolve, reject));
    return statement;
  };
  return new Proxy(target, {
    get(real, prop) {
      if (prop === 'update') {
        return (table: any) => {
          const builder = real.update(table);
          return { set: (values: any) => delayExecution(builder.set(values)) };
        };
      }
      if (prop === 'delete') {
        return (table: any) => delayExecution(real.delete(table));
      }
      if (prop === 'transaction') {
        return (body: (tx: any) => unknown, config?: unknown) =>
          real.transaction((tx: any) => body(withRowArrivingBeforeWrite(tx, arrive)), config);
      }
      const value = Reflect.get(real, prop);
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });
};
