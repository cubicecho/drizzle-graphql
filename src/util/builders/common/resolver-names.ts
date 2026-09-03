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
  const restorePrefix = prefixes.restore ?? 'restore';
  // update/delete/restore are named the way create and upsert are: the plural noun on the
  // form that operates on a set of rows, the singular noun on the one that operates on one.
  // They used to put the *singular* noun on the list form — they filter rather than
  // enumerate — which read as a single-row operation and was not one (`deleteUser(where:)`
  // deleting every match), and which left the one-row variant no name but `Single` even
  // under a mapper whose singular/plural pair had already separated every other operation.
  const updateFieldName = `${prefixes.update}${pluralNoun}${suffixes.list}`;
  // The batch variant is plural like the array insert/upsert, with an explicit `Many`
  // suffix so it never collides with the single-set update.
  const updateManyFieldName = `${prefixes.update}${pluralNoun}Many`;
  const deleteFieldName = `${prefixes.delete}${pluralNoun}${suffixes.list}`;
  // The soft-delete counterpart, named the same way so `deleteUsers` / `restoreUsers` and
  // `deleteUser` / `restoreUser` read as pairs however the prefixes and suffixes are set.
  const restoreFieldName = `${restorePrefix}${pluralNoun}${suffixes.list}`;
  // With a mapper the singular noun is separation enough, exactly as it is for the single
  // query and the single insert, so those take no suffix at all. Without one both nouns are
  // the table key and `suffixes.single` is what separates the pair — the same string the
  // single query is separated by, so a build where it cannot separate them has already
  // failed on the queries (or, with no mapper at all, on the suffix check in `buildSchema`)
  // before reaching here. These used to carry a 'Single' fallback for that case; it was
  // unreachable once the list forms above stopped taking the singular noun.
  const singleWrite = (prefix: string) =>
    mapped ? `${prefix}${singularNoun}` : `${prefix}${singularNoun}${suffixes.single}`;
  const updateSingleFieldName = singleWrite(prefixes.update);
  const deleteSingleFieldName = singleWrite(prefixes.delete);
  const restoreSingleFieldName = singleWrite(restorePrefix);
  // The count variants are the plural write under another name, so they take the plural
  // noun the plural writes take. Their explicit `Count` is the disambiguator, so they take
  // no configured suffix.
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
