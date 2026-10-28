// What the write resolvers call into at request time: splitting an input, validating its nested
// operations, and running the parent-side and child-side statements around the parent write.

import { and, type Column, getColumns, inArray, type SQL, sql, type Table } from 'drizzle-orm';
import { remapFromGraphQLSingleInput } from '../../data-mappers/index.ts';
import { drizzleError } from '../common/errors.ts';
import { balancedOr, parentKeyChunks, parentKeyCondition } from '../common/relations.ts';
import type { NestedWriteOp } from '../common/write-hooks.ts';
import {
  applyContextValues,
  type ContextValuesFor,
  extractFilters,
  insertStamps,
  junctionPolicy,
  type RelationFilterBase,
  type ResolverPolicies,
  type RowVisibility,
  relationFilterCtx,
  withRowVisibility,
} from '../common.ts';
import { createHookSteps, type HookSteps, registerChildSteps } from './hook-steps.ts';
import {
  asArray,
  attachingOp,
  FILTER_OPERATIONS,
  type NestedOps,
  type NestedWriteRequest,
  supplied,
  suppliedOps,
} from './ops.ts';
import { isInvalidDate, keyString, type NestedRelationPlan, type NestedWritePlans, writesTargetKey } from './plans.ts';

/** What the resolvers call into. Created once per build, next to the plans it closes over. */
export type NestedWriteRuntime = {
  /** Whether the table has any writable relation at all — the cheap check on the hot path. */
  enabled: (tableName: string) => boolean;
  /** Splits one mutation input into plain column values and the nested operations. */
  split: (tableName: string, values: Record<string, any>) => { columns: Record<string, any>; ops: NestedOps };
  /** Whether a split produced anything to do. */
  hasOps: (ops: NestedOps) => boolean;
  /**
   * Throws for operations the request's arguments alone make invalid: two inputs on a to-one,
   * or an operand that matches every row. Reads nothing, so a resolver runs it before the
   * `before` hook; the runtime repeats the same checks as it writes.
   */
  validate: (tableName: string, ops: NestedOps, request?: NestedWriteRequest) => void;
  /**
   * Adds the join columns the child-side operations will need to a RETURNING column map, so
   * the parent rows come back with the key their children are attached by.
   */
  withJoinColumns: <T extends Record<string, Column>>(tableName: string, ops: NestedOps, columns: T, table: Table) => T;
  /**
   * Runs the operations that have to happen *before* the parent row is written, and returns
   * the parent column values they produced.
   */
  applyParentSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    request?: NestedWriteRequest,
    /** The parent write updates existing rows rather than inserting (or upserting) them. */
    existing?: boolean,
  ) => Promise<ParentSidePatch>;
  /**
   * Checks the parent rows a write returned against what its parent-side operations asked
   * for: each one has to hold the key they set, and show any relation whose `where` filters
   * the parent. Throws, so the enclosing transaction rolls the write back.
   */
  checkParentSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    rows: Record<string, any>[],
    patch: ParentSidePatch,
  ) => Promise<void>;
  /**
   * An upsert's conflict `SET`, with the key of every parent-side relation in `ops` whose
   * `where` filters its target written as an update writes it: a key pointing at a row the
   * `where` hides is kept, so `checkParentSide` can tell that apart from a key the conflict
   * branch did not write. Returned unchanged when no such relation is written.
   */
  guardConflictSet: (tableName: string, ops: NestedOps, set: Record<string, SQL>) => Record<string, SQL>;
  /** Runs the operations that attach to the parent rows, once those rows exist. */
  applyChildSide: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    parentRows: Record<string, any>[],
    request?: NestedWriteRequest,
  ) => Promise<void>;
  /** Whether the operations insert a target row before the parent row is written. */
  createsParentSide: (tableName: string, ops: NestedOps) => boolean;
  /**
   * The parent rows as they stand after the child-side statements. Those statements write the
   * target table, which on a self-referencing relation is the parent's own — so the rows the
   * parent write returned can be stale. Returned unchanged when no operation targets the
   * parent's own table.
   */
  refreshed: (
    executor: any,
    tableName: string,
    ops: NestedOps,
    rows: Record<string, any>[],
  ) => Promise<Record<string, any>[]>;
};

/**
 * What the parent-side operations produced: `values` for the parent write, and the key each
 * written row must end up holding (`expected`, by relation name). The two differ on an update,
 * where a `disconnect` or `connect` is written as an expression that leaves a key the
 * relation's own `where` hides in place.
 */
export type ParentSidePatch = { values: Record<string, any>; expected: Record<string, any>; existing: boolean };

