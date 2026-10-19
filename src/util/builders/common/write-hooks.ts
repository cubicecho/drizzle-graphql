// Write hooks (`BuildSchemaConfig.onWrite`): the payload a hook is handed, and running one
// around the statement it is attached to.

import type { Column } from 'drizzle-orm';
import type { TablePolicies } from './policies.ts';

/** The write a hook is attached to. `restore` only exists for a soft-deleting table. */
export type WriteOperation = 'insert' | 'update' | 'updateMany' | 'upsert' | 'delete' | 'restore';

/** Which input of a relation field a nested write came from. */
export type NestedWriteOp = 'create' | 'connect' | 'disconnect' | 'set';

/**
 * Where a nested write came from: set on the payload of a hook that fires for a row a nested
 * `create` / `connect` / `disconnect` / `set` wrote, and absent at the mutation field's own
 * table. See {@link WriteHookPayload.nested}.
 */
export type NestedWriteOrigin = {
  /** Drizzle schema key of the table whose input carried the relation field. */
  parentTable: string;
  /** The relation field the write went through, as named on the parent table. */
  relation: string;
  /** The relation field's input that produced this statement. */
  op: NestedWriteOp;
};

/** What a write hook is handed. See {@link BuildSchemaConfig.onWrite}. */
export type WriteHookPayload = {
  /** Drizzle schema key of the table being written. */
  table: string;
  /**
   * What happened to `table`. A nested write reports what its statement did to *that* table:
   * `insert` for a nested `create`, `update` for a `connect` / `disconnect` / `set` that
   * changes the foreign key on the target, and `insert` / `delete` on the junction table for
   * a many-to-many link / unlink.
   */
  operation: WriteOperation;
  /** `'before'` runs ahead of the statement, `'after'` once it has returned. */
  position: 'before' | 'after';
  /**
   * Whether the field writes a single row (`createUsersSingle`) or a list. For a nested
   * write, whether the relation it went through is a to-one.
   */
  single: boolean;
  /**
   * The field's GraphQL arguments, exactly as the resolver received them — for a nested
   * write, the arguments of the root mutation field it is part of.
   */
  args: any;
  /**
   * Set when the rows were written by a nested write under another table's mutation, and
   * `undefined` for the mutation field's own table. A hook that only cares about root writes
   * skips the rest with `if (payload.nested) return;`.
   */
  nested?: NestedWriteOrigin;
  /**
   * The rows the write produced, as the database returned them — before the output mapper,
   * so values are database-shaped. Empty at the `before` position, and on MySQL, whose
   * mutations return no rows.
   *
   * Each row holds the columns the client's selection asked for (plus any key a relation or
   * nested write needed), **and** every column the hook names in `columns`. A column the
   * client did not select and the hook did not name is absent. The count mutations select
   * nothing, so there a row holds the named columns, or the primary key when none are named.
   *
   * A nested write has no selection of its own, so its rows hold the table's primary key and
   * the join column(s) the write changed, plus the hook's `columns`.
   */
  rows: any[];
  context: any;
  info: any;
  /** The executor the mutation itself ran on. Throwing from the hook rolls it back. */
  tx: any;
};

export type WriteHook = (payload: WriteHookPayload) => void | Promise<void>;
export type WriteHookPositions = {
  before?: WriteHook;
  after?: WriteHook;
  /**
   * Columns the `after` hook's `rows` always carry, whatever the client selected: a list of
   * column keys (the table object's property names, as `rows` is keyed), or `'all'` for
   * every column of the table. They are added to the statement's `RETURNING` and taken back
   * off before the result is mapped, so the client's response is unchanged.
   *
   * An unknown column fails the build, and so does `columns` without an `after` hook. On a
   * top-level (every-table) registration a named column must exist on every table.
   */
  columns?: readonly string[] | 'all';
};
export type WriteHooks = WriteHook | WriteHookPositions;

