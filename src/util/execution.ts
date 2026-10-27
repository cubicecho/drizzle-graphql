// Identifying one GraphQL execution — one `execute()` call — from a resolver's `info`.
//
// Per-request state (the field memo, the batch loaders, the auto-transaction) belongs to an
// execution, not to the context object: a host may hand the same context to several executions,
// and a parser cache hands them the same document AST. graphql-js coerces the variables once per
// execution, into a fresh object (16: the plain map; 17: a `{ sources, coerced }` record), and
// passes that same object to every resolver of it, so its identity names the execution under
// both majors. Subscriptions run one execution per event, so each event gets fresh state.

/**
 * The object that identifies the execution `info` belongs to, for keying weak maps. `undefined`
 * when there is no usable resolve info (a resolver called by hand), which callers treat as
 * "nothing execution-scoped to key on".
 */
export const executionOf = (info: { readonly variableValues?: unknown } | undefined): object | undefined => {
  const variables = info?.variableValues;
  return variables && typeof variables === 'object' ? variables : undefined;
};

/**
 * What per-request state is keyed on: the execution, or the context object when a resolver is
 * called without resolve info. `undefined` when neither exists, so nothing is shared.
 */
export const executionKey = (
  context: unknown,
  info: { readonly variableValues?: unknown } | undefined,
): object | undefined => {
  const execution = executionOf(info);
  if (execution) {
    return execution;
  }
  return context && typeof context === 'object' ? context : undefined;
};
