import type { InputWrite } from '../common/exclusions.ts';
import type { NestedWriteOp } from '../common/write-hooks.ts';
import type { ContextValuesFor } from '../common.ts';
import type { TableFeatures } from '../types.ts';

import type { NestedRelationPlan, NestedWritePlans } from './plans.ts';

/** The writes one relation-field input performs, as `[table, operation]` pairs. */
type RequiredWrite = { tableName: string | undefined; feature: 'insert' | 'update' | 'delete' };

/**
 * Which of the target's (or junction's) write features each input of a relation needs. A
 * parent-side `connect` / `disconnect` only rewrites the parent's own column, so it needs
 * nothing of the target; a child-side one moves the target's foreign key, which is an update
 * of the target. A to-one child-side `create` also detaches the row attached before it, when
 * the key is nullable. Linking through a soft-deleting junction can restore a marked link row
 * with an update instead of inserting one.
 */
const requiredWrites = (
  plan: NestedRelationPlan,
  op: NestedWriteOp,
  softDeletes: (tableName: string) => boolean,
): RequiredWrite[] => {
  if (plan.through) {
    const junction = plan.through.tableName;
    const links: RequiredWrite[] = [{ tableName: junction, feature: 'insert' }];
    if (junction !== undefined && softDeletes(junction)) {
      links.push({ tableName: junction, feature: 'update' });
    }
    if (op === 'connect') {
      return links;
    }
    if (op === 'disconnect') {
      return [{ tableName: junction, feature: 'delete' }];
    }
    if (op === 'set') {
      return [{ tableName: junction, feature: 'delete' }, ...links];
    }
    return [];
  }
  const target = plan.targetTableName;
  if (op === 'create') {
    const detaches = plan.fkSide === 'child' && plan.isOne && plan.canDetach;
    return detaches
      ? [
          { tableName: target, feature: 'insert' },
          { tableName: target, feature: 'update' },
        ]
      : [{ tableName: target, feature: 'insert' }];
  }
  return plan.fkSide === 'child' ? [{ tableName: target, feature: 'update' }] : [];
};

/**
 * Narrows every plan's `allowed` inputs to the ones whose writes the table they land on
 * permits: its `features.insert` / `update` / `delete`, and for a junction table that it is
 * not excluded. A plan left with nothing is dropped, so its relation field is not generated.
 * `softDeletes` says which tables have a soft-delete marker.
 *
 * Returns one line per input taken out, for the build note.
 */
export const gateNestedWritePlans = (
  plans: NestedWritePlans,
  featureOf: (tableName: string) => TableFeatures,
  isExcluded: (tableName: string) => boolean,
  softDeletes: (tableName: string) => boolean,
): string[] => {
  const omitted: string[] = [];
  for (const [tableName, tablePlans] of Object.entries(plans)) {
    for (const [relationName, plan] of Object.entries(tablePlans)) {
      for (const op of [...plan.allowed]) {
        const blocked = requiredWrites(plan, op, softDeletes).filter(
          ({ tableName: target, feature }) =>
            target !== undefined && (isExcluded(target) || !featureOf(target)[feature]),
        );
        if (blocked.length) {
          plan.allowed.delete(op);
          const reasons = blocked.map(({ tableName: target, feature }) =>
            isExcluded(target!) ? `${target} is excluded` : `${target}.${feature} is off`,
          );
          omitted.push(`${tableName}.${relationName}.${op} (${[...new Set(reasons)].join(', ')})`);
        }
      }
      if (!plan.allowed.size) {
        delete tablePlans[relationName];
      }
    }
    if (!Object.keys(tablePlans).length) {
      delete plans[tableName];
    }
  }
  return omitted;
};

/**
 * Takes out every relation whose foreign key is a `contextValues` column of the table storing
 * it — the parent's own column for a parent-side relation, the target's for a child-side one,
 * either junction column for a many-to-many.
 *
 * Every operation on such a relation writes that column: `connect`, `disconnect` and `set`
 * by definition, and a child-side `create` too, since it fills the key in from the parent row
 * rather than from context. That column is the server's to set — an insert stamps it and an
 * update never touches it — so writing it from a nested input would let a client pick, or
 * change, the owner the server assigns. Whole relations are dropped, not single inputs: no
 * operation on them is left that does not write the key.
 *
 * Returns one line per relation taken out, for the build note.
 */
