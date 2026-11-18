// Which columns a client may set through a write input: the one rule the create, update,
// upsert, conflict and nested-create inputs all share.

import type { Column } from 'drizzle-orm';
import { type InputWrite, isInputExcluded } from './exclusions.ts';
import type { TypeCacheCtx } from './type-cache.ts';

/** The build's policies that take a column out of a write input. */
export type WritePolicies = Pick<TypeCacheCtx, 'contextValuesOf' | 'softDeleteOf' | 'registries'>;

const ALWAYS = 'always';

/**
 * A column whose value the database always computes: `generatedAlwaysAs` (stored or virtual)
 * or PostgreSQL's `generatedAlwaysAsIdentity`. Drizzle drops a supplied value on insert and the
 * database rejects one on update, so no input offers it. Identity BY DEFAULT stays writable.
 */
export const isDatabaseOwnedColumn = (column: Column): boolean => {
  const generatedAlways = column.generated !== undefined && (column.generated.type ?? ALWAYS) === ALWAYS;
  return generatedAlways || column.generatedIdentity?.type === ALWAYS;
};

/**
 * Whether a client may set `columnName` on a create or an update of `tableName`. Database-owned
 * columns, `contextValues` columns (the server stamps them) and the soft-delete marker (only
 * delete and restore write it) are never writable; a column `exclude.inputs` names is not
 * writable by that one write.
 */
export const isWritableColumn = (
  policies: WritePolicies,
  tableName: string,
  columnName: string,
  column: Column,
  write: InputWrite,
): boolean => {
  const contextColumns = policies.contextValuesOf?.(tableName);
  const fromContext = !!contextColumns && Object.keys(contextColumns).includes(columnName);
  const isMarker = policies.softDeleteOf?.(tableName)?.columnName === columnName;
  const isLeftOut = isInputExcluded(policies.registries.inputExclusions, tableName, columnName, write);
  return !fromContext && !isMarker && !isLeftOut && !isDatabaseOwnedColumn(column);
};
