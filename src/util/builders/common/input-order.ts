// The two shared input types every generated OrderBy is assembled from: `orderNulls` and
// `innerOrder`.

import { GraphQLBoolean, GraphQLEnumType, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull } from 'graphql';

/**
 * Where NULL values sort relative to non-NULL values. Compiled to native
 * `NULLS FIRST` / `NULLS LAST` on PostgreSQL and SQLite (3.30+); MySQL has no such
 * clause, so there it is emulated with an extra `<expr> IS NULL` sort key ahead of
 * the column itself.
 */
export const orderNulls = new GraphQLEnumType({
  name: 'OrderNulls',
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
});

export const innerOrder = new GraphQLInputObjectType({
  name: 'InnerOrder' as const,
  fields: {
    direction: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'OrderDirection',
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
      ),
    },
    priority: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Priority of current field',
    },
    nulls: {
      type: orderNulls,
      description:
        "Where NULL values sort. Defaults to the database's own rule (PostgreSQL: last on asc, first on desc; MySQL/SQLite: first on asc, last on desc)",
    },
    matchFilterOrder: {
      type: GraphQLBoolean,
      description:
        "Sort by this column's position in the `inArray` list the same request's `where` gives it, rather than by the column's own value — `direction: asc` keeps the list's order, `desc` reverses it. Requires an `inArray` filter on the same column at the top level of `where`, and cannot be combined with `after` or `distinct`.",
    },
  } as const,
});
