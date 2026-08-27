// Table key to GraphQL type name, through the caller's `typeNameMapper`.

import { capitalize } from '../../case-ops/index.ts';
import type { TypeNameResolver } from './type-names.ts';

/** Optional mapper from table key to singular/plural name pair. Return undefined to use default naming for a table. */
export type TypeNameMapper = (tableName: string) => { singular: string; plural: string } | undefined;

/** Produce the GraphQL object type name for a table, using the mapper if provided. */
export const resolveTypeName = (name: string, typeNameMapper?: TypeNameMapper): string => {
  const mapped = typeNameMapper?.(name);
  return mapped ? capitalize(mapped.singular) : capitalize(name);
};

/**
 * The name a table's object type actually carries in the built schema — {@link resolveTypeName}
 * put through the build's naming rule. Resolvers read selections out of
 * `fieldsByTypeName`, which is keyed by the real type name, so anything that walks a
 * selection tree has to ask for the name this way rather than assuming the default.
 */
export const resolveObjectTypeName = (
  name: string,
  typeNameMapper?: TypeNameMapper,
  resolveName?: TypeNameResolver,
): string => applyObjectTypeName(resolveTypeName(name, typeNameMapper), name, resolveName);

/** {@link resolveObjectTypeName} for a caller that already holds the table's default type name. */
export const applyObjectTypeName = (defaultName: string, tableName: string, resolveName?: TypeNameResolver): string =>
  resolveName ? resolveName({ kind: 'object', defaultName, table: tableName }) : defaultName;