export const dropContextValueRelations = (
  plans: NestedWritePlans,
  contextValuesOf: ContextValuesFor | undefined,
): string[] => {
  const omitted: string[] = [];
  if (!contextValuesOf) {
    return omitted;
  }
  for (const [tableName, tablePlans] of Object.entries(plans)) {
    for (const [relationName, plan] of Object.entries(tablePlans)) {
      const keys: [string | undefined, string][] = plan.through
        ? [
            [plan.through.tableName, plan.through.sourceColPropName],
            [plan.through.tableName, plan.through.targetColPropName],
          ]
        : plan.fkSide === 'parent'
          ? [[tableName, plan.localColPropName]]
          : [[plan.targetTableName, plan.foreignColPropName]];
      const stamped = keys.find(([owner, column]) => owner !== undefined && contextValuesOf(owner)?.[column]);
      if (stamped) {
        delete tablePlans[relationName];
        omitted.push(`${tableName}.${relationName} (${stamped[0]}.${stamped[1]} is a contextValues column)`);
      }
    }
    if (!Object.keys(tablePlans).length) {
      delete plans[tableName];
    }
  }
  return omitted;
};

/** One column a nested input writes, and which write of its table writes it. */
type ColumnWrite = { tableName: string | undefined; columnName: string; write: InputWrite };

/**
 * The key columns one input of a relation writes. A child-side `create` fills the target's foreign
 * key in as it inserts the row, and its `connect` / `disconnect` / `set` move that key, an update.
 * A many-to-many `connect` or `set` inserts junction rows with both of its columns. A parent-side
 * relation writes the parent's own key, whose writes {@link dropInputExcludedWrites} decides whole.
 */
const keyWrites = (plan: NestedRelationPlan, op: NestedWriteOp): ColumnWrite[] => {
  if (plan.through) {
    const { tableName, sourceColPropName, targetColPropName } = plan.through;
    return op === 'connect' || op === 'set'
      ? [
          { tableName, columnName: sourceColPropName, write: 'insert' },
          { tableName, columnName: targetColPropName, write: 'insert' },
        ]
      : [];
  }
  if (plan.fkSide === 'parent') {
    return [];
  }
  const key = { tableName: plan.targetTableName, columnName: plan.foreignColPropName };
  if (op === 'create') {
    const detaches = plan.isOne && plan.canDetach;
    return detaches
      ? [
          { ...key, write: 'insert' },
          { ...key, write: 'update' },
        ]
      : [{ ...key, write: 'insert' }];
  }
  return [{ ...key, write: 'update' }];
};

/**
 * Takes out the nested inputs that would write a key column `exclude.inputs` keeps out of that
 * write, so a column a client may not change cannot be changed by moving a relation either. A
 * parent-side relation writes the parent's own key from its create and its update input alike, so
 * a key left out of either write takes the whole relation out.
 *
 * Returns one line per input or relation taken out, for the build note.
 */
export const dropInputExcludedWrites = (
  plans: NestedWritePlans,
  isExcluded: (tableName: string, columnName: string, write: InputWrite) => boolean,
): string[] => {
  const omitted: string[] = [];
  for (const [tableName, tablePlans] of Object.entries(plans)) {
    for (const [relationName, plan] of Object.entries(tablePlans)) {
      const isParentSide = !plan.through && plan.fkSide === 'parent';
      if (isParentSide) {
        const column = plan.localColPropName;
        const leftOut = (['insert', 'update'] as const).filter((write) => isExcluded(tableName, column, write));
        if (leftOut.length) {
          delete tablePlans[relationName];
          omitted.push(`${tableName}.${relationName} (${tableName}.${column} is left out of ${leftOut.join(' and ')})`);
        }
        continue;
      }
      for (const op of [...plan.allowed]) {
        const blocked = keyWrites(plan, op).find(
          ({ tableName: owner, columnName, write }) => owner !== undefined && isExcluded(owner, columnName, write),
        );
        if (blocked) {
          plan.allowed.delete(op);
          omitted.push(
            `${tableName}.${relationName}.${op} (${blocked.tableName}.${blocked.columnName} is left out of ${blocked.write})`,
          );
        }
      }
      if (!plan.allowed.size) {
        delete tablePlans[relationName];
      }
    }
    if (!Object.keys(tablePlans).length) {
      delete plans[tableName];
    }
  }
  return omitted;
};
