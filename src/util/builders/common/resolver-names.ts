// The field names one table's generated resolvers get, after prefixes, suffixes and the
// type-name mapper have been applied.

import { capitalize, uncapitalize } from '../../case-ops/index.ts';
import type { TypeNameMapper } from './naming.ts';

/** The query and mutation field names one table generates. */
export type ResolverFieldNames = {
  typeName: string;
  listFieldName: string;
  singleFieldName: string;
  aggregateFieldName: string;
  groupByFieldName: string;
  createArrayFieldName: string;
  createSingleFieldName: string;
  upsertArrayFieldName: string;
  upsertSingleFieldName: string;
  updateFieldName: string;
  updateManyFieldName: string;
  updateSingleFieldName: string;
  updateCountFieldName: string;
  deleteFieldName: string;
  deleteSingleFieldName: string;
  restoreFieldName: string;
  restoreSingleFieldName: string;
  deleteCountFieldName: string;
};

/**
 * Derives the generated query/mutation field names for a table from the naming config
 * (typeNameMapper + prefixes/suffixes). Shared by all three dialect builders.
 */
export const computeResolverFieldNames = (
  tableName: string,
  typeNameMapper: TypeNameMapper | undefined,
  prefixes: { insert: string; update: string; delete: string; upsert?: string; restore?: string },
  suffixes: { list: string; single: string },
): ResolverFieldNames => {
  const mapped = typeNameMapper?.(tableName);
  const typeName = mapped ? capitalize(mapped.singular) : capitalize(tableName);
  const listFieldName = (mapped?.plural ?? uncapitalize(tableName)) + suffixes.list;
  const singleFieldName = mapped?.singular ?? uncapitalize(tableName) + suffixes.single;
  const aggregateFieldName = `${mapped?.plural ?? uncapitalize(tableName)}Aggregate`;
  const groupByFieldName = `${mapped?.plural ?? uncapitalize(tableName)}GroupBy`;
  const createArrayFieldName = `${prefixes.insert}${mapped ? capitalize(mapped.plural) : capitalize(tableName)}`;
  const createSingleFieldName = mapped
    ? `${prefixes.insert}${capitalize(mapped.singular)}`
    : `${prefixes.insert}${capitalize(tableName)}${suffixes.single}`;
  const upsertPrefix = prefixes.upsert ?? 'upsert';
  const upsertArrayFieldName = `${upsertPrefix}${mapped ? capitalize(mapped.plural) : capitalize(tableName)}`;
  const upsertSingleFieldName = mapped
    ? `${upsertPrefix}${capitalize(mapped.singular)}`
    : `${upsertPrefix}${capitalize(tableName)}${suffixes.single}`;
  const updateFieldName = `${prefixes.update}${mapped ? capitalize(mapped.singular) : capitalize(tableName)}`;
  // The batch variant is plural like the array insert/upsert, with an explicit `Many`
  // suffix so it never collides with the single-set update.
  const updateManyFieldName = `${prefixes.update}${mapped ? capitalize(mapped.plural) : capitalize(tableName)}Many`;
  const deleteFieldName = `${prefixes.delete}${mapped ? capitalize(mapped.singular) : capitalize(tableName)}`;
  // The soft-delete counterpart, named the same way so `deleteUser` / `restoreUser` read as a
  // pair however the delete prefix and the single suffix are configured.
  const restoreFieldName = `${prefixes.restore ?? 'restore'}${mapped ? capitalize(mapped.singular) : capitalize(tableName)}`;
  // The plural update/delete mutations already use the singular noun when a mapper is
  // present, so — unlike create — the Single variants can't rely on singular vs plural to
  // stay distinct. They always carry a suffix, falling back to 'Single' when the configured
  // suffix is empty (a mapper config may set it to '' for the query side).
  const writeSingleSuffix = suffixes.single === '' ? 'Single' : suffixes.single;
  const updateSingleFieldName = `${updateFieldName}${writeSingleSuffix}`;
  const deleteSingleFieldName = `${deleteFieldName}${writeSingleSuffix}`;
  const restoreSingleFieldName = `${restoreFieldName}${writeSingleSuffix}`;
  // The count variants are the plural write under another name, so they take the plural
  // noun rather than the singular one the plural mutations inherited from the mapper.
  const pluralNoun = mapped ? capitalize(mapped.plural) : capitalize(tableName);
  const updateCountFieldName = `${prefixes.update}${pluralNoun}Count`;
  const deleteCountFieldName = `${prefixes.delete}${pluralNoun}Count`;
  return {
    typeName,
    listFieldName,
    singleFieldName,
    aggregateFieldName,
    groupByFieldName,
    createArrayFieldName,
    createSingleFieldName,
    upsertArrayFieldName,
    upsertSingleFieldName,
    updateFieldName,
    updateManyFieldName,
    updateSingleFieldName,
    updateCountFieldName,
    deleteFieldName,
    deleteSingleFieldName,
    restoreFieldName,
    restoreSingleFieldName,
    deleteCountFieldName,
  };
};
