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
  const pluralNoun = mapped ? capitalize(mapped.plural) : capitalize(tableName);
  const singularNoun = mapped ? capitalize(mapped.singular) : capitalize(tableName);
  // The write mutations take the same two suffixes the queries do, and in the same places:
  // `list` on the form that operates on a set of rows, `single` on the one that operates on
  // one. They used to take only `single`, so a build that renamed the list side got
  // `usersAll` on the query and a bare `createUsers` next to it — and, worse, a
  // `{ list: 'All', single: '' }` build silently lost the array insert, because both insert
  // mutations resolved to `createUsers` and the second registration overwrote the first.
  const createArrayFieldName = `${prefixes.insert}${pluralNoun}${suffixes.list}`;
  const createSingleFieldName = mapped
    ? `${prefixes.insert}${capitalize(mapped.singular)}`
    : `${prefixes.insert}${capitalize(tableName)}${suffixes.single}`;
  const upsertPrefix = prefixes.upsert ?? 'upsert';
  const upsertArrayFieldName = `${upsertPrefix}${pluralNoun}${suffixes.list}`;
  const upsertSingleFieldName = mapped
    ? `${upsertPrefix}${capitalize(mapped.singular)}`
    : `${upsertPrefix}${capitalize(tableName)}${suffixes.single}`;
  // The plural update/delete/restore mutations take the singular noun — they filter rather
  // than enumerate — so, unlike create, they cannot rely on singular vs plural to stay
  // distinct from their Single variants. The suffixes are what separates them.
  const updateBase = `${prefixes.update}${singularNoun}`;
  const deleteBase = `${prefixes.delete}${singularNoun}`;
  // The soft-delete counterpart, named the same way so `deleteUser` / `restoreUser` read as a
  // pair however the delete prefix and the suffixes are configured.
  const restoreBase = `${prefixes.restore ?? 'restore'}${singularNoun}`;
  const updateFieldName = `${updateBase}${suffixes.list}`;
  // The batch variant is plural like the array insert/upsert, with an explicit `Many`
  // suffix so it never collides with the single-set update.
  const updateManyFieldName = `${prefixes.update}${pluralNoun}Many`;
  const deleteFieldName = `${deleteBase}${suffixes.list}`;
  const restoreFieldName = `${restoreBase}${suffixes.list}`;
  // An empty `single` suffix means "no suffix", the same as it does on the query side —
  // except when it would name the Single variant exactly what the list variant above is
  // called. That happens only when both suffixes are the same string, which `buildSchema`
  // already rejects unless a `typeNameMapper` is present; the mapper's singular/plural pair
  // rescues the queries but not these three, which are singular on both sides. There, and
  // only there, the Single variants keep the 'Single' they have always had.
  const writeSingleSuffix = suffixes.single === suffixes.list ? 'Single' : suffixes.single;
  const updateSingleFieldName = `${updateBase}${writeSingleSuffix}`;
  const deleteSingleFieldName = `${deleteBase}${writeSingleSuffix}`;
  const restoreSingleFieldName = `${restoreBase}${writeSingleSuffix}`;
  // The count variants are the plural write under another name, so they take the plural
  // noun rather than the singular one the plural mutations inherited from the mapper. Their
  // explicit `Count` is the disambiguator, so they take no configured suffix.
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