/**
 * Resolved, per-field hooks: `undefined` when the table registered none. `columns` is the
 * hook's `columns` resolved against the table, or `undefined` when it named none.
 */
export type ResolvedWriteHooks = { before?: WriteHook; after?: WriteHook; columns?: Record<string, Column> };

/** Build-time lookup of a table's hooks, installed on {@link TablePolicies}. */
export type WriteHookFor = (tableName: string, operation: WriteOperation) => ResolvedWriteHooks | undefined;

/**
 * Normalizes the two registration shapes: a bare function is the `after` hook — the position
 * that has rows, and the one the common audit/outbox case wants — while `{ before, after }`
 * names them explicitly.
 */
export const normalizeWriteHooks = (
  hooks: WriteHooks | undefined | null,
  tableColumns: Record<string, Column>,
  where: string,
): ResolvedWriteHooks | undefined => {
  if (!hooks) {
    return undefined;
  }
  if (typeof hooks === 'function') {
    return { after: hooks };
  }
  const resolved: ResolvedWriteHooks = { before: hooks.before, after: hooks.after };
  if (hooks.columns !== undefined) {
    resolved.columns = resolveHookColumns(hooks.columns, !!hooks.after, tableColumns, where);
  }
  return resolved.before || resolved.after ? resolved : undefined;
};

/**
 * Resolves a hook's `columns` against the table it runs on. `where` names the registration
 * (`config.onWrite.posts`) and, for a top-level one, the table, so the error says which.
 */
const resolveHookColumns = (
  spec: readonly string[] | 'all',
  hasAfter: boolean,
  tableColumns: Record<string, Column>,
  where: string,
): Record<string, Column> => {
  // Only the `after` hook is handed rows, so naming columns for a `before` hook alone is a
  // config that asks for something nothing will ever receive.
  if (!hasAfter) {
    throw new Error(`Drizzle-GraphQL Error: ${where}.columns only applies to an 'after' hook, and none is registered.`);
  }
  if (spec === 'all') {
    return { ...tableColumns };
  }
  if (!Array.isArray(spec)) {
    throw new Error(`Drizzle-GraphQL Error: ${where}.columns must be an array of column names or 'all'.`);
  }
  const resolved: Record<string, Column> = {};
  for (const name of spec) {
    const column =
      typeof name === 'string' && Object.keys(tableColumns).includes(name) ? tableColumns[name] : undefined;
    if (!column) {
      throw new Error(
        `Drizzle-GraphQL Error: ${where}.columns names '${String(name)}', which is not a column of that table.`,
      );
    }
    resolved[name] = column;
  }
  return resolved;
};

/**
 * Adds a hook's `columns` to a RETURNING column map, and reports which keys it added — the
 * ones the client never asked for, which have to come back off before the rows are mapped.
 * Returns the map untouched, and no keys, when the hook named none or the selection already
 * covers them.
 */
export const withHookColumns = <T extends Record<string, Column>>(
  hooks: ResolvedWriteHooks | undefined,
  columns: T,
): { returning: T; added: string[] | undefined } => {
  const hookColumns = hooks?.columns;
  if (!hookColumns) {
    return { returning: columns, added: undefined };
  }
  const selected = new Set(Object.keys(columns));
  const added = Object.keys(hookColumns).filter((key) => !selected.has(key));
  if (!added.length) {
    return { returning: columns, added: undefined };
  }
  const returning: Record<string, Column> = { ...columns };
  for (const key of added) {
    returning[key] = hookColumns[key]!;
  }
  return { returning: returning as T, added };
};

/**
 * The rows with the hook-only keys taken off, as fresh objects: the hook was handed the
 * originals and may still hold them, so they are not mutated under it.
 */
export const omitHookColumns = <T extends Record<string, any>>(rows: T[], added: string[] | undefined): T[] => {
  if (!added) {
    return rows;
  }
  return rows.map((row) => {
    const copy: Record<string, any> = { ...row };
    for (const key of added) {
      delete copy[key];
    }
    return copy as T;
  });
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
