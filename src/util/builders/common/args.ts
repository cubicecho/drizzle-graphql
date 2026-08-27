// The argument maps the generated read fields take: the shared filter/order/paging set,
// and the `deleted` argument a soft-deleting table adds.

import {
  type GraphQLEnumType,
  type GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import type { SoftDeleteFor } from './policies.ts';
import { deletedFilterEnum } from './policies.ts';

/** GraphQL argument map for a list/array select field. */
/**
 * The `deleted` argument, emitted only on reads over a table that declares a soft-delete
 * column — a schema with no soft delete anywhere keeps exactly the arguments it had.
 */
export const deletedArg = (
  softDelete: SoftDeleteFor | undefined,
  tableName: string,
): Record<string, { type: any; description: string }> =>
  softDelete?.(tableName)
    ? {
        deleted: {
          type: deletedFilterEnum,
          description: 'Whether rows marked deleted are returned. Defaults to EXCLUDE.',
        },
      }
    : {};

export const selectArrayArgs = (
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  distinctEnum?: GraphQLEnumType,
  softDelete?: SoftDeleteFor,
  tableName?: string,
): Record<string, { type: any; description?: string }> => ({
  offset: { type: GraphQLInt },
  limit: { type: GraphQLInt },
  orderBy: { type: orderArgs },
  where: { type: filterArgs },
  after: {
    type: GraphQLString,
    description:
      "Keyset pagination: only return rows strictly after this cursor (a row's `cursor` field from a previous page, under the same orderBy).",
  },
  ...(distinctEnum ? { distinct: { type: new GraphQLList(new GraphQLNonNull(distinctEnum)) } } : {}),
  ...deletedArg(softDelete, tableName!),
});

/** GraphQL argument map for a single-row select field (no `limit`). */
export const selectSingleArgs = (
  orderArgs: GraphQLInputObjectType,
  filterArgs: GraphQLInputObjectType,
  softDelete?: SoftDeleteFor,
  tableName?: string,
): Record<string, { type: any }> => ({
  offset: { type: GraphQLInt },
  orderBy: { type: orderArgs },
  where: { type: filterArgs },
  ...deletedArg(softDelete, tableName!),
});
