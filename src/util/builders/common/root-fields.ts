// Registration of the generated root fields, with the collision check that the naming
// config cannot do for itself.

import type { GraphQLFieldConfig } from 'graphql';

/**
 * Registers one generated root field, refusing to overwrite a name already taken.
 *
 * A generated name is the table name run through `typeNameMapper`, a prefix and a suffix,
 * and the pluralization each operation applies — so whether two operations collide is a
 * property of the finished names, not of any one piece of the config. `buildSchema` checks
 * what it can up front (identical list and single suffixes with no mapper), but that check
 * compares the suffix *strings*, which cannot see a collision the rest of the naming rules
 * produce: `{ list: 'All', single: '' }` used to give both insert mutations the name
 * `createUsers`, and the array insert simply disappeared from the schema.
 *
 * Assigning into the record silently kept the last registration. Throwing here means a
 * naming config that cannot work says so at build time, naming the field it lost.
 */
export const defineRootField = (
  fields: Record<string, GraphQLFieldConfig<any, any>>,
  kind: 'query' | 'mutation',
  name: string,
  config: GraphQLFieldConfig<any, any>,
): void => {
  if (Object.getOwnPropertyDescriptor(fields, name) !== undefined) {
    throw new Error(
      `Drizzle-GraphQL Error: two generated ${kind} fields are both named '${name}'. Generated names come from the table name plus config.prefixes, config.suffixes and config.typeNameMapper — some combination of those gives two operations the same name. Adjust one of them so each operation gets its own.`,
    );
  }

  fields[name] = config;
};
