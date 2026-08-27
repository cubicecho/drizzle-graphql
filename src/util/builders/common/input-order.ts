// The two shared input types every generated OrderBy is assembled from: `orderNulls` and
// `innerOrder`. Both are built once per name they resolve to, so a build that renames its
// types gets its own pair and every other build keeps sharing one.

import { GraphQLBoolean, GraphQLEnumType, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull } from 'graphql';
import { sharedType, type TypeNameResolver } from './type-names.ts';

/**
 * Where NULL values sort relative to non-NULL values. Compiled to native
 * `NULLS FIRST` / `NULLS LAST` on PostgreSQL and SQLite (3.30+); MySQL has no such
 * clause, so there it is emulated with an extra `<expr> IS NULL` sort key ahead of
 * the column itself.
 */
export const orderNullsType = (typeName: TypeNameResolver): GraphQLEnumType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'OrderNulls' },
    (name) =>
      new GraphQLEnumType({
        name,
        description: 'Where NULL values sort relative to non-NULL values',
        values: {
          first: {
            value: 'first',
            description: 'NULL values sort before all non-NULL values',
          },
          last: {
            value: 'last',
            description: 'NULL values sort after all non-NULL values',
          },
        },
      }),
  );

const orderDirectionType = (typeName: TypeNameResolver): GraphQLEnumType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'OrderDirection' },
    (name) =>
      new GraphQLEnumType({
        name,
        description: 'Order by direction',
        values: {
          asc: {
            value: 'asc',
            description: 'Ascending order',
          },
          desc: {
            value: 'desc',
            description: 'Descending order',
          },
        },
      }),
  );

export const innerOrderType = (typeName: TypeNameResolver): GraphQLInputObjectType =>
  sharedType(
    typeName,
    { kind: 'shared', defaultName: 'InnerOrder' },
    (name) =>
      new GraphQLInputObjectType({
        name,
        fields: {
          direction: {
            type: new GraphQLNonNull(orderDirectionType(typeName)),
          },
          priority: {
            type: new GraphQLNonNull(GraphQLInt),
            description: 'Priority of current field',
          },
          nulls: {
            type: orderNullsType(typeName),
            description:
              "Where NULL values sort. Defaults to the database's own rule (PostgreSQL: last on asc, first on desc; MySQL/SQLite: first on asc, last on desc)",
          },
          matchFilterOrder: {
            type: GraphQLBoolean,
            description:
              "Sort by this column's position in the `inArray` list the same request's `where` gives it, rather than by the column's own value — `direction: asc` keeps the list's order, `desc` reverses it. Requires an `inArray` filter on the same column at the top level of `where`, and cannot be combined with `after` or `distinct`.",
          },
        },
      }),
  );
