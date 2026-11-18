// One parent write with its nested operations around it, in a transaction, for a single input or
// a batch of them.

import type { NestedOps, NestedWriteRequest } from './ops.ts';
import { keyString } from './plans.ts';
import type { NestedWriteRuntime } from './runtime.ts';

/** Thrown inside an entry's savepoint to undo a parent-side `create` whose parent was never written. */
class NoParentRow extends Error {}

/**
 * One parent write with its nested operations around it: the parent-side operations, whose
 * values `write` receives as a patch, then the write, then the child-side operations — and
 * the rows it returns read back when a child-side statement may have changed them.
 *
 * A parent write can come back empty: an update whose `where` matched nothing, an insert or
 * upsert that a conflict turned into a no-op. Anything a parent-side `create` inserted would
 * then be left with nothing pointing at it, so such an entry runs in a savepoint of its own
 * that is rolled back when the write produced no row, and the entry returns no rows — as it
 * would have without the nested operation. The rest of the batch is unaffected.
 *
 * `executor` must already be a transaction.
 */
export const writeNestedEntry = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  ops: NestedOps;
  write: (executor: any, patch: Record<string, any>) => Promise<Record<string, any>[]>;
  request?: NestedWriteRequest;
  /** The write updates existing rows; see {@link NestedWriteRuntime.applyParentSide}. */
  existing?: boolean;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, ops, write, request, existing } = params;
  const guarded = runtime.createsParentSide(tableName, ops);

  const run = async (tx: any, entryRequest: NestedWriteRequest | undefined) => {
    const patch = await runtime.applyParentSide(tx, tableName, ops, entryRequest, existing);
    const rows = await write(tx, patch.values);
    if (guarded && !rows.length) {
      throw new NoParentRow();
    }
    await runtime.checkParentSide(tx, tableName, ops, rows, patch);
    await runtime.applyChildSide(tx, tableName, ops, rows, entryRequest);
    return runtime.refreshed(tx, tableName, ops, rows);
  };

  if (!guarded) {
    return run(executor, request);
  }
  // The savepoint can roll back without failing the field, so the `onCommit` callbacks its
  // hooks register (the parent-side `create`'s `after`) are staged with it and dropped with it.
  const stage = request?.commits?.stage();
  try {
    const rows = await executor.transaction((tx: any) => run(tx, stage ? { ...request, commits: stage } : request));
    stage?.keep();
    return rows;
  } catch (error) {
    stage?.drop();
    if (error instanceof NoParentRow) {
      return [];
    }
    throw error;
  }
};

/**
 * The multi-row parent write a batch offers {@link writeWithNestedOps}, for writing every entry
 * at once when each one carries its own primary key.
 */
export type KeyedBatchWrite = {
  /** The table's primary-key property names, which every entry has to supply. */
  primaryKey: string[];
  /** Writes every entry's values, returning the primary key on top of what `write` returns. */
  write: (executor: any, values: Record<string, any>[]) => Promise<Record<string, any>[]>;
  /** The primary-key columns `write` returns only so its rows can be matched, taken off again. */
  matchOnly: string[];
};

/** Thrown inside the keyed batch's savepoint when its rows cannot be matched to its entries. */
class UnmatchedBatch extends Error {}

/**
 * The key a row or an entry's values hold, as one string, or `undefined` when a column of it
 * is missing.
 *
 * @param values - A row the write returned, or the values an entry writes.
 * @param primaryKey - The primary-key property names.
 * @returns The key, comparable across the two.
 */
const primaryKeyOf = (values: Record<string, any>, primaryKey: string[]): string | undefined => {
  const parts = primaryKey.map((name) => values[name]);
  const isComplete = parts.every((part) => part !== undefined && part !== null);
  if (isComplete === false) {
    return undefined;
  }
  try {
    return parts.map(keyString).join('\u0000');
  } catch {
    // A key no JS value can hold (see keyString) cannot be matched, so the entry is not keyed.
    return undefined;
  }
};

/**
 * Writes every entry's parent row in one statement and every relation's `create` rows in one
 * more, matching the returned parents to their entries by primary key — never by position,
 * since neither PostgreSQL nor SQLite returns a multi-row insert's rows in input order.
 *
 * Throws {@link UnmatchedBatch} unless the rows match the entries one to one: each entry's key
 * came back exactly once and nothing else did. Anything else (a conflict that wrote no row, a
 * key the database stored in another form than it was given) is left to the caller's fallback.
 *
 * @param params.keys - Each entry's supplied primary key, from {@link primaryKeyOf}.
 * @returns The parent rows, in entry order.
 */
