// The `onError` boundary: what a resolver's throw is turned into, the default mapper, and the
// plumbing that lets a caller replace it.

import { type ASTNode, GraphQLError } from 'graphql';
import type { DrizzleFieldOperation } from '../../extensions.ts';

/**
 * The classification of an error drizzle-graphql raised itself, published as
 * `extensions.code`. A consumer maps these onto its own vocabulary; the prose is written for
 * a client to read and may be reworded in any release, so it is not something to match on.
 */
export type DrizzleErrorCode =
  /** A `Single` write's `where` matched more than one row, so nothing was written. */
  | 'DRIZZLE_MULTI_ROW_MATCH'
  /** A write that refuses to run unbounded was given no `where`, or one matching every row. */
  | 'DRIZZLE_WHERE_REQUIRED'
  /** The requested `limit` is above the maximum the field's limit policy allows. */
  | 'DRIZZLE_LIMIT_EXCEEDED'
  /** A write's `values` / `set` carried nothing to write. */
  | 'DRIZZLE_NO_VALUES'
  /** An insert reported no row back, so there is nothing to return or attach. */
  | 'DRIZZLE_NO_ROW_RETURNED'
  /** The driver reported no row count for a returnless write. */
  | 'DRIZZLE_ROW_COUNT_UNAVAILABLE'
  /** A nested write was passed to a field that cannot run one. */
  | 'DRIZZLE_NESTED_WRITES_UNSUPPORTED'
  /** A nested `create` / `connect` / `disconnect` / `set` operand was not usable. */
  | 'DRIZZLE_NESTED_WRITE_INVALID'
  /** A `groupBy` named no column, or one that cannot be grouped by. */
  | 'DRIZZLE_INVALID_GROUP_BY'
  /** An `after` cursor did not decode, or was issued for a different ordering. */
  | 'DRIZZLE_INVALID_CURSOR'
  /** A `where` key was not a filter of the table, or a relation was used as one. */
  | 'DRIZZLE_INVALID_FILTER'
  /** A column's update operations input held none, or more than one. */
  | 'DRIZZLE_INVALID_UPDATE_OPERATION'
  /** A configured `scope` hook returned something that is not a predicate. */
  | 'DRIZZLE_INVALID_SCOPE'
  /** An `orderBy` named something that cannot be ordered by in this query. */
  | 'DRIZZLE_INVALID_ORDER_BY'
  /** `distinct` was asked for where it cannot be applied. */
  | 'DRIZZLE_INVALID_DISTINCT'
  /** An `onConflict` named a target or update column the upsert cannot use. */
  | 'DRIZZLE_INVALID_ON_CONFLICT'
  /** A written value could not be converted to what its column stores. */
  | 'DRIZZLE_INVALID_INPUT_VALUE'
  /** An update's `set` gave a column that cannot hold null an explicit null. */
  | 'DRIZZLE_NOT_NULL'
  /** A write's input named a key that is not a column of the table. */
  | 'DRIZZLE_UNKNOWN_COLUMN'
  /** A stored value could not be represented by the scalar that transports it. */
  | 'DRIZZLE_UNREPRESENTABLE_VALUE'
  /** The request's shared mutation transaction was rolled back, so this field never ran. */
  | 'DRIZZLE_TRANSACTION_ABORTED';

/**
 * What an error was about, published as `extensions.drizzle` beside the code — the runtime
 * half of the `extensions.drizzle` markers a generated field carries.
 *
 * `field` is the **generated** field name, which is why it is data rather than prose: a build
 * that republishes these fields under other names (`RenameRootFields`, a stitched gateway, a
 * hand-written façade) would otherwise be telling a client about a field it has never heard
 * of. The name the client asked for is already in the error's `path`.
 */
export type DrizzleErrorContext = {
  /** The Drizzle schema key of the table the field reads or writes. */
  table?: string;
  operation?: DrizzleFieldOperation;
  /** The generated field's own name, pre-rename. */
  field?: string;
  /** For a relation field: the relation's name. */
  relation?: string;
};

/**
 * A `GraphQLError` carrying its context as data. The message says what went wrong, in prose
 * meant for a client; `extensions.code` classifies it and `extensions.drizzle` says which
 * table, operation and generated field it came from.
 */
export const drizzleError = (
  message: string,
  {
    code,
    nodes,
    ...context
  }: DrizzleErrorContext & {
    code: DrizzleErrorCode;
    /** The AST the error is about, where the throw site has one — it becomes the `locations`. */
    nodes?: ASTNode | readonly ASTNode[];
  },
): GraphQLError =>
  new GraphQLError(message, {
    nodes,
    extensions: Object.keys(context).length ? { code, drizzle: context } : { code },
  });

/**
 * Attaches `extensions.drizzle` to one of this library's own errors on its way out of a
 * resolver, so that the deep helpers — filter compilation, ordering, cursors, conflict
 * planning — can raise a coded error without every one of them being handed the field it was
 * called from. Anything else (a driver error, a `GraphQLError` a hook raised) passes through
 * untouched, and context a throw site already supplied wins over the field's.
 */
export const withErrorContext = (error: unknown, context: DrizzleErrorContext): unknown => {
  if (!(error instanceof GraphQLError)) {
    return error;
  }
  const { code, drizzle } = (error.extensions ?? {}) as { code?: unknown; drizzle?: DrizzleErrorContext };
  if (typeof code !== 'string' || !code.startsWith('DRIZZLE_')) {
    return error;
  }
  return new GraphQLError(error.message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
    originalError: error.originalError,
    extensions: { ...error.extensions, drizzle: { ...context, ...drizzle } },
  });
};

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
