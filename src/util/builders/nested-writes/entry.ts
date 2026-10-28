// One parent write with its nested operations around it, in a transaction, for a single input or
// a batch of them.

import type { NestedOps, NestedWriteRequest } from './ops.ts';
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

  const run = async (tx: any) => {
    const patch = await runtime.applyParentSide(tx, tableName, ops, request, existing);
    const rows = await write(tx, patch.values);
    if (guarded && !rows.length) {
      throw new NoParentRow();
    }
    await runtime.checkParentSide(tx, tableName, ops, rows, patch);
    await runtime.applyChildSide(tx, tableName, ops, rows, request);
    return runtime.refreshed(tx, tableName, ops, rows);
  };

  if (!guarded) {
    return run(executor);
  }
  try {
    return await executor.transaction(run);
  } catch (error) {
    if (error instanceof NoParentRow) {
      return [];
    }
    throw error;
  }
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
 */
export const writeWithNestedOps = async (params: {
  executor: any;
  runtime: NestedWriteRuntime;
  tableName: string;
  entries: { columns: Record<string, any>; ops: NestedOps }[];
  remapValues: (columns: Record<string, any>) => Record<string, any>;
  /** `ops` is the entry's nested operations, for a write whose statement depends on them. */
  write: (executor: any, values: Record<string, any>, ops: NestedOps) => Promise<Record<string, any>[]>;
  request?: NestedWriteRequest;
}): Promise<Record<string, any>[]> => {
  const { executor, runtime, tableName, entries, remapValues, write, request } = params;

  return executor.transaction(async (tx: any) => {
    const rows: Record<string, any>[] = [];
    for (const entry of entries) {
      const written = await writeNestedEntry({
        executor: tx,
        runtime,
        tableName,
        ops: entry.ops,
        write: (target, patch) => write(target, { ...remapValues(entry.columns), ...patch }, entry.ops),
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
