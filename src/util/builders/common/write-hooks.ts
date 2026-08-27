// Write hooks (`BuildSchemaConfig.onWrite`): the payload a hook is handed, and running one
// around the statement it is attached to.

import type { TablePolicies } from './policies.ts';

/** The write a hook is attached to. `restore` only exists for a soft-deleting table. */
export type WriteOperation = 'insert' | 'update' | 'updateMany' | 'upsert' | 'delete' | 'restore';

/** What a write hook is handed. See {@link BuildSchemaConfig.onWrite}. */
export type WriteHookPayload = {
  /** Drizzle schema key of the table being written. */
  table: string;
  operation: WriteOperation;
  /** `'before'` runs ahead of the statement, `'after'` once it has returned. */
  position: 'before' | 'after';
  /** Whether the field writes a single row (`createUsersSingle`) or a list. */
  single: boolean;
  /** The field's GraphQL arguments, exactly as the resolver received them. */
  args: any;
  /**
   * The rows the write produced, as the database returned them — before the output mapper,
   * so values are database-shaped. Empty at the `before` position, and on MySQL, whose
   * mutations return no rows.
   */
  rows: any[];
  context: any;
  info: any;
  /** The executor the mutation itself ran on. Throwing from the hook rolls it back. */
  tx: any;
};

export type WriteHook = (payload: WriteHookPayload) => void | Promise<void>;
export type WriteHookPositions = { before?: WriteHook; after?: WriteHook };
export type WriteHooks = WriteHook | WriteHookPositions;

/** Resolved, per-field hooks: `undefined` when the table registered none. */
export type ResolvedWriteHooks = { before?: WriteHook; after?: WriteHook };

/** Build-time lookup of a table's hooks, installed on {@link TablePolicies}. */
export type WriteHookFor = (tableName: string, operation: WriteOperation) => ResolvedWriteHooks | undefined;

/**
 * Normalizes the two registration shapes: a bare function is the `after` hook — the position
 * that has rows, and the one the common audit/outbox case wants — while `{ before, after }`
 * names them explicitly.
 */
export const normalizeWriteHooks = (hooks: WriteHooks | undefined | null): ResolvedWriteHooks | undefined => {
  if (!hooks) {
    return undefined;
  }
  if (typeof hooks === 'function') {
    return { after: hooks };
  }
  const resolved = { before: hooks.before, after: hooks.after };
  return resolved.before || resolved.after ? resolved : undefined;
};

/**
 * Invokes one position of a field's hooks. Returns `undefined` rather than a resolved promise
 * when nothing is registered, so the awaiting call site costs nothing on an unhooked build.
 */
export const runWriteHook = (
  hooks: ResolvedWriteHooks | undefined,
  position: 'before' | 'after',
  payload: Omit<WriteHookPayload, 'position' | 'rows'> & { rows?: any[] },
): Promise<void> | undefined => {
  const hook = position === 'before' ? hooks?.before : hooks?.after;
  if (!hook) {
    return undefined;
  }
  return Promise.resolve(hook({ ...payload, position, rows: payload.rows ?? [] }));
};
