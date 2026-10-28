// Write hooks (`BuildSchemaConfig.onWrite`): the payload a hook is handed, and running one
// around the statement it is attached to.

import type { Column } from 'drizzle-orm';
import type { TablePolicies } from './policies.ts';

/**
 * Every operation a write hook can be attached to, and so every key an operation map in
 * `onWrite` may use. The count mutations report as `update` / `delete`.
 */
export const WRITE_OPERATIONS = ['insert', 'update', 'updateMany', 'upsert', 'delete', 'restore'] as const;

/** The write a hook is attached to. `restore` only exists for a soft-deleting table. */
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

/** The keys of a {@link WriteHookPositions} object, which an operation map cannot use. */
const POSITION_KEYS = ['before', 'after', 'columns'] as const;

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
/** `null` at any position, or for an operation key, means no hook, the same as leaving it out. */
export type WriteHookPositions = {
  before?: WriteHook | null;
  after?: WriteHook | null;
  /**
   * Columns the `after` hook's `rows` always carry, whatever the client selected: a list of
   * column keys (the table object's property names, as `rows` is keyed), or `'all'` for
   * every column of the table. They are added to the statement's `RETURNING` and taken back
   * off before the result is mapped, so the client's response is unchanged.
   *
   * An unknown column fails the build, and so does `columns` without an `after` hook. On a
   * top-level (every-table) registration a named column must exist on every table.
   */
  columns?: readonly string[] | 'all' | null;
};
export type WriteHooks = WriteHook | WriteHookPositions;

/**
 * Hooks for one operation at a time, keyed by {@link WriteOperation}. Each value is the same
 * shape a table takes for every operation: a bare function (the `after` hook) or
 * `{ before, after, columns }`.
 */
export type WriteHooksByOperation = { [Operation in WriteOperation]?: WriteHooks | null };

/**
 * One table's registration (or the every-table one): a bare function, which is the `after`
 * hook of every operation, or an object holding positions that apply to every operation and
 * operation keys that apply to that operation only. Where both cover an operation, both run:
 * the every-operation hook first, then the operation's own.
 */
export type TableWriteHooks = WriteHook | (WriteHookPositions & WriteHooksByOperation);

/**
 * Resolved, per-field hooks: `undefined` when the table registered none. `columns` is the
 * hook's `columns` resolved against the table, or `undefined` when it named none.
 */
export type ResolvedWriteHooks = { before?: WriteHook; after?: WriteHook; columns?: Record<string, Column> };

/** A table's resolved hooks per operation; an operation with none is absent. */
export type ResolvedTableWriteHooks = Partial<Record<WriteOperation, ResolvedWriteHooks>>;

/**
 * Names a place in the config for an error message. `path` is `''` for the registration
 * itself and `.<operation>` for one of its operation keys.
 */
export type HookConfigPath = (path: string) => string;

/** Build-time lookup of a table's hooks for one operation, installed on {@link TablePolicies}. */
export type WriteHookFor = (tableName: string, operation: WriteOperation) => ResolvedWriteHooks | undefined;

/** Whether `key` names a hook position (`before`, `after`, `columns`). */
const isPositionKey = (key: string): boolean => (POSITION_KEYS as readonly string[]).includes(key);

/**
 * Whether `key` names a {@link WriteOperation}.
 *
 * @param key - the config key to test
 */
export const isWriteOperation = (key: string): key is WriteOperation =>
  (WRITE_OPERATIONS as readonly string[]).includes(key);

/** The operation keys, quoted, for error messages. */
const OPERATION_LIST = WRITE_OPERATIONS.map((operation) => `'${operation}'`).join(', ');

/**
 * Normalizes the two registration shapes: a bare function is the `after` hook — the position
 * that has rows, and the one the common audit/outbox case wants — while `{ before, after }`
 * names them explicitly.
 *
 * @param hooks - the registration, or nothing
 * @param tableColumns - the columns of the table the hooks run on, for `columns`
 * @param where - the registration's place in the config, for error messages
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
  for (const position of ['before', 'after'] as const) {
    const hook = hooks[position];
    if (hook !== undefined && hook !== null && typeof hook !== 'function') {
      throw new Error(`Drizzle-GraphQL Error: ${where}.${position} must be a function, got ${typeof hook}.`);
    }
  }
  const resolved: ResolvedWriteHooks = { before: hooks.before ?? undefined, after: hooks.after ?? undefined };
  if (hooks.columns !== undefined && hooks.columns !== null) {
    resolved.columns = resolveHookColumns(hooks.columns, !!hooks.after, tableColumns, where);
  }
  return resolved.before || resolved.after ? resolved : undefined;
};

/** Runs `first` then `second` on the same payload; either may be missing. */
const inSequence = (first: WriteHook | undefined, second: WriteHook | undefined): WriteHook | undefined => {
  if (!first || !second) {
    return first ?? second;
  }
  return async (payload) => {
    await first(payload);
    await second(payload);
  };
};