const writeKeyedBatch = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  entries: { ops: NestedOps }[];
  values: Record<string, any>[];
  keys: string[];
  batch: KeyedBatchWrite;
  request?: NestedWriteRequest;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, entries, values, keys, batch, request } = params;
  const returned = await batch.write(executor, values);
  const byKey = new Map<string, Record<string, any>>();
  for (const row of returned) {
    const key = primaryKeyOf(row, batch.primaryKey);
    if (key === undefined || byKey.has(key)) {
      throw new UnmatchedBatch();
    }
    byKey.set(key, row);
  }
  const rows = keys.map((key) => byKey.get(key));
  const isOneToOne = returned.length === keys.length && rows.every((row) => row !== undefined);
  if (isOneToOne === false) {
    throw new UnmatchedBatch();
  }
  const matched = rows as Record<string, any>[];
  await runtime.applyChildSideBatch(
    executor,
    tableName,
    entries.map((entry, index) => ({ ops: entry.ops, row: matched[index]! })),
    request,
  );
  if (!batch.matchOnly.length) {
    return matched;
  }
  return matched.map((row) => {
    const copy = { ...row };
    for (const name of batch.matchOnly) {
      delete copy[name];
    }
    return copy;
  });
};

/**
 * Runs one parent write per input entry, with that entry's nested operations around it, all
 * inside a single transaction — a savepoint when the caller already runs on one, so a failing
 * entry rolls the whole batch back.
 *
 * That transaction is also the `tx` the target tables' `onWrite` hooks run on. Every nested
 * write opens it, so a hook on a nested target has the whole tree to roll back even when the
 * root field carries no hook of its own and was not forced into a transaction for one.
 *
 * Entries are written one at a time rather than as a single multi-row statement: a nested
 * operation attaches to the row its own entry produced, so the two have to stay correlated.
 * The batch path is untouched when no entry carries a nested operation.
 *
 * The exception is a `batch` whose entries each supply their own primary key, and whose nested
 * operations {@link NestedWriteRuntime.batchable} accepts: the key correlates a returned row to
 * its entry, so the parents go in as one statement and each relation's children as one more
 * (see {@link writeKeyedBatch}). That attempt runs in a savepoint of its own. When its rows do
 * not match the entries one to one, or any of its statements fails, the savepoint is rolled
 * back and the entries are written one at a time after all — so the outcome, rows or error, is
 * the one the per-entry writes produce.
 */
export const writeWithNestedOps = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  entries: { columns: Record<string, any>; ops: NestedOps }[];
  remapValues: (columns: Record<string, any>) => Record<string, any>;
  /** `ops` is the entry's nested operations, for a write whose statement depends on them. */
  write: (executor: any, values: Record<string, any>, ops: NestedOps) => Promise<Record<string, any>[]>;
  /** The keyed multi-row write, when the table has a primary key to match by. */
  batch?: KeyedBatchWrite;
  request?: NestedWriteRequest;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, entries, remapValues, write, batch, request } = params;

  return executor.transaction(async (tx: any) => {
    // Remapped once, so a fallback after the keyed attempt writes the values it tried.
    const remapped: Record<string, any>[] = [];
    const valuesOf = (index: number) => (remapped[index] ??= remapValues(entries[index]!.columns));

    const offersBatch =
      !!batch?.primaryKey.length &&
      entries.length > 1 &&
      runtime.batchable(
        tableName,
        entries.map(({ ops }) => ops),
      );
    if (offersBatch) {
      const values = entries.map((_, index) => valuesOf(index));
      const keys = values.map((entryValues) => primaryKeyOf(entryValues, batch!.primaryKey));
      const isKeyed = keys.every((key) => key !== undefined) && new Set(keys).size === keys.length;
      if (isKeyed) {
        try {
          return await tx.transaction((savepoint: any) =>
            writeKeyedBatch({
              executor: savepoint,
              runtime,
              tableName,
              entries,
              values,
              keys: keys as string[],
              batch: batch!,
              request,
            }),
          );
        } catch {
          // Rolled back with the savepoint; the per-entry writes below reach the same outcome.
        }
      }
    }

    const rows: Record<string, any>[] = [];
    for (const [index, entry] of entries.entries()) {
      const written = await writeNestedEntry({
        executor: tx,
        runtime,
        tableName,
        ops: entry.ops,
        write: (target, patch) => write(target, { ...valuesOf(index), ...patch }, entry.ops),
        request,
      });
      rows.push(...written);
    }
    return rows;
  });
};

/**
 * The update counterpart: one `set` whose nested operations apply to every row the `where`
 * matched. Resolves the parent-side operations into the values first, writes once, then
 * attaches to each row that came back.
 */
export const updateWithNestedOps = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  columns: Record<string, any>;
  ops: NestedOps;
  remapValues: (columns: Record<string, any>) => Record<string, any>;
  write: (executor: any, values: Record<string, any>) => Promise<Record<string, any>[]>;
  request?: NestedWriteRequest;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, columns, ops, remapValues, write, request } = params;

  return executor.transaction((tx: any) =>
    writeNestedEntry({
      executor: tx,
      runtime,
      tableName,
      ops,
      write: (target, patch) => write(target, { ...remapValues(columns), ...patch }),
      request,
      existing: true,
    }),
  );
};
