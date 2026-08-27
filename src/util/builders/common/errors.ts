// The `onError` boundary: what a resolver's throw is turned into, the default mapper, and the
// plumbing that lets a caller replace it.

import { GraphQLError } from 'graphql';

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
