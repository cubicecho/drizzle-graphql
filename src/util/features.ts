import type { SchemaFeatures } from '../types.ts';
import type { TableFeatures } from './builders/types.ts';

/**
 * What a table generates when the config says nothing. Everything is on except the opt-in
 * features, so a build with no `features` block generates what it always did.
 */
export const featureDefaults: TableFeatures = {
  aggregates: true,
  groupBy: true,
  relationAggregates: true,
  distinct: true,
  insert: true,
  update: true,
  updateMany: true,
  delete: true,
  upsert: false,
  fieldUpdateOperations: false,
  countMutations: false,
  requireWhere: false,
  uniqueKeyFilters: false,
};

/**
 * Turns `BuildSchemaConfig.features` — booleans, per-table predicates, or nothing at all —
 * into a lookup the generators can ask about one table. Memoized, so a predicate is run once
 * per table however many places consult it.
 */
export const resolveTableFeatures = (features: SchemaFeatures | undefined): ((tableName: string) => TableFeatures) => {
  const cache = new Map<string, TableFeatures>();
  const names = Object.keys(featureDefaults) as (keyof TableFeatures)[];
  return (tableName: string): TableFeatures => {
    let resolved = cache.get(tableName);
    if (!resolved) {
      resolved = {} as TableFeatures;
      for (const name of names) {
        const configured = features?.[name];
        // A predicate answering with something other than a boolean is answering "yes" for
        // anything truthy, matching how the flags read everywhere else.
        resolved[name] =
          configured === undefined
            ? featureDefaults[name]
            : typeof configured === 'function'
              ? !!configured(tableName)
              : !!configured;
      }
      cache.set(tableName, resolved);
    }
    return resolved;
  };
};
