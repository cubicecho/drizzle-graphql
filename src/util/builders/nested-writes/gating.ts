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
