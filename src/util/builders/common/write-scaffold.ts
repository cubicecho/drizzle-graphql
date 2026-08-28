// The scaffolding every generated mutation resolver shares, whatever the dialect or the
// operation: look up the table's write hooks, run the statement inside the request's
// transaction, emit the hooks around it, and tag anything that escapes with the field it
// came from.
//
// This was written out by hand at twelve call sites — six in the MySQL builder, five in the
// shared pg/SQLite write resolvers, one in the shared `updateMany` — and every one of them
// spelled the same hook payload, the same `runMutation` wrapper and the same catch clause.
// What actually differs between a MySQL insert and a PostgreSQL one is the statement in the
// middle: MySQL has no RETURNING clause, so it writes and reports `{ isSuccess }`, while the
// others select their rows back on the way out. That difference lives in the body below,
// which is exactly the shape a caller passes in.

import type { GraphQLFieldConfigArgumentMap } from 'graphql';
import type { CreatedResolver } from '../types.ts';
import { type DrizzleErrorContext, toGraphQLError, withErrorContext } from './errors.ts';
import type { ResolverPolicies } from './policies.ts';
import { type MutationTxCtx, runMutation } from './transactions.ts';
import { runWriteHook, type WriteOperation } from './write-hooks.ts';

/**
 * The table's `onWrite` hooks, bound to this field and this request. A body calls `before()`
 * ahead of its statement and `after(rows)` once the statement has returned; both are no-ops
 * when the table registered no hook.
 */
export type WriteHookEmitter = {
  before: () => Promise<void> | undefined;
  /** @param rows the rows the write produced, or `[]` where the dialect returns none. */
  after: (rows?: any[]) => Promise<void> | undefined;
};

/** The statement a mutation field runs, and whatever it resolves to. */
export type WriteBody<TArgs> = (
  params: {
    /** The transaction (or bare `db`) the write must run on. */
    executor: any;
    args: TArgs;
    context: any;
    info: any;
  } & WriteHookEmitter,
) => Promise<any>;

export type WriteResolverSpec<TArgs> = {
  db: any;
  tableName: string;
  operation: WriteOperation;
  /** Whether the field writes one row or a list — reported to the hooks, nothing else. */
  single: boolean;
  fieldName: string;
  /** The field's GraphQL arguments, passed through untouched. */
  args: GraphQLFieldConfigArgumentMap;
  txCtx?: MutationTxCtx;
  policies?: ResolverPolicies;
  run: WriteBody<TArgs>;
};

/**
 * Wraps one mutation body in the scaffolding above and returns the field it becomes.
 *
 * A field carrying a hook is forced into a transaction even when it would have run straight
 * on `db`: a hook exists to write atomically with the mutation, and one that ran outside the
 * transaction could not roll anything back.
 */
export const writeResolver = <TArgs = any>({
  db,
  tableName,
  operation,
  single,
  fieldName,
  args: queryArgs,
  txCtx,
  policies,
  run,
}: WriteResolverSpec<TArgs>): CreatedResolver => {
  const hooks = policies?.onWrite?.(tableName, operation);
  const errorCtx: DrizzleErrorContext = { table: tableName, operation, field: fieldName };

  return {
    name: fieldName,
    resolver: async (_source, args: TArgs, context, info) => {
      try {
        return await runMutation(
          db,
          context,
          info,
          txCtx,
          (executor) => {
            const payload = { table: tableName, operation, single, args, context, info, tx: executor };
            return run({
              executor,
              args,
              context,
              info,
              before: () => runWriteHook(hooks, 'before', payload),
              after: (rows) => runWriteHook(hooks, 'after', { ...payload, rows: rows ?? [] }),
            });
          },
          !!hooks,
        );
      } catch (e) {
        throw withErrorContext(toGraphQLError(e), errorCtx);
      }
    },
    args: queryArgs,
  };
};
