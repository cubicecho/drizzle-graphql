// The `onWrite` calls a nested write makes: one step per relation-field input, table and
// operation, whose rows reach `after` together.

import type { Column } from 'drizzle-orm';
import {
  type NestedWriteOp,
  type ResolvedWriteHooks,
  runWriteHook,
  type WriteHookPayload,
  withHookColumns,
} from '../common/write-hooks.ts';
import type { ResolverPolicies } from '../common.ts';
import { attachingOp, type NestedWriteRequest, supplied } from './ops.ts';
import { type NestedRelationPlan, writesTargetKey } from './plans.ts';

/** The write a nested statement performs on the table it lands on. */
type NestedOperation = 'insert' | 'update' | 'delete' | 'restore';

/**
 * One `onWrite` call for a nested write: every statement one relation-field input runs
 * against one table with one operation, within one call of the runtime. Their rows are
 * collected and handed to `after` together, the way a root field's hook sees its whole
 * statement's rows at once.
 */
type HookStep = {
  tableName: string;
  operation: NestedOperation;
  op: NestedWriteOp;
  hooks: ResolvedWriteHooks;
  /** The keys the write touches plus the hook's `columns` — what each statement returns. */
  returning: Record<string, Column>;
  rows: any[];
};

/**
 * The hook calls one relation field makes. Every step is registered before the field's first
 * statement, so each `before` runs ahead of all of them and each `after` once the last has
 * returned. A table without hooks registers nothing, and its statements run exactly as they
 * did before hooks reached nested writes — no RETURNING clause is added.
 */
export const createHookSteps = (
  onWrite: ResolverPolicies['onWrite'],
  executor: any,
  request: NestedWriteRequest | undefined,
  parentTable: string,
  plan: NestedRelationPlan,
) => {
  const steps = new Map<string, HookStep>();
  const keyOf = (op: NestedWriteOp, operation: NestedOperation) => `${op}:${operation}`;
  // Every write the library runs hands its nested writes a queue; one called by hand without a
  // request has nowhere to defer to.
  const onCommit: WriteHookPayload['onCommit'] = (fn) => {
    if (!request?.commits) {
      throw new Error('Drizzle-GraphQL Error: payload.onCommit is not available outside a generated mutation.');
    }
    request.commits.add(fn);
  };

  const payload = (step: HookStep): Omit<WriteHookPayload, 'position' | 'rows'> => ({
    table: step.tableName,
    operation: step.operation,
    single: plan.isOne,
    args: request?.args,
    context: request?.context,
    info: request?.info,
    tx: executor,
    onCommit,
    nested: { parentTable, relation: plan.relationName, op: step.op },
  });

  return {
    /** Registers the hook call for `op`'s `operation` statements, if that table has hooks. */
    add: (op: NestedWriteOp, operation: NestedOperation) => {
      const through = plan.through;
      const tableName = through ? through.tableName : plan.targetTableName;
      const hooks = tableName ? onWrite?.(tableName, operation) : undefined;
      if (!tableName || !hooks || steps.has(keyOf(op, operation))) {
        return;
      }
      const keyColumns: Record<string, Column> = through
        ? { [through.sourceColPropName]: through.sourceCol, [through.targetColPropName]: through.targetCol }
        : { ...plan.targetKeyColumns };
      steps.set(keyOf(op, operation), {
        tableName,
        operation,
        op,
        hooks,
        returning: withHookColumns(hooks, keyColumns).returning,
        rows: [],
      });
    },
    get: (op: NestedWriteOp, operation: NestedOperation) => steps.get(keyOf(op, operation)),
    /** Runs one statement, returning its rows to the step it belongs to when there is one. */
    run: async (query: any, op: NestedWriteOp, operation: NestedOperation) => {
      const step = steps.get(keyOf(op, operation));
      if (!step) {
        await query;
        return;
      }
      step.rows.push(...((await query.returning(step.returning)) as any[]));
    },
    before: async () => {
      for (const step of steps.values()) {
        await runWriteHook(step.hooks, 'before', payload(step));
      }
    },
    after: async () => {
      for (const step of steps.values()) {
        await runWriteHook(step.hooks, 'after', { ...payload(step), rows: step.rows });
      }
    },
  };
};

export type HookSteps = ReturnType<typeof createHookSteps>;

/**
 * Registers the hook calls a child-side relation field will make, in the order its
 * statements run, so the `before` hooks fire in that order too. Mirrors the branches of
 * `applyChildSide` and `applyThroughOps` exactly: a step registered for an input that runs no
 * statement would fire with no rows, and one missing would miss them.
 */
export const registerChildSteps = (
  steps: HookSteps,
  plan: NestedRelationPlan,
  op: Record<string, any>,
  /** The junction soft-deletes, so a link is restored rather than inserted when it can be. */
  junctionSoftDeletes = false,
) => {
  if (plan.through) {
    if (supplied(op['set'])) {
      steps.add('set', 'delete');
      if (junctionSoftDeletes) {
        steps.add('set', 'restore');
      }
      steps.add('set', 'insert');
    }
    if (supplied(op['disconnect'])) {
      steps.add('disconnect', 'delete');
    }
    if (supplied(op['connect'])) {
      if (junctionSoftDeletes) {
        steps.add('connect', 'restore');
      }
      steps.add('connect', 'insert');
    }
    return;
  }
  if (supplied(op['set'])) {
    steps.add('set', 'update');
  }
  if (supplied(op['disconnect']) && (!plan.isOne || op['disconnect'] === true)) {
    steps.add('disconnect', 'update');
  }
  const attachedBy = attachingOp(op);
  if (plan.isOne && attachedBy && plan.canDetach && !supplied(op['set'])) {
    steps.add(attachedBy, 'update');
  }
  if (supplied(op['connect']) && !writesTargetKey(plan)) {
    steps.add('connect', 'update');
  }
  if (supplied(op['create'])) {
    steps.add('create', 'insert');
  }
};
