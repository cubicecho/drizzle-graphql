// A table's compound unique constraints as `where` fields: the input a lookup by natural key
// is spelled with, and the SQL it compiles to.
//
// The library already knows every unique constraint — `onConflict`'s `target` is validated
// against them — but only on the write side. A read by a two-column natural key had to be
// spelled as two ordinary filters, which reads as a partial filter that happens to return one
// row, and stays valid when half of it goes missing. A key field says the same thing in one
// place, with every member required.

import type { Column, Table } from 'drizzle-orm';
import { and, eq, getColumns, type SQL } from 'drizzle-orm';
import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { capitalize } from '../../case-ops/index.ts';
import { remapFromGraphQLCore } from '../../data-mappers/index.ts';
import { drizzleColumnToGraphQLType } from '../../type-converter/index.ts';
import type { ConvertedInputColumn, NullableConvertedColumnType } from '../../type-converter/types.ts';
import { drizzleError } from './errors.ts';
import { visibleColumns } from './exclusions.ts';
import type { TypeNameMapper } from './naming.ts';
import { resolveTypeName } from './naming.ts';
import type { TypeCacheCtx } from './type-cache.ts';

/** A table's unique-key `where` fields: field name → the constraint's member property names. */
export type UniqueKeyMap = Record<string, readonly string[]>;

/** The field a constraint is offered under: its member property names, in declaration order. */
export const uniqueKeyFieldName = (members: readonly string[]): string => members.join('_');

/**
 * Which of a table's unique constraints get a `where` field.
 *
 * Single-column constraints are left out — `eq` on the column already says "the row with this
 * key", and a wrapper around one value would only be a second way to spell it. A set whose
 * field name is taken by a column or a relation is left out too: the existing field keeps the
 * name, exactly as a relation yields to a same-named column.
 *
 * @param taken names already claimed on the table's filter input (columns, then relations)
 */
export const buildUniqueKeyMap = (sets: readonly string[][], taken: ReadonlySet<string>): UniqueKeyMap => {
  const map: Record<string, readonly string[]> = {};
  for (const set of sets) {
    if (set.length < 2) {
      continue;
    }
    const fieldName = uniqueKeyFieldName(set);
    if (taken.has(fieldName) || fieldName in map) {
      continue;
    }
    map[fieldName] = set;
  }
  return map;
};

/**
 * The `where` fields for a table's compound unique constraints, one input type per constraint.
 *
 * Every member is non-null, which is the whole point: a half-supplied key is a query-validation
 * error rather than a filter that quietly matches more rows than the caller meant it to.
 */
export const generateUniqueKeyFilterFields = (
  table: Table,
  tableName: string,
  uniqueKeys: UniqueKeyMap,
  typeNameMapper: TypeNameMapper | undefined,
  cacheCtx: TypeCacheCtx,
): Record<string, ConvertedInputColumn> => {
  const columns = visibleColumns(table) as Record<string, Column>;
  const typeName = resolveTypeName(tableName, typeNameMapper);
  const fields: Record<string, ConvertedInputColumn> = {};

  for (const [fieldName, members] of Object.entries(uniqueKeys)) {
    fields[fieldName] = {
      type: new GraphQLInputObjectType({
        name: cacheCtx.typeName({
          kind: 'uniqueKey',
          defaultName: `${typeName}${members.map((member) => capitalize(member)).join('')}Key`,
          table: tableName,
          operation: fieldName,
        }),
        description: `The unique constraint on ${members.join(' + ')} of ${typeName}. Every field is required — a half-supplied key is an error, not a broader filter.`,
        fields: Object.fromEntries(
          members.map((member) => [
            member,
            {
              // `forceNullable` is on, so the conversion never returns an already-wrapped type;
              // the cast is only to narrow the union graphql 17 refuses to wrap.
              type: new GraphQLNonNull(
                drizzleColumnToGraphQLType(columns[member]!, member, tableName, true, false, true)
                  .type as NullableConvertedColumnType<true>,
              ),
            },
          ]),
        ),
      }),
      description: `The one ${typeName} row holding this ${members.join(' + ')} key. ANDed with any sibling filters.`,
    } as ConvertedInputColumn;
  }

  return fields;
};

/**
 * Compiles a unique-key field into the equality on each member column. Identical to the
 * filters it replaces — the guarantee is in the input type, not in the SQL.
 */
export const extractUniqueKeyFilter = (
  table: Table,
  tableName: string,
  fieldName: string,
  members: readonly string[],
  value: Record<string, any>,
): SQL | undefined => {
  const columns = getColumns(table) as Record<string, Column>;
  const conditions: SQL[] = [];

  for (const member of members) {
    const column = columns[member];
    const supplied = value?.[member];
    // Unreachable through the generated input, whose members are all non-null. Reachable when
    // the same-named input arrives from a stitched schema that spells the key differently, and
    // a key missing a column is not the key.
    if (!column || supplied === undefined || supplied === null) {
      throw drizzleError(`WHERE ${tableName}: ${fieldName} is missing ${member}, so it does not name a row.`, {
        code: 'DRIZZLE_INVALID_FILTER',
      });
    }
    conditions.push(eq(column, remapFromGraphQLCore(supplied, column, member)));
  }

  return conditions.length > 1 ? and(...conditions) : conditions[0];
};
