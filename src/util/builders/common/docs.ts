// The descriptions generated fields and inputs carry, assembled from the Drizzle schema and
// whatever the caller passed in `docs`.

import type { Column } from 'drizzle-orm';
import { GraphQLNonNull } from 'graphql';
import type { SchemaDocs } from '../../type-converter/types.ts';

/**
 * The `description` / `deprecationReason` a column field should carry, from the build's
 * documentation hooks. Both are omitted rather than set to `undefined` so a field config
 * built by spreading this stays identical to one built without it.
 */
export const columnDocs = (
  docs: SchemaDocs,
  column: Column,
  tableName: string,
  columnName: string,
): { description?: string; deprecationReason?: string } => {
  const description = docs.describeColumn?.(column, { tableName, columnName });
  const deprecationReason = docs.deprecateColumn?.(column, { tableName, columnName });
  return {
    ...(description !== undefined ? { description } : {}),
    ...(deprecationReason !== undefined ? { deprecationReason } : {}),
  };
};

/**
 * A required input field cannot be deprecated — graphql-js rejects the schema outright, since
 * a client has no way to stop sending it. `deprecateColumn` is written against the column, not
 * against each generated input, so drop the reason where it cannot apply rather than making
 * the caller predict which inputs made the column non-null.
 */
export const inputFieldDocs = (
  docs: SchemaDocs,
  column: Column,
  tableName: string,
  columnName: string,
  fieldType: unknown,
): { description?: string; deprecationReason?: string } => {
  const resolved = columnDocs(docs, column, tableName, columnName);
  if (resolved.deprecationReason !== undefined && fieldType instanceof GraphQLNonNull) {
    const { deprecationReason: _dropped, ...rest } = resolved;
    return rest;
  }
  return resolved;
};
