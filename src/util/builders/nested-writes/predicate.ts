import type { NestedWritesSwitch } from '../../../types.ts';

import type { NestedWritePlans } from './plans.ts';

/**
 * Narrows every plan's `allowed` inputs to the ones a `features.nestedWrites` predicate lets
 * through, dropping a plan left with nothing and a table left with no plans.
 *
 * @param plans - The build's nested-write plans, narrowed in place.
 * @param nestedWrites - The configured switch; anything but a predicate leaves the plans as they are.
 *
 * @remarks
 * Run before the feature gate, so an input the caller turned off here is never reported as one
 * the target's own switches took away. Nothing is noted for what the predicate removes, since
 * the caller asked for it.
 */
export const restrictNestedWritePlans = (plans: NestedWritePlans, nestedWrites: NestedWritesSwitch | undefined) => {
  if (typeof nestedWrites !== 'function') {
    return;
  }
  for (const [tableName, tablePlans] of Object.entries(plans)) {
    for (const [relationName, plan] of Object.entries(tablePlans)) {
      for (const op of [...plan.allowed]) {
        // Anything truthy is a yes, as with the per-table feature predicates.
        const isOffered = nestedWrites({ table: tableName, relation: relationName, target: plan.targetTableName, op });
        if (!isOffered) {
          plan.allowed.delete(op);
        }
      }
      if (plan.allowed.size === 0) {
        delete tablePlans[relationName];
      }
    }
    if (Object.keys(tablePlans).length === 0) {
      delete plans[tableName];
    }
  }
};