/** A to-one `connect` whose filter did not match exactly one row. */
const connectMatchError = (relationName: string, matched: number) =>
  drizzleError(
    `Drizzle-GraphQL Error: 'connect' on '${relationName}' matched ${matched} rows — it attaches a single row, so its filter must match exactly one.`,
    { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
  );

/** The child-side relation in `ops` whose target is the parent's own table, if there is one. */
const selfTargetingPlan = (
  tablePlans: Record<string, NestedRelationPlan> | undefined,
  tableName: string,
  ops: NestedOps,
): NestedRelationPlan | undefined =>
  Object.keys(ops)
    .map((relationName) => tablePlans?.[relationName])
    .find((plan) => plan?.fkSide === 'child' && !plan.through && plan.targetTableName === tableName);

export const createNestedWriteRuntime = (params: {
  plans: NestedWritePlans;
  filterCtx: RelationFilterBase | undefined;
  policies?: ResolverPolicies;
  contextValues?: ContextValuesFor;
}): NestedWriteRuntime => {
  const { plans, filterCtx, policies, contextValues } = params;
  const onWrite = policies?.onWrite;
  /** What an insert into `tableName` stamps — see {@link insertStamps}. */
  const stampsOf = (tableName: string) => insertStamps({ contextValues, softDelete: policies?.softDelete }, tableName);

  /**
   * A `connect` / `disconnect` / `set` operand compiled to SQL. An operand that compiles to
   * nothing is rejected: `connect: {}` would otherwise attach every row in the table.
   */
  const conditionOf = (
    plan: NestedRelationPlan,
    filter: Record<string, any>,
    operation: string,
    visibility: RowVisibility | undefined,
  ) => {
    const condition = extractFilters(
      plan.targetTable,
      plan.targetTableName,
      filter,
      relationFilterCtx(filterCtx, plan.targetTableName, visibility),
    );
    if (!condition) {
      throw drizzleError(
        `Drizzle-GraphQL Error: '${operation}' on '${plan.relationName}' needs a filter that selects rows — it was given one that matches everything.`,
        { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
      );
    }
    // The filter selects rows to attach or detach, so it is a write against the target
    // table and is narrowed by its scope: `connect` cannot reach a row the caller cannot
    // see, and out-of-scope rows are not detached. The relation's own `where` narrows it the
    // same way: only rows the relation shows are detached, and only rows it would show are
    // attached.
    return withRowVisibility(
      visibility,
      plan.targetTableName,
      plan.targetTable,
      and(condition, plan.ownCondition?.()),
    )!;
  };

  const assertSingleOperation = (plan: NestedRelationPlan, op: Record<string, any>) => {
    const given = ['create', 'connect', 'disconnect'].filter((key) => supplied(op[key]));
    if (given.length > 1) {
      throw drizzleError(
        `Drizzle-GraphQL Error: '${plan.relationName}' takes one of ${given.join(', ')} at a time — it holds a single row.`,
        { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
      );
    }
  };

  /** The values the junction stores for the target rows one operand selects. */
  const selectedTargetKeys = async (
    executor: any,
    plan: NestedRelationPlan,
    filter: Record<string, any>,
    operation: string,
    visibility: RowVisibility | undefined,
  ): Promise<any[]> => {
    // Only the key the junction stores is read back, so the projection asks for that column
    // alone — a wide target row is never dragged across the wire to pick one value off it.
    const rows = await executor
      .select({ [plan.foreignColPropName]: plan.foreignCol })
      .from(plan.targetTable)
      .where(conditionOf(plan, filter, operation, visibility));
    return rows
      .map((row: any) => row[plan.foreignColPropName])
      .filter((value: any) => value !== undefined && value !== null);
  };

  /**
   * The distinct target keys a list of operands selects, in the order they were first selected.
   * Each operand is one read, made once for the whole batch of parents: an operand does not
   * depend on the parent it is applied to.
   */
  const selectedTargetKeysOf = async (
    executor: any,
    plan: NestedRelationPlan,
    operands: any[],
    operation: string,
    visibility: RowVisibility | undefined,
  ): Promise<any[]> => {
    const seen = new Set<string>();
    const targets: any[] = [];
    for (const filter of operands) {
      for (const targetKey of await selectedTargetKeys(executor, plan, filter, operation, visibility)) {
        if (!seen.has(keyString(targetKey))) {
          seen.add(keyString(targetKey));
          targets.push(targetKey);
        }
      }
    }
    return targets;
  };

  /**
   * The link half of a many-to-many write: junction rows are inserted and deleted, and both
   * the parent rows and the target rows are left exactly as they are.
   *
   * Runs once for every parent row of the write: each operand is resolved to target keys once,
   * and each statement covers every parent key (`keys`, distinct) at once — split into chunks
   * that keep each statement's bound parameters within the dialects' limits. Each input still
   * runs in full, over every parent, before the next one starts.
   *
   * `connect` reads the parents' existing links first and inserts only the missing ones, so
   * re-connecting a linked row is a no-op on every dialect rather than a unique-constraint
   * error on some of them — the read and the write share the surrounding transaction, so no
   * other writer can slip a duplicate in between them.
   */
  const applyThroughOps = async (
    executor: any,
    plan: NestedRelationPlan,
    keys: any[],
    op: Record<string, any>,
    visibility: RowVisibility | undefined,
    steps: HookSteps,
    context: any,
  ) => {
    const through = plan.through!;
    const junctionName = through.tableName;
    // The junction's own policy decides which links exist for this request, as it does on every
    // read path: a link row another tenant's scope owns is not one this request can see,
    // unlink, or count as already linked, and a soft-deleted link row is a removed link.
    const live = junctionPolicy(visibility, junctionName, through.table);
    const marker = junctionName ? policies?.softDelete?.(junctionName) : undefined;
    const junctionWidth = Object.keys(getColumns(through.table)).length;
    const pairKey = (source: unknown, target: unknown) => `${keyString(source)}\u0000${keyString(target)}`;

    // Unlinking a soft-deleting junction marks the link row, as a delete of that table does.
    const unlink = (where: SQL) =>
      marker
        ? executor
            .update(through.table)
            .set({ [marker.columnName]: marker.writeDeleted() })
            .where(and(where, live))
        : executor.delete(through.table).where(and(where, live));

    const link = async (operands: any[], operation: 'connect' | 'set') => {
      const targets = await selectedTargetKeysOf(executor, plan, operands, operation, visibility);
      if (!targets.length) {
        return;
      }
      // Each chunk binds its parent keys alongside every target key, in the restore below.
      for (const chunk of parentKeyChunks(keys, 1 + targets.length)) {
        const existing = new Set<string>();
        const linked = (await executor
          .select({ source: through.sourceCol, target: through.targetCol })
          .from(through.table)
          .where(and(inArray(through.sourceCol, chunk), live))) as { source: unknown; target: unknown }[];
        for (const row of linked) {
          // A link to a target whose key a JS Date cannot hold is never one being linked now:
          // each target key here was read as a valid one, or `pairKey` below refuses it.
          if (!isInvalidDate(row.target)) {
            existing.add(pairKey(row.source, row.target));
          }
        }
        // The targets each parent is missing, grouped by parent so the restore can name them.
        const missing = new Map<any, any[]>();
        for (const key of chunk) {
          const absent = targets.filter((targetKey) => !existing.has(pairKey(key, targetKey)));
          if (absent.length) {
            missing.set(key, absent);
          }
        }
        if (!missing.size) {
          continue;
        }
        // A link this request removed earlier is still there, marked: it is restored rather than
        // inserted again, which a key on the junction's two columns would refuse. Parents missing
        // the same targets share one `source IN (…) AND target IN (…)` term.
        const restored = new Set<string>();
        if (marker && junctionName) {
          const groups = new Map<string, { sources: any[]; targets: any[] }>();
          for (const [key, absent] of missing) {
            const signature = absent.map(keyString).join('\u0000');
            const group = groups.get(signature) ?? { sources: [], targets: absent };
            group.sources.push(key);
            groups.set(signature, group);
          }
          const step = steps.get(operation, 'restore');
          const rows = (await executor
            .update(through.table)
            .set({ [marker.columnName]: marker.writeRestored })
            .where(
              and(
                balancedOr(
                  [...groups.values()].map((group) =>
                    and(inArray(through.sourceCol, group.sources), inArray(through.targetCol, group.targets)),
                  ),
                ),
                visibility?.on(junctionName, through.table, 'ONLY'),
              ),
            )
            .returning(
              step
                ? step.returning
                : { [through.sourceColPropName]: through.sourceCol, [through.targetColPropName]: through.targetCol },
            )) as any[];
          step?.rows.push(...rows);
          for (const row of rows) {
            restored.add(pairKey(row[through.sourceColPropName], row[through.targetColPropName]));
          }
        }
        const rows: Record<string, any>[] = [];
        for (const [key, absent] of missing) {
          for (const targetKey of absent) {
            if (!restored.has(pairKey(key, targetKey))) {
              rows.push(
                applyContextValues(
                  { [through.sourceColPropName]: key, [through.targetColPropName]: targetKey },
                  junctionName ? stampsOf(junctionName) : undefined,
                  context,
                ),
              );
            }
          }
        }
        for (const batch of parentKeyChunks(rows, junctionWidth)) {
          await steps.run(executor.insert(through.table).values(batch), operation, 'insert');
        }
      }
    };

    // Replace-the-set first, so a `set` alongside a `connect` reads as "these rows, plus that
    // one". `set: []` unlinks everything and links nothing back, which is how the relation is
    // cleared.
    //
    // "Everything" is everything the caller could have attached: links to targets outside the
    // scope, soft-deleted, or hidden by the relation's own `where` are kept, exactly as
    // `disconnect` could not have reached them — and so are link rows the junction's own
    // policy hides.
    if (supplied(op['set'])) {
      const reachable = withRowVisibility(visibility, plan.targetTableName, plan.targetTable, plan.ownCondition?.());
      for (const chunk of parentKeyChunks(keys, 1)) {
        const linked = reachable
          ? and(
              inArray(through.sourceCol, chunk),
              inArray(
                through.targetCol,
                executor
                  .select({ [plan.foreignColPropName]: plan.foreignCol })
                  .from(plan.targetTable)
                  .where(reachable),
              ),
            )!
          : inArray(through.sourceCol, chunk);
        await steps.run(unlink(linked), 'set', 'delete');
      }
      await link(asArray(op['set']), 'set');
    }

    if (supplied(op['disconnect'])) {
      const targets = await selectedTargetKeysOf(executor, plan, asArray(op['disconnect']), 'disconnect', visibility);
      if (targets.length) {
        for (const chunk of parentKeyChunks(keys, 1 + targets.length)) {
          await steps.run(
            unlink(and(inArray(through.sourceCol, chunk), inArray(through.targetCol, targets))!),
            'disconnect',
            'delete',
          );
        }
      }
    }

    if (supplied(op['connect'])) {
      await link(asArray(op['connect']), 'connect');
    }
  };

  /**
   * The value a parent-side `connect` / `disconnect` writes to an existing row's key: `next`,
   * unless the key points at a row the relation's own `where` hides, which it then keeps.
   */
  const keepingHidden = (plan: NestedRelationPlan, next: any): any => {
    if (!plan.ownCondition) {
      return next;
    }
    return keepingHiddenSql(plan, next === null ? sql`null` : sql`${sql.param(next, plan.localCol)}`);
  };

  /** {@link keepingHidden} around a value that is already SQL — an upsert's `excluded.<key>`. */
  const keepingHiddenSql = (plan: NestedRelationPlan, replacement: SQL): SQL => {
    const shown = sql`select ${plan.foreignCol} from ${plan.targetTable} where ${plan.ownCondition!()}`;
    return sql`case when ${plan.localCol} is null or ${plan.localCol} in (${shown}) then ${replacement} else ${plan.localCol} end`;
  };

  /**
   * Which of `keys` — keys the written parent rows hold — point at a target row the relation's
   * own `where` hides. A null key points at nothing, so it is never hidden.
   */
  const hiddenKeys = async (executor: any, plan: NestedRelationPlan, keys: any[]): Promise<Set<string>> => {
    const held = keys.filter((key) => key !== null && key !== undefined);
    if (!held.length || !plan.ownCondition) {
      return new Set();
    }
    const shown = new Set(
      (
        (await executor
          .select({ key: plan.foreignCol })
          .from(plan.targetTable)
          .where(and(inArray(plan.foreignCol, held), plan.ownCondition()))) as { key: any }[]
      ).map((row) => keyString(row.key)),
    );
    return new Set(held.map(keyString).filter((key) => !shown.has(key)));
  };

  /** Detaches every row attached to any of the parents keyed `keys` — one statement per chunk. */
  const detachAll = async (
    executor: any,
    plan: NestedRelationPlan,
    keys: any[],
    visibility: RowVisibility | undefined,
    steps: HookSteps,
    op: NestedWriteOp,
  ) => {
    for (const chunk of parentKeyChunks(keys, 1)) {
      await steps.run(
        executor
          .update(plan.targetTable)
          .set({ [plan.foreignColPropName]: null })
          .where(
            withRowVisibility(
              visibility,
              plan.targetTableName,
              plan.targetTable,
              and(inArray(plan.foreignCol, chunk), plan.ownCondition?.()),
            ),
          ),
        op,
        'update',
      );
    }
  };

  /**
   * Refuses a to-one attach whose key cannot be detached while any of the parents keyed `keys`
   * already holds a row other than the one being connected — one read per chunk of parents.
   * "Attached" is what `detachAll` would reach: the target's scope and the relation's `where`.
   * Connecting the row already attached is a no-op, and taking a row from another parent is not
   * refused: only the parents being written are checked.
   */
  const assertNothingElseAttached = async (
    executor: any,
    plan: NestedRelationPlan,
    keys: any[],
    visibility: RowVisibility | undefined,
    operation: NestedWriteOp,
    connected: SQL | undefined,
  ) => {
    // A filter that compares NULL is neither true nor false; such a row is not the connected one.
    const notConnected = connected ? sql`not coalesce((${connected}), false)` : undefined;
    for (const chunk of parentKeyChunks(keys, 1)) {
      const held = await executor
        .select({ [plan.foreignColPropName]: plan.foreignCol })
        .from(plan.targetTable)
        .where(
          withRowVisibility(
            visibility,
            plan.targetTableName,
            plan.targetTable,
            and(inArray(plan.foreignCol, chunk), plan.ownCondition?.(), notConnected),
          ),
        )
        .limit(1);
      if (held.length) {
        throw drizzleError(
          `Drizzle-GraphQL Error: cannot ${operation} through '${plan.relationName}': the parent already has a ${plan.targetTableName} row attached, and '${plan.foreignColPropName}' is NOT NULL, so that row cannot be detached. Delete it or move it to another parent first, or make '${plan.foreignColPropName}' nullable so attaching a new row detaches the old one.`,
          { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
        );
      }
    }
  };

  /**
   * A child-side foreign-key relation's inputs, applied to every parent row of the write.
   *
   * Each input runs over the whole batch before the next starts — `set`, then `disconnect`, then
   * `connect`, then `create` — and its operands are compiled once. Detaching is one statement
   * for all the parents (`foreignCol IN (…)`, chunked); attaching assigns one parent's key, so
   * `set` and `connect` run one statement per parent row and operand, in parent order: when
   * several parents select the same rows, the last parent's statement is the one that holds.
   * `create` inserts every parent's rows in one statement (chunked).
   *
   * `keys` is one entry per parent row; `distinctKeys` the same keys once each.
   */
  const applyForeignKeyOps = async (
    executor: any,
    plan: NestedRelationPlan,
    keys: any[],
    distinctKeys: any[],
    op: Record<string, any>,
    visibility: RowVisibility | undefined,
    steps: HookSteps,
    context: any,
    tableName: string,
  ) => {
    const relationName = plan.relationName;
    const attach = async (conditions: SQL[], operation: 'set' | 'connect') => {
      for (const key of keys) {
        for (const condition of conditions) {
          await steps.run(
            executor
              .update(plan.targetTable)
              .set({ [plan.foreignColPropName]: key })
              .where(condition),
            operation,
            'update',
          );
        }
      }
    };

    // Replace-the-set first, so a `set` alongside a `create` reads as "these rows, plus this
    // new one" rather than dropping the row it just inserted.
    if (supplied(op['set'])) {
      const conditions = asArray(op['set']).map((filter) => conditionOf(plan, filter, 'set', visibility));
      await detachAll(executor, plan, distinctKeys, visibility, steps, 'set');
      await attach(conditions, 'set');
    }

    if (supplied(op['disconnect'])) {
      if (plan.isOne) {
        if (op['disconnect'] === true) {
          await detachAll(executor, plan, distinctKeys, visibility, steps, 'disconnect');
        }
      } else {
        for (const filter of asArray(op['disconnect'])) {
          const condition = conditionOf(plan, filter, 'disconnect', visibility);
          for (const chunk of parentKeyChunks(distinctKeys, 1)) {
            await steps.run(
              executor
                .update(plan.targetTable)
                .set({ [plan.foreignColPropName]: null })
                .where(and(inArray(plan.foreignCol, chunk), condition)),
              'disconnect',
              'update',
            );
          }
        }
      }
    }

    const connectConditions = supplied(op['connect'])
      ? asArray(op['connect']).map((filter) => conditionOf(plan, filter, 'connect', visibility))
      : [];

    // A to-one `connect` attaches a single row, so its filter has to match exactly one —
    // checked before anything is detached, so a miss leaves the current rows in place.
    if (plan.isOne && supplied(op['connect'])) {
      const matched = await executor
        .select({ [plan.foreignColPropName]: plan.foreignCol })
        .from(plan.targetTable)
        .where(connectConditions[0]);
      if (matched.length !== 1) {
        throw connectMatchError(relationName, matched.length);
      }
    }

    // A to-one relation holds one row, so attaching a new one detaches whatever was there —
    // otherwise both rows point at this parent and the relation is ambiguous. A NOT NULL key
    // cannot be detached, so the attach is refused instead while another row holds it.
    const attachedBy = attachingOp(op);
    if (plan.isOne && attachedBy && !supplied(op['set'])) {
      if (plan.canDetach) {
        await detachAll(executor, plan, distinctKeys, visibility, steps, attachedBy);
      } else if (!(attachedBy === 'connect' && writesTargetKey(plan))) {
        const connected = attachedBy === 'connect' ? connectConditions[0] : undefined;
        await assertNothingElseAttached(executor, plan, distinctKeys, visibility, attachedBy, connected);
      }
    }

    if (supplied(op['connect'])) {
      if (writesTargetKey(plan)) {
        for (const condition of connectConditions) {
          const held = await executor
            .select({ [plan.foreignColPropName]: plan.foreignCol })
            .from(plan.targetTable)
            .where(condition);
          if (
            distinctKeys.some((key) =>
              held.some((row: any) => keyString(row[plan.foreignColPropName]) !== keyString(key)),
            )
          ) {
            throw drizzleError(
              `Drizzle-GraphQL Error: cannot connect through '${relationName}': '${plan.foreignColPropName}' is the primary key of ${plan.targetTableName}, which a connect never rewrites. A row that already holds this ${tableName} row's key is connected as it is.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }
        }
      } else {
        await attach(connectConditions, 'connect');
      }
    }

    if (supplied(op['create'])) {
      // The context values go on last: a relation whose key is one of them is never planned
      // (see dropContextValueRelations), and the server's value wins regardless.
      const rows = keys.flatMap((key) =>
        asArray(op['create']).map((row) =>
          applyContextValues(
            { ...remapFromGraphQLSingleInput(row, plan.targetTable), [plan.foreignColPropName]: key },
            stampsOf(plan.targetTableName),
            context,
          ),
        ),
      );
      for (const batch of parentKeyChunks(rows, Object.keys(getColumns(plan.targetTable)).length)) {
        await steps.run(executor.insert(plan.targetTable).values(batch), 'create', 'insert');
      }
    }
  };

  return {
    enabled: (tableName) => !!plans[tableName],

    split: (tableName, values) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return { columns: values, ops: {} };
      }
      const columns: Record<string, any> = {};
      const ops: NestedOps = {};
      for (const [key, value] of Object.entries(values)) {
        if (tablePlans[key] && supplied(value)) {
          ops[key] = suppliedOps(value);
        } else if (!tablePlans[key]) {
          columns[key] = value;
        }
      }
      return { columns, ops };
    },

    hasOps: (ops) => Object.keys(ops).length > 0,

    validate: (tableName, ops, request) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return;
      }
      const visibility = policies?.visibility?.(request?.context);
      for (const [relationName, op] of Object.entries(ops)) {
        const plan = tablePlans[relationName];
        if (!plan) {
          continue;
        }
        if (plan.isOne) {
          assertSingleOperation(plan, op);
        }
        // A to-one `disconnect` is `true`, not a filter; every object operand is compiled.
        for (const operation of FILTER_OPERATIONS) {
          for (const filter of asArray(op[operation])) {
            const isFilter = typeof filter === 'object';
            if (isFilter) {
              conditionOf(plan, filter, operation, visibility);
            }
          }
        }
      }
    },

    withJoinColumns: (tableName, ops, columns, table) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return columns;
      }
      const allColumns = getColumns(table);
      for (const relationName of Object.keys(ops)) {
        const plan = tablePlans[relationName];
        // Child-side operations attach by this key; parent-side ones are checked against it
        // (see `checkParentSide`), along with the primary key an inherited `where` needs.
        if (plan && !(plan.localColPropName in columns) && allColumns[plan.localColPropName]) {
          (columns as any)[plan.localColPropName] = allColumns[plan.localColPropName];
        }
        if (plan?.fkSide === 'parent' && plan.parentHidden) {
          for (const [name, column] of Object.entries(plan.parentKeyColumns ?? {})) {
            if (!(name in columns)) {
              (columns as any)[name] = column;
            }
          }
        }
      }
      // A self-referencing write reads the parent rows back by primary key — see `refreshed`.
      for (const name of selfTargetingPlan(tablePlans, tableName, ops)?.targetPrimaryKey ?? []) {
        if (!(name in columns) && allColumns[name]) {
          (columns as any)[name] = allColumns[name];
        }
      }
      return columns;
    },

    createsParentSide: (tableName, ops) =>
      Object.entries(ops).some(
        ([relationName, op]) => plans[tableName]?.[relationName]?.fkSide === 'parent' && supplied(op?.['create']),
      ),

    refreshed: async (executor, tableName, ops, rows) => {
      const plan = selfTargetingPlan(plans[tableName], tableName, ops);
      const pk = plan?.targetPrimaryKey ?? [];
      if (!plan || !pk.length || !rows.length || !pk.every((name) => name in rows[0]!)) {
        return rows;
      }
      const columns = getColumns(plan.targetTable) as Record<string, Column>;
      const selection = Object.fromEntries(
        Object.keys(rows[0]!)
          .filter((name) => columns[name])
          .map((name) => [name, columns[name]!]),
      );
      const keyOf = (row: Record<string, any>) => pk.map((name) => keyString(row[name])).join('\u0000');
      const pkCols = pk.map((name) => columns[name]!);
      const fresh = new Map<string, Record<string, any>>();
      for (const chunk of parentKeyChunks(rows, pk.length)) {
        const match = parentKeyCondition(
          pkCols,
          chunk.map((row) => pk.map((name) => row[name])),
        );
        for (const row of (await executor.select(selection).from(plan.targetTable).where(match)) as Record<
          string,
          any
        >[]) {
          fresh.set(keyOf(row), row);
        }
      }
      return rows.map((row) => ({ ...row, ...fresh.get(keyOf(row)) }));
    },

    applyParentSide: async (executor, tableName, ops, request, existing = false) => {
      const tablePlans = plans[tableName];
      const result: ParentSidePatch = { values: {}, expected: {}, existing };
      const patch = result.values;
      if (!tablePlans) {
        return result;
      }
      const context = request?.context;
      const visibility = policies?.visibility?.(context);

      for (const [relationName, op] of Object.entries(ops)) {
        const plan = tablePlans[relationName];
        if (plan?.fkSide !== 'parent') {
          continue;
        }
        assertSingleOperation(plan, op);

        if (supplied(op['create'])) {
          // The only parent-side input that writes the target: `connect` and `disconnect`
          // change the parent's own column, which the parent's own hooks already cover.
          const steps = createHookSteps(onWrite, executor, request, tableName, plan);
          steps.add('create', 'insert');
          await steps.before();
          const values = applyContextValues(
            remapFromGraphQLSingleInput(op['create'], plan.targetTable),
            stampsOf(plan.targetTableName),
            context,
          );
          // The hook's RETURNING always includes the join column, which the patch reads.
          const step = steps.get('create', 'insert');
          const inserted = await executor
            .insert(plan.targetTable)
            .values(values)
            .returning(step ? step.returning : { [plan.foreignColPropName]: plan.foreignCol });
          step?.rows.push(...inserted);
          const created = inserted[0];
          if (!created) {
            throw drizzleError(
              `Drizzle-GraphQL Error: 'create' on '${relationName}' inserted no row, so there is nothing to attach.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }
          await steps.after();
          patch[plan.localColPropName] = created[plan.foreignColPropName];
          result.expected[relationName] = created[plan.foreignColPropName];
        } else if (supplied(op['connect'])) {
          // `rows.length` drives the match check and is unaffected by the projection, so the
          // read asks only for the key that ends up on the parent's patch.
          const rows = await executor
            .select({ [plan.foreignColPropName]: plan.foreignCol })
            .from(plan.targetTable)
            .where(conditionOf(plan, op['connect'], 'connect', visibility));
          if (rows.length !== 1) {
            throw connectMatchError(relationName, rows.length);
          }
          const key = rows[0][plan.foreignColPropName];
          // Replacing the key detaches the row it pointed at, which the relation's own `where`
          // may hide. Such a row keeps its key, and `checkParentSide` refuses the connect.
          patch[plan.localColPropName] = existing ? keepingHidden(plan, key) : key;
          result.expected[relationName] = key;
        } else if (op['disconnect'] === true) {
          // A row the relation's own `where` hides is out of a disconnect's reach, as it is
          // child-side: the key is cleared only where it points at a row the relation shows.
          patch[plan.localColPropName] = existing ? keepingHidden(plan, null) : null;
          // Only an upsert's input offers this without `existing`, and its conflict branch
          // has to write the cleared key, as it has to write a connected one. A key it kept
          // because the relation's `where` hides its row is allowed (see `checkParentSide`).
          if (!existing) {
            result.expected[relationName] = null;
          }
        }
      }

      // A context-derived column is the server's to set, never a nested input's. No relation
      // whose key is one is planned (see dropContextValueRelations); this keeps the patch from
      // ever overriding the stamped value, or reassigning it on an update, regardless.
      for (const columnName of Object.keys(contextValues?.(tableName) ?? {})) {
        delete patch[columnName];
      }
      return result;
    },

    checkParentSide: async (executor, tableName, ops, rows, patch) => {
      const tablePlans = plans[tableName];
      if (!tablePlans || !rows.length) {
        return;
      }
      for (const relationName of Object.keys(ops)) {
        const plan = tablePlans[relationName];
        if (plan?.fkSide !== 'parent') {
          continue;
        }
        if (relationName in patch.expected) {
          const expected = keyString(patch.expected[relationName]);
          const mismatched = rows.filter((row) => keyString(row[plan.localColPropName]) !== expected);
          if (mismatched.length) {
            const hiddenError = drizzleError(
              `Drizzle-GraphQL Error: cannot connect through '${relationName}': the row it holds now is one its \`where\` hides, which a write through it cannot detach.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
            // On an update the key is only ever kept because its row is hidden.
            if (patch.existing) {
              throw hiddenError;
            }
            // An upsert's conflict branch either kept a hidden key (see `guardConflictSet`) or
            // did not write the key at all, and the two read the same from the row alone.
            const hidden = await hiddenKeys(
              executor,
              plan,
              mismatched.map((row) => row[plan.localColPropName]),
            );
            if (mismatched.some((row) => !hidden.has(keyString(row[plan.localColPropName])))) {
              throw drizzleError(
                `Drizzle-GraphQL Error: cannot write through '${relationName}': the ${tableName} row was not written with it — an upsert whose conflict branch did not write '${plan.localColPropName}'. Include it in onConflict.update, or leave update unset.`,
                { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
              );
            }
            // A disconnect that leaves a hidden row attached is what an update does too.
            if (ops[relationName]?.['disconnect'] !== true) {
              throw hiddenError;
            }
          }
        }
        if (plan.parentHidden && (await plan.parentHidden(executor, rows))) {
          throw drizzleError(
            `Drizzle-GraphQL Error: cannot write through '${relationName}': its \`where\` hides the relation on this ${tableName} row.`,
            { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
          );
        }
      }
    },

    guardConflictSet: (tableName, ops, set) => {
      const tablePlans = plans[tableName];
      let guarded = set;
      for (const relationName of Object.keys(ops)) {
        const plan = tablePlans?.[relationName];
        if (plan?.fkSide === 'parent' && plan.ownCondition && set[plan.localColPropName]) {
          guarded = { ...guarded, [plan.localColPropName]: keepingHiddenSql(plan, set[plan.localColPropName]!) };
        }
      }
      return guarded;
    },

    applyChildSide: async (executor, tableName, ops, parentRows, request) => {
      const tablePlans = plans[tableName];
      if (!tablePlans) {
        return;
      }
      const context = request?.context;
      const visibility = policies?.visibility?.(context);

      for (const [relationName, op] of Object.entries(ops)) {
        const plan = tablePlans[relationName];
        if (plan?.fkSide !== 'child') {
          continue;
        }
        if (plan.isOne) {
          assertSingleOperation(plan, op);
        }

        // One hook call per input and operation for the whole batch of parent rows: an update
        // matching several rows writes each one's children, and the hook sees them together.
        const steps = createHookSteps(onWrite, executor, request, tableName, plan);
        registerChildSteps(
          steps,
          plan,
          op,
          !!(plan.through?.tableName && policies?.softDelete?.(plan.through.tableName)),
        );
        await steps.before();

        // Every statement below covers the whole batch of parent rows: an operand selects the
        // same rows whichever parent it is applied to, so it is compiled (and, through a
        // junction, read) once; only a statement that writes one parent's key is run per parent.
        const keys = parentRows.map((parentRow) => {
          const key = parentRow?.[plan.localColPropName];
          if (key === undefined || key === null) {
            throw drizzleError(
              `Drizzle-GraphQL Error: cannot write through '${relationName}': the ${tableName} row has no '${plan.localColPropName}' value to attach to.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }
          return key;
        });
        const seenKeys = new Set<string>();
        const distinctKeys = keys.filter((key) => !seenKeys.has(keyString(key)) && !!seenKeys.add(keyString(key)));

        if (distinctKeys.length) {
          if (plan.parentKeysHidden && (await plan.parentKeysHidden(executor, distinctKeys))) {
            throw drizzleError(
              `Drizzle-GraphQL Error: cannot write through '${relationName}': its \`where\` hides the relation on this ${tableName} row.`,
              { code: 'DRIZZLE_NESTED_WRITE_INVALID' },
            );
          }

          if (plan.through) {
            await applyThroughOps(executor, plan, distinctKeys, op, visibility, steps, context);
          } else {
            await applyForeignKeyOps(executor, plan, keys, distinctKeys, op, visibility, steps, context, tableName);
          }
        }

        await steps.after();
      }
    },
  };
};
