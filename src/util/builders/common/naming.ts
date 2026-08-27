// Table key to GraphQL type name, through the caller's `typeNameMapper`.

import { capitalize } from '../../case-ops/index.ts';

/** Optional mapper from table key to singular/plural name pair. Return undefined to use default naming for a table. */
export type TypeNameMapper = (tableName: string) => { singular: string; plural: string } | undefined;

/** Produce the GraphQL object type name for a table, using the mapper if provided. */
export const resolveTypeName = (name: string, typeNameMapper?: TypeNameMapper): string => {
  const mapped = typeNameMapper?.(name);
  return mapped ? capitalize(mapped.singular) : capitalize(name);
};