/**
 * One operation's hooks from the every-operation registration and the operation's own: both
 * run, the shared one first, and the `after` rows carry the columns either names.
 */
const combineWriteHooks = (
  shared: ResolvedWriteHooks | undefined,
  own: ResolvedWriteHooks | undefined,
): ResolvedWriteHooks | undefined => {
  if (!shared || !own) {
    return shared ?? own;
  }
  const combined: ResolvedWriteHooks = {
    before: inSequence(shared.before, own.before),
    after: inSequence(shared.after, own.after),
  };
  const namesColumns = shared.columns !== undefined || own.columns !== undefined;
  if (namesColumns) {
    combined.columns = { ...shared.columns, ...own.columns };
  }
  return combined;
};

/**
 * Normalizes the value of one operation key: today's registration shape, scoped to that
 * operation. Operation keys do not nest, so its object form holds positions only.
 */
const normalizeOperationHooks = (
  hooks: WriteHooks | undefined | null,
  tableColumns: Record<string, Column>,
  where: string,
): ResolvedWriteHooks | undefined => {
  if (hooks === undefined || hooks === null || typeof hooks === 'function') {
    return normalizeWriteHooks(hooks, tableColumns, where);
  }
  if (typeof hooks !== 'object') {
    throw new Error(
      `Drizzle-GraphQL Error: ${where} must be a function (the 'after' hook) or an object with 'before', 'after' and/or 'columns'.`,
    );
  }
  for (const key of Object.keys(hooks)) {
    if (isPositionKey(key)) {
      continue;
    }
    const nestingHint = isWriteOperation(key)
      ? ' Operation keys do not nest: each one takes the hooks for that operation directly.'
      : '';
    throw new Error(
      `Drizzle-GraphQL Error: ${where} has an unknown key '${key}'; it takes 'before', 'after' and 'columns'.${nestingHint}`,
    );
  }
  return normalizeWriteHooks(hooks, tableColumns, where);
};

/**
 * Whether a top-level `onWrite` is the every-table form rather than a table map. A function,
 * a hook position (`before` / `after` as a function, or `columns`) or — when no key is a
 * table — nothing but operation keys makes it every-table. A key naming a table keeps the
 * table-map reading, so a table whose key is an operation name still means that table.
 *
 * @param config - the top-level `onWrite` value
 * @param tableNames - the Drizzle schema's table keys
 */
export const isEveryTableWriteHooks = (
  config: TableWriteHooks | Record<string, TableWriteHooks | undefined>,
  tableNames: ReadonlySet<string>,
): boolean => {
  if (typeof config === 'function') {
    return true;
  }
  const positions = config as WriteHookPositions;
  const hasPosition =
    typeof positions.before === 'function' ||
    typeof positions.after === 'function' ||
    (positions.columns !== undefined && positions.columns !== null);
  if (hasPosition) {
    return true;
  }
  const keys = Object.keys(config);
  const namesTable = keys.some((key) => tableNames.has(key));
  return keys.length > 0 && !namesTable && keys.every(isWriteOperation);
};

/**
 * Resolves one registration (see {@link TableWriteHooks}) into the hooks each operation
 * runs. Every key is checked: positions and operation keys are all a registration can hold,
 * so anything else is a typo that would otherwise never fire.
 *
 * @param entry - the registration, or nothing
 * @param tableColumns - the columns of the table the hooks run on, for `columns`
 * @param where - names a place in the registration, for error messages
 */
export const resolveTableWriteHooks = (
  entry: TableWriteHooks | undefined | null,
  tableColumns: Record<string, Column>,
  where: HookConfigPath,
): ResolvedTableWriteHooks => {
  if (entry === undefined || entry === null) {
    return {};
  }
  if (typeof entry === 'function') {
    const everyOperation: ResolvedWriteHooks = { after: entry };
    return Object.fromEntries(WRITE_OPERATIONS.map((operation) => [operation, everyOperation]));
  }
  if (typeof entry !== 'object') {
    throw new Error(
      `Drizzle-GraphQL Error: ${where('')} must be a function (the 'after' hook) or an object with 'before', 'after', 'columns' and/or operation keys (${OPERATION_LIST}).`,
    );
  }
  for (const key of Object.keys(entry)) {
    if (!isPositionKey(key) && !isWriteOperation(key)) {
      throw new Error(
        `Drizzle-GraphQL Error: ${where('')} has an unknown key '${key}'; it takes 'before', 'after' and 'columns' for every operation, or an operation key (${OPERATION_LIST}) for one.`,
      );
    }
  }
  const shared = normalizeWriteHooks(
    { before: entry.before, after: entry.after, columns: entry.columns },
    tableColumns,
    where(''),
  );
  const resolved: ResolvedTableWriteHooks = {};
  for (const operation of WRITE_OPERATIONS) {
    const own = normalizeOperationHooks(entry[operation], tableColumns, where(`.${operation}`));
    const combined = combineWriteHooks(shared, own);
    if (combined) {
      resolved[operation] = combined;
    }
  }
  return resolved;
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
